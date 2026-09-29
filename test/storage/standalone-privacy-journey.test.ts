import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { ClinikoAvailabilityReader } from "../../src/cliniko/availability.ts";
import { ClinikoPatientCandidateReader } from "../../src/cliniko/patients.ts";
import { ok } from "../../src/core/model.ts";
import type { Result } from "../../src/core/model.ts";
import { ARCHIVE_SECTIONS } from "../../src/portability/archive-envelope.ts";
import { decodeTenantConfigArchive } from "../../src/portability/config-archive.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { StandaloneAvailabilityTextRunner } from "../../src/standalone/availability-text-runner.ts";
import { createAvailabilityConsoleServer } from "../../src/standalone/availability-console/server.ts";
import { createStandaloneTextComposition } from "../../src/standalone/text-composition.ts";
import { ClinikoPhoneLookup } from "../../src/standalone/cliniko-phone-lookup.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { buildPostgresConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresPatientPhoneIndex } from "../../src/storage/postgres-patient-phone-index.ts";
import { PostgresPatientPhoneScan } from "../../src/storage/postgres-patient-phone-scan.ts";
import { scanDisposableBackupCanaries } from "./backup-canary-scan.ts";
import { resolve } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

function value<T, E>(result: Result<T, E>): T {
  assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.error));
  return result.value;
}

