import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoFinancialPendingDiscovery } from "../../src/cliniko/financial-pending-discovery.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { encodeClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import { pendingFinancialFixture } from "../support/financial-pending-discovery.ts";
import { value, now, uuid, observation, reviewDate } from "../support/financial-retention.ts";

test("pending financial discovery reads old provider-owned work without a created-time cutoff or local queue", async () => {
  const f = pendingFinancialFixture();
  f.rows.get("30")!.created_at = f.rows.get("30")!.updated_at = "2026-10-01T09:00:00.000Z";
  f.rows.get("30")!.notes = value(encodeClinikoFinancialIntent({ ...f.intent, createdAt: "2026-10-01T09:00:00.000Z" }));
  const result = value(await f.scan()); assert.equal(result.kind, "pendingContext"); assert.equal(result.scanned, 1);
  assert.equal(result.work.length, 1); assert.equal(result.work[0]?.kind, "intentContext"); assert.equal(result.attempts.length, 0);
  assert.deepEqual(f.calls.map(u => u.pathname), ["/v1/recalls", "/v1/recalls/30"]);
  assert.ok(f.grants.every(q => q.purpose === "pendingUnrecalledFinancialWork" && q.includeArchived === false && q.unrecalledAtOnly && Object.isFrozen(q)));
  assert.equal(JSON.stringify(f.scanner), "{}");
});

test("pending source and signed observation assemble exact private context without creating financial permission", async () => {
  const f = pendingFinancialFixture();
  const retained = value(await f.retainer.retainBookingObservationOnce(observation(f.intent), { intent: f.intent, intentRecallRef: "cliniko:recall:30" }, reviewDate, new AbortController().signal));
  assert.equal(retained.kind, "accepted"); f.rows.get("31")!.recalled_at = null;
  const result = value(await f.scan()); assert.equal(result.work.length, 1); assert.equal(result.work[0]?.kind, "pairedContext");
  if (result.work[0]?.kind === "pairedContext") assert.equal(result.work[0].observation.targetRef, "cliniko:appointment:91");
  assert.equal(f.rows.size, 2); assert.equal(result.attempts.length, 0); assert.ok(f.calls.every(u => u.pathname.startsWith("/v1/recalls")));
});

