import assert from "node:assert/strict";
import test from "node:test";
import { nativeWaiverFixture } from "../support/financial-waiver.ts";
import { base, value } from "../support/financial-retention.ts";
import { ClinikoFinancialSettlementReview } from "../../src/standalone/cliniko-financial-settlement-review.ts";
import type { FinancialSettlementBindings, FinancialSettlementPurpose } from "../../src/standalone/cliniko-financial-settlement-review.ts";

async function fixture() {
  const f = await nativeWaiverFixture(), state = { status: 10, completeGrant: true, current: true, mappingCurrent: true, gets: 0, withWaiver: false };
  const context = { intent: f.intent, intentRecallRef: f.expected.intentRecallRef, targetRef: f.expected.targetRef };
  const binding: FinancialSettlementBindings = { targetRef: context.targetRef, invoice: { financialActionRef: f.intent.actionRef,
    invoiceRef: "72", patientId: f.intent.patientId, bookingId: "91", bookingKind: "book", expectedTotalMinor: f.intent.payment.amount,
    currency: f.intent.payment.currency, expiresAt: "2026-11-02T01:00:00.000Z" } };
  const invoice = () => ({ id: "72", links: { self: `${base}/invoices/72` }, patient: { links: { self: `${base}/patients/${f.intent.patientId}` } },
    business: { links: { self: `${base}/businesses/${f.intent.businessId}` } }, booking: { links: { self: `${base}/bookings/91` } },
    archived_at: null, deleted_at: null, total_amount: (f.intent.payment.amount / 100).toFixed(2), status: state.status,
    created_at: f.decision.approvedAt, updated_at: f.decision.approvedAt, notes: "private-invoice-note" });
  const port: typeof fetch = async (input, init) => {
    if (String(input) === `${base}/invoices/72`) { state.gets++; assert.equal(init?.method, "GET"); return Response.json(invoice()); }
    return f.port(input, init);
  };
  const ports = { bindings: { resolve: async () => ({ ...binding, ...(state.withWaiver ? { waiver: f.binding } : {}) }), current: () => state.mappingCurrent },
    invoices: { allows: async () => true, current: () => true }, waivers: { config: f.config, issuer: f.issuer, authority: f.authority }, native: port };
  const review = value(ClinikoFinancialSettlementReview.create(f.config, ports));
  const check = (purpose: FinancialSettlementPurpose = "collect") => review.allows(context, purpose, new AbortController().signal,
    async () => state.completeGrant, () => state.current);
  return { ...f, context, binding, invoice, port, ports, review, state, check };
}

