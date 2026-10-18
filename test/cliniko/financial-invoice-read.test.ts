import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoFinancialInvoiceReader } from "../../src/cliniko/financial-invoice-read.ts";
import type { FinancialInvoiceAuthority, FinancialInvoiceBinding } from "../../src/cliniko/financial-invoice-read.ts";
import { fixture as retained, value, uuid, base, now, stop } from "../support/financial-retention.ts";

function fixture() {
  const f = retained(), state = { now, allowed: true, current: true, reads: 0, quota: 0, cooldown: 0 };
  const config = { ...f.config, clock: () => state.now, rateBudget: {
    claim: async () => { state.quota++; return null; }, checkHeadroom: async () => null,
    observe429: async () => { state.cooldown++; return { kind: "rateLimited" as const }; },
  } };
  const binding: FinancialInvoiceBinding = { financialActionRef: uuid(1), invoiceRef: "71", patientId: "21", bookingId: "91",
    expectedTotalMinor: 5000, currency: "gbp", expiresAt: "2026-11-01T10:01:00.000Z" };
  const row = { id: "71", links: { self: `${base}/invoices/71` }, patient: { links: { self: `${base}/patients/21` } },
    business: { links: { self: `${base}/businesses/11` } }, booking: { links: { self: `${base}/bookings/91` } },
    attendee: { links: { self: `${base}/attendees/81` } }, archived_at: null, deleted_at: null,
    total_amount: "50.0", status: 20, created_at: "2026-10-31T10:00:00Z", updated_at: now,
    notes: "private-financial-notes", invoice_to: "private-patient-address", online_payment_url: "https://private.invalid/link" };
  const queries: unknown[] = [], signals: AbortSignal[] = [];
  const authority: FinancialInvoiceAuthority = { allows: async (q, signal) => { queries.push(q); signals.push(signal); return state.allowed; }, current: () => state.current };
  const port: typeof fetch = async (input, init) => {
    assert.equal(String(input), `${base}/invoices/71`); assert.equal(init?.method, "GET"); assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("Authorization"), `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`);
    state.reads++; return Response.json(row);
  };
  return { config, binding, row, state, authority, port, queries, signals,
    create: (transport = port, grants = authority, settings = config) => value(ClinikoFinancialInvoiceReader.create(settings, grants, transport)) };
}

test("exact invoice read preserves current financial mapping and only bounded native state", async () => {
  const f = fixture(), reader = f.create(), found = value(await reader.read(f.binding, stop()));
  assert.deepEqual(found, { state: "recordedPaid", totalMinor: 5000, currency: "gbp", observedAt: now, updatedAt: now });
  assert.equal(f.state.reads, 1); assert.equal(f.state.quota, 1); assert.equal(f.queries.length, 3);
  assert.equal(f.queries[0], f.queries[1]); assert.equal(f.queries[1], f.queries[2]); assert.equal(f.signals[0], f.signals[2]);
  assert.ok(Object.isFrozen((f.queries[0] as { binding: object }).binding));
  assert.equal(JSON.stringify(reader), "{}"); assert.equal(JSON.stringify(found).includes("private"), false);
});
for (const [status, expected] of [[10, "open"], [20, "recordedPaid"], [30, "closed"], [40, "openCredit"]] as const)
test(`native status ${status} remains ${expected}, without inventing unpaid, received or waived`, async () => {
  const f = fixture(); f.row.status = status; const result = value(await f.create().read(f.binding, stop()));
  assert.equal(result.state, expected); assert.equal(Object.hasOwn(result, "waived"), false); assert.equal(Object.hasOwn(result, "received"), false);
});
for (const [total, expected] of [["50", 5000], ["50.0", 5000], ["50.01", 5001], ["0.01", 1], ["-0.01", -1], ["0", 0]] as const)
test(`invoice decimal ${total} is compared exactly in minor units`, async () => {
  const f = fixture(); f.row.total_amount = total;
  assert.equal(value(await f.create().read({ ...f.binding, expectedTotalMinor: expected }, stop())).totalMinor, expected);
});
for (const total of ["50.001", "5e1", " 50", "050.00", "NaN", "5000000000", "+50.00"])
test("invalid or overprecision invoice totals cannot be rounded into the approved obligation", async () => {
  const f = fixture(); f.row.total_amount = total; assert.equal((await f.create().read(f.binding, stop())).ok, false);
});
for (const patch of [{ invoiceRef: "../invoices" }, { patientId: "" }, { financialActionRef: "arbitrary-note" }, { expectedTotalMinor: 1.1 },
  { currency: "jpy" }, { expiresAt: now }, { privateContext: "private" }])
