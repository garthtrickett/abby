import assert from "node:assert/strict";
import test from "node:test";
import { checkoutFixture, value, now, stop, uuid, base } from "../support/financial-checkout-owner.ts";
import { ClinikoFinancialWorkDiscovery } from "../../src/cliniko/financial-work-discovery.ts";
import { decodeFinancialCheckoutAttempt, encodeFinancialCheckoutAttempt } from "../../src/cliniko/financial-checkout-attempt.ts";
import { intentValue } from "../support/financial-retention.ts";

const posts = (f: Awaited<ReturnType<typeof checkoutFixture>>) => f.requests.filter(r => r.method === "POST");
test("one owner command retains exact native attempt before one bound hosted checkout", async () => {
  const f = await checkoutFixture({ stripe: (row, method) => {
    if (method === "POST") assert.ok([...f.rows.values()].some(r => String(r.notes).includes("financial checkout attempt")));
    return Response.json(row);
  } });
  const r = value(await f.owner.createOnce(f.binding, stop())); assert.equal(r.kind, "created");
  if (r.kind !== "created") throw new Error("Not created");
  assert.equal(r.checkoutRef, "cs_test_owner"); assert.equal(r.expiresAt, f.intent.payment.deadline); assert.ok(!JSON.stringify(r).includes("private-stripe-response-canary"));
  const post = posts(f)[0]!, p = new URLSearchParams(post.body);
  assert.equal(post.headers.get("Idempotency-Key"), `abby-checkout-${f.intent.effects.checkout}`);
  assert.equal(p.get("mode"), "payment"); assert.equal(p.get("client_reference_id"), f.intent.actionRef);
  assert.equal(p.get("line_items[0][price_data][unit_amount]"), String(f.intent.payment.amount)); assert.equal(p.get("line_items[0][price_data][currency]"), f.intent.payment.currency);
  assert.equal(p.get("adaptive_pricing[enabled]"), "false"); assert.equal(p.get("automatic_tax[enabled]"), "false");
  assert.ok(!post.body.includes(f.intent.patientId + "&")); assert.ok(!post.body.includes("cliniko")); assert.ok(!post.body.includes(f.intent.recipient.address));
  assert.equal(f.burned.has(f.intent.effects.checkout), true);
  const record = f.rows.get(r.attemptRecallRef.split(":").at(-1)!)!, attempt = value(decodeFinancialCheckoutAttempt(record.notes));
  assert.equal(attempt.effectRef, f.intent.effects.checkout); assert.equal(attempt.intentRecallRef, f.binding.intentRecallRef); assert.notEqual(attempt.actionRef, attempt.effectRef);
  const context = value(await f.retainer.readCheckoutAttempt({ recallRef: r.attemptRecallRef, actionRef: attempt.actionRef, intentRecallRef: f.binding.intentRecallRef }, f.intent, stop()));
  assert.equal(context.kind, "attemptContext"); assert.equal(context.attempt.targetRef, "cliniko:appointment:91");
});
test("duplicate concurrent commands and a fresh owner cannot create a second payable", async () => {
  const f = await checkoutFixture();
  const results = await Promise.all([f.owner.createOnce(f.binding, stop()), value(f.make()).createOnce(f.binding, stop())]);
  assert.equal(results.filter(r => r.ok && r.value.kind === "created").length, 1); assert.equal(posts(f).length, 1);
  const again = await value(f.make()).createOnce(f.binding, stop()); assert.equal(again.ok, false); if (!again.ok) assert.equal(again.error.kind, "alreadyClaimed");
  assert.equal(posts(f).length, 1);
});
test("lost Stripe response remains uncertain with durable native context and no replay", async () => {
  const f = await checkoutFixture({ stripe: (row, method) => { if (method === "POST") throw new Error("private provider error canary"); return Response.json(row); } });
  const r = value(await f.owner.createOnce(f.binding, stop())); assert.equal(r.kind, "uncertain");
  assert.equal(f.rows.size, 3); assert.ok(!JSON.stringify(r).includes("private provider"));
  assert.equal((await value(f.make()).createOnce(f.binding, stop())).ok, false); assert.equal(posts(f).length, 1);
  const scanner = value(ClinikoFinancialWorkDiscovery.create(f.config.cliniko, { allowsAccountRead: async () => true, allowsRecordRead: async () => true, current: () => true }, f.nativePort));
  const discovered = value(await scanner.scan({ createdFrom: "2026-11-01T09:30:00.000Z", createdThrough: now }, stop()));
  assert.equal(discovered.attempts.length, 1); assert.equal(discovered.attempts[0]?.attempt.effectRef, f.intent.effects.checkout);
  assert.equal(discovered.work[0]?.kind, "pairedContext");
});
test("lost native attempt acknowledgement burns effect but sends no Stripe POST", async () => {
  const f = await checkoutFixture({ native: { response: (row, method) => { if (method === "POST" && String(row.notes).includes("checkout attempt")) throw new Error("lost attempt"); return Response.json(row, { status: method === "POST" ? 201 : 200 }); } } });
  const r = await f.owner.createOnce(f.binding, stop()); assert.equal(r.ok, false); if (!r.ok) assert.equal(r.error.kind, "attemptUncertain");
  assert.equal(posts(f).length, 0); assert.equal(f.burned.has(f.intent.effects.checkout), true); assert.equal(f.rows.size, 3);
  assert.equal((await value(f.make()).createOnce(f.binding, stop())).ok, false); assert.equal(posts(f).length, 0);
});
for (const [name, authority] of Object.entries({ source: { sourceAuthorized: async () => false }, collection: { collectionAuthorized: async () => false },
  producer: { producerAdmitted: async () => false }, current: { current: () => false } })) test(`independent ${name} denial cannot create or consume checkout`, async () => {
  const f = await checkoutFixture({ authority }); const r = await f.owner.createOnce(f.binding, stop()); assert.equal(r.ok, false);
  assert.equal(posts(f).length, 0); assert.equal(f.burned.has(f.intent.effects.checkout), false);
});
test("account mismatch refuses before consuming effect", async () => {
  const f = await checkoutFixture({ stripe: row => Response.json({ ...row, id: "acct_foreign" }) });
  const r = await f.owner.createOnce(f.binding, stop()); assert.equal(r.ok, false); assert.equal(posts(f).length, 0); assert.equal(f.burned.has(f.intent.effects.checkout), false);
});
for (const [name, mutate] of Object.entries({ recalledIntent: (f: Awaited<ReturnType<typeof checkoutFixture>>) => { f.rows.get("30")!.recalled = true; },
  archivedObservation: (f: Awaited<ReturnType<typeof checkoutFixture>>) => { f.rows.get("31")!.archived_at = now; },
  alteredProof: (f: Awaited<ReturnType<typeof checkoutFixture>>) => { f.rows.get("31")!.notes = String(f.rows.get("31")!.notes).replace("appointment:91", "appointment:92"); } })) test(`refuses ${name}`, async () => {
  const f = await checkoutFixture(); mutate(f); assert.equal((await f.owner.createOnce(f.binding, stop())).ok, false); assert.equal(posts(f).length, 0);
});
test("native intent edit during attempt retention refuses before Stripe", async () => {
  const f = await checkoutFixture({ native: { response: (row, method) => {
    if (method === "POST" && String(row.notes).includes("checkout attempt")) f.rows.get("30")!.notes = String(f.rows.get("30")!.notes).replace("5000", "6000");
    return Response.json(row, { status: method === "POST" ? 201 : 200 });
  } } });
  const r = await f.owner.createOnce(f.binding, stop()); assert.equal(r.ok, false); assert.equal(posts(f).length, 0); assert.equal(f.burned.has(f.intent.effects.checkout), true);
});
for (const [name, mutate] of Object.entries({ wrongAmount: (r: Record<string, unknown>) => { r.amount_total = 6000; }, wrongCurrency: (r: Record<string, unknown>) => { r.currency = "usd"; },
  paid: (r: Record<string, unknown>) => { r.payment_status = "paid"; }, wrongURL: (r: Record<string, unknown>) => { r.url = "https://evil.invalid/c/pay/cs_test_owner"; },
  wrongExpiry: (r: Record<string, unknown>) => { r.expires_at = 0; }, foreignMode: (r: Record<string, unknown>) => { r.livemode = true; },
  tax: (r: Record<string, unknown>) => { r.total_details = { amount_tax: 1, amount_discount: 0, amount_shipping: 0 }; },
  missingEffect: (r: Record<string, unknown>) => { r.metadata = {}; } })) test(`nonexact ${name} acknowledgement is uncertain and never repeated`, async () => {
  const f = await checkoutFixture({ stripe: (r, method) => { if (method === "POST") mutate(r); return Response.json(r); } });
  assert.equal(value(await f.owner.createOnce(f.binding, stop())).kind, "uncertain");
  assert.equal((await value(f.make()).createOnce(f.binding, stop())).ok, false); assert.equal(posts(f).length, 1);
});
test("permission loss after exact creation preserves created truth but withholds URL", async () => {
  const f = await checkoutFixture({ stripe: (row, method) => { if (method === "POST") f.forbid(); return Response.json(row); } });
  const r = value(await f.owner.createOnce(f.binding, stop())); assert.equal(r.kind, "createdWithheld"); assert.ok(!JSON.stringify(r).includes("checkout.stripe.com"));
});
for (const hours of [0.25, 25]) test(`outside provider expiry bounds ${hours}h does not clamp or send`, async () => {
  const i = intentValue(), deadline = new Date(Date.parse(now) + hours * 3_600_000).toISOString();
  const f = await checkoutFixture({ native: { intent: { ...i, payment: { ...i.payment, deadline } } } });
  assert.equal((await f.owner.createOnce(f.binding, stop())).ok, false); assert.equal(posts(f).length, 0); assert.equal(f.burned.has(f.intent.effects.checkout), false);
});
test("trusted grants cannot mutate the selected intent or checkout terms", async () => {
  const f = await checkoutFixture({ authority: { collectionAuthorized: async q => {
    assert.throws(() => { (q.intent.payment as { amount: number }).amount = 1; }, TypeError); return true;
  } } }); assert.equal(value(await f.owner.createOnce(f.binding, stop())).kind, "created");
});
test("attempt codec is canonical and rejects alias/extra fields and non-string refs", async () => {
  const f = await checkoutFixture(); const r = value(await f.owner.createOnce(f.binding, stop()));
  const a = value(decodeFinancialCheckoutAttempt(f.rows.get(r.attemptRecallRef.split(":").at(-1)!)!.notes));
  assert.equal(encodeFinancialCheckoutAttempt({ ...a, actionRef: a.effectRef }).ok, false);
  assert.equal(encodeFinancialCheckoutAttempt({ ...a, extra: "private" } as typeof a).ok, false);
  assert.equal(encodeFinancialCheckoutAttempt({ ...a, intentRecallRef: [a.intentRecallRef] } as unknown as typeof a).ok, false);
  assert.equal(decodeFinancialCheckoutAttempt(String(f.rows.get("32")!.notes) + "\n").ok, false);
});
test("bad exact source refs and ended service lifetime perform no Stripe calls", async () => {
  const f = await checkoutFixture(); assert.equal((await f.owner.createOnce({ ...f.binding, observationRecallRef: f.binding.intentRecallRef }, stop())).ok, false);
  const ended = new AbortController(); ended.abort(); assert.equal((await f.owner.createOnce(f.binding, ended.signal)).ok, false); assert.equal(f.requests.length, 0);
});
