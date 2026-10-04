import assert from "node:assert/strict";
import test from "node:test";
import { CallerVerificationSession, verificationPrompt } from "../../src/standalone/caller-verification-session.ts";
import { callerVerificationFixture, verificationCanaries } from "../support/caller-verification.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), "synthetic checkpoint must be reached");
}
async function issue(f: Awaited<ReturnType<typeof callerVerificationFixture>>) {
  assert.deepEqual(f.session.begin(), { prompt: verificationPrompt });
  await waitUntil(() => f.mail.length === 1);
  assert.deepEqual(await f.session.submitCode(f.mail[0]!.code), { verified: true });
  const grant = await f.session.verified(); assert.ok(grant); return grant;
}

test("E2E-274 dedicated code entry reaches actual text gateway protected read without putting code/contact/token into caller turns", async () => {
  const f = await callerVerificationFixture();
  try {
    await f.read("guessed-proof"); assert.equal(f.provider.filter(path => path.includes("appointments")).length, 0);
    const grant = await issue(f), progress = await f.read(grant.verificationRef);
    assert.ok(f.provider.includes("/v1/individual_appointments"));
    const publicState = JSON.stringify([progress, await f.state(), f.session, f.session.begin()]);
    for (const secret of [...verificationCanaries, f.mail[0]!.code, grant.verificationRef]) assert.equal(publicState.includes(secret), false);
    assert.deepEqual((await f.state()).processedTurnIds, ["appointment-read-1", "appointment-read-2"]);
    assert.deepEqual(await f.session.submitCode(f.mail[0]!.code), { verified: false });
    assert.equal(f.mail.length, 1); assert.equal((await f.session.proof.verifyOperation(f.scope, grant.verificationRef,
      "appointments.cancel", "2026-10-04T06:00:00.000Z")).ok, false);
  } finally { await f.close(); }
});

test("E2E-274 begin is immediate and identical with held mail, and an early code answer waits for the owned challenge", async () => {
  let code = "", release: () => void = () => undefined;
  const f = await callerVerificationFixture({ delivery: { send: async (_email, secret) => {
    code = secret; return new Promise<boolean>(resolve => { release = () => resolve(true); });
  } } });
  try {
    assert.deepEqual(f.session.begin(), { prompt: verificationPrompt }); await waitUntil(() => !!code);
    let settled = false; const pending = f.session.submitCode(code).then(value => { settled = true; return value; });
    await tick(); assert.equal(settled, false); release();
    assert.deepEqual(await pending, { verified: true }); assert.ok(await f.session.verified());
  } finally { await f.close(); }
});

test("E2E-274 disabled/unapproved/shared/stale/absent/contact/permission failures share wording and cannot read appointments", async () => {
  for (const kind of ["disabled", "unapproved", "shared", "stale", "none", "email", "phone", "permission"] as const) {
    const f = await callerVerificationFixture({ enabled: kind !== "disabled", approved: kind !== "unapproved" });
    try {
      if (kind === "shared") f.setCandidates({ kind: "multiple", candidateIds: [verificationCanaries[2]!, "43"] });
      if (kind === "stale") f.setCandidates({ kind: "indexStale", candidateIds: [] });
      if (kind === "none") f.setCandidates({ kind: "none", candidateIds: [] });
      if (kind === "email") f.setEmail("");
      if (kind === "phone") f.setPhone("+61499999888");
      if (kind === "permission") f.setPermitted(false);
      assert.deepEqual(f.session.begin(), { prompt: verificationPrompt });
      assert.deepEqual(await f.session.submitCode("123456"), { verified: false });
      assert.equal(f.mail.length, 0); assert.equal(await f.session.verified(), undefined);
      await f.read("guessed-proof"); assert.equal(f.provider.some(path => path.includes("appointments")), false);
    } finally { await f.close(); }
  }
});

test("E2E-274 three wrong answers exhaust the challenge, repeated starts do not resend, and malformed codes count", async () => {
  const kinds: string[] = [], f = await callerVerificationFixture({ budget: { reserve: async (_scope, kind) => { kinds.push(kind); return true; } } });
  try {
    f.session.begin(); f.session.begin(); await waitUntil(() => f.mail.length === 1);
    assert.deepEqual(await f.session.submitCode("x".repeat(10000)), { verified: false });
    const wrong = f.mail[0]!.code === "000000" ? "999999" : "000000";
    for (let i = 0; i < 2; i++) assert.deepEqual(await f.session.submitCode(wrong), { verified: false });
    assert.deepEqual(await f.session.submitCode(f.mail[0]!.code), { verified: false });
    assert.deepEqual(kinds, ["issue", "answer", "answer", "answer"]); assert.equal(f.mail.length, 1);
  } finally { await f.close(); }
});

