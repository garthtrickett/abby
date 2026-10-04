import assert from "node:assert/strict";
import { chmod, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { OwnerFileIntakePolicy } from "../../src/standalone/owner-file-intake-policy.ts";
import { intakeDeferred, intakeDraft } from "../support/intake-edge.ts";
import { intakePolicyFixture } from "../support/intake-policy.ts";

test("E2E-293 approved clinic policy validates private draft and exact recorded consent versions but returns only public terms", async () => {
  const f = await intakePolicyFixture();
  try {
    const checked = await f.policy.checkDraft(f.query); assert.ok(checked.ok);
    assert.deepEqual(checked.value, { scope: f.scope, revision: f.approval.revision, intakeVersion: "1",
      privacyTerms: f.approval.privacyTerms, intakeTerms: f.approval.intakeTerms, recoveryTerms: f.approval.recoveryTerms, expiresAt: f.approval.effectiveUntil });
    for (const privateValue of [intakeDraft.firstName, intakeDraft.lastName, intakeDraft.email, intakeDraft.dateOfBirth, intakeDraft.patientPhone]) {
      assert.equal(JSON.stringify(checked).includes(privateValue), false);
    }
    Object.assign(checked.value.privacyTerms, { approvedText: "caller changed return" }); // Runtime consumer cannot alter the captured source.
    assert.ok((await f.policy.checkDraft(f.query)).ok);
    const current = await f.policy.current(f.scope); assert.ok(current.ok);
    assert.equal(current.value.privacyTerms.approvedText, f.approval.privacyTerms.approvedText);
  } finally { await f.close(); }
});

test("E2E-293 public schema rejects patient data, unsupported recovery, unsupported caller methods and missing or expanded required fields", async () => {
  const f = await intakePolicyFixture();
  try {
    for (const patch of [{ patientId: "42" }, { email: intakeDraft.email }, { patientPhone: intakeDraft.patientPhone }, { notes: "private note" },
      { recoveryContract: "providerQueue" }, { recoveryTerms: { version: "r", approvedText: "It will all be fine." } }, { operation: "appointments.book" }, { callerEligibility: "anyone" }, { minors: "allow" },
      { representatives: "allow" }, { minimumAgeYears: 17 }, { minimumAgeYears: 121 }, { minimumAgeYears: "18" },
      { leapDayBirthday: "february28" }, { callerPhone: "callerSupplied" }, { verificationMethod: "callerId" },
      { patientPermission: "emailPossession" }, { duplicatePolicy: "merge" }, { intakeVersion: "0" }, { intakeVersion: "01" },
      { intakeVersion: "9007199254740992" }, { businessId: "0" }, { credentialFingerprint: "raw-secret" }, { countryCallingCode: "0" },
      { timeZone: "unknown" }, { scope: { ...f.scope, patientId: "42" } },
      { requiredFields: ["firstName"] }, { requiredFields: [...f.approval.requiredFields, "clinicalNotes"] },
      { requiredFields: Array(6).fill("email") }, { privacyTerms: { version: "x", approvedText: "" } },
      { privacyTerms: { version: "x", approvedText: "a\nb" } }, { intakeTerms: { version: "x", approvedText: "x".repeat(1001) } },
      { intakeTerms: { ...f.approval.intakeTerms, patientId: "42" } }, { approvedAt: "2026-02-30T00:00:00.000Z" }]) {
      await writeFile(f.path, JSON.stringify({ ...f.approval, ...patch }));
      assert.deepEqual(await OwnerFileIntakePolicy.capture(f.config), { ok: false, error: { kind: "intakePolicyUnavailable" } });
    }
  } finally { await f.close(); }
});

test("E2E-293 changing approvals, pinned location/intake/business/credential, admin membership or expiration revokes current use", async () => {
  for (const change of ["approved", "enabled", "revision", "intakeVersion", "policyVersion", "businessId", "credentialFingerprint",
    "timeZone", "terms", "role", "membership", "removed", "future", "expired", "clock"] as const) {
    const f = await intakePolicyFixture();
    try {
      if (change === "approved" || change === "enabled") await f.replaceApproval({ [change]: false });
      if (change === "revision") await f.replaceApproval({ revision: "next" });
      if (change === "intakeVersion") await f.replaceApproval({ intakeVersion: "3" });
      if (change === "policyVersion") await f.replaceApproval({ policyVersion: "new" });
      if (change === "businessId") await f.replaceApproval({ businessId: "12" });
      if (change === "credentialFingerprint") await f.replaceApproval({ credentialFingerprint: "0".repeat(64) });
      if (change === "timeZone") await f.replaceApproval({ timeZone: "Asia/Tokyo" });
      if (change === "terms") await f.replaceApproval({ privacyTerms: { ...f.approval.privacyTerms, version: "next" } });
      if (change === "role") await f.replaceAccount({ actor: { ...f.account.actor, role: "staff" } });
      if (change === "membership") await f.replaceAccount({ membershipVersion: "next" });
      if (change === "removed") await writeFile(f.accountPath, "[]");
      if (change === "future") f.setTime("2025-12-31T23:59:59.999Z");
      if (change === "expired") f.setTime(f.approval.effectiveUntil);
      if (change === "clock") f.setTime("2026-02-30T00:00:00.000Z");
      assert.equal((await f.policy.current(f.scope)).ok, false, change);
      assert.equal((await f.policy.checkDraft(f.query)).ok, false, change);
    } finally { await f.close(); }
  }
  const f = await intakePolicyFixture();
  try {
    for (const patch of [{ intakeEnabled: false }, { intakeVersion: "0" }, { policyVersion: "other" }, { businessId: "12" },
      { credentialFingerprint: "0".repeat(64) }, { countryCallingCode: "64" }, { timeZone: "UTC" },
      { scope: { ...f.scope, locationId: "foreign" } }]) assert.equal((await OwnerFileIntakePolicy.capture({ ...f.config, ...patch })).ok, false);
  } finally { await f.close(); }
});

test("E2E-293 caller, private fields, exact terms, privacy and admitted-phone mismatches deny a draft without disclosing its data", async () => {
  const f = await intakePolicyFixture();
  try {
    for (const patch of [{ caller: "proxy" }, { privacyAccepted: false }, { intakeAccepted: false }, { privacyTermsVersion: "old" },
      { intakeTermsVersion: "old" }, { recoveryAccepted: false }, { recoveryTermsVersion: "old" }, { admittedCallerPhone: "+61499999999" }, { admittedCallerPhone: "hidden" },
      { draft: { ...intakeDraft, firstName: "" } }, { draft: { ...intakeDraft, lastName: "x".repeat(256) } },
      { draft: { ...intakeDraft, email: "bad" } }, { draft: { ...intakeDraft, dateOfBirth: "1990-02-30" } },
      { draft: { ...intakeDraft, dateOfBirth: "2027-01-01" } }, { draft: { ...intakeDraft, patientPhone: "+61499999999" } },
      { draft: { ...intakeDraft, notes: "unapproved chart data" } }, { patientId: "42" },
      { scope: { ...f.scope, clinicId: "foreign" } }]) {
      const result = await f.policy.checkDraft({ ...f.query, ...patch } as typeof f.query);
      assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes(intakeDraft.email), false);
    }
    assert.ok((await f.policy.checkDraft({ ...f.query, admittedCallerPhone: "0400 111 222" })).ok);
  } finally { await f.close(); }
});