test("the full 500-row/50-selected pending bound uses 55 claims from the actual shared 180 budget", async () => {
  let claims = 0;
  const physical = new ClinikoReadBudget(180, () => Date.parse(now));
  const budget = { claim: () => { claims++; return physical.claim(); }, observe429: physical.observe429.bind(physical) };
  const f = pendingFinancialFixture({ native: { config: { rateBudget: budget } } });
  const template = f.row(1, true); f.rows.clear();
  for (let index = 1; index <= 500; index++) {
    const n = 1_000 + index * 10;
    const intent = { ...f.intent, actionRef: uuid(n), booking: { ...f.intent.booking, actionRef: uuid(n + 1) },
      effects: { checkout: uuid(n + 2), linkDelivery: uuid(n + 3), receiptDelivery: uuid(n + 4), checkoutExpiry: uuid(n + 5), clinicalExpiry: uuid(n + 6) } };
    const row = { ...template, id: String(index), links: { self: `https://api.au5.cliniko.com/v1/recalls/${index}` },
      ...(index <= 50 ? { notes: value(encodeClinikoFinancialIntent(intent)) } : { recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/55" } }, notes: "unrelated-private-note-canary" }) };
    f.rows.set(String(index), row);
  }
  const result = value(await f.scan()); assert.equal(result.scanned, 500); assert.equal(result.work.length, 50); assert.equal(claims, 55);
  assert.equal(f.calls.filter(u => u.pathname === "/v1/recalls").length, 5);
  assert.doesNotMatch(JSON.stringify(result), /unrelated-private-note-canary/);
  assert.equal(f.rows.size, 500);
});

for (const limit of ["rows", "selected"] as const) test(`pending financial ${limit} overflow cannot return partial context`, async () => {
  const f = pendingFinancialFixture({ list: body => Response.json(limit === "rows" ? { ...body, total_entries: 501 } : body) });
  if (limit === "selected") for (let id = 31; id <= 80; id++) f.rows.set(String(id), f.row(id, true));
  assert.equal((await f.scan()).ok, false); assert.equal(f.calls.length, 1);
});

for (const grant of ["pending", "record", "current"] as const) test(`independent ${grant} refusal yields no pending context`, async () => {
  const f = pendingFinancialFixture();
  if (grant === "pending") f.denyAccount(); if (grant === "record") f.denyRecord(); if (grant === "current") f.expirePending();
  assert.equal((await f.scan()).ok, false); if (grant !== "record") assert.equal(f.calls.length, 0);
});

test("window-read grants and producer trust cannot substitute for an explicit pending-account grant", () => {
  const f = pendingFinancialFixture();
  assert.equal(ClinikoFinancialPendingDiscovery.create(f.config, { allowsAccountRead: async () => true,
    allowsRecordRead: async () => true, current: () => true } as never, f.port).ok, false);
  assert.equal(f.calls.length, 0);
});

test("permission lost while claiming quota blocks the pending provider GET", async () => {
  const f = pendingFinancialFixture({ native: { quota: async () => { f.denyAccount(); return null; } } });
  assert.equal((await f.scan()).ok, false); assert.equal(f.calls.length, 0);
});

test("quota exhaustion after a pending list cannot disclose its partial native context", async () => {
  const f = pendingFinancialFixture({ native: { config: { rateBudget: new ClinikoReadBudget(1, () => Date.parse(now)) } } });
  const result = await f.scan(); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.kind, "rateLimited");
  assert.equal(f.calls.length, 1);
});

for (const fault of ["archived", "recalledAt", "recalled", "missingState", "foreignSelf", "foreignPatient", "futureUpdated", "badNotes"] as const)
test(`pending list ${fault} violation cannot become financial work`, async () => {
  const f = pendingFinancialFixture({ list: body => {
    const row = body.recalls[0]!;
    if (fault === "archived") row.archived_at = now;
    if (fault === "recalledAt") row.recalled_at = now;
    if (fault === "recalled") row.recalled = true;
    if (fault === "missingState") delete row.recalled_at;
    if (fault === "foreignSelf") row.links = { self: "https://other.example/recalls/30" };
    if (fault === "foreignPatient") row.patient = { links: { self: "https://other.example/patients/21" } };
    if (fault === "futureUpdated") row.updated_at = "2027-11-01T10:00:00.000Z";
    if (fault === "badNotes") row.notes = "private unknown financial notes";
    return Response.json(body);
  } });
  assert.equal((await f.scan()).ok, false);
});

test("source record edits and permission loss after list observation discard pending context", async () => {
  for (const fault of ["changed", "denied"] as const) {
    const f = pendingFinancialFixture({ native: { response: row => {
      if (fault === "changed") row.notes = "Staff changed this financial review."; else f.denyRecord();
      return Response.json(row);
    } } });
    assert.equal((await f.scan()).ok, false); assert.equal(f.calls.length, 2);
  }
});

test("changing total/page order cannot release earlier pending candidates", async () => {
  const f = pendingFinancialFixture({ list: (body, url) => Response.json(Number(url.searchParams.get("page")) === 2 ? { ...body, total_entries: 100 } : body) });
  for (let id = 31; id <= 130; id++) f.rows.set(String(id), f.row(id));
  assert.equal((await f.scan()).ok, false); assert.equal(f.calls.length, 2);
  const duplicate = pendingFinancialFixture({ list: body => Response.json({ ...body, total_entries: 2, recalls: [body.recalls[0], body.recalls[0]] }) });
  assert.equal((await duplicate.scan()).ok, false);
});

test("held pending bodies and caller cancellation terminate under the existing bounded deadline", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const f = pendingFinancialFixture({ native: { config: { deadlineMs: 30 } }, list: async () => {
      if (cancel) controller.abort(); return new Promise<Response>(() => {});
    } });
    const result = await f.scan(controller.signal); assert.equal(result.ok, false); assert.equal(f.calls.length, 1);
  }
});
