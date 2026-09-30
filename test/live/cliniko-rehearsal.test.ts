import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { ClinikoAvailabilityReader } from "../../src/cliniko/availability.ts";
import { ClinikoPatientCandidateReader } from "../../src/cliniko/patients.ts";
import { StandaloneAvailabilityTextRunner } from "../../src/standalone/availability-text-runner.ts";
import { ClinikoPhoneLookup } from "../../src/standalone/cliniko-phone-lookup.ts";
import { PhoneIndexRefreshWorker } from "../../src/standalone/phone-index-refresh-worker.ts";
import { createStandaloneTextComposition } from "../../src/standalone/text-composition.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import type Database from "../../src/storage/generated/Database.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { PostgresPatientPhoneIndex } from "../../src/storage/postgres-patient-phone-index.ts";
import { PostgresPatientPhoneScan } from "../../src/storage/postgres-patient-phone-scan.ts";
import { PostgresPhoneRefreshGuard } from "../../src/storage/postgres-phone-refresh-guard.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";

type Body = Record<string, unknown>;

function record(value: unknown): Body | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Body : undefined;
}

function id(value: unknown): string | undefined {
  const text = String(value ?? "");
  return /^[1-9][0-9]*$/.test(text) ? text : undefined;
}

function localDate(timeZone: string, daysAhead: number): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit",
    day: "2-digit", calendar: "gregory", numberingSystem: "latn" }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  return new Date(Date.parse(`${today}T00:00:00Z`) + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

function clinikoClient(apiKey: string, contactEmail: string) {
  const shard = apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1];
  if (!shard) throw new Error("invalid Cliniko test credential");
  const base = `https://api.${shard}.cliniko.com/v1`;
  const headers = { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
    "Content-Type": "application/json", "User-Agent": `Abby (${contactEmail})` };
  return async (method: "GET" | "POST" | "PATCH", path: string, input?: Body):
    Promise<{ status: number; body: Body }> => {
    const response = await fetch(`${base}${path}`, { method, headers, redirect: "error",
      ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(15_000) });
    const raw = await response.text();
    if (raw.length > 1_000_000) throw new Error("oversized Cliniko test response");
    let body: Body = {};
    if (raw) {
      try { body = record(JSON.parse(raw) as unknown) ?? {}; }
      catch { throw new Error("malformed Cliniko test response"); }
    }
    return { status: response.status, body };
  };
}