test("invalid invoice binding refuses before private native transport or quota", async () => {
  const f = fixture(); assert.equal((await f.create().read({ ...f.binding, ...patch }, stop())).ok, false);
  assert.equal(f.state.reads, 0); assert.equal(f.state.quota, 0);
});
for (const patch of [{ id: "72" }, { links: { self: `${base}/invoices/72` } }, { patient: { links: { self: `${base}/patients/22` } } },
  { business: { links: { self: `${base}/businesses/12` } } }, { booking: { links: { self: `${base}/bookings/92` } } },
  { archived_at: now }, { deleted_at: now }, { total_amount: "49.99" }, { status: 0 }, { updated_at: "2026-11-02T00:00:00Z" }])
test("wrong, archived, deleted, changed, unknown or future invoice evidence refuses", async () => {
  const f = fixture(); const reader = f.create(async () => Response.json({ ...f.row, ...patch }));
  assert.equal((await reader.read(f.binding, stop())).ok, false);
});
test("class payment binding needs the independently selected exact attendee, not a shared occurrence", async () => {
  const f = fixture(), reader = f.create();
  assert.equal((await reader.read({ ...f.binding, attendeeId: "81" }, stop())).ok, true);
  assert.equal((await reader.read({ ...f.binding, attendeeId: "82" }, stop())).ok, false);
});
test("invoice permission withdrawn during quota wait prevents GET", async () => {
  const f = fixture(), config = { ...f.config, rateBudget: { ...f.config.rateBudget, claim: async () => { f.state.allowed = false; return null; } } };
  assert.equal((await f.create(f.port, f.authority, config).read(f.binding, stop())).ok, false); assert.equal(f.state.reads, 0);
});
test("invoice permission withdrawn after private body cannot publish evidence", async () => {
  const f = fixture(); const reader = f.create(async () => { f.state.allowed = false; return Response.json(f.row); });
  assert.equal((await reader.read(f.binding, stop())).ok, false);
});
test("unknown physical quota refuses without a GET", async () => {
  const f = fixture(), config = { ...f.config, rateBudget: { ...f.config.rateBudget, claim: async () => ({ kind: "rateLimited" as const }) } };
  assert.equal((await f.create(f.port, f.authority, config).read(f.binding, stop())).ok, false); assert.equal(f.state.reads, 0);
});
test("native 429 is observed on the existing account budget with no alternate request", async () => {
  const f = fixture(); const reader = f.create(async () => { f.state.reads++; return new Response(null, { status: 429 }); });
  assert.equal((await reader.read(f.binding, stop())).ok, false); assert.equal(f.state.cooldown, 1); assert.equal(f.state.reads, 1);
});
for (const next of ["2026-11-01T09:59:59.000Z", "2026-11-01T10:01:00.000Z"])
test("backwards clock or expired approval during quota cannot dispatch", async () => {
  const f = fixture(), config = { ...f.config, rateBudget: { ...f.config.rateBudget, claim: async () => { f.state.now = next; return null; } } };
  assert.equal((await f.create(f.port, f.authority, config).read(f.binding, stop())).ok, false); assert.equal(f.state.reads, 0);
});
test("abort bounds ignored native fetch and private errors never escape", async () => {
  const f = fixture(); let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const reader = f.create(async () => { entered(); return new Promise(() => {}); }), controller = new AbortController();
  const pending = reader.read(f.binding, controller.signal); await ready; controller.abort();
  assert.equal((await pending).ok, false);
  const failed = await f.create(async () => { throw new Error("private-provider-error"); }).read(f.binding, stop());
  assert.deepEqual(failed, { ok: false, error: { kind: "unavailable" } });
});
test("held private body is bounded by the original invoice read deadline", { timeout: 3000 }, async t => {
  const f = fixture(); let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const reader = f.create(async () => new Response(new ReadableStream({ start() { entered(); } })), f.authority, { ...f.config, deadlineMs: 1000 });
  t.mock.timers.enable({ apis: ["setTimeout"] }); const pending = reader.read(f.binding, stop()); await ready; t.mock.timers.tick(1000);
  assert.equal((await pending).ok, false);
});
