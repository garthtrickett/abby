import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { twilioOutboundStopSpeechFixture } from "../support/twilio-outbound-stop-speech.ts";
import { value } from "../support/outbound-records.ts";
import { decodeTwilioOutboundReport } from "../../src/cliniko/twilio-outbound-report.ts";
import { decodeOutboundContactReview } from "../../src/cliniko/outbound-contact-review.ts";
import { clearOutboundStopPhrase } from "../../src/standalone/twilio-outbound-stop-speech.ts";

test("actual signed guarded outbound voice writes its own positive report and restrictive native DNC before any intent", { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopSpeechFixture(); t.after(f.close);
  const server = await f.listen(); t.after(server.close); const wire = await f.start(server);
  const closed = once(wire.socket, "close"); wire.sendTurn(); await closed;
  // Transport closes first; await the actual owned receive/disconnect tail,
  // rather than treating a socket close or attempted native POST as an ACK.
  await f.finished;
  assert.equal(f.reportPosts.length, 1); assert.equal(f.dncPosts.length, 1);
  const report = value(decodeTwilioOutboundReport(f.reportPosts[0]!.notes));
  assert.equal(report.actionRef.length, 36); assert.equal(report.contact.kind, "stopRequested"); assert.equal(report.terminal, null);
  assert.equal(report.patientId, f.request.patientId); assert.equal(report.callSid, f.callSid);
  const dnc = value(decodeOutboundContactReview(f.dncPosts[0]!.notes));
  assert.equal(dnc.actionRef, f.attempt.dncReferences!.actionRef); assert.equal(dnc.consent, "unknown"); assert.equal(dnc.doNotCall, "blocked");
  assert.deepEqual(f.intents, []); assert.equal(f.spoken.length, 1); assert.equal(f.carrierCalls, 1);
  assert.equal(f.held.size, 1); assert.equal(f.contactHeld.size, 1); assert.equal(f.released.size, 0); assert.equal(f.contactReleased.size, 0);
  const cold = value(await f.recover()); assert.equal(cold.evidence, "stop"); assert.equal(cold.outcome.kind, "existingDecision");
  assert.equal(f.reportPosts.length, 1); assert.equal(f.dncPosts.length, 1);
});

test("whole-turn positive grammar refuses negation, quotes, reported words and unsupported language", () => {
  for (const text of ["Stop calling", "Please stop calling me.", "Don’t call me again!", "Please, remove my number from your calling list."])
    assert.equal(clearOutboundStopPhrase(text), true, text);
  for (const text of ["don't stop calling me", 'he said "stop calling me"', '"stop calling me"', "stop calling me about that appointment only",
    "no more calls? Actually keep calling", "please stop", "deja de llamarme", "x".repeat(513)]) assert.equal(clearOutboundStopPhrase(text), false, text);
});

test("positive stop fences transport and intent before a held native write, then drains independent retention after voice abort", { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopSpeechFixture(); t.after(f.close);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), writing = new Promise<void>(resolve => { entered = resolve; });
  t.after(() => release()); f.stateSpeech.beforeReport = async () => { entered(); await held; };
  const server = await f.listen(); t.after(server.close); const wire = await f.start(server);
  const closed = once(wire.socket, "close"); wire.sendTurn(); await Promise.all([closed, writing]);
  assert.deepEqual(f.intents, []); assert.equal(f.spoken.length, 1); assert.equal(f.dncPosts.length, 0);
  assert.equal(f.reportPosts.length, 1); assert.equal(f.contactControls.rows.some(row => String(row.id) === "250"), false);
  let complete = false; void f.finished.then(() => { complete = true; }); await Promise.resolve(); assert.equal(complete, false);
  release(); await f.finished; assert.equal(f.dncPosts.length, 1); assert.equal(f.contactHeld.size, 1); assert.equal(f.held.size, 1);
});

for (const denial of ["report", "history", "decision", "producer"] as const)
test(`actual speech stop with ${denial} permission unavailable closes without inventing a durable decision`, { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopSpeechFixture(); t.after(f.close);
  const server = await f.listen(); t.after(server.close); const wire = await f.start(server);
  f.stateSpeech[denial] = false;
  const closed = once(wire.socket, "close"); wire.sendTurn(); await closed; await f.finished;
  assert.deepEqual(f.intents, []); assert.equal(f.spoken.length, 1); assert.equal(f.dncPosts.length, 0);
  assert.equal(f.reportPosts.length, denial === "history" || denial === "decision" ? 1 : 0);
  assert.equal(f.contactHeld.size, 1); assert.equal(f.held.size, 1); assert.equal(f.contactReleased.size, 0); assert.equal(f.released.size, 0);
});

