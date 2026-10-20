// E2E-419: actual private verifier succession for one live movement; serving remains unfinished.
import assert from "node:assert/strict";
import test from "node:test";
import { ClassMovementVerifier } from "../../src/standalone/class-movement-verifier.ts";
import { verificationPrompt } from "../../src/standalone/caller-verification-session.ts";
import { callerVerificationFixture, verificationCanaries } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

type Fixture = Awaited<ReturnType<typeof callerVerificationFixture>>;
const signal = () => new AbortController().signal;
async function checkpoint(ready: () => boolean) {
  const until = Date.now() + 5000;
  while (!ready() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(ready(), "private challenge checkpoint must be reached");
}
async function issue(f: Fixture, codes?: string[]) {
  f.session.begin();
  await checkpoint(() => (codes?.length ?? f.mail.length) === 1);
  assert.deepEqual(await f.session.submitCode(codes?.[0] ?? f.mail[0]!.code), { verified: true });
  const subject = await f.session.verifiedSubject("appointments.reschedule"); assert.ok(subject);
  return subject;
}
async function forward(f: Fixture, seconds: number) {
  let at = Date.parse(f.sessionConfig.clock());
  for (let remaining = seconds; remaining > 0; remaining -= 20) {
    at += Math.min(remaining, 20) * 1000;
    const now = new Date(at).toISOString(); f.setTime(now);
    const state = await f.state();
    resultValue(await f.runtime.renewSession(f.callId, f.sessionId, state.sessionLease!.version, now));
  }
}

test("live movement proof is reused without another code or an extended expiry", async () => {
  const f = await callerVerificationFixture({ operation: "appointments.reschedule" }), lifetime = new AbortController();
  try {
    const initial = await issue(f);
    const owner = resultValue(await ClassMovementVerifier.capture(f.session, f.sessionConfig.clock, lifetime.signal));
    const prepared = resultValue(await owner.prepare(signal()));
    assert.deepEqual(prepared, { kind: "ready", patient: initial });
    assert.deepEqual(resultValue(await owner.proof.verifyPatient(f.scope, initial.verificationRef, f.sessionConfig.clock())), initial);
    assert.equal(f.mail.length, 1);
    assert.equal(Object.keys((await f.state()).actions).length, 0, "proof preparation grants no phase or provider mutation");
    lifetime.abort(); assert.equal((await owner.prepare(signal())).ok, false);
  } finally { lifetime.abort(); await f.close(); }
});

test("unverified or foreign-operation owners cannot be captured or lose their existing authority", async () => {
  const f = await callerVerificationFixture(), lifetime = new AbortController();
  try {
    assert.equal((await ClassMovementVerifier.capture(f.session, f.sessionConfig.clock, lifetime.signal)).ok, false);
    assert.equal(f.mail.length, 0);
    f.session.begin(); await checkpoint(() => f.mail.length === 1);
    assert.deepEqual(await f.session.submitCode(f.mail[0]!.code), { verified: true });
    const before = await f.session.verified(); assert.ok(before);
    assert.equal((await ClassMovementVerifier.capture(f.session, f.sessionConfig.clock, lifetime.signal)).ok, false);
    assert.deepEqual(await f.session.verified(), before);
    assert.equal(f.mail.length, 1);
  } finally { lifetime.abort(); await f.close(); }
});

test("expired movement proof renews before a protected check can clear its source and never redirects an old proof object", async () => {
  const f = await callerVerificationFixture({ operation: "appointments.reschedule" }), lifetime = new AbortController();
  try {
    const initial = await issue(f), oldProof = f.session.proof;
    const owner = resultValue(await ClassMovementVerifier.capture(f.session, f.sessionConfig.clock, lifetime.signal));
    await forward(f, 301);
    assert.equal((await owner.proof.verifyPatient(f.scope, initial.verificationRef, f.sessionConfig.clock())).ok, false);
    assert.deepEqual(resultValue(await owner.prepare(signal())), { kind: "verificationRequired", prompt: verificationPrompt });
    await checkpoint(() => f.mail.length === 2);
    assert.equal(resultValue(await owner.prepare(signal())).kind, "verificationRequired");
    assert.equal(f.mail.length, 2, "repeated preparation cannot resend or reset the challenge");
    assert.deepEqual(await owner.submitCode(f.mail[0]!.code, signal()), { verified: false });
    assert.deepEqual(await owner.submitCode(f.mail[1]!.code, signal()), { verified: true });
    const ready = resultValue(await owner.prepare(signal())); assert.ok(ready.kind === "ready");
    assert.equal(ready.patient.patientRef, initial.patientRef);
    assert.notEqual(ready.patient.verificationRef, initial.verificationRef);
    assert.equal(initial.expiresAt, new Date(Date.parse(f.receipt.admission.acceptedAt) + 300000).toISOString());
    assert.ok(Date.parse(ready.patient.expiresAt) > Date.parse(initial.expiresAt));
    assert.equal((await oldProof.verifyOperation(f.scope, ready.patient.verificationRef, "appointments.reschedule", f.sessionConfig.clock())).ok, false);
    assert.equal((await owner.proof.verifyPatient(f.scope, initial.verificationRef, f.sessionConfig.clock())).ok, false);
    assert.equal((await owner.proof.verifyPatient({ ...f.scope, locationId: "foreign" }, ready.patient.verificationRef, f.sessionConfig.clock())).ok, false);
    assert.equal((await owner.proof.verifyPatient(f.scope, ready.patient.verificationRef, f.receipt.admission.acceptedAt)).ok, false);
    assert.equal((await owner.proof.verifyPatient(f.scope, ready.patient.verificationRef, f.sessionConfig.clock())).ok, true);
    const publicState = JSON.stringify([owner, await f.state()]);
    for (const secret of [...verificationCanaries, initial.verificationRef, ready.patient.verificationRef, ...f.mail.map(mail => mail.code)])
      assert.equal(publicState.includes(secret), false);
    assert.equal(Object.keys((await f.state()).actions).length, 0);
  } finally { lifetime.abort(); await f.close(); }
});

test("movement renewal keeps the original subject and cannot reset exhausted code answers", async () => {
  for (const kind of ["differentPatient", "exhausted"] as const) {
    const f = await callerVerificationFixture({ operation: "appointments.reschedule" }), lifetime = new AbortController();
    try {
      await issue(f);
      const owner = resultValue(await ClassMovementVerifier.capture(f.session, f.sessionConfig.clock, lifetime.signal));
      await forward(f, 301);
      if (kind === "differentPatient") { f.setCandidates({ kind: "one", candidateIds: ["43"] }); f.setNativePatientId("43"); }
      resultValue(await owner.prepare(signal()));
      if (kind === "exhausted") await checkpoint(() => f.mail.length === 2);
      for (let i = 0; i < 3; i++) assert.deepEqual(await owner.submitCode("not-a-code", signal()), { verified: false });
      resultValue(await owner.prepare(signal()));
      assert.deepEqual(await owner.submitCode(f.mail.at(-1)!.code, signal()), { verified: false });
      assert.equal(f.mail.length, kind === "differentPatient" ? 1 : 2);
    } finally { lifetime.abort(); await f.close(); }
  }
});

test("canceled private code entry retires a held successor and ignores late successful delivery", async () => {
  const codes: string[] = []; let held = false, release: () => void = () => undefined;
  const f = await callerVerificationFixture({ operation: "appointments.reschedule", delivery: { send: async (_address, code) => {
    codes.push(code);
    return held ? new Promise<boolean>(resolve => { release = () => resolve(true); }) : true;
  } } }), lifetime = new AbortController();
  try {
    const initial = await issue(f, codes);
    const owner = resultValue(await ClassMovementVerifier.capture(f.session, f.sessionConfig.clock, lifetime.signal));
    await forward(f, 301); held = true;
    resultValue(await owner.prepare(signal())); await checkpoint(() => codes.length === 2);
    const external = new AbortController(), answer = owner.submitCode(codes[1]!, external.signal);
    external.abort(); assert.deepEqual(await answer, { verified: false });
    release(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((await owner.prepare(signal())).ok, false);
    assert.equal((await owner.proof.verifyPatient(f.scope, initial.verificationRef, f.sessionConfig.clock())).ok, false);
    assert.equal(Object.keys((await f.state()).actions).length, 0);
  } finally { release(); lifetime.abort(); await f.close(); }
});