test("E2E-274 close, timeout or revoked approval during pending mail cannot accept a late successful delivery", async () => {
  for (const kind of ["close", "timeout", "approval"] as const) {
    let code = "", release: () => void = () => undefined;
    const f = await callerVerificationFixture({ timeoutMs: kind === "timeout" ? 100 : 1000,
      delivery: { send: async (_email, secret) => { code = secret; return new Promise<boolean>(resolve => { release = () => resolve(true); }); } } });
    try {
      f.session.begin(); await waitUntil(() => !!code); const pending = f.session.submitCode(code);
      if (kind === "close") f.session.dispose();
      if (kind === "approval") await f.replaceApproval({ enabled: false });
      if (kind !== "timeout") release();
      assert.deepEqual(await pending, { verified: false }); release(); await tick();
      assert.equal(await f.session.verified(), undefined); await f.read("guessed-proof");
      assert.equal(f.provider.some(path => path.includes("appointments")), false);
    } finally { await f.close(); }
  }
});

test("E2E-274 issued access is revoked by SAM expiry, emergency automation disable, clinic approval, membership and patient permission", async () => {
  for (const kind of ["lease", "automation", "approval", "membership", "permission", "close", "endCall"] as const) {
    const f = await callerVerificationFixture();
    try {
      const grant = await issue(f);
      if (kind === "lease") f.setTime("2026-10-04T06:01:00.000Z");
      if (kind === "automation") assert.ok((await f.policies.changeAutomationEnabled(f.scope, "1", false, "synthetic-admin")).ok);
      if (kind === "approval") await f.replaceApproval({ revision: "changed-approval" });
      if (kind === "membership") await f.replaceAccount({ membershipVersion: "revoked" });
      if (kind === "permission") f.setPermitted(false);
      if (kind === "close") f.session.dispose();
      if (kind === "endCall") assert.ok((await f.runtime.endCall(f.callId, f.sessionId, "2026-10-04T06:00:00.000Z")).ok);
      assert.equal(await f.session.verified(), undefined); await f.read(grant.verificationRef);
      assert.equal(f.provider.some(path => path.includes("appointments")), false);
    } finally { await f.close(); }
  }
});

test("E2E-274 emergency write stop denies write verification before issue and revokes already-issued write proof", async () => {
  for (const timing of ["before", "after"] as const) {
    const f = await callerVerificationFixture({ operation: "appointments.cancel" });
    try {
      if (timing === "before") {
        assert.ok((await f.ledger.stopWrites(f.scope, "synthetic-admin", "verification stop")).ok);
        f.session.begin(); assert.deepEqual(await f.session.submitCode("123456"), { verified: false }); assert.equal(f.mail.length, 0);
      } else {
        const grant = await issue(f);
        assert.ok((await f.ledger.stopWrites(f.scope, "synthetic-admin", "verification stop")).ok);
        assert.equal(await f.session.verified(), undefined);
        assert.equal((await f.session.proof.verifyOperation(f.scope, grant.verificationRef, "appointments.cancel", "2026-10-04T06:00:00.000Z")).ok, false);
      }
      assert.equal(f.provider.some(path => path.includes("appointments")), false);
    } finally { await f.close(); }
  }
});

test("E2E-274 another admitted call or a mismatched inbound event cannot reuse code/proof or create authority", async () => {
  const a = await callerVerificationFixture(), b = await callerVerificationFixture({ scope: a.scope });
  try {
    const grant = await issue(a);
    assert.deepEqual(await b.session.submitCode(a.mail[0]!.code), { verified: false });
    assert.equal((await b.session.proof.verifyPatient(b.scope, grant.verificationRef, "2026-10-04T06:00:00.000Z")).ok, false);
    for (const config of [{ ...a.sessionConfig, inbound: b.inbound },
      { ...a.sessionConfig, inbound: { ...a.inbound, dialedNumber: "+6125550111" } },
      { ...a.sessionConfig, operation: "appointments.cancel" as const },
      { ...a.sessionConfig, receipt: { ...a.receipt, lifecycle: "ended" as const } },
      { ...a.sessionConfig, inbound: { ...a.inbound, presentedCallerNumber: "anonymous" } }]) {
      assert.deepEqual(CallerVerificationSession.create(config), { ok: false, error: { kind: "verificationUnavailable" } });
    }
  } finally { await a.close(); await b.close(); }
});
