import assert from "node:assert/strict";
import test from "node:test";
import { financialFeePolicyFixture } from "../support/financial-fee-policy.ts";
import { value } from "../support/financial-retention.ts";
import { ClinikoFinancialBookingRecipient } from "../../src/cliniko/financial-booking-recipient.ts";
import type { FinancialRecipientAuthority } from "../../src/cliniko/financial-booking-recipient.ts";
const signal = () => new AbortController().signal;
async function fixture() {
  const f = await financialFeePolicyFixture(), state = Object.assign(f.state, { allowed: true, current: true, posts: 0, gets: 0, address: "patient-financial@example.invalid" });
  const selection = { ...f.selection, credentialFingerprint: f.selection.credentialFingerprint }, queries: unknown[] = [];
  selection.credentialFingerprint = f.retained.intent.credentialFingerprint;
  const config = { ...f.native, clock: () => f.state.now };
  const authority: FinancialRecipientAuthority = { allows: async q => { queries.push(q); return state.allowed; }, current: () => state.current };
  const port: typeof fetch = async (input, init) => {
    assert.equal(String(input), `https://api.au5.cliniko.com/v1/patients/${selection.patientId}`);
    assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error"); state.gets++;
    assert.equal(new Headers(init.headers).get("Authorization"), `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`);
    return Response.json({ id: selection.patientId, archived_at: null, email: state.address, notes: "private-recipient-chart-canary" });
  };
  return { ...f, selection, config, state, authority, port, queries,
    create: (p: typeof fetch = port, a = authority) => value(ClinikoFinancialBookingRecipient.create(config, a, p)) };
}

test("financial recipient reads only exact registered patient with independent purpose admission", async t => {
  const f = await fixture(); t.after(f.close); const reader = f.create(), found = await reader.read(f.selection, signal()); assert.ok(found);
  assert.deepEqual(found.recipient, { kind: "email", address: f.state.address });
  assert.equal(reader.currentForSend(f.selection, found.recipient, signal()), true);
  assert.equal(JSON.stringify(reader), "{}"); assert.equal(JSON.stringify(found).includes("private-recipient-chart-canary"), false);
  assert.equal(f.queries.length, 3);
});
for (const field of ["scope", "businessId", "credentialFingerprint", "patientId", "expiresAt"] as const)
test(`financial recipient refuses invalid ${field} before private transport`, async t => {
  const f = await fixture(); t.after(f.close); const changed = { ...f.selection };
  if (field === "scope") changed.scope = { ...changed.scope, locationId: "other" };
  else changed[field] = field === "expiresAt" ? f.state.now : "invalid";
  assert.equal(await f.create().read(changed, signal()), undefined); assert.equal(f.state.gets, 0);
});
for (const permission of ["allows", "current"] as const)
test(`financial recipient requires independent ${permission} grant`, async t => {
  const f = await fixture(); t.after(f.close);
  const authority: FinancialRecipientAuthority = permission === "allows" ? { ...f.authority, allows: async () => false } : { ...f.authority, current: () => false };
  assert.equal(await f.create(f.port, authority).read(f.selection, signal()), undefined); assert.equal(f.state.gets, 0);
});
for (const patch of [{ id: "99" }, { archived_at: "2026-11-01T00:00:00.000Z" }, { email: "bad\nmail@example.invalid" }, { email: null }])
test("financial recipient refuses mismatched, archived or malformed private patient rows", async t => {
  const f = await fixture(); t.after(f.close);
  const reader = f.create(async () => Response.json({ id: f.selection.patientId, archived_at: null, email: f.state.address, ...patch }));
  assert.equal(await reader.read(f.selection, signal()), undefined);
});

test("financial recipient rechecks permission after a held physical quota wait", async t => {
  const f = await fixture(); t.after(f.close); let allowed = true, reads = 0;
  const config = { ...f.config, rateBudget: { ...f.config.rateBudget, claim: async () => { allowed = false; return null; } } };
  const reader = value(ClinikoFinancialBookingRecipient.create(config, { allows: async () => allowed, current: () => allowed }, async () => { reads++; return f.port(""); }));
  assert.equal(await reader.read(f.selection, signal()), undefined); assert.equal(reads, 0);
});

test("financial recipient rechecks permission after receiving private bytes", async t => {
  const f = await fixture(); t.after(f.close); let allowed = true;
  const reader = f.create(async () => { allowed = false; return Response.json({ id: f.selection.patientId, archived_at: null, email: f.state.address }); },
    { allows: async () => allowed, current: () => allowed });
  assert.equal(await reader.read(f.selection, signal()), undefined);
});

test("current financial recipient grant withdrawal and changed selection close continuation", async t => {
  const f = await fixture(); t.after(f.close); let current = true;
  const reader = f.create(f.port, { ...f.authority, current: () => current }), found = await reader.read(f.selection, signal()); assert.ok(found);
  assert.equal(reader.currentForSend({ ...f.selection, patientId: "99" }, found.recipient, signal()), false);
  current = false; assert.equal(reader.currentForSend(f.selection, found.recipient, signal()), false);
});

test("abort bounds a held financial recipient response and keeps late bytes private", { timeout: 3000 }, async t => {
  const f = await fixture(); t.after(f.close); let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
  const reader = f.create(async () => { entered(); return new Promise(() => {}); }), controller = new AbortController();
  const pending = reader.read(f.selection, controller.signal); await ready; controller.abort(); assert.equal(await pending, undefined);
});

test("financial recipient refuses transport after the offer expires during quota wait", async t => {
  const f = await fixture(); t.after(f.close); let reads = 0;
  const config = { ...f.config, rateBudget: { ...f.config.rateBudget, claim: async () => { f.state.now = f.selection.expiresAt; return null; } } };
  const reader = value(ClinikoFinancialBookingRecipient.create(config, f.authority, async () => { reads++; throw new Error("Must not read expired context"); }));
  assert.equal(await reader.read(f.selection, signal()), undefined); assert.equal(reads, 0);
});

test("financial recipient deadline bounds a held body stream", { timeout: 3000 }, async t => {
  const f = await fixture(); t.after(f.close); let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
  const reader = value(ClinikoFinancialBookingRecipient.create({ ...f.config, deadlineMs: 1000 }, f.authority,
    async () => new Response(new ReadableStream({ start() { entered(); } }))));
  t.mock.timers.enable({ apis: ["setTimeout"] }); const pending = reader.read(f.selection, signal()); await ready; t.mock.timers.tick(1000);
  assert.equal(await pending, undefined);
});
