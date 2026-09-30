import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { ClinikoAvailabilityReader } from "../../src/cliniko/availability.ts";
import { ClinikoPatientCandidateReader } from "../../src/cliniko/patients.ts";
import type { CallState } from "../../src/core/model.ts";
import type { Result } from "../../src/core/model.ts";
import type { PreparedAvailabilityText } from "../../src/reference/availability-text-runner.ts";
import { StandaloneAvailabilityTextRunner } from "../../src/standalone/availability-text-runner.ts";
import { ClinikoPhoneLookup } from "../../src/standalone/cliniko-phone-lookup.ts";
import { createStandaloneTextComposition } from "../../src/standalone/text-composition.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresPatientPhoneIndex } from "../../src/storage/postgres-patient-phone-index.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";

function value<T, E>(result: Result<T, E>): T {
  assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.error));
  return result.value;
}
function object(raw: unknown): Record<string, unknown> {
  assert.ok(raw && typeof raw === "object" && !Array.isArray(raw));
  return raw as Record<string, unknown>;
}
function rows(raw: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(raw));
  return raw.map(object);
}
function dateInZone(instant: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit",
    day: "2-digit", calendar: "gregory", numberingSystem: "latn" }).formatToParts(instant);
  const part = (type: string) => parts.find(item => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function nextDay(zone: string): string {
  const today = dateInZone(new Date(), zone);
  return new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
function slotOnDay(day: string, zone: string): string {
  const base = Date.parse(`${day}T00:00:00Z`);
  for (let offset = -24; offset <= 24; offset += 1) {
    const instant = new Date(base + offset * 3_600_000);
    if (dateInZone(instant, zone) === day && instant.toISOString().slice(0, 10) !== day) return instant.toISOString();
  }
  for (let offset = -24; offset <= 24; offset += 1) {
    const instant = new Date(base + offset * 3_600_000);
    if (dateInZone(instant, zone) === day) return instant.toISOString();
  }
  throw new Error("no clinic-local slot instant");
}

/** Live GETs anchor the demo profile; edge responses below are controlled injections. No provider writes occur. */
test("C-LIVE-18 demo-backed read-only availability and phone failure journey",
  { skip: process.env.ABBY_LIVE_CLINIKO_EVAL !== "1" || process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" ||
    !process.env.ABBY_CLINIKO_API_KEY || !process.env.ABBY_CLINIKO_CONTACT_EMAIL, timeout: 120_000 }, async () => {
  const apiKey = process.env.ABBY_CLINIKO_API_KEY!;
  const contactEmail = process.env.ABBY_CLINIKO_CONTACT_EMAIL!;
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const shard = apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1];
  assert.ok(shard);
  const base = `https://api.${shard}.cliniko.com/v1`;
  const headers = { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
    "User-Agent": `Abby (${contactEmail})` };
  let liveGets = 0;
  const get = async (path: string): Promise<Record<string, unknown>> => {
    liveGets += 1;
    const response = await fetch(`${base}${path}`, { method: "GET", headers, redirect: "error",
      signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, 200, `demo GET ${path.split("?")[0]} failed`);
    const raw = await response.text();
    assert.ok(raw.length <= 1_000_000);
    return object(JSON.parse(raw) as unknown);
  };
  const admin = connectPostgres(adminUrl);
  const name = `abby_readonly_edges_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  let created = false;
  let db: ReturnType<typeof connectPostgres> | undefined;
  try {
    const business = rows((await get("/businesses?page=1&per_page=100")).businesses)[0];
    const practitioner = rows((await get("/practitioners?page=1&per_page=100")).practitioners)[0];
    const appointmentType = rows((await get("/appointment_types?page=1&per_page=100")).appointment_types)
      .find(item => item.show_in_online_bookings === true);
    assert.ok(business && practitioner && appointmentType);
    const businessId = String(business.id);
    const practitionerId = String(practitioner.id);
    const typeId = String(appointmentType.id);
    assert.match(businessId, /^[1-9]\d*$/);
    assert.match(practitionerId, /^[1-9]\d*$/);
    assert.match(typeId, /^[1-9]\d*$/);
    const zone = business.time_zone_identifier;
    assert.equal(typeof zone, "string");
    const day = nextDay(zone as string);
    const startsAt = slotOnDay(day, zone as string);
    const businessPractitioners = await get(`/businesses/${businessId}/practitioners?page=1&per_page=100`);
    const practitionerTypes = await get(`/practitioners/${practitionerId}/appointment_types?page=1&per_page=100`);
    assert.ok(rows(businessPractitioners.practitioners).some(item => String(item.id) === practitionerId));
    assert.ok(rows(practitionerTypes.appointment_types).some(item => String(item.id) === typeId));
    const patientList = await get("/patients?page=1&per_page=1");
    assert.ok(Number.isSafeInteger(patientList.total_entries));
    await sql.raw(`create database "${name}"`).execute(admin);
    created = true;
    db = connectPostgres(target.toString());
    await migrate(db);
    const suffix = randomUUID().slice(0, 8);
    const scope = { tenantId: `readonly-${suffix}`, clinicId: "demo", locationId: "frontdesk" };
    const config = { scope, apiKey, contactEmail, businessId, practitionerId, appointmentTypeId: typeId };
    const control = value(ClinikoAvailabilityReader.create(config, async (input, init) => {
      assert.equal(init?.method, "GET");
      return fetch(input, init);
    }));
    const observed = await control.list(scope, day, day);
    assert.ok(observed.ok || ["rateLimited", "unavailable"].includes(observed.error.kind));
    if (observed.ok && observed.value.kind === "times") {
      assert.equal(observed.value.timeZone, zone);
      assert.equal(observed.value.reservable, false);
    }
    const appointmentId = `synthetic-appointment-${suffix}`;
    const callerText = `synthetic-caller-${suffix}`;
    for (const scenario of ["shown", "empty", "rateLimited", "partialFailure"] as const) {
      const methods: string[] = [];
      const reader: ClinikoAvailabilityReader = value(ClinikoAvailabilityReader.create(config,
        async (input, init): Promise<Response> => {
        methods.push(init?.method ?? "GET");
        assert.equal(init?.method, "GET");
        const url = new URL(String(input));
        const path = url.pathname;
        if (path === `/v1/businesses/${businessId}`) return Response.json({ ...business, show_in_online_bookings: true });
        if (path === `/v1/practitioners/${practitionerId}`) return Response.json(practitioner);
        if (path === `/v1/appointment_types/${typeId}`) return Response.json(appointmentType);
        if (path === `/v1/businesses/${businessId}/practitioners`) return Response.json(businessPractitioners);
        if (path === `/v1/practitioners/${practitionerId}/appointment_types`) return Response.json(practitionerTypes);
        if (path.endsWith("/available_times")) {
          if (scenario === "rateLimited") return new Response(null, { status: 429 });
          if (scenario === "partialFailure") {
            if (url.searchParams.get("page") === "2") return new Response(null, { status: 503 });
            return Response.json({ total_entries: 101,
              available_times: Array.from({ length: 100 }, (_, index) => ({
                appointment_start: new Date(Date.parse(startsAt) + index * 60_000).toISOString(),
                appointment_id: `${appointmentId}-${index}` })) });
          }
          return Response.json({ total_entries: scenario === "shown" ? 1 : 0,
            available_times: scenario === "shown" ? [{ appointment_start: startsAt,
              appointment_id: appointmentId }] : [] });
        }
        throw new Error("unexpected edge read");
      }));
      const direct: Awaited<ReturnType<ClinikoAvailabilityReader["list"]>> = await reader.list(scope, day, day);
      if (scenario === "rateLimited" || scenario === "partialFailure") {
        assert.equal(direct.ok, false);
        assert.equal(direct.error.kind, scenario === "rateLimited" ? "rateLimited" : "unavailable");
      } else {
        assert.ok(direct.ok);
        assert.equal(direct.value.kind, "times");
        if (direct.value.kind === "times") {
          assert.equal(direct.value.timeZone, zone);
          assert.equal(direct.value.startsAt.length, scenario === "shown" ? 1 : 0);
        }
      }
      const runner: StandaloneAvailabilityTextRunner = new StandaloneAvailabilityTextRunner(db, scope, reader,
        () => new Date().toISOString());
      const prepared: PreparedAvailabilityText = value(await runner.prepare({ text: callerText, from: day, to: day }));
      assert.equal(prepared.status, scenario === "shown" ? "shown" : scenario === "empty" ? "empty" : "failed");
      assert.doesNotMatch(prepared.message, /confirmed appointment|staff (has|will) (receive|contact)/i);
      assert.ok((await runner.confirmWritten(prepared)).ok);
      const state: CallState = value(await createStandaloneTextComposition(db, reader).reception.read(scope, prepared.callId));
      assert.deepEqual(state.actions, {});
      assert.deepEqual(state.staffItems, {});
      assert.ok(methods.length >= 6 && methods.every(method => method === "GET"));
    }
    const phoneScope = { tenantId: scope.tenantId, clinicId: scope.clinicId };
    const phone = "+61400111222";
    let secondCurrent = true;
    const patientReader = value(ClinikoPatientCandidateReader.create({ scope: phoneScope, apiKey, contactEmail },
      async (input, init) => {
        assert.equal(init?.method, "GET");
        const path = new URL(String(input)).pathname;
        if (path === "/v1/patients") return Response.json({ total_entries: 2, patients: [
          { id: "901", archived_at: null, patient_phone_numbers: [{ number: "0400 111 222", phone_type: "Mobile" }] },
          { id: "902", archived_at: null, patient_phone_numbers: [{ number: "0400 111 222", phone_type: "Home" }] },
        ] });
        if (path === "/v1/patients/901" || path === "/v1/patients/902") return Response.json({
          id: path.endsWith("901") ? "901" : "902", archived_at: null,
          patient_phone_numbers: [{ number: path.endsWith("901") || secondCurrent ? "0400 111 222" : "0400 999 999",
            phone_type: "Mobile" }],
        });
        throw new Error("unexpected patient edge read");
      }));
    const index = new PostgresPatientPhoneIndex(db);
    const lookup = new ClinikoPhoneLookup(patientReader, index, "61", 60_000);
    assert.ok((await lookup.refresh(phoneScope)).ok);
    const ambiguous = value(await lookup.candidates(phoneScope, phone));
    assert.equal(ambiguous.kind, "multiple");
    assert.equal(ambiguous.candidateIds.length, 2);
    secondCurrent = false;
    const current = value(await lookup.candidates(phoneScope, phone));
    assert.equal(current.kind, "one");
    assert.equal(current.candidateIds.length, 1);
    const head = value(await index.head(phoneScope));
    assert.ok(head);
    assert.ok((await index.markStale(phoneScope, head.generation)).ok);
    assert.deepEqual(value(await lookup.candidates(phoneScope, phone)), { kind: "indexStale", candidateIds: [] });
    assert.ok(liveGets >= 6);
    assert.deepEqual(await scanPatientDataCanaries(db, [
      { label: "caller", value: callerText }, { label: "appointment", value: appointmentId },
      { label: "time", value: startsAt },
    ]), { ok: true, value: [] });
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), [
      { label: "caller", value: callerText }, { label: "appointment", value: appointmentId },
    ]), []);
  } finally {
    await db?.destroy();
    try { if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); }
    finally { await admin.destroy(); }
  }
});
