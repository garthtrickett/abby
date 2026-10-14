import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoAppointmentReader } from "../../src/cliniko/appointments.ts";
import { ClinikoAvailabilityReader } from "../../src/cliniko/availability.ts";
import { ClinikoPatientCandidateReader } from "../../src/cliniko/patients.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { checkClinikoHeadroom } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";

const scope = { tenantId: "budget-tenant", clinicId: "budget-clinic", locationId: "budget-location" };
const apiKey = "synthetic-key-au5";
const contactEmail = "dev@example.test";

test("E2E-402 headroom reports a relative wait on its own clock and rejects malformed host delays", async () => {
  let now = 1234000; const budget = new ClinikoReadBudget(2, () => now);
  assert.equal(budget.claim(), null); now += 15000;
  assert.deepEqual(await checkClinikoHeadroom(budget, 2), { kind: "rateLimited", resetAt: new Date(1294000).toISOString(), retryAfterMs: 45000 });
  assert.equal(budget.claim(), null, "headroom has not reserved the remaining claim");
  for (const retryAfterMs of [0, -1, 1.5, NaN, Infinity, 8_640_000_001]) {
    assert.equal((await checkClinikoHeadroom({ claim: () => null, observe429: () => ({ kind: "rateLimited" }),
      checkHeadroom: () => ({ kind: "rateLimited", retryAfterMs }) }, 1))?.kind, "unavailable");
  }
});

test("E2E-398 headroom checks do not consume or reserve quota, respect cooldown and reject unavailable hosts", async () => {
  let now = 180000;
  const budget = new ClinikoReadBudget(3, () => now);
  assert.equal(await checkClinikoHeadroom(budget, 3), null); assert.equal(await checkClinikoHeadroom(budget, 3), null);
  assert.equal(budget.claim(), null); assert.equal((await checkClinikoHeadroom(budget, 3))?.kind, "rateLimited");
  assert.equal(await checkClinikoHeadroom(budget, 2), null); assert.equal(budget.claim(), null); assert.equal(budget.claim(), null);
  assert.equal(budget.claim()?.kind, "rateLimited"); now += 60001; assert.equal(await checkClinikoHeadroom(budget, 3), null);
  budget.observe429(null); assert.equal((await checkClinikoHeadroom(budget, 1))?.kind, "rateLimited");
  for (const count of [0, -1, 201, 1.5]) assert.equal((await checkClinikoHeadroom(budget, count))?.kind, "unavailable");
  assert.equal((await checkClinikoHeadroom({ claim: () => null, observe429: () => ({ kind: "rateLimited" }) }, 1))?.kind, "unavailable");
});

