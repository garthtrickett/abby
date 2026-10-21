import assert from "node:assert/strict";
import test from "node:test";
import { twilioNotificationDeliveryFixture as fixture } from "../support/twilio-outbound-notification-delivery.ts";


test("actual signed HTTP204 acknowledges one native notification and its cold duplicate without settling contact or capacity", async t => {
  const f = await fixture(); t.after(f.closeDelivery);
  assert.equal(await f.sendStatus(), 204); assert.equal(f.native.calls.filter(c => c.method === "POST").length, 1);
  const stored = structuredClone([...f.native.rows]); assert.equal(await f.sendStatus(), 204);
  assert.deepEqual([...f.native.rows], stored); assert.equal(f.native.calls.filter(c => c.method === "POST").length, 1);
  assert.equal(f.recoveryState.pages, 2); assert.equal(f.recoveryState.reads, 0); assert.equal(f.recoveryState.releases, 0); assert.equal(f.held.size, 1);
  assert.equal(f.carrierRequests, 1); assert.equal(f.deliveryState.progress, 2);
});

for (const lostAck of ["stored", "unstored"] as const)
test(`actual signed notification HTTP handles ${lostAck} native ACK loss without another POST`, async t => {
  const f = await fixture({ lostAck }); t.after(f.closeDelivery);
  assert.equal(await f.sendStatus(), lostAck === "stored" ? 204 : 503); assert.equal(await f.sendStatus(), lostAck === "stored" ? 204 : 503);
  assert.equal(f.native.calls.filter(c => c.method === "POST").length, 1); assert.equal(f.recoveryState.releases, 0); assert.equal(f.held.size, 1); assert.equal(f.carrierRequests, 1);
});

for (const grant of ["source", "record", "producer", "current", "ingress", "signature", "legacy"] as const)
test(`signed notification HTTP denies ${grant} without acquiring native or session effects`, async t => {
  const f = await fixture({ legacy: grant === "legacy" }); t.after(f.closeDelivery);
  if (["source", "record", "producer", "current"].includes(grant)) f.state[grant as "source" | "record" | "producer" | "current"] = false;
  if (grant === "ingress") f.deliveryState.ingress = false;
  const request = { ...f.request() }; if (grant === "signature") request.signature = "forged";
  assert.equal(await f.sendStatus(request), grant === "signature" ? 403 : 503);
  assert.equal(f.native.calls.filter(c => c.method === "POST").length, 0); assert.equal(f.recoveryState.releases, 0); assert.equal(f.held.size, 1);
});

test("unsupported authentic progress is acknowledged without spending the completed purpose or inventing terminal truth", async t => {
  const f = await fixture(); t.after(f.closeDelivery);
  for (const CallStatus of ["queued", "ringing", "in-progress", "busy", "failed", "no-answer", "canceled"]) assert.equal(await f.sendStatus(f.request({ CallStatus })), 204);
  assert.equal(f.native.calls.length, 0); assert.equal(f.burned.size, 0); assert.equal(f.recoveryState.releases, 0); assert.equal(f.held.size, 1);
});

for (const grant of ["history", "decoded", "nativeLive"] as const)
test(`cold duplicate ACK needs independent current ${grant} read authority`, async t => {
  const f = await fixture(); t.after(f.closeDelivery); assert.equal(await f.sendStatus(), 204);
  f.recoveryState[grant] = false; assert.equal(await f.sendStatus(), 503); assert.equal(f.native.calls.filter(c => c.method === "POST").length, 1);
});

test("source withdrawal during the actual native budget wait permanently fences dispatch", async t => {
  const f = await fixture(); t.after(f.closeDelivery); f.state.beforeBudget = () => { f.state.source = false; };
  assert.equal(await f.sendStatus(), 503); assert.equal(f.native.calls.filter(c => c.method === "POST").length, 0); assert.equal(f.burned.size, 1);
});

test("captured source methods and verifier key cannot be replaced after receiver construction", async t => {
  const f = await fixture(); t.after(f.closeDelivery); f.key.fill(0); f.source.current = () => true; f.state.source = false;
  assert.equal(await f.sendStatus(), 503); assert.equal(f.native.calls.filter(c => c.method === "POST").length, 0);
});


test("an ignored approval read cannot outlive the selected native/HTTP deadline and send a late POST", async t => {
  const f = await fixture({ deadlineMs: 50 }); t.after(f.closeDelivery); let release!: () => void;
  const held = new Promise<void>(r => { release = r; }); f.state.beforeSource = () => held;
  assert.equal(await f.sendStatus(), 503); release(); await new Promise<void>(r => setImmediate(r));
  assert.equal(f.native.calls.filter(c => c.method === "POST").length, 0); assert.equal(f.burned.size, 0);
});