test("standalone phone, setting, export, and text journey retains only patient phone-to-ID links", async () => {
  const suffix = randomUUID().slice(0, 8);
  const scope = { tenantId: `privacy-${suffix}`, clinicId: "clinic", locationId: "frontdesk" };
  const targetScope = { tenantId: `privacy-buyer-${suffix}`, clinicId: "clinic", locationId: "frontdesk" };
  const clinicScope = { tenantId: scope.tenantId, clinicId: scope.clinicId };
  const phone = "+61400111222";
  const patientIds = ["901", "902"];
  const privateName = `patient-name-${suffix}`;
  const privateNote = `patient-note-${suffix}`;
  const appointmentId = `appointment-${suffix}`;
  const appointmentTime = `2030-03-14T12:34:56.${String(parseInt(suffix.slice(0, 3), 16) % 1000).padStart(3, "0")}Z`;
  const callerText = `caller-request-${suffix}`;
  const answerText = `answer-private-${suffix}`;
  const verificationRef = `verification-private-${suffix}`;
  const offerRef = `offer-private-${suffix}`;
  let secondPhone = "0400 111 222";
  const fetchPort: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/patients") return Response.json({ total_entries: 2, patients: patientIds.map(id => ({
      id, first_name: privateName, appointment_notes: privateNote,
      next_appointment_id: appointmentId, next_appointment_at: appointmentTime,
      archived_at: null, patient_phone_numbers: [{ number: "0400 111 222", phone_type: "Mobile" }],
    })) });
    if (path === "/v1/patients/901" || path === "/v1/patients/902") return Response.json({
      id: path.slice(-3), first_name: privateName, appointment_notes: privateNote,
      next_appointment_id: appointmentId, next_appointment_at: appointmentTime,
      archived_at: null, patient_phone_numbers: [{ number: path.endsWith("902") ? secondPhone : "0400 111 222",
        phone_type: "Mobile" }],
    });
    throw new Error("unexpected Cliniko request");
  };
  const reader = value(ClinikoPatientCandidateReader.create({ scope: clinicScope,
    apiKey: "synthetic-au5", contactEmail: "test@example.com" }, fetchPort));
  const index = new PostgresPatientPhoneIndex(db);
  const lookup = new ClinikoPhoneLookup(reader, index, "61", 60_000, undefined, new PostgresPatientPhoneScan(db));
  assert.deepEqual(await lookup.refresh(clinicScope), { ok: true, value: 1 });
  assert.deepEqual(await lookup.candidates(clinicScope, phone),
    { ok: true, value: { kind: "multiple", candidateIds: patientIds } });
  secondPhone = "0400 999 999";
  assert.deepEqual(await lookup.candidates(clinicScope, phone),
    { ok: true, value: { kind: "one", candidateIds: ["901"] } });

  const app = createStandaloneTextComposition(db);
  assert.equal(value(await app.policy.changeBookingEnabled(scope, "0", true, "clinic-admin")).capabilities.book,
    "unavailable");
  const archiveRequest = { scope, targetScope, timeZone: "UTC",
    mappingProvenance: "approved-map", archiveId: `privacy-export-${suffix}`, actorRef: "clinic-admin",
    createdAt: "2026-09-29T10:00:00Z" };
  const archiveAuthority = { authorizeAndRecord: async () => ok({ requestRef: "audited-export" }) };
  const archive = value(await buildPostgresConfigArchive(db, archiveRequest, archiveAuthority));
  const archiveBytes: Uint8Array[] = [archive.manifestBytes];
  for (const section of ARCHIVE_SECTIONS) {
    for await (const chunk of archive.sections[section]()) archiveBytes.push(chunk);
  }

  const now = "2026-09-29T10:00:00Z";
  const callId = randomUUID();
  value(await app.reception.startCall(callId, scope, now));
  const booking = value(await app.reception.proposeBooking(scope,
    { callId, turnId: randomUUID(), text: callerText, quality: "clear", at: now },
    verificationRef, offerRef, now));
  assert.equal(booking.callerMessages.at(-1), "I can't complete that request here.");
  assert.deepEqual(booking.actions, {});
  assert.deepEqual(booking.staffItems, {});
  const pendingId = booking.pendingPresentationId;
  assert.ok(pendingId);
  value(await app.reception.acknowledgeTextPresentation(scope, callId, pendingId));
  const answered = value(await app.reception.answer(scope,
    { callId, turnId: randomUUID(), text: callerText, quality: "clear", at: now },
    ["parking"], answerText, now));
  assert.equal(answered.callerMessages.includes(answerText), false);
  const appointments = value(await app.reception.checkAppointments(scope,
    { callId, turnId: randomUUID(), text: callerText, quality: "clear", at: now },
    verificationRef, appointmentTime, appointmentTime, now));
  assert.deepEqual(appointments.actions, {});
  assert.deepEqual(appointments.staffItems, {});
  assert.equal(app.reception.appointmentReadEnabled(), false);
  const reloaded = createStandaloneTextComposition(db);
  const stored = value(await reloaded.reception.read(scope, callId));
  assert.deepEqual(stored.callerMessages, []);
  assert.deepEqual(stored.appointmentReads, []);
  assert.deepEqual(stored.staffItems, {});
  assert.deepEqual(await buildPostgresConfigArchive(db, archiveRequest, archiveAuthority),
    { ok: false, error: { kind: "callsRequireRetention" } });

  const canaries = [privateName, privateNote, appointmentId, appointmentTime, callerText,
    answerText, verificationRef, offerRef].map((canary, index) => ({ label: `private_${index}`, value: canary }));
  assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] });
  assert.deepEqual(await scanDisposableBackupCanaries(url, canaries), []);
  const serializedArchive = Buffer.concat(archiveBytes).toString("utf8");
  assert.equal(canaries.some(canary => serializedArchive.includes(canary.value)), false,
    "configuration export contained a patient-data canary");
  const links = await db.selectFrom("patient_phone_index").select(["normalized_phone", "patient_id"])
    .where("tenant_id", "=", scope.tenantId as never).orderBy("patient_id").execute();
  assert.deepEqual(links.map(link => [link.normalized_phone, link.patient_id]),
    patientIds.map(id => [phone, id]));
  assert.deepEqual(await index.clear(clinicScope), { ok: true, value: true });
  assert.deepEqual(await lookup.candidates(clinicScope, phone),
    { ok: true, value: { kind: "indexStale", candidateIds: [] } });
  assert.equal((await db.selectFrom("patient_phone_index").select("patient_id")
    .where("tenant_id", "=", scope.tenantId as never).execute()).length, 0);
});