test("E2E-293 age eligibility follows the clinic local birthday and the explicit March 1 leap-day rule", async () => {
  const f = await intakePolicyFixture();
  const birthday = { ...f.query, draft: { ...intakeDraft, dateOfBirth: "2008-10-05" } };
  const leap = { ...f.query, draft: { ...intakeDraft, dateOfBirth: "2008-02-29" } };
  try {
    f.setTime("2026-10-04T12:59:59.999Z"); assert.equal((await f.policy.checkDraft(birthday)).ok, false);
    f.setTime("2026-10-04T13:00:00.000Z"); assert.equal((await f.policy.checkDraft(birthday)).ok, true, "Sydney has entered Oct 5 while UTC has not");
    f.setTime("2026-02-28T01:00:00.000Z"); assert.equal((await f.policy.checkDraft(leap)).ok, false);
    f.setTime("2026-03-01T01:00:00.000Z"); assert.equal((await f.policy.checkDraft(leap)).ok, true);
    await f.replaceApproval({ minimumAgeYears: 21 }); const recaptured = await OwnerFileIntakePolicy.capture(f.config); assert.ok(recaptured.ok);
    assert.equal((await recaptured.value.checkDraft(leap)).ok, false);
  } finally { await f.close(); }
});

test("E2E-293 owner-file safety and bounded abandoned directory reads deny publication of late approval", async () => {
  const f = await intakePolicyFixture();
  try {
    await chmod(f.path, 0o644); assert.equal((await OwnerFileIntakePolicy.capture(f.config)).ok, false); await chmod(f.path, 0o600);
    await symlink(f.path, `${f.path}.link`); assert.equal((await OwnerFileIntakePolicy.capture({ ...f.config, path: `${f.path}.link` })).ok, false);
    const entered = intakeDeferred<void>(), release = intakeDeferred<void>();
    const directory = { findByEmail: f.directory.findByEmail.bind(f.directory), findByRef: async () => {
      entered.resolve(); await release.promise; return { ok: true as const, value: f.account };
    } };
    const consumer = new AbortController(); const pending = OwnerFileIntakePolicy.capture({ ...f.config, directory }, consumer.signal);
    await entered.promise; consumer.abort(); assert.equal((await pending).ok, false); release.resolve();
    assert.equal((await OwnerFileIntakePolicy.capture({ ...f.config, directory: { ...directory,
      findByRef: () => new Promise(() => {}) }, timeoutMs: 10 })).ok, false);
    await rm(f.path); assert.equal((await f.policy.current(f.scope)).ok, false);
  } finally { await f.close(); }
});

