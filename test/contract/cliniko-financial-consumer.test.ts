import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { financialConsumerFixture } from "../support/financial-consumer.ts";
import { value, stop, now } from "../support/financial-checkout-owner.ts";
import { signWebhook } from "../support/financial-webhook-handoff.ts";
import { ClinikoFinancialConsumer } from "../../src/standalone/cliniko-financial-consumer.ts";

test("configured periodic consumer creates once, rediscovers native work, and separately delivers link and Stripe receipt", async t => {
  const f = await financialConsumerFixture(); t.after(() => f.consumer.close());
  assert.equal(f.sessions.length, 0); assert.equal(f.cycles.length, 0);
  const first = f.cycle(), running = f.start();
  assert.equal((await first).creationAcknowledged, 1); assert.equal(f.receipts.length, 1); assert.equal(f.messages.length, 0);
  assert.equal(f.receipts[0]!.intentDigest.length, 64); assert.ok(Object.isFrozen(f.receipts[0]));
  const sent = await f.cycle(); assert.equal(sent.messageAccepted, 1); assert.equal(f.messages[0]!.ref, f.intent.effects.linkDelivery);
  assert.equal((await f.cycle()).alreadyAttempted, 1); assert.equal(f.messages.length, 1);
  f.paid(); assert.equal((await f.cycle()).messageAccepted, 1); assert.equal(f.messages[1]!.ref, f.intent.effects.receiptDelivery);
  assert.equal((await f.cycle()).alreadyAttempted, 1); assert.equal(f.messages.length, 2);
  assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
  assert.doesNotMatch(JSON.stringify(f.cycles), /cs_test|acct_|cliniko:|private|@|5000|gbp/);
  assert.deepEqual(f.consumer.start(stop()), { ok: false, error: { kind: "alreadyStarted" } });
  await f.consumer.close(); await running.done; assert.equal(f.consumer.start(stop()).ok, false);
});

for (const denial of ["denyRun", "denyWork", "denyPending", "retire"] as const)
test(`consumer ${denial} cannot grant collection from a valid native signed booking`, async t => {
  const f = await financialConsumerFixture(); t.after(() => f.consumer.close()); f[denial]();
  const first = f.cycle(); f.start(); const observed = await first;
  assert.equal(observed.creationAcknowledged, 0); assert.equal(f.sessions.length, 0); assert.equal(f.messages.length, 0);
  assert.equal(f.burned.has(f.intent.effects.checkout), false);
});

test("prospective intent without a signed booking remains staff review, and a recalled source stops polling effects", async t => {
  for (const change of ["missingCitation", "closedIntent"] as const) {
    const f = await financialConsumerFixture(); t.after(() => f.consumer.close());
    if (change === "missingCitation") f.rows.delete("31"); else { f.rows.get("30")!.recalled = true; f.rows.get("30")!.recalled_at = now; }
    const first = f.cycle(); f.start(); assert.equal((await first).creationAcknowledged, 0);
    assert.equal(f.sessions.length, 0); assert.equal(f.messages.length, 0); await f.consumer.close();
  }
});

test("lost creation ACK and metadata are observation only until independent recovered binding approval", async t => {
  const f = await financialConsumerFixture({ checkout: { stripe: (row, method) => {
    if (method === "POST") throw new Error("Private lost Stripe ACK"); return Response.json(row);
  } } }); t.after(() => f.consumer.close());
  const first = f.cycle(); f.start(); assert.equal((await first).reviewRequired, 1);
  assert.equal((await f.cycle()).reviewRequired, 1); assert.equal(f.receipts.length, 0); assert.equal(f.messages.length, 0);
  f.approved.add("cs_test_owner"); assert.equal((await f.cycle()).messageAccepted, 1);
  assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
});

test("acknowledgement observer failure preserves creation and a new consumer cannot manufacture its receipt", async t => {
  const f = await financialConsumerFixture({ onAcknowledged: async () => { throw new Error("Private independent observer failed"); } });
  t.after(() => f.consumer.close()); const first = f.cycle(); f.start(); assert.equal((await first).reviewRequired, 1);
  assert.equal(f.sessions.length, 1); await f.consumer.close();
  const cold = f.make(); t.after(() => cold.close()); const next = f.cycle(); value(cold.start(stop()));
  assert.equal((await next).reviewRequired, 1); assert.equal(f.receipts.length, 1); assert.equal(f.messages.length, 0);
  assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
});

test("cold consumer and restored missing link claim cannot resend a closed native possible-message attempt", async t => {
  const f = await financialConsumerFixture(); t.after(() => f.consumer.close()); const first = f.cycle(); f.start(); await first;
  assert.equal((await f.cycle()).messageAccepted, 1); await f.consumer.close();
  f.burned.delete(f.intent.effects.linkDelivery); const message = f.rows.get("33")!;
  message.recalled = true; message.recalled_at = now; message.archived_at = now;
  const cold = f.make(); t.after(() => cold.close()); const next = f.cycle(); value(cold.start(stop()));
  assert.equal((await next).alreadyAttempted, 1); assert.equal(f.messages.length, 1);
  assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
});

test("actual raw HTTP webhook requires the active admitted periodic consumer and never trusts paid event flags", async t => {
  const f = await financialConsumerFixture(); t.after(() => f.consumer.close());
  const server = createServer(f.consumer.handle); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const notify = async (type = "checkout.session.completed") => {
    const signed = signWebhook(JSON.stringify({ id: "evt_consumer", object: "event", type, created: Date.parse(now) / 1_000,
      livemode: false, account: f.config.checkout.stripe.accountRef, api_version: f.config.webhook.apiVersion,
      data: { object: { object: "checkout.session", id: "cs_test_owner", payment_status: "paid", customer_email: "private-event@example.invalid" } } }));
    const response = await fetch(`http://127.0.0.1:${address.port}/stripe/webhook`, { method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signed.signature }, body: signed.raw });
    return { status: response.status, body: await response.text() };
  };
  assert.deepEqual(await notify(), { status: 503, body: '{"ok":false}' });
  const first = f.cycle(); f.start(); await first;
  for (const type of ["checkout.session.completed", "checkout.session.expired", "checkout.session.completed"]) {
    assert.deepEqual(await notify(type), { status: 200, body: '{"ok":true}' });
  }
  assert.equal(f.messages.length, 0); assert.equal(f.sessions[0]!.payment_status, "unpaid");
  f.denyRun(); assert.equal((await notify()).status, 503);
  await f.consumer.close(); assert.equal((await notify()).status, 503);
  assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
});

test("invalid provisioning and an already-aborted start perform no provider I/O", async () => {
  const f = await financialConsumerFixture();
  for (const patch of [{ pollEveryMs: 0 }, { cycleDeadlineMs: 120_001 }])
    assert.equal(ClinikoFinancialConsumer.create({ ...f.config, ...patch }, f.authority, f.dependencies).ok, false);
  const controller = new AbortController(); controller.abort();
  assert.equal(f.consumer.start(controller.signal).ok, false); assert.equal(f.sessions.length, 0); await f.consumer.close();
});