test("E2E-125 text: agent reads provisional times and gives truthful empty or failed fallback", async () => {
  const suffix = randomUUID().slice(0, 8);
  const scope = { tenantId: `availability-${suffix}`, clinicId: "clinic", locationId: "frontdesk" };
  const now = "2026-10-01T00:00:00Z";
  const startsAt = "2026-10-02T00:00:00.000Z";
  const privateName = `patient-availability-name-${suffix}`;
  const appointmentId = `patient-appointment-id-${suffix}`;
  const callerText = `caller-availability-${suffix}`;
  let times = [startsAt];
  let unavailable = false;
  const fetchPort: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (unavailable) return Response.json({}, { status: 503 });
    if (path === "/v1/businesses/11") return Response.json({ id: "11", show_in_online_bookings: true,
      time_zone_identifier: "Australia/Sydney", patient_name: privateName });
    if (path === "/v1/practitioners/22") return Response.json({ id: "22", active: true, show_in_online_bookings: true });
    if (path === "/v1/appointment_types/33") return Response.json({ id: "33", show_in_online_bookings: true });
    if (path === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1, practitioners: [{ id: "22" }] });
    if (path === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1, appointment_types: [{ id: "33" }] });
    if (path.endsWith("/available_times")) return Response.json({ total_entries: times.length,
      available_times: times.map(appointment_start => ({ appointment_start, appointment_id: appointmentId })) });
    throw new Error("unexpected Cliniko request");
  };
  const reader = value(ClinikoAvailabilityReader.create({ scope, apiKey: "synthetic-key-au5",
    contactEmail: "test@example.com", businessId: "11", practitionerId: "22", appointmentTypeId: "33" },
  fetchPort, () => now));
  const app = createStandaloneTextComposition(db, reader);
  const agent = new CommandGateway({ actorRef: "agent", role: "agent", scope }, app.policy, app.reception);
  assert.equal(agent.listPermitted().some(item => item.id === "availability.read.v2"), true);
  assert.equal(agent.listPermitted().some(item => item.id === "appointments.read.v1"), false);
  const withoutCliniko = createStandaloneTextComposition(db);
  assert.equal(new CommandGateway({ actorRef: "agent", role: "agent", scope }, withoutCliniko.policy,
    withoutCliniko.reception).listPermitted().some(item => item.id === "availability.read.v2"), false);
  const callId = randomUUID();
  value(await app.reception.startCall(callId, scope, now));
  const shown = value(await app.reception.checkAvailability(scope,
    { callId, turnId: randomUUID(), text: callerText, quality: "clear", at: now },
    "2026-10-02", "2026-10-02", now));
  assert.equal(shown.availabilityReads.at(-1)?.status, "shown");
  assert.deepEqual(shown.availabilityReads.at(-1)?.shownStartsAt, [startsAt]);
  assert.match(shown.callerMessages.at(-1) ?? "", /possible times/);
  assert.match(shown.callerMessages.at(-1) ?? "", /can't reserve or confirm/);
  assert.deepEqual(shown.staffItems, {});

  times = [];
  const emptyTurnId = randomUUID();
  const empty = value(await agent.submit({ kind: "availability.read.v2",
    turn: { callId, turnId: emptyTurnId, text: callerText, quality: "clear", at: now },
    from: "2026-10-02", to: "2026-10-02", now }));
  assert.equal(empty.kind, "availabilityAnswer");
  if (empty.kind !== "availabilityAnswer") return;
  assert.deepEqual(empty.progress.availability?.status, "empty");
  const noTimes = value(await app.reception.checkAvailability(scope,
    { callId, turnId: randomUUID(), text: callerText, quality: "clear", at: now },
    "2026-10-02", "2026-10-02", now));
  assert.match(noTimes.callerMessages.at(-1) ?? "", /contact the clinic directly/);
  assert.doesNotMatch(noTimes.callerMessages.at(-1) ?? "", /staff follow-up/);
  unavailable = true;
  const failed = value(await app.reception.checkAvailability(scope,
    { callId, turnId: randomUUID(), text: callerText, quality: "clear", at: now },
    "2026-10-02", "2026-10-02", now));
  assert.equal(failed.availabilityReads.at(-1)?.status, "failed");
  assert.deepEqual(failed.staffItems, {});
  assert.match(failed.callerMessages.at(-1) ?? "", /contact the clinic directly/);

  const reloaded = createStandaloneTextComposition(db, reader);
  const stored = value(await reloaded.reception.read(scope, callId));
  assert.deepEqual(stored.availabilityReads, []);
  assert.deepEqual(stored.callerMessages, []);
  assert.deepEqual(stored.staffItems, {});
  assert.deepEqual(await scanPatientDataCanaries(db, [
    { label: "patient_name", value: privateName }, { label: "appointment_id", value: appointmentId },
    { label: "appointment_time", value: startsAt }, { label: "caller_text", value: callerText },
  ]), { ok: true, value: [] });
  assert.deepEqual(await scanDisposableBackupCanaries(url, [
    { label: "patient_name", value: privateName }, { label: "appointment_id", value: appointmentId },
    { label: "caller_text", value: callerText },
  ]), []);
});