/** An opt-in demo-account proof. It never prints patient, offer, or credential values. */
test("C-LIVE-17 Cliniko phone refresh and provisional text availability preserve Abby's patient-data boundary",
  { skip: process.env.ABBY_LIVE_CLINIKO_EVAL !== "1" ||
    process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" ||
    !process.env.ABBY_CLINIKO_API_KEY || !process.env.ABBY_CLINIKO_CONTACT_EMAIL,
  timeout: 120_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL;
  const apiKey = process.env.ABBY_CLINIKO_API_KEY;
  const contactEmail = process.env.ABBY_CLINIKO_CONTACT_EMAIL;
  assert.ok(adminUrl && apiKey && contactEmail);
  const request = clinikoClient(apiKey, contactEmail);
  const admin = connectPostgres(adminUrl);
  const name = `abby_cliniko_rehearsal_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${name}`;
  let created = false;
  let db: ReturnType<typeof connectPostgres> | undefined;
  const marker = randomUUID().replaceAll("-", "");
  const patientName = `SyntheticRehearsal${marker.slice(0, 12)}`;
  const patientEmail = `abby-rehearsal+${marker}@example.test`;
  const callerText = `availability-rehearsal-${marker}`;
  const phone = `+614555${randomInt(10_000, 100_000)}`;
  let patientAttempted = false;
  let patientId: string | undefined;
  let patientArchived = false;
  let businessId: string | undefined;
  let originalBookingFlag: boolean | undefined;
  let bookingChangeAttempted = false;
  const cleanupFailures: string[] = [];
  try {
    await sql.raw(`create database "${name}"`).execute(admin);
    created = true;
    db = connectPostgres(databaseUrl.toString());
    await migrate(db);
    const businesses = await request("GET", "/businesses?page=1&per_page=100");
    const practitioners = await request("GET", "/practitioners?page=1&per_page=100");
    const types = await request("GET", "/appointment_types?page=1&per_page=100");
    assert.ok(businesses.status === 200 && practitioners.status === 200 && types.status === 200);
    const businessRows = businesses.body.businesses;
    const practitionerRows = practitioners.body.practitioners;
    const typeRows = types.body.appointment_types;
    assert.ok(Array.isArray(businessRows) && businessRows.length === 1);
    assert.ok(Array.isArray(practitionerRows) && practitionerRows.length === 1);
    assert.ok(Array.isArray(typeRows) && typeRows.length > 0);
    const business = record(businessRows[0]);
    const practitioner = record(practitionerRows[0]);
    const selectedType = typeRows.map(record).find(item => item?.show_in_online_bookings === true);
    businessId = id(business?.id);
    const practitionerId = id(practitioner?.id);
    const typeId = id(selectedType?.id);
    originalBookingFlag = business?.show_in_online_bookings as boolean | undefined;
    const timeZone = business?.time_zone_identifier;
    assert.ok(businessId && practitionerId && typeId &&
      typeof originalBookingFlag === "boolean" && typeof timeZone === "string" &&
      practitioner?.show_in_online_bookings === true);

    const scope = { tenantId: `live-cliniko-${marker.slice(0, 8)}`, clinicId: "demo", locationId: "frontdesk" };
    const clinicScope = { tenantId: scope.tenantId, clinicId: scope.clinicId };
    patientAttempted = true;
    const createdPatient = await request("POST", "/patients", { first_name: "Abby",
      last_name: patientName, old_reference_id: marker, email: patientEmail,
      date_of_birth: "1990-05-21", patient_phone_numbers: [{ number: phone, phone_type: "Mobile" }] });
    assert.equal(createdPatient.status, 201);
    patientId = id(createdPatient.body.id);
    assert.ok(patientId);

    const budget = new PostgresClinikoRequestBudget(db, { apiKey });
    const patients = ClinikoPatientCandidateReader.create({ scope: clinicScope, apiKey, contactEmail,
      rateBudget: budget });
    assert.ok(patients.ok);
    const index = new PostgresPatientPhoneIndex(db);
    const lookupForSession = (session: Kysely<Database>): ClinikoPhoneLookup => {
      const sessionReader = ClinikoPatientCandidateReader.create({ scope: clinicScope, apiKey, contactEmail,
        rateBudget: new PostgresClinikoRequestBudget(session, { apiKey }) });
      assert.ok(sessionReader.ok);
      return new ClinikoPhoneLookup(sessionReader.value, new PostgresPatientPhoneIndex(session), "61",
        60 * 60_000, undefined, new PostgresPatientPhoneScan(session));
    };
    const worker = new PhoneIndexRefreshWorker(index, [{ scope: clinicScope, lookupForSession,
      credentialFingerprint: patients.value.credentialFingerprint(), countryCallingCode: "61", refreshEveryMs: 15 * 60_000 }], undefined,
    new PostgresPhoneRefreshGuard(databaseUrl.toString()));
    assert.equal((await worker.runOnce())[0]?.kind, "refreshed");
    assert.equal((await worker.runOnce())[0]?.kind, "fresh");
    const lookup = new ClinikoPhoneLookup(patients.value, index, "61", 60 * 60_000,
      undefined, new PostgresPatientPhoneScan(db));
    const links = await db.selectFrom("patient_phone_index").select(["normalized_phone", "patient_id"]).execute();
    assert.equal(links.length, 1);
    assert.ok(links[0]?.normalized_phone === phone && links[0]?.patient_id === patientId);
    const allowedCanaries = [{ label: "phone", value: phone },
      ...(patientId.length >= 4 ? [{ label: "patient_id", value: patientId }] : [])];
    const allowedHits = await scanPatientDataCanaries(db, allowedCanaries);
    assert.ok(allowedHits.ok && allowedHits.value.some(hit => hit.table === "patient_phone_index" &&
      hit.column === "normalized_phone") &&
      allowedHits.value.every(hit => ["patient_phone_index", "patient_phone_scan"].includes(hit.table)));
    const candidates = await lookup.candidates(clinicScope, phone);
    assert.ok(candidates.ok, candidates.ok ? "" : candidates.error.kind);
    assert.ok(candidates.value.kind === "one" && candidates.value.candidateIds.length === 1 &&
      candidates.value.candidateIds[0] === patientId);

    const availability = ClinikoAvailabilityReader.create({ scope, apiKey, contactEmail, rateBudget: budget,
      businessId, practitionerId, appointmentTypeId: typeId });
    assert.ok(availability.ok);
    const from = localDate(timeZone, 1);
    const to = localDate(timeZone, 7);
    if (!originalBookingFlag) {
      const blocked = await availability.value.list(scope, from, to);
      assert.ok(blocked.ok && blocked.value.kind === "notEligible" && blocked.value.reason === "business");
      bookingChangeAttempted = true;
      const enabled = await request("PATCH", `/businesses/${businessId}`, { show_in_online_bookings: true });
      assert.ok(enabled.status === 200 && enabled.body.show_in_online_bookings === true);
    }
    const offers = await availability.value.list(scope, from, to);
    assert.ok(offers.ok, offers.ok ? "" : offers.error.kind);
    assert.equal(offers.value.kind, "times");
    if (offers.value.kind !== "times") throw new Error("Cliniko availability not eligible");
    assert.equal(offers.value.reservable, false);
    const runner = new StandaloneAvailabilityTextRunner(db, scope, availability.value);
    const prepared = await runner.prepare({ text: callerText, from, to });
    assert.ok(prepared.ok, prepared.ok ? "" : prepared.error.kind);
    assert.equal(prepared.value.status, offers.value.startsAt.length ? "shown" : "empty");
    assert.match(prepared.value.message, offers.value.startsAt.length ? /can't reserve or confirm/ : /contact the clinic/i);
    assert.equal((await runner.confirmWritten(prepared.value)).ok, true);
    const stored = await createStandaloneTextComposition(db, availability.value).reception.read(scope,
      prepared.value.callId);
    assert.ok(stored.ok);
    assert.equal(stored.value.lifecycle, "ended");
    assert.equal(stored.value.callerMessages.length, 0);
    assert.equal(stored.value.availabilityReads.length, 0);

    const canaries = [patientName, patientEmail, marker, "1990-05-21", callerText,
      ...offers.value.startsAt.slice(0, 1)].map((value, index) => ({ label: `live_private_${index}`, value }));
    const scanned = await scanPatientDataCanaries(db, canaries);
    assert.ok(scanned.ok && scanned.value.length === 0);
    assert.equal((await scanDisposableBackupCanaries(databaseUrl.toString(), canaries)).length, 0);

    const archived = await request("POST", `/patients/${patientId}/archive`);
    assert.equal(archived.status, 204);
    const archivedRead = await request("GET", `/patients/${patientId}?q%5B%5D=archived_at%3A*`);
    assert.ok(archivedRead.status === 200 && !!archivedRead.body.archived_at);
    patientArchived = true;
    const afterArchive = await lookup.candidates(clinicScope, phone);
    assert.ok(afterArchive.ok && afterArchive.value.kind === "none" && afterArchive.value.candidateIds.length === 0);
    assert.equal((await index.clear(clinicScope)).ok, true);
    assert.equal((await db.selectFrom("patient_phone_index").select("patient_id").execute()).length, 0);
  } finally {
    if (patientAttempted && !patientArchived) {
      try {
        if (!patientId) {
          const matches = await request("GET", `/patients?page=1&per_page=2&q%5B%5D=old_reference_id%3A%3D${marker}`);
          const rows = matches.body.patients;
          if (matches.status === 200 && Array.isArray(rows) && rows.length === 1 &&
              record(rows[0])?.old_reference_id === marker) patientId = id(record(rows[0])?.id);
        }
        if (!patientId) cleanupFailures.push("patient reconciliation uncertain");
        else {
          const archived = await request("POST", `/patients/${patientId}/archive`);
          const verified = await request("GET", `/patients/${patientId}?q%5B%5D=archived_at%3A*`);
          if (archived.status !== 204 || verified.status !== 200 || !verified.body.archived_at)
            cleanupFailures.push("patient archive unverified");
        }
      } catch { cleanupFailures.push("patient cleanup unavailable"); }
    }
    if (bookingChangeAttempted && businessId && originalBookingFlag !== undefined) {
      try {
        const restored = await request("PATCH", `/businesses/${businessId}`,
          { show_in_online_bookings: originalBookingFlag });
        const verified = await request("GET", `/businesses/${businessId}`);
        if (restored.status !== 200 || verified.status !== 200 ||
            verified.body.show_in_online_bookings !== originalBookingFlag)
          cleanupFailures.push("business setting restore unverified");
      } catch { cleanupFailures.push("business setting cleanup unavailable"); }
    }
    await db?.destroy();
    try { if (created) await sql.raw(`drop database "${name}"`).execute(admin); }
    finally { await admin.destroy(); }
    if (cleanupFailures.length) throw new Error(`Cliniko demo cleanup uncertain: ${cleanupFailures.join(", ")}`);
  }
});
