import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { twilioOutboundStopReceiverFixture } from "../support/twilio-outbound-stop-receiver.ts";
import { twilioOutboundStopReceiver } from "../../src/standalone/twilio-outbound-stop-receiver.ts";
import { TwilioAbbyOutboundRuntime } from "../../src/voice/twilio-outbound-runtime.ts";
import { value } from "../support/outbound-records.ts";

test("actual signed HTTP terminal delivery retains the native DNC before acknowledging and remains duplicate safe", { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopReceiverFixture(); t.after(f.closeReceiver); const server = await f.listen();
  assert.equal((await server.post()).status, 204); assert.equal(f.dncPosts.length, 1); assert.deepEqual(f.receiverState.progress, ["completed"]);
  assert.equal((await server.post()).status, 204); assert.equal(f.dncPosts.length, 1); assert.equal(f.released.size, 0);
  assert.deepEqual(f.receiverState.argumentCounts, [2, 2]);
  assert.equal(f.calls.length, 1); assert.equal(f.held.size, 1);
});
test("a final callback before native report production stays retryable and a later delivery recovers it", { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopReceiverFixture(); t.after(f.closeReceiver); const server = await f.listen();
  f.contactControls.rows.splice(f.contactControls.rows.indexOf(f.reportRow), 1);
  const response = await server.post(); assert.equal(response.status, 503); assert.equal(await response.text(), "");
  assert.equal(f.dncPosts.length, 0); assert.equal(f.receiverState.progress.length, 0);
  f.contactControls.rows.push(f.reportRow);
  assert.equal((await server.post()).status, 204); assert.equal(f.dncPosts.length, 1); assert.equal(f.released.size, 0);
});
test("lost native ACK returns retryable HTTP and the next signed delivery discovers the original decision", { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopReceiverFixture(); t.after(f.closeReceiver); const server = await f.listen();
  f.stopState.response = () => { throw Error("Synthetic native ACK lost"); };
  assert.equal((await server.post()).status, 503); assert.equal(f.dncPosts.length, 1);
  assert.equal((await server.post()).status, 204); assert.equal(f.dncPosts.length, 1);
});
test("an uncertain unobserved write is never retried by another signed delivery", { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopReceiverFixture(); t.after(f.closeReceiver); const server = await f.listen();
  f.stopState.beforeStore = () => { throw Error("Synthetic native write never observed"); };
  assert.equal((await server.post()).status, 503); assert.equal((await server.post()).status, 503);
  assert.equal(f.dncPosts.length, 1); assert.equal(f.receiverState.progress.length, 0);
});
test("authenticated native no-stop data acknowledges delivery without a DNC decision or hold release", { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopReceiverFixture(); t.after(f.closeReceiver); const server = await f.listen();
  f.replaceReport({ terminal: { endedAt: f.state.now, observedAt: f.state.now }, contact: { kind: "completeNoStop" } });
  assert.equal((await server.post()).status, 204); assert.equal(f.dncPosts.length, 0); assert.equal(f.released.size, 0);
});
for (const status of ["initiated", "ringing", "in-progress"])
test(`nonterminal ${status} remains progress only without native recovery reads`, { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopReceiverFixture(); t.after(f.closeReceiver); const server = await f.listen();
  assert.equal((await server.post({ CallStatus: status })).status, 204); assert.equal(f.reportQueries.length, 0);
  assert.equal(f.dncPosts.length, 0); assert.deepEqual(f.receiverState.progress, [status]);
});
for (const denial of ["signature", "ingress", "report", "policy"] as const)
test(`HTTP ${denial} denial cannot retain a DNC decision`, { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopReceiverFixture(); t.after(f.closeReceiver); const server = await f.listen();
  if (denial === "ingress") f.receiverState.allowed = false;
  if (denial === "report") f.reportState.live = false;
  if (denial === "policy") await f.replaceStopPolicy({ enabled: false });
  assert.equal((await server.post({}, denial !== "signature")).status, denial === "signature" ? 403 : 503);
  assert.equal(f.dncPosts.length, 0); assert.equal(f.receiverState.progress.length, 0); assert.equal(f.released.size, 0);
});
test("router deadline aborts native report recovery and a late grant cannot append", { timeout: 15000 }, async t => {
  const f = await twilioOutboundStopReceiverFixture({ deadlineMs: 500 }); t.after(f.closeReceiver);
  let entered = false, release!: () => void; const held = new Promise<void>(done => { release = done; }); t.after(release);
  f.recoveryPorts.reports.allowsHistoryRead = async () => { entered = true; await held; return true; };
  const server = await f.listen(); assert.equal((await server.post()).status, 503); assert.equal(entered, true);
  release(); await setImmediate(); assert.equal(f.dncPosts.length, 0); assert.equal(f.dncBurned.size, 0);
});
test("a differently selected runtime cannot be paired with the native stop owner", async t => {
  const f = await twilioOutboundStopReceiverFixture(); t.after(f.closeReceiver);
  const foreign = new TwilioAbbyOutboundRuntime({ ...f.carrier, profileRef: "foreign-profile" });
  assert.throws(() => twilioOutboundStopReceiver({ ...f.receiverConfig, runtime: foreign, stopRecovery: value(f.makeRecovery()) }));
});
