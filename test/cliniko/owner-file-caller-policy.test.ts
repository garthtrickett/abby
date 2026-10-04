import assert from "node:assert/strict";
import { chmod, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { OwnerFileCallerPolicy } from "../../src/standalone/owner-file-caller-policy.ts";
import { callerVerificationFixture } from "../support/caller-verification.ts";

test("E2E-275 current clinic approval is location/operation/time/admin-bound and changes revoke a captured call", async () => {
  for (const kind of ["enabled", "approved", "operations", "revision", "future", "expired", "scope", "role", "removed", "email", "membership"] as const) {
    const f = await callerVerificationFixture();
    try {
      assert.deepEqual(await f.policy.current(f.scope), { ok: true, value: { scope: f.scope, enabled: true, version: f.config.policyVersion } });
      if (kind === "enabled") await f.replaceApproval({ enabled: false });
      if (kind === "approved") await f.replaceApproval({ approved: false });
      if (kind === "operations") await f.replaceApproval({ operations: ["appointments.cancel"] });
      if (kind === "revision") await f.replaceApproval({ revision: "changed" });
      if (kind === "future") f.setTime("2026-10-04T05:59:59.999Z");
      if (kind === "expired") f.setTime("2026-10-05T06:00:00.000Z");
      if (kind === "scope") await f.replaceAccount({ actor: { ...f.account.actor, scope: { ...f.scope, locationId: "other" } } });
      if (kind === "role") await f.replaceAccount({ actor: { ...f.account.actor, role: "staff" } });
      if (kind === "removed") await writeFile(f.accountPath, "[]");
      if (kind === "email") await f.replaceAccount({ email: "changed-admin@example.test" });
      if (kind === "membership") await f.replaceAccount({ membershipVersion: "changed" });
      const found = await f.policy.current(f.scope); assert.equal(found.ok && found.value.enabled, false);
      f.session.begin(); assert.deepEqual(await f.session.submitCode("123456"), { verified: false }); assert.equal(f.mail.length, 0);
      assert.equal(f.provider.some(path => path.includes("appointments")), false);
    } finally { await f.close(); }
  }
});

test("E2E-275 invalid and expanded approval records fail closed; channel approval never replaces patient permission", async () => {
  const f = await callerVerificationFixture();
  try {
    for (const patch of [{ patientId: "42" }, { patientPhone: "+61400111222" }, { notes: "private-data" },
      { method: "phoneMatch" }, { maxAnswers: 4 }, { lifetimeSeconds: 600 }, { representatives: "allow" },
      { sharedNumbers: "allow" }, { patientPermission: "emailPossession" }, { approved: "yes" },
      { operations: [] }, { operations: ["appointments.read", "appointments.read"] }, { operations: ["anything"] },
      { scope: { ...f.scope, locationId: "other" } }, { approvedAt: "2026-02-30T06:00:00.000Z" },
      { effectiveUntil: f.approval.effectiveFrom }, { revision: "patient@example.test" }]) {
      await writeFile(f.path, JSON.stringify({ ...f.approval, ...patch }));
      assert.deepEqual(await OwnerFileCallerPolicy.capture(f.config), { ok: false, error: { kind: "callerPolicyUnavailable" } });
    }
    await f.replaceApproval({}); f.setPermitted(false); f.session.begin();
    assert.deepEqual(await f.session.submitCode("123456"), { verified: false }); assert.equal(f.mail.length, 0);
  } finally { await f.close(); }
});

test("E2E-275 owner file permissions, symlink, missing/oversize/malformed configuration and wrong scope fail closed", async () => {
  const f = await callerVerificationFixture();
  try {
    await chmod(f.path, 0o644); assert.equal((await OwnerFileCallerPolicy.capture(f.config)).ok, false); await chmod(f.path, 0o600);
    await symlink(f.path, `${f.path}.link`);
    for (const path of [`${f.path}.link`, `${f.path}.missing`, f.folder, "relative.json"]) {
      assert.equal((await OwnerFileCallerPolicy.capture({ ...f.config, path })).ok, false);
    }
    for (const content of ["malformed", " ".repeat(8193), "[]", "null"]) {
      await writeFile(f.path, content); assert.equal((await OwnerFileCallerPolicy.capture(f.config)).ok, false);
    }
    await f.replaceApproval({});
    const other = await f.policy.current({ ...f.scope, locationId: "other" }); assert.equal(other.ok && other.value.enabled, false);
    await rm(f.path); assert.equal((await f.policy.current(f.scope)).ok, false);
  } finally { await f.close(); }
});

test("E2E-275 approval replacement during a held membership read is detected before capture or use", async () => {
  const f = await callerVerificationFixture();
  try {
    let release: () => void = () => undefined, entered: () => void = () => undefined;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const directory = { ...f.config.directory, findByEmail: f.config.directory.findByEmail.bind(f.config.directory),
      findByRef: async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { ok: true as const, value: f.account }; } };
    const pending = OwnerFileCallerPolicy.capture({ ...f.config, directory });
    await waiting; await f.replaceApproval({ revision: "replaced" }); release(); assert.equal((await pending).ok, false);
    const current = await f.policy.current(f.scope); assert.equal(current.ok && current.value.enabled, false);
    let hold = false, signal: () => void = () => undefined;
    const directoryForUse = { findByEmail: f.config.directory.findByEmail.bind(f.config.directory), findByRef: async (ref: string) => {
      if (hold) { signal(); await new Promise<void>(resolve => { release = resolve; }); }
      return f.config.directory.findByRef(ref);
    } };
    const captured = await OwnerFileCallerPolicy.capture({ ...f.config, directory: directoryForUse }); assert.ok(captured.ok);
    const reading = new Promise<void>(resolve => { signal = resolve; }); hold = true;
    const using = captured.value.current(f.scope); await reading;
    await f.replaceApproval({ enabled: false }); release();
    const changed = await using; assert.equal(changed.ok && changed.value.enabled, false);
  } finally { await f.close(); }
});