for (const response of ["lostStored", "lostUnstored"] as const)
test(`actual speech report ${response} is resolved from native history without another report POST`, { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopSpeechFixture({ reportResponse: response }); t.after(f.close);
  const server = await f.listen(); t.after(server.close); const wire = await f.start(server);
  const closed = once(wire.socket, "close"); wire.sendTurn(); await closed; await f.finished;
  assert.equal(f.reportPosts.length, 1); assert.equal(f.dncPosts.length, response === "lostStored" ? 1 : 0);
  const cold = value(await f.recover()); assert.equal(cold.evidence, response === "lostStored" ? "stop" : "missing");
  assert.equal(cold.outcome.kind, response === "lostStored" ? "existingDecision" : "unresolved");
  assert.equal(f.reportPosts.length, 1); assert.equal(f.dncPosts.length, response === "lostStored" ? 1 : 0);
  assert.equal(f.contactHeld.size, 1); assert.equal(f.held.size, 1);
});

for (const response of ["lostStored", "lostUnstored"] as const)
test(`actual speech DNC ${response} cold recovery never replays the one-use restrictive write`, { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopSpeechFixture({ decisionResponse: response }); t.after(f.close);
  const server = await f.listen(); t.after(server.close); const wire = await f.start(server);
  const closed = once(wire.socket, "close"); wire.sendTurn(); await closed; await f.finished;
  assert.equal(f.reportPosts.length, 1); assert.equal(f.dncPosts.length, 1);
  const cold = await f.recover();
  if (response === "lostStored") assert.equal(value(cold).outcome.kind, "existingDecision"); else assert.equal(cold.ok, false);
  assert.equal(f.reportPosts.length, 1); assert.equal(f.dncPosts.length, 1); assert.deepEqual(f.intents, []);
  assert.equal(f.contactHeld.size, 1); assert.equal(f.held.size, 1);
});

test("approved conversation without the selected producer binding opens no speech or session", { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopSpeechFixture({ omitProfileBinding: true }); t.after(f.close);
  const server = await f.listen(); t.after(server.close);
  const response = await server.post(); assert.equal(response.status, 200);
  const wire = await server.open(await response.text()); assert.equal(await wire.outcome, "closed");
  assert.equal(f.admitted, undefined); assert.deepEqual(f.spoken, []); assert.deepEqual(f.intents, []);
  assert.equal(f.reportPosts.length, 0); assert.equal(f.dncPosts.length, 0);
});

for (const [text, quality] of [["don't stop calling me", "clear"], ["Could you help me", "needsClarification"]] as const)
test(`actual ${quality} non-positive turn produces no stop or no-stop record`, { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopSpeechFixture({ text, quality }); t.after(f.close);
  const server = await f.listen(); t.after(server.close); const wire = await f.start(server);
  const reply = new Promise<void>(resolve => { wire.socket.on("message", raw => {
    if ((JSON.parse(raw.toString()) as { event: string }).event === "mark") resolve();
  }); });
  wire.sendTurn(); await reply;
  assert.equal(f.reportPosts.length, 0); assert.equal(f.dncPosts.length, 0);
  assert.deepEqual(f.intents, quality === "clear" ? [text] : []); assert.equal(f.contactHeld.size, 1); assert.equal(f.held.size, 1);
  const closed = once(wire.socket, "close"); wire.socket.close(); await closed; await f.finished;
});

test("actual uncertain whole stop phrase closes without another utterance or fabricated native stop", { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopSpeechFixture({ text: "Stop calling me", quality: "needsClarification" }); t.after(f.close);
  const server = await f.listen(); t.after(server.close); const wire = await f.start(server);
  const outcome = new Promise<"closed" | "ordinaryReply"> (resolve => {
    wire.socket.once("close", () => resolve("closed"));
    wire.socket.on("message", raw => { if ((JSON.parse(raw.toString()) as { event: string }).event === "mark") resolve("ordinaryReply"); });
  });
  wire.sendTurn(); assert.equal(await outcome, "closed"); await f.finished;
  assert.equal(f.spoken.length, 1); assert.deepEqual(f.intents, []); assert.equal(f.reportPosts.length, 0); assert.equal(f.dncPosts.length, 0);
  assert.equal(f.contactHeld.size, 1); assert.equal(f.held.size, 1); assert.equal(f.contactReleased.size, 0); assert.equal(f.released.size, 0);
});
