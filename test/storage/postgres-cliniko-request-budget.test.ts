import assert from "node:assert/strict";
import test, { after } from "node:test";
import { ClinikoAvailabilityReader } from "../../src/cliniko/availability.ts";
import { ClinikoPatientCandidateReader } from "../../src/cliniko/patients.ts";
import type { ClinikoBudgetOperationalEvent } from "../../src/cliniko/read-budget.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const firstDb = connectPostgres(url);
const secondDb = connectPostgres(url);
after(async () => { await Promise.all([firstDb.destroy(), secondDb.destroy()]); });

test("E2E-156 separate standalone Cliniko readers share one PostgreSQL request budget", async () => {
  const scope = { tenantId: "budget-standalone", clinicId: "clinic", locationId: "main" };
  const apiKey = "synthetic-shared-budget-key-au5";
  const events: ClinikoBudgetOperationalEvent[] = [];
  const first = new PostgresClinikoRequestBudget(firstDb, { apiKey, maxPerMinute: 1,
    onEvent: event => { events.push(event); } });
  const second = new PostgresClinikoRequestBudget(secondDb, { apiKey, maxPerMinute: 1,
    onEvent: event => { events.push(event); } });
  let outbound = 0;
  const port: typeof fetch = async input => {
    outbound += 1;
    const path = new URL(String(input)).pathname;
    if (path === "/v1/patients") return Response.json({ total_entries: 0, patients: [] });
    if (path === "/v1/businesses/11") return Response.json({ id: "11", archived_at: null,
      show_in_online_bookings: true, appointment_type_ids: ["33"], time_zone_identifier: "Australia/Sydney" });
    throw new Error("unexpected Cliniko read");
  };
  const patient = ClinikoPatientCandidateReader.create({ scope, apiKey,
    contactEmail: "test@example.com", rateBudget: first }, port);
  const availability = ClinikoAvailabilityReader.create({ scope, apiKey,
    contactEmail: "test@example.com", businessId: "11", practitionerId: "22",
    appointmentTypeId: "33", rateBudget: second }, port);
  assert.ok(patient.ok && availability.ok);
  const results = await Promise.all([
    patient.value.findByEmailAndBirthDate(scope, "test@example.com", "1990-01-01"),
    availability.value.list(scope, "2026-09-30", "2026-09-30"),
  ]);
  assert.equal(outbound, 1);
  assert.ok(results.some(result => !result.ok && result.error.kind === "rateLimited"));
  assert.deepEqual(events, ["claimRateLimited"]);
  const rows = await firstDb.selectFrom("cliniko_request_budgets").selectAll().execute();
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.budget_ref, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(rows).includes(apiKey), false);
  assert.deepEqual(Object.keys(rows[0]!).sort(), ["budget_ref", "cooldown_until_ms", "max_per_minute", "sent_at_ms"]);
});

test("E2E-157 a provider 429 fences a second standalone process", async () => {
  const apiKey = "synthetic-429-budget-key-au5";
  const events: ClinikoBudgetOperationalEvent[] = [];
  const first = new PostgresClinikoRequestBudget(firstDb, { apiKey, maxPerMinute: 2,
    onEvent: event => { events.push(event); } });
  const second = new PostgresClinikoRequestBudget(secondDb, { apiKey, maxPerMinute: 2,
    onEvent: event => { events.push(event); } });
  const reset = String(Math.floor(Date.now() / 1_000) + 90);
  let outbound = 0;
  const port: typeof fetch = async () => {
    outbound += 1;
    return new Response(null, { status: 429, headers: { "X-RateLimit-Reset": reset } });
  };
  const scope = { tenantId: "budget-429", clinicId: "clinic", locationId: "main" };
  const patient = ClinikoPatientCandidateReader.create({ scope, apiKey,
    contactEmail: "test@example.com", rateBudget: first }, port);
  const availability = ClinikoAvailabilityReader.create({ scope, apiKey,
    contactEmail: "test@example.com", businessId: "11", practitionerId: "22",
    appointmentTypeId: "33", rateBudget: second }, port);
  assert.ok(patient.ok && availability.ok);
  const observed = await patient.value.findByEmailAndBirthDate(scope, "test@example.com", "1990-01-01");
  assert.equal(observed.ok, false);
  if (observed.ok) return;
  assert.equal(observed.error.kind, "rateLimited");
  assert.deepEqual(await availability.value.list(scope, "2026-09-30", "2026-09-30"), observed);
  assert.equal(outbound, 1);
  assert.deepEqual(events, ["provider429", "claimRateLimited"]);
});

