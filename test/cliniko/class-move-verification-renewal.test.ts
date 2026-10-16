import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ClinikoClassAttendanceMove } from "../../src/standalone/cliniko-class-attendance-move.ts";
import { CallerVerificationSession } from "../../src/standalone/caller-verification-session.ts";
import { callerVerificationFixture } from "../support/caller-verification.ts";
import { classPassMoveFixture } from "../support/class-pass-move.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

for (const withdrawn of [false, true]) test(`E2E-418 real admitted verifier handoff ${withdrawn ? "denies a revoked permission before original cancellation" : "completes a staged native pass move after original verification expiry"}`, async () => {
  const f = await classPassMoveFixture({ history: 999, rosterHistory: 201, differentCase: true, differentService: true });
  const v = await callerVerificationFixture({ scope: f.scope, patientId: "42", now: f.config.clock(), operation: "appointments.reschedule", apiKey: f.config.cliniko.apiKey, rateBudget: f.config.cliniko.rateBudget });
  const owners: CallerVerificationSession[] = [v.session]; let owner = v.session, at = Date.parse(f.config.clock());
  const clock = () => new Date(at).toISOString();
  const advanceTime = async (seconds: number) => {
    for (let left = seconds; left > 0; left -= 20) {
      at += Math.min(left, 20) * 1000; f.setTime(clock()); v.setTime(clock());
      const state = await v.state(); resultValue(await v.runtime.renewSession(v.callId, v.sessionId, state.sessionLease!.version, clock()));
    }
  };
  const issue = async () => {
    const count = v.mail.length; owner.begin();
    const deadline = Date.now() + 5000;
    while (v.mail.length === count && Date.now() < deadline) await new Promise<void>(r => setTimeout(r, 5));
    assert.equal(v.mail.length, count + 1); assert.deepEqual(await owner.submitCode(v.mail[count]!.code), { verified: true });
    const grant = await owner.verified(); assert.ok(grant); return grant;
  };
  try {
    f.setTime(clock()); const first = await issue();
    const request = { ...f.request, verificationRef: first.verificationRef, expiresAt: new Date(at + 120000).toISOString() };
    const version = "admitted-renewal-v1";
    const mover = resultValue(ClinikoClassAttendanceMove.create({ ...f.config, clock,
      proofNativeRequestFloor: 1, quotaStaging: { version },
      proof: { verifyPatient: (scope, ref, now, signal) => owner.proof.verifyOperation(scope, ref, "appointments.reschedule", now, signal) } }));
    const stages = resultValue(mover.prepareStagesOnce(request));
    const step = (ref: string, expiresAt = new Date(at + 110000).toISOString()) => stages.advanceOnce({
      contractVersion: version, verificationRef: ref, confirmationRef: randomUUID(), expiresAt,
    }, f.lifetime.signal, f.permit);
    await advanceTime(61);
    const replacement = resultValue(await step(first.verificationRef, request.expiresAt));
    assert.equal(replacement.kind, "staged"); assert.equal(f.writes.length, 1); assert.equal(f.original.cancelled_at, null);
    // Keep the actual SAM lease live while independently allowing the original
    // email attestation and proof to expire. No proof timestamps are edited.
    await advanceTime(301);
    assert.ok(at > Date.parse(first.expiresAt));
    const previousProof = owner.proof;
    owner = resultValue(await owner.renewOnce(first.verificationRef, f.lifetime.signal)); owners.push(owner);
    assert.equal((await previousProof.verifyOperation(f.scope, first.verificationRef, "appointments.reschedule", clock())).ok, false);
    assert.equal(await owner.verified(), undefined); assert.equal(f.writes.length, 1);
    const fresh = await issue(); assert.notEqual(fresh.verificationRef, first.verificationRef);
    if (withdrawn) v.setPermitted(false);
    assert.equal(resultValue(await step(fresh.verificationRef)).kind, "waiting", "verification reads use the same physical account quota");
    assert.equal(f.writes.length, 1); await advanceTime(61);
    const original = resultValue(await step(fresh.verificationRef));
    if (withdrawn) {
      assert.equal(original.kind, "finished"); if (original.kind === "finished") assert.equal(original.observation.kind, "needsReview");
      assert.equal(f.writes.length, 1); assert.equal(f.original.cancelled_at, null);
      assert.equal(f.recalls.length, 1); return;
    }
    assert.equal(original.kind, "staged"); assert.equal(f.writes.length, 2); assert.notEqual(f.original.cancelled_at, null);
    await advanceTime(61);
    const association = resultValue(await step(fresh.verificationRef));
    assert.equal(association.kind, "finished"); if (association.kind === "finished") assert.equal(association.observation.kind, "moved");
    assert.deepEqual(f.writes.map(w => w.leg), ["replacement", "original", "association"]);
    assert.equal(v.mail.length, 2); assert.equal(f.recalls.length, 1);
    const notes = String(f.recalls[0]!.notes);
    for (const secret of [first.verificationRef, fresh.verificationRef, ...v.mail.map(m => m.code)]) assert.equal(notes.includes(secret), false);
    const state = JSON.stringify(await v.state());
    for (const secret of [first.verificationRef, fresh.verificationRef, ...v.mail.map(m => m.code)]) assert.equal(state.includes(secret), false);
  } finally { f.lifetime.abort(); owners.forEach(s => s.dispose()); await v.close(); }
});
