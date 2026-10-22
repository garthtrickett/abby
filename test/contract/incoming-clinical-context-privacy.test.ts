// E2E-424: independently verified native callback context and exact original ownership.
import assert from "node:assert/strict";
import test from "node:test";
import { incomingClinicalCallFlowFixture } from "../support/incoming-clinical-call-flow.ts";
import { value } from "../support/outbound-records.ts";

const unknown = "I don't know why the clinic called you. I can't verify an outbound-call reason from this call. Please contact the clinic directly.";

for (const reason of ["unverified", "shared-phone", "wrong-patient", "stale"] as const) {
  test(`the actual incoming ${reason} call cannot disclose the campaign or select its appointment`, async t => {
    const f = await incomingClinicalCallFlowFixture({ rescheduling: true,
      ...(reason === "wrong-patient" ? { patientId: "22" } : {}), ...(reason === "stale" ? { lookBackMs: 60_000 } : {}) });
    t.after(f.close);
    if (reason === "shared-phone") {
      f.setCandidates({ kind: "multiple", candidateIds: [f.attempt.patientId, "22"] });
      const before = await f.callState();
      const started = value(await f.reception.startWorkflow(f.scope, f.turn("Read my appointments"), "appointments.read", f.now, before.conversationRevision));
      assert.equal(started.lastWorkflowStart?.next, "codeRequired"); await f.play();
      f.flow.beginVerification(); assert.deepEqual(await f.flow.submitCode("123456"), { verified: false }); assert.equal(f.mail.length, 0);
    } else if (reason !== "unverified") await f.verify();
    const answer = value(await f.reception.respondMissedCall(f.scope, f.turn("Why did the clinic call me?")));
    assert.equal(answer.callerMessages.at(-1), unknown);
    const state = await f.callState(); assert.equal(Object.keys(state.actions).length, 0); assert.equal(f.reviews.length, 0);
    assert.deepEqual(f.writes, []); assert.deepEqual(f.moves, []);
    assert.equal(f.traffic.some(q => q.path.startsWith("/v1/individual_appointments/")), false);
    if (reason === "unverified" || reason === "shared-phone") assert.equal(f.traffic.some(q => q.path === "/v1/recalls"), false);
    for (const privateValue of [f.attempt.actionRef, f.attempt.effectRef, f.observation.callSid, "unrelated-private-history-note"])
      assert.equal(answer.callerMessages.some(message => message.includes(privateValue)), false);
  });
}
