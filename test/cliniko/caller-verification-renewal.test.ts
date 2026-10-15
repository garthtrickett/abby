import assert from "node:assert/strict";
import test from "node:test";
import { CallerVerificationSession, verificationPrompt } from "../../src/standalone/caller-verification-session.ts";
import { callerVerificationFixture, verificationNow, verificationCanaries } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

type Fixture = Awaited<ReturnType<typeof callerVerificationFixture>>;
const signal = () => new AbortController().signal;
async function issue(f: Fixture, session = f.session) {
  const count = f.mail.length;
  assert.deepEqual(session.begin(), { prompt: verificationPrompt });
  // The mail transport records the code before the immediate answer awaits
  // challenge completion. Polling here is only for this mid-run checkpoint.
  const deadline = Date.now() + 5000;
  while (f.mail.length === count && Date.now() < deadline) await new Promise<void>(r => setTimeout(r, 5));
  assert.equal(f.mail.length, count + 1);
  assert.deepEqual(await session.submitCode(f.mail[count]!.code), { verified: true });
  return (await session.verified())!;
}
async function forward(f: Fixture, seconds: number) {
  let at = Date.parse((await f.state()).sessionLease!.expiresAt) - 30000;
  for (let remaining = seconds; remaining > 0; remaining -= 20) {
    at += Math.min(remaining, 20) * 1000;
    f.setTime(new Date(at).toISOString());
    const state = await f.state();
    resultValue(await f.runtime.renewSession(f.callId, f.sessionId, state.sessionLease!.version, new Date(at).toISOString()));
  }
}

test("E2E-418 renewal replaces an expired source with a fresh same-patient challenge and revokes every old proof owner", async () => {
  const f = await callerVerificationFixture({ operation: "appointments.reschedule" });
  let successor: CallerVerificationSession | undefined;
  try {
    const before = await issue(f), oldProof = f.session.proof;
    await forward(f, 301);
    successor = resultValue(await f.session.renewOnce(before.verificationRef, signal()));
    assert.equal(await f.session.verified(), undefined);
    assert.equal(await successor.verified(), undefined);
    assert.deepEqual(await successor.submitCode(f.mail[0]!.code), { verified: false });
    assert.equal(f.mail.length, 1, "handoff alone sends no code");
    const fresh = await issue(f, successor);
    assert.notEqual(fresh.verificationRef, before.verificationRef);
    assert.ok(Date.parse(fresh.expiresAt) > Date.parse(before.expiresAt));
    const now = (await f.state()).sessionLease!.expiresAt;
    assert.equal((await oldProof.verifyOperation(f.scope, before.verificationRef, "appointments.reschedule", now)).ok, false);
    assert.equal((await successor.proof.verifyOperation(f.scope, before.verificationRef, "appointments.reschedule", now)).ok, false);
    assert.equal((await successor.proof.verifyOperation(f.scope, fresh.verificationRef, "appointments.cancel", now)).ok, false);
    const subject = await successor.verifiedSubject("appointments.reschedule");
    assert.equal(subject?.patientRef, verificationCanaries[2]);
    assert.equal((await f.session.renewOnce(before.verificationRef, signal())).ok, false);
    const publicState = JSON.stringify([await f.state(), successor, successor.begin()]);
    for (const secret of [...verificationCanaries, before.verificationRef, fresh.verificationRef, ...f.mail.map(m => m.code)]) assert.equal(publicState.includes(secret), false);
  } finally { successor?.dispose(); await f.close(); }
});

test("E2E-418 forged, unverified, foreign and aborted renewal requests cannot retire a valid owner or reset failed answers", async () => {
  const f = await callerVerificationFixture(), other = await callerVerificationFixture();
  try {
    assert.equal((await f.session.renewOnce("guessed", signal())).ok, false);
    const before = await issue(f), foreign = await issue(other);
    for (const ref of ["guessed", foreign.verificationRef, `${before.verificationRef} `]) assert.equal((await f.session.renewOnce(ref, signal())).ok, false);
    assert.equal((await f.session.renewOnce(before.verificationRef, AbortSignal.abort())).ok, false);
    assert.deepEqual(await f.session.verified(), before);
    assert.equal(f.mail.length, 1);
  } finally { await f.close(); await other.close(); }
  const failed = await callerVerificationFixture();
  try {
    failed.session.begin();
    for (let i = 0; i < 3; i++) await failed.session.submitCode("not-code");
    assert.equal((await failed.session.renewOnce("guessed", signal())).ok, false);
    failed.session.begin(); assert.equal(failed.mail.length, 1);
  } finally { await failed.close(); }
});

