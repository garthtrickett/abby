import assert from "node:assert/strict";
import test from "node:test";
import { twilioStatusDeliveryFixture as fixture } from "../support/twilio-outbound-status-delivery.ts";
import { NativeRequestAllowance } from "../../src/standalone/internal/native-request-allowance.ts";

test("combined signed completed delivery retains an independent DNC decision and one notification without releasing either hold", async t => {
  const f = await fixture(); t.after(f.close);
  assert.equal((await f.receive()).ok, true); assert.equal(f.dncPosts.length, 1); assert.equal(f.notificationPosts.length, 1);
  assert.equal((await f.receive()).ok, true); assert.equal(f.dncPosts.length, 1); assert.equal(f.notificationPosts.length, 1);
  assert.equal(f.held.size, 1); assert.equal(f.released.size, 0); assert.equal(f.calls.length, 1);
});

test("completed delivery with absent positive speech acknowledges only retained notification and leaves contact unknown", async t => {
  const f = await fixture({ missingReport: true }); t.after(f.close);
  assert.equal((await f.receive()).ok, true); assert.equal(f.dncPosts.length, 0); assert.equal(f.notificationPosts.length, 1);
  assert.equal(f.dncBurned.size, 0); assert.equal(f.released.size, 0); assert.equal(f.held.size, 1);
});

for (const notificationAck of ["stored", "unstored"] as const)
test(`combined delivery preserves positive DNC through ${notificationAck} notification acknowledgement loss`, async t => {
  const f = await fixture({ notificationAck }); t.after(f.close);
  assert.equal((await f.receive()).ok, notificationAck === "stored"); assert.equal((await f.receive()).ok, notificationAck === "stored");
  assert.equal(f.dncPosts.length, 1); assert.equal(f.notificationPosts.length, 1); assert.equal(f.held.size, 1); assert.equal(f.released.size, 0);
});

test("lost positive DNC acknowledgement is recovered cold before notification without repeating either POST", async t => {
  const f = await fixture(); t.after(f.close); f.stopState.response = () => { throw Error("Lost DNC response"); };
  assert.equal((await f.receive()).ok, false); assert.equal(f.dncPosts.length, 1); assert.equal(f.notificationPosts.length, 0);
  assert.equal((await f.receive()).ok, true); assert.equal(f.dncPosts.length, 1); assert.equal(f.notificationPosts.length, 1);
});

test("authentic negative terminal status preserves legacy positive-stop recovery without creating completed provenance", async t => {
  const f = await fixture(); t.after(f.close);
  assert.equal((await f.receive({ CallStatus: "failed" })).ok, true); assert.equal(f.dncPosts.length, 1); assert.equal(f.notificationPosts.length, 0);
  const missing = await fixture({ missingReport: true }); t.after(missing.close);
  assert.equal((await missing.receive({ CallStatus: "failed" })).ok, false); assert.equal(missing.dncPosts.length, 0); assert.equal(missing.notificationPosts.length, 0);
});

test("progress and forged status do not spend a native purpose or grant a stop", async t => {
  const f = await fixture(); t.after(f.close); const before = f.claims;
  assert.equal((await f.receive({ CallStatus: "ringing" })).ok, true);
  assert.equal((await f.delivery.receiveStatus({ ...f.request(), signature: "forged" }, new AbortController().signal)).ok, false);
  assert.equal(f.claims, before); assert.equal(f.notificationBurned.size, 0); assert.equal(f.dncBurned.size, 0);
});

test("one cumulative request allowance spans positive-report reads and the later notification writer", async t => {
  const baseline = await fixture({ missingReport: true }); t.after(baseline.close); const before = baseline.claims;
  assert.equal((await baseline.receive()).ok, true); const required = baseline.claims - before; assert.ok(required > 1);
  const limited = await fixture({ missingReport: true, maximumNativeRequests: required - 1 }); t.after(limited.close); const start = limited.claims;
  assert.equal((await limited.receive()).ok, false); assert.ok(limited.claims - start <= required - 1);
  assert.equal(limited.notificationPosts.length, 0); assert.equal(limited.dncPosts.length, 0);
});

for (const changed of ["physical", "credential", "family"] as const)
test(`combined capture rejects mismatched ${changed} selection`, async t => {
  const f = await fixture(); t.after(f.close); const n = f.deliveryConfig.notifications.config;
  if (changed === "physical") n.observations.rateBudget = { claim: async () => null, observe429: async () => ({ kind: "rateLimited" }) };
  if (changed === "credential") n.observations.apiKey = "foreign-au5";
  if (changed === "family") n.observations.outboundTerminalObservationRecallTypeId = f.recoveryConfig.reports.outboundProviderReportRecallTypeId;
  assert.equal(f.makeDelivery().ok, false); assert.equal(f.dncPosts.length, 0); assert.equal(f.notificationPosts.length, 0);
});

test("a denied positive-report grant cannot be bypassed by successful notification permission", async t => {
  const f = await fixture(); t.after(f.close); f.reportState.broad = false;
  assert.equal((await f.receive()).ok, false); assert.equal(f.dncPosts.length, 0); assert.equal(f.notificationPosts.length, 0);
});

test("an ignored stop grant shares the one whole delivery deadline and cannot append later notification", async t => {
  const f = await fixture({ deadlineMs: 30 }); t.after(f.close); let release!: () => void;
  const held = new Promise<void>(r => { release = r; }); f.recoveryPorts.reports.allowsHistoryRead = async () => { await held; return true; };
  const delivery = f.makeDelivery(); assert.equal(delivery.ok, true); if (!delivery.ok) return;
  assert.equal((await delivery.value.receiveStatus(f.request(), new AbortController().signal)).ok, false);
  release(); await new Promise<void>(r => setImmediate(r)); assert.equal(f.dncPosts.length, 0); assert.equal(f.notificationPosts.length, 0);
});

test("a cumulative allowance has no reset operation and rejects invalid or over-bound headroom", () => {
  const allowance = new NativeRequestAllowance(2); assert.equal(allowance.hasHeadroom(2), true); assert.equal(allowance.take(), true);
  assert.equal(allowance.hasHeadroom(2), false); assert.equal(allowance.take(), true); assert.equal(allowance.take(), false);
  assert.equal(allowance.hasHeadroom(-1), false); assert.equal(allowance.hasHeadroom(NaN), false); assert.throws(() => new NativeRequestAllowance(181));
});