test("E2E-293 held membership observes approval replacement and a mutable draft cannot change the checked snapshot", async () => {
  const f = await intakePolicyFixture();
  let held = false;
  const entered = intakeDeferred<void>(), release = intakeDeferred<void>();
  const directory = { findByEmail: f.directory.findByEmail.bind(f.directory), findByRef: async (ref: string) => {
    if (held) { entered.resolve(); await release.promise; } return f.directory.findByRef(ref);
  } };
  try {
    const captured = await OwnerFileIntakePolicy.capture({ ...f.config, directory }); assert.ok(captured.ok);
    held = true;
    const mutable = structuredClone(f.query); const pending = captured.value.checkDraft(mutable);
    await entered.promise;
    Object.assign(mutable.draft, { dateOfBirth: "2026-01-01", patientPhone: "+61499999999" });
    release.resolve(); assert.equal((await pending).ok, true, "the originally eligible private snapshot was checked");
    const swappedEntered = intakeDeferred<void>(), swappedRelease = intakeDeferred<void>();
    const swapping = { ...directory, findByRef: async (ref: string) => { swappedEntered.resolve(); await swappedRelease.promise; return f.directory.findByRef(ref); } };
    const replacing = OwnerFileIntakePolicy.capture({ ...f.config, directory: swapping });
    await swappedEntered.promise; await f.replaceApproval({ enabled: false }); swappedRelease.resolve();
    assert.equal((await replacing).ok, false);
  } finally { await f.close(); }
});

test("E2E-293 memory raw-setting edits affect later calls while approval replacement revokes earlier public eligibility", async () => {
  const { MemoryClinicIntakeSettingStore } = await import("../../src/reference/clinic-intake-setting-store.ts");
  const { exerciseIntakePolicySetting } = await import("../support/intake-policy-setting.ts");
  await exerciseIntakePolicySetting(new MemoryClinicIntakeSettingStore());
});
