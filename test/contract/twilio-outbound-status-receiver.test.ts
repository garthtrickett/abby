import assert from "node:assert/strict";
import test from "node:test";
import { twilioStatusReceiverFixture as fixture } from "../support/twilio-outbound-status-receiver.ts";

test("actual signed HTTP callback retains one restrictive decision and notification then acknowledges its cold duplicate", async t => {
  const f = await fixture(); t.after(f.closeReceiver);
  assert.equal(await f.sendStatus(), 204); assert.equal(await f.sendStatus(), 204);
  assert.equal(f.dncPosts.length, 1); assert.equal(f.notificationPosts.length, 1); assert.equal(f.httpState.sessions, 0); assert.equal(f.httpState.progress, 2);
  assert.equal(f.held.size, 1); assert.equal(f.released.size, 0); assert.equal(f.calls.length, 1);
});

test("actual completed HTTP callback can acknowledge notification while positive speech remains unknown", async t => {
  const f = await fixture({ missingReport: true }); t.after(f.closeReceiver);
  assert.equal(await f.sendStatus(), 204); assert.equal(f.dncPosts.length, 0); assert.equal(f.notificationPosts.length, 1);
  assert.equal(f.held.size, 1); assert.equal(f.released.size, 0); assert.equal(f.httpState.sessions, 0);
});

test("actual HTTP retry discovers a lost DNC acknowledgement before completing notification delivery", async t => {
  const f = await fixture({ configure: f => { f.stopState.response = () => { throw Error("Lost DNC acknowledgement"); }; } }); t.after(f.closeReceiver);
  assert.equal(await f.sendStatus(), 503); assert.equal(await f.sendStatus(), 204);
  assert.equal(f.dncPosts.length, 1); assert.equal(f.notificationPosts.length, 1); assert.equal(f.released.size, 0);
});

for (const denied of ["signature", "ingress"] as const)
test(`actual callback ${denied} denial cannot spend either native action or acquire a voice session`, async t => {
  const f = await fixture(); t.after(f.closeReceiver); const request = { ...f.request() };
  if (denied === "signature") request.signature = "forged"; else f.httpState.ingress = false;
  assert.equal(await f.sendStatus(request), denied === "signature" ? 403 : 503);
  assert.equal(f.dncPosts.length, 0); assert.equal(f.notificationPosts.length, 0); assert.equal(f.httpState.sessions, 0);
});

test("the actual router deadline aborts an ignored stop grant and prevents late native work", async t => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ httpDeadlineMs: 30, configure: f => { f.deliveryConfig.stop.ports.reports.allowsHistoryRead = async () => { await held; return true; }; } }); t.after(f.closeReceiver);
  assert.equal(await f.sendStatus(), 503); release(); await new Promise<void>(r => setImmediate(r));
  assert.equal(f.dncPosts.length, 0); assert.equal(f.notificationPosts.length, 0); assert.equal(f.httpState.sessions, 0);
});


test("actual signed no-answer HTTP callback retains its own provenance while missing speech leaves contact blocked", async t => {
  const f = await fixture({ missingReport: true, unanswered: true }); t.after(f.closeReceiver);
  assert.equal(await f.sendStatus(f.request({ CallStatus: "no-answer" })), 204);
  assert.equal(await f.sendStatus(f.request({ CallStatus: "no-answer" })), 204);
  assert.equal(f.unansweredPosts.length, 1); assert.equal(f.notificationPosts.length, 0); assert.equal(f.staffPosts.length, 0);
  assert.equal(f.dncPosts.length, 0); assert.equal(f.released.size, 0); assert.equal(f.held.size, 1);
  assert.equal(f.httpState.sessions, 0); assert.equal(f.calls.length, 1);
});

for (const unansweredAck of ["stored", "unstored"] as const) {
  test(`actual signed no-answer HTTP ${unansweredAck} response loss is reconciled without a second POST`, async t => {
    const f = await fixture({ missingReport: true, unanswered: true, unansweredAck }); t.after(f.closeReceiver);
    const expected = unansweredAck === "stored" ? 204 : 503;
    assert.equal(await f.sendStatus(f.request({ CallStatus: "no-answer" })), expected);
    assert.equal(await f.sendStatus(f.request({ CallStatus: "no-answer" })), expected);
    assert.equal(f.unansweredPosts.length, 1); assert.equal(f.notificationPosts.length, 0); assert.equal(f.dncPosts.length, 0);
    assert.equal(f.released.size, 0); assert.equal(f.held.size, 1); assert.equal(f.httpState.sessions, 0);
  });
}