test("one provider 429 stops patient, availability, and appointment reads until its reset", async () => {
  let now = Date.parse("2026-09-29T00:00:00.000Z");
  const resetAt = "2026-09-29T00:01:00.000Z";
  const budget = new ClinikoReadBudget(200, () => now);
  const requests: string[] = [];
  const port: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    assert.equal(init?.method, "GET");
    if (url.pathname === "/v1/patients") {
      return new Response(null, { status: 429, headers: { "X-RateLimit-Reset": String(Date.parse(resetAt) / 1000) } });
    }
    if (url.pathname === "/v1/businesses/11") return Response.json({ id: "11", archived_at: null,
      show_in_online_bookings: true, appointment_type_ids: ["33"], time_zone_identifier: "Australia/Sydney" });
    if (url.pathname === "/v1/practitioners/22" || url.pathname === "/v1/appointment_types/33") {
      return Response.json({ id: url.pathname.split("/").at(-1), archived_at: null, active: true,
        show_in_online_bookings: true });
    }
    if (url.pathname === "/v1/businesses/11/practitioners") {
      return Response.json({ total_entries: 1, practitioners: [{ id: "22" }] });
    }
    if (url.pathname === "/v1/practitioners/22/appointment_types") {
      return Response.json({ total_entries: 1, appointment_types: [{ id: "33" }] });
    }
    if (url.pathname.endsWith("/available_times")) {
      return Response.json({ total_entries: 1, available_times: [{ appointment_start: "2026-09-30T11:00:00Z" }] });
    }
    if (url.pathname === "/v1/individual_appointments") {
      return Response.json({ total_entries: 1, individual_appointments: [{ id: "55", starts_at: "2026-09-30T11:00:00Z",
        ends_at: "2026-09-30T11:30:00Z", cancelled_at: null, archived_at: null, deleted_at: null,
        patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/44" } },
        business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/11" } } }] });
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };
  const patient = ClinikoPatientCandidateReader.create({ scope, apiKey, contactEmail, rateBudget: budget },
    port, () => new Date(now).toISOString());
  const availability = ClinikoAvailabilityReader.create({ scope, apiKey, contactEmail, businessId: "11",
    practitionerId: "22", appointmentTypeId: "33", rateBudget: budget }, port, () => new Date(now).toISOString());
  const proof = new ReferenceClinicHost([{ scope, patientRef: "44", verificationRef: "proof-44",
    expiresAt: "2026-09-30T00:00:00Z" }], []);
  const appointments = ClinikoAppointmentReader.create({ scope, apiKey, contactEmail, businessId: "11", rateBudget: budget },
    proof, port, () => new Date(now).toISOString());
  assert.ok(patient.ok && availability.ok && appointments.ok);

  const first = await patient.value.findByEmailAndBirthDate(scope, "test@example.test", "1990-01-01");
  assert.deepEqual(first, { ok: false, error: { kind: "rateLimited", resetAt } });
  assert.deepEqual(await availability.value.list(scope, "2026-09-30", "2026-10-01"), first);
  assert.deepEqual(await appointments.value.list(scope, "proof-44", resetAt, "2026-10-01T00:00:00Z",
    new Date(now).toISOString()), first);
  assert.deepEqual(requests, ["/v1/patients"]);

  now = Date.parse(resetAt);
  const times = await availability.value.list(scope, "2026-09-30", "2026-10-01");
  assert.equal(times.ok, true);
  if (times.ok) assert.equal(times.value.kind, "times");
  const found = await appointments.value.list(scope, "proof-44", resetAt, "2026-10-01T00:00:00Z", resetAt);
  assert.equal(found.ok, true);
  if (found.ok) assert.deepEqual(found.value.appointments.map(row => row.appointmentRef), ["55"]);
  assert.equal(requests.length, 9);
});

test("the local minute budget and unknown provider reset fail closed, then reopen", () => {
  let now = Date.parse("2026-09-29T00:00:00.000Z");
  const budget = new ClinikoReadBudget(2, () => now);
  assert.equal(budget.claim(), null);
  assert.equal(budget.claim(), null);
  assert.deepEqual(budget.claim(), { kind: "rateLimited", resetAt: "2026-09-29T00:01:00.000Z" });
  now += 60_000;
  assert.equal(budget.claim(), null);
  assert.deepEqual(budget.observe429("unparseable"), { kind: "rateLimited", resetAt: "2026-09-29T00:02:00.000Z" });
  assert.deepEqual(budget.claim(), { kind: "rateLimited", resetAt: "2026-09-29T00:02:00.000Z" });
  now += 60_000;
  assert.equal(budget.claim(), null);
});

test("parallel patient readers cannot spend the same final request slot", async () => {
  const now = Date.parse("2026-09-29T00:00:00.000Z");
  const budget = new ClinikoReadBudget(1, () => now);
  let sent = 0;
  const port: typeof fetch = async () => {
    sent += 1;
    return Response.json({ total_entries: 0, patients: [] });
  };
  const config = { scope, apiKey, contactEmail, rateBudget: budget };
  const first = ClinikoPatientCandidateReader.create(config, port, () => new Date(now).toISOString());
  const second = ClinikoPatientCandidateReader.create(config, port, () => new Date(now).toISOString());
  assert.ok(first.ok && second.ok);
  const results = await Promise.all([
    first.value.findByEmailAndBirthDate(scope, "test@example.test", "1990-01-01"),
    second.value.findByEmailAndBirthDate(scope, "test@example.test", "1990-01-01"),
  ]);
  assert.deepEqual(results.map(result => result.ok ? "none" : result.error.kind), ["none", "rateLimited"]);
  assert.equal(sent, 1);
});

test("a faulty host budget fails closed before a Cliniko request", async () => {
  let sent = 0;
  const port: typeof fetch = async () => { sent += 1; return Response.json({ total_entries: 0, patients: [] }); };
  for (const claim of [async () => { throw new Error("budget offline"); }, async () => undefined]) {
    const rateBudget = { claim, observe429: async () => ({ kind: "rateLimited" as const }) } as unknown as ClinikoRequestBudget;
    const reader = ClinikoPatientCandidateReader.create({ scope, apiKey, contactEmail,
      rateBudget }, port);
    assert.ok(reader.ok);
    assert.deepEqual(await reader.value.findByEmailAndBirthDate(scope, "test@example.test", "1990-01-01"),
      { ok: false, error: { kind: "unavailable" } });
  }
  assert.equal(sent, 0);
});
