import assert from "node:assert/strict";
import test from "node:test";
import { StripeCheckoutDiscovery } from "../../src/stripe/checkout-discovery.ts";
import { decodeFinancialCheckoutAttempt } from "../../src/cliniko/financial-checkout-attempt.ts";
import { checkoutFixture, value, now, stop } from "../support/financial-checkout-owner.ts";

for (const observed of [false, true]) test(`whole retained possible-creation range after lost ACK (observed=${observed}) never authorizes a replay`, async () => {
  const f = await checkoutFixture({ stripe: (row, method) => {
    if (method === "POST") {
      // The provider may complete creation after the caller's transport loss.
      // Its fixed expiry still bounds the latest possible creation time.
      row.created = Math.floor(Date.parse(now) / 1_000) + 7_200;
      throw new Error("Synthetic lost creation response");
    }
    return Response.json(row);
  } });
  const result = value(await f.owner.createOnce(f.binding, stop())); assert.equal(result.kind, "uncertain");
  const record = f.rows.get(result.attemptRecallRef.split(":").at(-1)!)!, decoded = value(decodeFinancialCheckoutAttempt(record.notes));
  const retained = value(await f.retainer.readCheckoutAttempt({ recallRef: result.attemptRecallRef, actionRef: decoded.actionRef,
    intentRecallRef: f.binding.intentRecallRef }, f.intent, stop()));
  assert.equal(retained.kind, "attemptContext"); assert.ok(retained.attempt.createdThrough - retained.attempt.createdFrom > 3_600);
  const readCalls: URL[] = [];
  const discovery = new StripeCheckoutDiscovery({ ...f.config.stripe, clock: () => Date.parse(now) + 10_800_000 }, async (input, init) => {
    assert.equal(init?.method, "GET");
    const url = new URL(String(input)); readCalls.push(url);
    if (url.pathname === "/v1/account") return Response.json({ object: "account", id: f.config.stripe.accountRef });
    const from = Number(url.searchParams.get("created[gte]")), through = Number(url.searchParams.get("created[lte]"));
    const data = observed ? f.sessions.filter(row => Number(row.created) >= from && Number(row.created) <= through) : [];
    return Response.json({ object: "list", url: "/v1/checkout/sessions", data, has_more: false });
  });
  const binding = { actionRef: f.intent.actionRef, amount: f.intent.payment.amount, currency: f.intent.payment.currency,
    createdFrom: retained.attempt.createdFrom, createdTo: retained.attempt.createdThrough };
  assert.equal((await discovery.find(binding, stop())).ok, false, "ordinary account scans keep their one-hour contract");
  const found = value(await discovery.findPossibleCreation(binding, stop()));
  assert.equal(found.kind, observed ? "observed" : "notObserved");
  if (found.kind === "observed") assert.equal(found.checkoutRef, "cs_test_owner");
  const last = readCalls.at(-1)!; assert.equal(Number(last.searchParams.get("created[lte]")), retained.attempt.createdThrough);
  assert.ok(readCalls.length > 2); assert.equal(f.requests.filter(row => row.method === "POST").length, 1);
  // Missing/restored local claim state is not provider absence or permission.
  // The independent native attempt history still forbids another creation.
  f.burned.clear();
  const repeated = await value(f.make()).createOnce(f.binding, stop()); assert.equal(repeated.ok, false);
  if (!repeated.ok) assert.equal(repeated.error.kind, "alreadyClaimed");
  assert.equal(f.requests.filter(row => row.method === "POST").length, 1);
});