test("E2E-125 text: standalone ingress presents provisional availability without patient-data retention", async () => {
  const suffix = randomUUID().slice(0, 8);
  const scope = { tenantId: `availability-entry-${suffix}`, clinicId: "clinic", locationId: "frontdesk" };
  const now = "2026-10-01T00:00:00Z";
  const startsAt = "2026-10-02T00:00:00.000Z";
  const callerText = `caller-entry-${suffix}`;
  const patientName = `patient-entry-${suffix}`;
  const appointmentId = `appointment-entry-${suffix}`;
  const fetchPort: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/businesses/11") return Response.json({ id: "11", show_in_online_bookings: true,
      time_zone_identifier: "Australia/Sydney", patient_name: patientName });
    if (path === "/v1/practitioners/22") return Response.json({ id: "22", active: true, show_in_online_bookings: true });
    if (path === "/v1/appointment_types/33") return Response.json({ id: "33", show_in_online_bookings: true });
    if (path === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1, practitioners: [{ id: "22" }] });
    if (path === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1, appointment_types: [{ id: "33" }] });
    if (path.endsWith("/available_times")) return Response.json({ total_entries: 1,
      available_times: [{ appointment_start: startsAt, appointment_id: appointmentId }] });
    throw new Error("unexpected Cliniko request");
  };
  const reader = value(ClinikoAvailabilityReader.create({ scope, apiKey: "synthetic-key-au5",
    contactEmail: "test@example.com", businessId: "11", practitionerId: "22", appointmentTypeId: "33" },
  fetchPort, () => now));
  const runner = new StandaloneAvailabilityTextRunner(db, scope, reader, () => now);
  const invalid = await runner.prepare({ text: callerText, from: "2026-10-03", to: "2026-10-02" });
  assert.deepEqual(invalid, { ok: false, error: { kind: "invalidInput" } });
  assert.equal((await db.selectFrom("calls").select("call_id")
    .where("tenant_id", "=", scope.tenantId as never).execute()).length, 0);

  const prepared = value(await runner.prepare({ text: callerText, from: "2026-10-02", to: "2026-10-02" }));
  assert.match(prepared.callId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(prepared.status, "shown");
  assert.match(prepared.message, /possible times/);
  assert.match(prepared.message, /can't reserve or confirm/);
  assert.deepEqual(await createStandaloneTextComposition(db, reader).reception.completeTextPresentation(scope,
    prepared.callId, "0".repeat(64), now),
    { ok: false, error: { kind: "invalidTransition" } });
  assert.deepEqual(await runner.confirmWritten(prepared), { ok: true, value: true });
  const stored = value(await createStandaloneTextComposition(db, reader).reception.read(scope, prepared.callId));
  const events = await db.selectFrom("call_events").select("sequence")
    .where("call_id", "=", prepared.callId as never).execute();
  assert.deepEqual(await runner.confirmWritten(prepared), { ok: true, value: true });
  assert.equal(value(await createStandaloneTextComposition(db, reader).reception.read(scope, prepared.callId)).version,
    stored.version);
  assert.equal((await db.selectFrom("call_events").select("sequence")
    .where("call_id", "=", prepared.callId as never).execute()).length, events.length);
  assert.equal(stored.lifecycle, "ended");
  assert.equal(stored.terminal?.reason, "textCompleted");
  assert.deepEqual(stored.callerMessages, []);
  assert.deepEqual(stored.availabilityReads, []);
  assert.deepEqual(stored.staffItems, {});
  assert.deepEqual(stored.actions, {});
  assert.equal(stored.presentations[prepared.presentationId]?.status, "played");
  assert.deepEqual(await scanPatientDataCanaries(db, [
    { label: "caller_text", value: callerText }, { label: "patient_name", value: patientName },
    { label: "appointment_id", value: appointmentId }, { label: "appointment_time", value: startsAt },
  ]), { ok: true, value: [] });
  assert.deepEqual(await scanDisposableBackupCanaries(url, [
    { label: "caller_text", value: callerText }, { label: "patient_name", value: patientName },
    { label: "appointment_id", value: appointmentId },
  ]), []);
});

