// E2E-423: bounded contact-only terminal public-ASR drain; complete no-stop and real acoustic acceptance remain open.
import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { twilioOutboundStopSpeechFixture } from "../support/twilio-outbound-stop-speech.ts";
import { value } from "../support/outbound-records.ts";

for (const end of ["wireStop", "socketClose"] as const)
test(`actual signed ${end} drains the unendpointed positive stop into its original native DNC purpose`, { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopSpeechFixture(); t.after(f.close);
  const server = await f.listen(); t.after(server.close); const wire = await f.start(server);
  await wire.sendTail(); assert.equal(f.transcriptionStats.flushes, 0); assert.deepEqual(f.intents, []);
  assert.equal(f.reportPosts.length, 0); assert.equal(f.dncPosts.length, 0);
  const closed = once(wire.socket, "close"); if (end === "wireStop") wire.stopTail(); else wire.socket.close();
  await closed; await f.finished;
  assert.equal(f.transcriptionStats.flushes, 1); assert.equal(f.transcriptionStats.closes, 1);
  assert.equal(f.reportPosts.length, 1); assert.equal(f.dncPosts.length, 1); assert.deepEqual(f.intents, []);
  assert.deepEqual(f.acceptedTranscripts, [], "terminal ASR finals never return to the clinical session");
  assert.equal(f.spoken.length, 1); assert.equal(f.carrierCalls, 1);
  assert.equal(f.contactHeld.size, 1); assert.equal(f.held.size, 1); assert.equal(f.contactReleased.size, 0); assert.equal(f.released.size, 0);
  assert.equal(value(await f.recover()).outcome.kind, "existingDecision"); assert.equal(f.dncPosts.length, 1);
});

test("terminal ASR and held native retention use independent purposes while clinical work remains revoked", { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopSpeechFixture(); t.after(f.close);
  let entered!: () => void, release!: () => void;
  const begun = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  f.stateSpeech.beforeReport = async () => { entered(); await held; };
  const server = await f.listen(); t.after(server.close); const wire = await f.start(server); await wire.sendTail();
  const closed = once(wire.socket, "close"); wire.stopTail(); await Promise.all([closed, begun]);
  assert.deepEqual(f.intents, []); assert.deepEqual(f.acceptedTranscripts, []); assert.equal(f.spoken.length, 1);
  let finished = false; void f.finished.then(() => { finished = true; }); await Promise.resolve(); assert.equal(finished, false);
  assert.equal(f.reportPosts.length, 1); assert.equal(f.dncPosts.length, 0); release(); await f.finished;
  assert.equal(f.dncPosts.length, 1); assert.equal(f.contactHeld.size, 1); assert.equal(f.held.size, 1);
});

for (const denied of ["report", "decision", "producer", "conversation"] as const)
test(`terminal positive tail retains independent ${denied} revocation instead of gaining clinical or release authority`, { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopSpeechFixture(); t.after(f.close);
  const server = await f.listen(); t.after(server.close); const wire = await f.start(server); await wire.sendTail();
  if (denied === "conversation") f.stateSpeech.conversation = false; else f.stateSpeech[denied] = false;
  const closed = once(wire.socket, "close"); wire.socket.close(); await closed; await f.finished;
  assert.equal(f.reportPosts.length, ["report", "producer", "conversation"].includes(denied) ? 0 : 1);
  assert.equal(f.dncPosts.length, 0);
  assert.deepEqual(f.intents, []); assert.deepEqual(f.acceptedTranscripts, []); assert.equal(f.spoken.length, 1);
  assert.equal(f.contactHeld.size, 1); assert.equal(f.held.size, 1);
});

for (const variant of ["uncertain", "nonPositive"] as const)
test(`terminal ${variant} observation produces neither a positive report nor a negative completion assertion`, { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopSpeechFixture(variant === "uncertain" ? { quality: "needsClarification" } : { text: "Do not stop calling me" }); t.after(f.close);
  const server = await f.listen(); t.after(server.close); const wire = await f.start(server); await wire.sendTail();
  const closed = once(wire.socket, "close"); wire.socket.close(); await closed; await f.finished;
  assert.equal(f.transcriptionStats.flushes, 1); assert.equal(f.reportPosts.length, 0); assert.equal(f.dncPosts.length, 0);
  assert.deepEqual(f.intents, []); assert.equal(f.contactHeld.size, 1); assert.equal(f.held.size, 1);
});

for (const late of [false, true])
test(`actual held terminal ASR ${late ? "deadline refuses a late final" : "rechecks conversation approval after decoding"}`, { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopSpeechFixture(); t.after(f.close);
  let entered!: () => void, release!: () => void, actualSignal!: AbortSignal;
  const begun = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  f.stateSpeech.beforeFlush = async signal => { actualSignal = signal; entered(); await held; };
  const server = await f.listen(); t.after(server.close); const wire = await f.start(server); await wire.sendTail();
  const closed = once(wire.socket, "close"); wire.socket.close(); await Promise.all([closed, begun]);
  if (late) { await f.finished; assert.equal(actualSignal.aborted, true); release(); await new Promise<void>(resolve => setImmediate(resolve)); }
  else { f.stateSpeech.conversation = false; release(); await f.finished; }
  assert.equal(f.transcriptionStats.flushes, 1); assert.equal(f.reportPosts.length, 0); assert.equal(f.dncPosts.length, 0);
  assert.deepEqual(f.intents, []); assert.deepEqual(f.acceptedTranscripts, []); assert.equal(f.contactHeld.size, 1); assert.equal(f.held.size, 1);
});

for (const end of ["wireStop", "socketClose"] as const)
test(`signed queued public media before immediate ${end} reaches contact-only ASR with no clinical dispatch`, { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopSpeechFixture(); t.after(f.close);
  const server = await f.listen(); t.after(server.close); const wire = await f.start(server);
  const closed = once(wire.socket, "close"); wire.sendQueuedTail(end); await closed; await f.finished;
  assert.equal(f.transcriptionStats.accepted, 2); assert.equal(f.transcriptionStats.flushes, 1);
  assert.equal(f.reportPosts.length, 1); assert.equal(f.dncPosts.length, 1);
  assert.deepEqual(f.intents, []); assert.deepEqual(f.acceptedTranscripts, []); assert.equal(f.spoken.length, 1);
  assert.equal(f.contactHeld.size, 1); assert.equal(f.held.size, 1);
});