for (const kind of ["differentPatient", "shared", "stale", "permission", "approval", "writeStop", "automation", "ended", "lease", "issueBudget"] as const)
  test(`E2E-418 current ${kind} withdrawal cannot produce renewed access or preserve old access`, async () => {
    let issueAllowed = true;
    const f = await callerVerificationFixture({ operation: "appointments.reschedule", budget: { reserve: async (_scope, use) => use !== "issue" || issueAllowed } });
    let successor: CallerVerificationSession | undefined;
    try {
      const before = await issue(f);
      if (kind === "differentPatient") { f.setCandidates({ kind: "one", candidateIds: ["43"] }); f.setNativePatientId("43"); }
      if (kind === "shared") f.setCandidates({ kind: "multiple", candidateIds: [verificationCanaries[2]!, "43"] });
      if (kind === "stale") f.setCandidates({ kind: "indexStale", candidateIds: [] });
      if (kind === "permission") f.setPermitted(false);
      if (kind === "approval") await f.replaceApproval({ enabled: false });
      if (kind === "writeStop") resultValue(await f.ledger.stopWrites(f.scope, "synthetic-admin", "synthetic stop"));
      if (kind === "automation") resultValue(await f.policies.changeAutomationEnabled(f.scope, "1", false, "synthetic-admin"));
      if (kind === "ended") resultValue(await f.runtime.endCall(f.callId, f.sessionId, verificationNow));
      if (kind === "lease") f.setTime("2026-10-04T06:01:00.000Z");
      if (kind === "issueBudget") issueAllowed = false;
      const renewed = await f.session.renewOnce(before.verificationRef, signal());
      if (renewed.ok) {
        successor = renewed.value; assert.deepEqual(successor.begin(), { prompt: verificationPrompt });
        assert.deepEqual(await successor.submitCode("123456"), { verified: false });
      }
      assert.equal(await f.session.verified(), undefined);
      assert.equal(await successor?.verified(), undefined);
      assert.equal(f.mail.length, 1);
      if (kind === "differentPatient") assert.equal(f.provider.includes("/v1/patients/43"), false, "pinned successor must stop before reading another patient's channel");
      assert.equal((await f.session.renewOnce(before.verificationRef, signal())).ok, false);
    } finally { successor?.dispose(); await f.close(); }
  });

test("E2E-418 concurrent renewal has one successor and never auto-resends its challenge", async () => {
  const f = await callerVerificationFixture();
  const owners: CallerVerificationSession[] = [];
  try {
    const before = await issue(f);
    const results = await Promise.all(Array.from({ length: 5 }, () => f.session.renewOnce(before.verificationRef, signal())));
    for (const result of results) if (result.ok) owners.push(result.value);
    assert.equal(owners.length, 1); const next = owners[0]!;
    const fresh = await issue(f, next);
    for (let i = 0; i < 3; i++) next.begin();
    assert.equal(f.mail.length, 2); assert.deepEqual(await next.verified(), fresh);
  } finally { owners.forEach(s => s.dispose()); await f.close(); }
});

test("E2E-418 permission withdrawn during renewed delivery cannot accept its late code", async () => {
  const delivered: string[] = []; let release = () => {};
  const f = await callerVerificationFixture({ delivery: { send: async (_email, code) => {
    delivered.push(code);
    return delivered.length === 1 ? true : new Promise<boolean>(r => { release = () => r(true); });
  } } });
  let next: CallerVerificationSession | undefined;
  try {
    f.session.begin(); const deadline = Date.now() + 5000;
    while (!delivered.length && Date.now() < deadline) await new Promise<void>(r => setTimeout(r, 5));
    assert.deepEqual(await f.session.submitCode(delivered[0]!), { verified: true });
    const before = (await f.session.verified())!;
    next = resultValue(await f.session.renewOnce(before.verificationRef, signal())); next.begin();
    while (delivered.length < 2 && Date.now() < deadline) await new Promise<void>(r => setTimeout(r, 5));
    assert.equal(delivered.length, 2); const answer = next.submitCode(delivered[1]!);
    f.setPermitted(false); release();
    assert.deepEqual(await answer, { verified: false }); assert.equal(await next.verified(), undefined);
  } finally { release(); next?.dispose(); await f.close(); }
});

for (const kind of ["abort", "close"] as const) test(`E2E-418 ${kind} during a held renewal ownership read discards late success without restoring old access`, async () => {
  const f = await callerVerificationFixture(); let hold = false, entered = false, release = () => {};
  const gate = new Promise<void>(r => { release = r; });
  const owner = resultValue(CallerVerificationSession.create({ ...f.sessionConfig, ledger: {
    readWriteStop: f.ledger.readWriteStop.bind(f.ledger),
    read: async (...args: Parameters<typeof f.ledger.read>) => { if (hold) { entered = true; await gate; } return f.ledger.read(...args); },
  } }));
  try {
    const before = await issue(f, owner), proof = owner.proof, controller = new AbortController(); hold = true;
    const renewed = owner.renewOnce(before.verificationRef, controller.signal);
    const deadline = Date.now() + 5000;
    while (!entered && Date.now() < deadline) await new Promise<void>(r => setTimeout(r, 5));
    assert.equal(entered, true);
    assert.equal((await proof.verifyPatient(f.scope, before.verificationRef, verificationNow)).ok, false);
    if (kind === "abort") controller.abort(); else { owner.dispose(); release(); }
    assert.equal((await renewed).ok, false); release(); await new Promise<void>(r => setImmediate(r));
    owner.begin(); assert.equal(f.mail.length, 1); assert.equal(await owner.verified(), undefined);
    assert.equal((await owner.renewOnce(before.verificationRef, signal())).ok, false);
  } finally { release(); owner.dispose(); await f.close(); }
});

test("E2E-418 disposal after subject verification cannot publish a late successful code or a renewable subject", async () => {
  const f = await callerVerificationFixture();
  try {
    const verify = f.session.verifiedSubject.bind(f.session);
    f.session.verifiedSubject = async (...args) => {
      const subject = await verify(...args);
      queueMicrotask(() => f.session.dispose());
      return subject;
    };
    f.session.begin(); const deadline = Date.now() + 5000;
    while (!f.mail.length && Date.now() < deadline) await new Promise<void>(r => setTimeout(r, 5));
    assert.equal(f.mail.length, 1);
    assert.deepEqual(await f.session.submitCode(f.mail[0]!.code), { verified: false });
    assert.equal(await f.session.verified(), undefined);
    assert.equal((await f.session.renewOnce("retired", signal())).ok, false);
  } finally { await f.close(); }
});
