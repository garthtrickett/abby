// E2E-422: exact original-target signed outgoing cancellation; remote native/speech/grants are synthetic.
import assert from "node:assert/strict";
import test from "node:test";
import { outboundClinicalVoiceFixture } from "../support/outbound-clinical-voice.ts";
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";

async function proposed(f: Awaited<ReturnType<typeof outboundClinicalVoiceFixture>>) {
  await f.open(); assert.deepEqual(f.spoken, ["Hello, this is Abby calling on behalf of the clinic."]);
  assert.equal(f.mail.length, 0); assert.equal(f.cancellations, 0); await f.mark();
  await f.say("I would like to cancel my appointment", { kind: "workflow", operation: "cancel" });
  const code = await f.waitForMail(); assert.equal(f.mail.at(-1)!.email, verificationCanaries[0]);
  await f.mark(); await f.privateCode(code);
  const proof = await f.flow.cancellationProof(); assert.ok(proof);
  await f.say("Which appointment can I cancel", { kind: "appointments", verificationRef: proof.verificationRef,
    from: verificationNow, to: "2026-10-09T06:00:00.000Z" });
  assert.doesNotMatch(f.spoken.at(-1)!, /Option two/); await f.mark();
  await f.say("Cancel that appointment", { kind: "cancel", verificationRef: proof.verificationRef, targetRef: "selected" });
  const state = await f.current(), action = Object.values(state.actions)[0]!;
  assert.equal(action.kind, "cancel"); assert.equal(action.status, "awaitingConfirmation");
  assert.equal(state.presentations[action.presentationId]?.status, "started");
  assert.equal(f.cancellations, 0); return code;
}

test("signed outgoing cancellation uses actual private keypad and a separately played exact clinical readback before one native cancellation", { timeout: 30000 }, async t => {
  const f = await outboundClinicalVoiceFixture({ sickDayAction: "cancel" }); t.after(f.close);
  const code = await proposed(f); await f.mark(); await f.say("Yes", { kind: "affirm" });
  assert.equal(f.cancellations, 1); assert.equal(f.patches, 0); assert.equal(f.bookings, 0);
  assert.equal(Object.values((await f.current()).actions)[0]!.status, "committed");
  assert.equal((await f.current()).admission?.direction, "outbound");
  assert.deepEqual(f.nativeCalls.filter(c => c.method === "PATCH"), [{ method: "PATCH", path: "/v1/individual_appointments/91/cancel" }]);
  for (const secret of [code, f.recipientNumber, verificationCanaries[0]!, verificationCanaries[2]!])
    assert.equal(JSON.stringify([f.spoken, f.transcripts, f.modelTurns, f.sent]).includes(secret), false);
});

for (const changed of ["target", "request", "contact", "approval"] as const)
test(`signed outgoing cancellation loses ${changed} authority after played exact readback`, { timeout: 30000 }, async t => {
  const f = await outboundClinicalVoiceFixture({ sickDayAction: "cancel" }); t.after(f.close); await proposed(f); await f.mark();
  if (changed === "target") f.changeTarget(); else if (changed === "request") f.changeRequest();
  else if (changed === "contact") f.changeContact(); else f.state.originalLive = false;
  await f.say("Yes", { kind: "affirm" }); assert.equal(f.cancellations, 0);
  assert.equal(f.nativeCalls.some(c => c.method === "PATCH"), false);
  assert.notEqual(Object.values((await f.current()).actions)[0]!.status, "committed");
});

test("signed outgoing cancellation response loss remains uncertain and cannot replay a second mutation", { timeout: 30000 }, async t => {
  const f = await outboundClinicalVoiceFixture({ sickDayAction: "cancel", lostCancellationResponse: true }); t.after(f.close);
  await proposed(f); await f.mark(); await f.say("Yes", { kind: "affirm" });
  assert.equal(f.cancellations, 1); assert.equal(Object.values((await f.current()).actions)[0]!.status, "uncertain");
  await f.mark(); await f.say("Did it finish", { kind: "outcome" }); assert.equal(f.cancellations, 1);
  assert.notEqual(Object.values((await f.current()).actions)[0]!.status, "committed");
});

for (const kind of ["multiple", "different"] as const)
test(`signed outgoing cancellation ${kind} household clue delivers no code or appointment disclosure`, { timeout: 15000 }, async t => {
  const f = await outboundClinicalVoiceFixture({ sickDayAction: "cancel" }); t.after(f.close);
  f.setCandidates(kind === "multiple" ? { kind: "multiple", candidateIds: [verificationCanaries[2]!, "99"] } : { kind: "one", candidateIds: ["99"] });
  await f.open(); await f.mark(); await f.say("Cancel my appointment", { kind: "workflow", operation: "cancel" }); await f.mark();
  await f.rejectPrivateCode("000000"); assert.equal(f.mail.length, 0); assert.equal(f.cancellations, 0);
  assert.equal(f.spoken.some(text => /Thursday|October|sick.day|physio|482746192837465/i.test(text)), false);
  assert.equal(f.transcripts.some(text => text.includes("000000")), false);
});
