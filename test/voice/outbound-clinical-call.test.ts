// E2E-420: original-patient signed outgoing clinical rescheduling; synthetic remote grants/speech, no live acceptance.
import assert from "node:assert/strict";
import test from "node:test";
import { outboundClinicalVoiceFixture } from "../support/outbound-clinical-voice.ts";
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";

async function verified(f: Awaited<ReturnType<typeof outboundClinicalVoiceFixture>>) {
  await f.open();
  assert.deepEqual(f.spoken, ["Hello, this is Abby calling on behalf of the clinic."]);
  assert.equal(f.mail.length, 0); assert.equal(f.patches, 0);
  await f.mark(); await f.say("I would like to move my appointment", { kind: "workflow", operation: "reschedule" });
  const code = await f.waitForMail();
  assert.equal(f.mail.at(-1)!.email, verificationCanaries[0]); assert.equal(f.flow.verificationRequired, true);
  await f.mark(); await f.privateCode(code);
  return code;
}
async function proposed(f: Awaited<ReturnType<typeof outboundClinicalVoiceFixture>>) {
  const code = await verified(f);
  await f.say("Which appointment can I move", { kind: "reschedulingMenu", stage: "targets", from: verificationNow, to: "2026-10-09T06:00:00.000Z" });
  await f.mark(); await f.say("The first appointment", { kind: "reschedulingChoice", stage: "targets", choice: 1 });
  await f.mark(); await f.say("What times are available on Thursday", { kind: "reschedulingMenu", stage: "offers", from: "2026-10-08", to: "2026-10-08" });
  await f.mark(); await f.say("The first time", { kind: "reschedulingChoice", stage: "offers", choice: 1 });
  return code;
}

test("signed outgoing clinical speech uses real private keypad and played exact-target review before one native move", { timeout: 30_000 }, async t => {
  const f = await outboundClinicalVoiceFixture(); t.after(f.close);
  const code = await proposed(f);
  assert.equal(f.patches, 0);
  const before = await f.current(), action = Object.values(before.actions)[0]!;
  assert.equal(action.kind, "reschedule"); assert.equal(action.status, "awaitingConfirmation");
  assert.equal(before.presentations[action.presentationId]?.status, "started");
  await f.mark(); await f.say("Yes", { kind: "affirm" });
  assert.equal(f.patches, 1); const after = await f.current(); assert.equal(Object.values(after.actions)[0]!.status, "committed");
  assert.equal(f.transport.state.created, 1); assert.equal(f.transport.state.burned.size, 1);
  assert.equal(after.admission?.direction, "outbound"); assert.equal("dialedNumber" in after.admission!, false);
  assert.ok(f.nativeCalls.some(call => call.path === "/v1/individual_appointments/91" && call.method === "PATCH"));
  assert.equal(f.nativeCalls.some(call => call.path === "/v1/individual_appointments/92" && call.method === "PATCH"), false);
  for (const secret of [code, f.recipientNumber, verificationCanaries[0]!, verificationCanaries[2]!])
    assert.equal(JSON.stringify([f.spoken, f.transcripts, f.modelTurns, f.sent]).includes(secret), false);
});

for (const changed of ["target", "request", "contact", "approval"] as const)
test(`signed outgoing played readback loses ${changed} authority before actual native write`, { timeout: 30_000 }, async t => {
  const f = await outboundClinicalVoiceFixture(); t.after(f.close); await proposed(f); await f.mark();
  if (changed === "target") f.changeTarget(); else if (changed === "request") f.changeRequest();
  else if (changed === "contact") f.changeContact(); else f.state.originalLive = false;
  await f.say("Yes", { kind: "affirm" });
  assert.equal(f.patches, 0); assert.equal(f.nativeCalls.some(call => call.method === "PATCH"), false);
  assert.notEqual(Object.values((await f.current()).actions)[0]!.status, "committed");
});

for (const kind of ["multiple", "different"] as const)
test(`signed outgoing ${kind} household clue cannot deliver a code or disclose clinical purpose`, { timeout: 15_000 }, async t => {
  const f = await outboundClinicalVoiceFixture(); t.after(f.close);
  f.setCandidates(kind === "multiple" ? { kind: "multiple", candidateIds: [verificationCanaries[2]!, "99"] } : { kind: "one", candidateIds: ["99"] });
  await f.open(); await f.mark();
  await f.say("I would like to move my appointment", { kind: "workflow", operation: "reschedule" }); await f.mark();
  await f.rejectPrivateCode("000000");
  assert.equal(f.mail.length, 0); assert.equal(f.patches, 0);
  assert.equal(f.spoken.some(text => /Thursday|October|sick.day|physio|482746192837465/i.test(text)), false);
  assert.equal(f.transcripts.some(text => text.includes("000000")), false);
  assert.equal(f.modelTurns.some(text => text.includes("000000")), false);
});