test("E2E-125/E2E-127 text: HTTP availability completes and exports no caller or Cliniko details", async () => {
  const suffix = randomUUID().slice(0, 8);
  const scope = { tenantId: `availability-http-${suffix}`, clinicId: "clinic", locationId: "frontdesk" };
  const now = "2026-10-01T00:00:00Z";
  const appointmentId = `appointment-http-${suffix}`;
  const appointmentTime = "2026-10-02T00:00:00.000Z";
  const privateName = `patient-http-${suffix}`;
  const callerText = `caller-http-${suffix}`;
  const fetchPort: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/businesses/11") return Response.json({ id: "11", show_in_online_bookings: true,
      time_zone_identifier: "Australia/Sydney", patient_name: privateName });
    if (path === "/v1/practitioners/22") return Response.json({ id: "22", active: true, show_in_online_bookings: true });
    if (path === "/v1/appointment_types/33") return Response.json({ id: "33", show_in_online_bookings: true });
    if (path === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1, practitioners: [{ id: "22" }] });
    if (path === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1, appointment_types: [{ id: "33" }] });
    if (path.endsWith("/available_times")) return Response.json({ total_entries: 1,
      available_times: [{ appointment_start: appointmentTime, appointment_id: appointmentId }] });
    throw new Error("unexpected Cliniko request");
  };
  const reader = value(ClinikoAvailabilityReader.create({ scope, apiKey: "synthetic-key-au5",
    contactEmail: "test@example.com", businessId: "11", practitionerId: "22", appointmentTypeId: "33" },
  fetchPort, () => now));
  const runner = new StandaloneAvailabilityTextRunner(db, scope, reader, () => now);
  let resolveWritten!: () => void;
  const written = new Promise<void>(resolve => { resolveWritten = resolve; });
  const server = await createAvailabilityConsoleServer({
    prepare: input => runner.prepare(input),
    confirmWritten: async prepared => {
      try { return await runner.confirmWritten(prepared); }
      finally { resolveWritten(); }
    },
  }, resolve("dist/availability-console/app.js"));
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const invalid = await fetch(`${base}/api/availability`, { method: "POST", headers: {
      Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({
        text: callerText, from: "2026-10-03", to: "2026-10-02",
      }) });
    assert.equal(invalid.status, 400);
    assert.equal((await db.selectFrom("calls").select("call_id")
      .where("tenant_id", "=", scope.tenantId as never).execute()).length, 0);
    const response = await fetch(`${base}/api/availability`, { method: "POST", headers: {
      Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({
        text: callerText, from: "2026-10-02", to: "2026-10-02",
      }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const answer = await response.json() as { ok: boolean; value: { status: string; message: string } };
    assert.equal(answer.ok, true);
    assert.equal(answer.value.status, "shown");
    assert.match(answer.value.message, /can't reserve or confirm/);
    assert.equal(JSON.stringify(answer).includes(appointmentId), false);
    assert.equal(JSON.stringify(answer).includes(privateName), false);
    await written;
    const calls = await db.selectFrom("calls").select(["call_id", "state"])
      .where("tenant_id", "=", scope.tenantId as never).execute();
    assert.equal(calls.length, 1);
    const stored = value(await createStandaloneTextComposition(db, reader).reception.read(scope, calls[0]!.call_id));
    assert.equal(stored.lifecycle, "ended");
    assert.equal(stored.terminal?.reason, "textCompleted");
    assert.deepEqual(stored.callerMessages, []);
    assert.deepEqual(stored.availabilityReads, []);
    assert.deepEqual(stored.actions, {});
    assert.deepEqual(stored.staffItems, {});
    const canaries = [callerText, privateName, appointmentId, appointmentTime]
      .map((entry, index) => ({ label: `http_private_${index}`, value: entry }));
    assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] });
    assert.deepEqual(await scanDisposableBackupCanaries(url, canaries), []);
    const targetScope = { ...scope, tenantId: `availability-http-buyer-${suffix}` };
    const archive = value(await buildPostgresConfigArchive(db, { scope, targetScope,
      timeZone: "Australia/Sydney", mappingProvenance: "reviewed", archiveId: `http-export-${suffix}`,
      actorRef: "clinic-admin", createdAt: now },
    { authorizeAndRecord: async () => ok({ requestRef: `http-audit-${suffix}` }) }));
    const decoded = value(await decodeTenantConfigArchive(archive, targetScope.tenantId));
    assert.equal(decoded.omittedCalls.notRetained, 1);
    assert.equal(decoded.sectionManifests.calls.recordCount, 0);
    const archiveBytes: Uint8Array[] = [archive.manifestBytes];
    for (const section of ARCHIVE_SECTIONS) {
      for await (const chunk of archive.sections[section]()) archiveBytes.push(chunk);
    }
    const serializedArchive = Buffer.concat(archiveBytes).toString("utf8");
    assert.equal(canaries.some(canary => serializedArchive.includes(canary.value)), false);
    assert.equal(serializedArchive.includes(calls[0]!.call_id), false);
  } finally {
    await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
  }
});