test("E2E-158 budget storage loss prevents a standalone Cliniko read", async () => {
  const apiKey = "synthetic-down-key-au5";
  const unavailableDb = connectPostgres("postgresql://postgres@127.0.0.1:1/unavailable");
  try {
    const events: ClinikoBudgetOperationalEvent[] = [];
    const unavailable = new PostgresClinikoRequestBudget(unavailableDb, { apiKey,
      onEvent: event => { events.push(event); } });
    let outbound = 0;
    const reader = ClinikoPatientCandidateReader.create({ scope: { tenantId: "budget-down", clinicId: "clinic" },
      apiKey, contactEmail: "test@example.com", rateBudget: unavailable },
    async () => { outbound += 1; return Response.json({ total_entries: 0, patients: [] }); });
    assert.ok(reader.ok);
    assert.deepEqual(await reader.value.findByEmailAndBirthDate({ tenantId: "budget-down", clinicId: "clinic" },
      "test@example.com", "1990-01-01"), { ok: false, error: { kind: "unavailable" } });
    assert.equal(outbound, 0);
    assert.deepEqual(events, ["claimUnavailable"]);
  } finally { await unavailableDb.destroy(); }
});

test("a diagnostic callback failure does not change budget outcomes", async () => {
  const budget = new PostgresClinikoRequestBudget(firstDb, {
    apiKey: "synthetic-callback-fault-au5", maxPerMinute: 1,
    onEvent: () => { throw new Error("diagnostic failure"); },
  });
  assert.equal(await budget.claim(), null);
  assert.equal((await budget.claim())?.kind, "rateLimited");
  assert.equal((await budget.observe429(null)).kind, "rateLimited");
  const asyncBudget = new PostgresClinikoRequestBudget(firstDb, {
    apiKey: "synthetic-async-callback-fault-au5", maxPerMinute: 1,
    onEvent: async () => { throw new Error("asynchronous diagnostic failure"); },
  });
  assert.equal(await asyncBudget.claim(), null);
  assert.equal((await asyncBudget.claim())?.kind, "rateLimited");
  assert.equal((await asyncBudget.observe429(null)).kind, "rateLimited");
});

test("E2E-159 one configured user group shares a budget across distinct keys", async () => {
  const first = new PostgresClinikoRequestBudget(firstDb, { apiKey: "synthetic-first-key-au5",
    sharedUserRef: "synthetic-user-e2e-156", maxPerMinute: 1 });
  const second = new PostgresClinikoRequestBudget(secondDb, { apiKey: "synthetic-second-key-au5",
    sharedUserRef: "synthetic-user-e2e-156", maxPerMinute: 1 });
  const claims = await Promise.all([first.claim(), second.claim()]);
  assert.equal(claims.filter(claim => claim === null).length, 1);
  assert.equal(claims.filter(claim => claim?.kind === "rateLimited").length, 1);
});

test("E2E-160 conflicting limits for one Cliniko user fail closed", async () => {
  const first = new PostgresClinikoRequestBudget(firstDb, { apiKey: "synthetic-consistent-key-au5",
    sharedUserRef: "synthetic-user-e2e-160", maxPerMinute: 1 });
  assert.equal(await first.claim(), null);
  const misconfigured = new PostgresClinikoRequestBudget(secondDb, { apiKey: "synthetic-other-key-au5",
    sharedUserRef: "synthetic-user-e2e-160", maxPerMinute: 2 });
  assert.deepEqual(await misconfigured.claim(), { kind: "unavailable" });
});