test("open invoice context still requires the complete independent manual-payment and waiver grant", async t => {
  const f = await fixture(); t.after(f.close); assert.equal(await f.check(), true); assert.equal(f.state.gets, 1);
  f.state.completeGrant = false; assert.equal(await f.check(), false); assert.equal(f.state.gets, 1);
  assert.equal(JSON.stringify(f.review), "{}");
});
for (const status of [20, 30, 40]) for (const purpose of ["collect", "sendLink", "cancelClinical"] as const)
test(`native invoice ${status} cannot authorize ${purpose} even if an independent callback erroneously permits`, async t => {
  const f = await fixture(); t.after(f.close); f.state.status = status; assert.equal(await f.check(purpose), false);
});
for (const purpose of ["collect", "sendLink", "cancelClinical"] as const)
test(`actual current approved waiver prevents original full-amount ${purpose}`, async t => {
  const f = await fixture(); t.after(f.close); f.state.withWaiver = true; assert.equal(await f.check(purpose), false); assert.equal(f.state.gets, 1);
});
test("partial waiver cannot silently reduce and recollect an immutable existing Checkout amount", async t => {
  const f = await fixture(); t.after(f.close); f.state.withWaiver = true; f.row.notes = f.format({ ...f.decision, amount: 1000 });
  assert.equal(await f.check(), false); assert.equal(f.intent.payment.amount, 5000);
});
test("expiring the exact Checkout link retains its own independent grant despite recorded payment or waiver", async t => {
  const f = await fixture(); t.after(f.close); f.state.status = 20; f.state.withWaiver = true;
  assert.equal(await f.check("expireCheckout"), true); f.state.completeGrant = false; assert.equal(await f.check("expireCheckout"), false);
});
test("unknown or revoked selected waiver is not skipped when invoice state is known", async t => {
  const f = await fixture(); t.after(f.close); f.state.withWaiver = true; f.row.recalled = true;
  assert.equal(await f.check("expireCheckout"), false);
});
for (const change of ["patient", "action", "currency", "target"] as const)
test(`independently selected invoice/waiver ${change} mapping cannot retarget the financial owner`, async t => {
  const f = await fixture(); t.after(f.close);
  const binding = { ...f.binding, invoice: { ...f.binding.invoice } };
  if (change === "patient") binding.invoice.patientId = "22";
  if (change === "action") binding.invoice.financialActionRef = "00000000-0000-4000-8000-000000000099";
  if (change === "currency") binding.invoice.currency = "aud";
  if (change === "target") binding.targetRef = "cliniko:appointment:92";
  const ports = { ...f.ports, bindings: { resolve: async () => binding, current: () => true } };
  const review = value(ClinikoFinancialSettlementReview.create(f.config, ports));
  assert.equal(await review.allows(f.context, "collect", new AbortController().signal, async () => true, () => true), false); assert.equal(f.state.gets, 0);
});
test("a selected waiver for another intent cannot cross the financial owner binding", async t => {
  const f = await fixture(); t.after(f.close);
  const waiver = { ...f.expected, decisionRef: f.decision.actionRef, intent: { ...f.intent, patientId: "22" } };
  const review = value(ClinikoFinancialSettlementReview.create(f.config, { ...f.ports,
    bindings: { resolve: async () => ({ ...f.binding, waiver }), current: () => true } }));
  assert.equal(await review.allows(f.context, "collect", new AbortController().signal, async () => true, () => true), false); assert.equal(f.state.gets, 0);
});
test("mapping or independent authority withdrawal while native invoice waits prevents the owning effect", async t => {
  const f = await fixture(); t.after(f.close);
  const review = value(ClinikoFinancialSettlementReview.create(f.config, { ...f.ports, native: async (input, init) => {
    f.state.current = false; return f.port(input, init);
  } }));
  assert.equal(await review.allows(f.context, "collect", new AbortController().signal, async () => true, () => f.state.current), false);
});
test("review refuses a separate waiver budget even for the same native account", async t => {
  const f = await fixture(); t.after(f.close);
  assert.equal(ClinikoFinancialSettlementReview.create(f.config, { ...f.ports, waivers: { ...f.ports.waivers,
    config: { ...f.config, rateBudget: { ...f.config.rateBudget } } } }).ok, false);
});
test("abort bounds a held independent record mapping without private native transport", async t => {
  const f = await fixture(); t.after(f.close); let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
  const review = value(ClinikoFinancialSettlementReview.create(f.config, { ...f.ports,
    bindings: { resolve: async () => { entered(); return new Promise(() => {}); }, current: () => true } }));
  const stop = new AbortController(), pending = review.allows(f.context, "collect", stop.signal, async () => true, () => true);
  await ready; stop.abort(); assert.equal(await pending, false); assert.equal(f.state.gets, 0);
});


test("second-resolution native waiver remains a positive settlement observation with independent effect grants", async t => {
  const f = await fixture(); t.after(f.close);
  f.row.notes = f.format({ ...f.decision, approvedAt: "2026-11-01T09:30:00.005Z" });
  f.row.updated_at = "2026-11-01T09:30:00Z"; f.state.withWaiver = true;
  assert.equal(await f.check("expireCheckout"), true, "the current native waiver must be read successfully");
  assert.ok(f.queries.length >= 3);
  assert.equal(await f.check("collect"), false, "a positive waiver must not permit the original collection");
  f.state.completeGrant = false; const before = f.state.gets;
  assert.equal(await f.check("expireCheckout"), false); assert.equal(f.state.gets, before);
});
