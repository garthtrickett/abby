import { installClinicalVerificationCanaries } from "./verification-code-canary.ts";
import { observeSyntheticWire } from "./synthetic-wire-observer.ts";
import { syntheticTaskSequence, syntheticMultiTaskBookingProvider } from "./call-task-sequence.ts";
import { withSmtpVerificationServer } from "./smtp-verification-server.ts";
import { SmtpPatientCodeDelivery } from "../../src/standalone/smtp-patient-code-delivery.ts";
import type { PatientCodeDelivery } from "../../src/standalone/email-patient-authority.ts";
import { locationServiceFixture, intakeLocationServiceFixture } from "./location-service-catalogue.ts";
import { serviceBookingFixture } from "./service-booking-catalogue.ts";
import { intakeServiceFixture } from "./intake-service-catalogue.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VoiceRunnerPorts } from "../../scripts/serve-cliniko-voice.ts";
import { serveClinikoVoice } from "../../scripts/serve-cliniko-voice.ts";
import { ClinikoVoiceClinicalHost } from "../../src/standalone/cliniko-voice-clinical-host.ts";
import { intakeAllowedFields, OwnerFileIntakePolicy } from "../../src/standalone/owner-file-intake-policy.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { err, ok } from "../../src/core/model.ts";
import { bookingCallFlowFixture, cancellationCallFlowFixture, reschedulingCallFlowFixture, intakeCallFlowFixture } from "./cliniko-call-flow.ts";
import { patientCorrectionCallFlowFixture } from "./patient-correction-call-flow.ts";
import { OwnerFilePatientUpdatePolicy } from "../../src/standalone/owner-file-patient-update-policy.ts";
import { appointmentEnquiryFixture } from "./cliniko-appointment-enquiry.ts";
import { clinikoStaffCallFlowFixture } from "./cliniko-staff-call-flow.ts";
import { staffRequestLanguage } from "../../src/standalone/staff-request-language.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { withApprovedSyntheticVoice } from "./approved-voice.ts";
import { captureVoicePolicy } from "../../src/core/voice-policy.ts";
import { OpenAIVoiceProfileHost } from "../../src/voice/openai-voice-profile.ts";
import { rosterPlan, rosterInterval, syntheticRosterProvider } from "./roster-booking.ts";

observeSyntheticWire();

const operation = process.env.ABBY_SYNTHETIC_CLINICAL_OPERATION;
if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.ABBY_VOICE_TEST_MODE !== "1" ||
    process.env.ABBY_CLINIKO_API_KEY !== "synthetic-key-au5" || !process.env.DATABASE_URL?.includes("/abby_test_voice_") ||
    process.env.ABBY_TWILIO_ACCOUNT_SID !== `AC${"1".repeat(32)}` ||
    !["book", "cancel", "reschedule", "intake", "patientUpdate", "appointments.read", "staff.request"].includes(operation ?? "")) {
  throw new Error("synthetic clinical runner requires an isolated fixture");
}
process.send?.({ kind: "verificationCanaryWindow", diagnostic: installClinicalVerificationCanaries() });
const taskSequence = process.env.ABBY_SYNTHETIC_TASK_SEQUENCE === "1";
if (process.env.ABBY_SYNTHETIC_TASK_SEQUENCE && (!taskSequence || operation !== "book" || process.env.ABBY_SYNTHETIC_SERVICE_MODE || process.env.ABBY_SYNTHETIC_LOCATION_MODE)) throw new Error("invalid synthetic task sequence mode");
const intakeFields = process.env.ABBY_SYNTHETIC_INTAKE_FIELDS === "1";
if (intakeFields && operation !== "intake") throw new Error("invalid synthetic intake field mode");
const services = process.env.ABBY_SYNTHETIC_SERVICE_MODE === "1", smtpMode = process.env.ABBY_SYNTHETIC_SMTP_MODE === "1";
if (services && !["book", "intake"].includes(operation!) || process.env.ABBY_SYNTHETIC_SERVICE_MODE && !services || process.env.ABBY_SYNTHETIC_SMTP_MODE && !smtpMode) throw new Error("invalid synthetic integration mode");
const multiLocation = process.env.ABBY_SYNTHETIC_LOCATION_MODE === "1";
const practitionerMove = process.env.ABBY_SYNTHETIC_PRACTITIONER_MOVE;
if (practitionerMove && (!["changedTime", "sameTime", "directory"].includes(practitionerMove) || operation !== "reschedule" || services || multiLocation)) throw new Error("invalid synthetic practitioner move mode");
const longSearch = process.env.ABBY_SYNTHETIC_LONG_SEARCH_MODE === "1";
const offlineCalendar = process.env.ABBY_SYNTHETIC_OFFLINE_CALENDAR === "1", missingBusy = process.env.ABBY_SYNTHETIC_MISSING_BUSY === "1";
const recurringBusy = process.env.ABBY_SYNTHETIC_RECURRING_BUSY;
const recurringOpening = process.env.ABBY_SYNTHETIC_RECURRING_OPENING;
if (offlineCalendar && (!services || !["book", "intake"].includes(operation!)) || missingBusy && !offlineCalendar) throw new Error("invalid synthetic calendar mode");
if (recurringBusy && (!offlineCalendar || !["approved", "legacy"].includes(recurringBusy))) throw new Error("invalid synthetic busy occurrence mode");
if (recurringOpening && (!offlineCalendar || !["approved", "legacy"].includes(recurringOpening))) throw new Error("invalid synthetic opening occurrence mode");
const calendars = new Map<string, ReturnType<typeof syntheticRosterProvider>>();
if (longSearch && (!services || operation !== "book" || multiLocation)) throw new Error("invalid synthetic long search mode");
if (multiLocation && (!services || !["book", "intake"].includes(operation!))) throw new Error("invalid synthetic location mode");
const locationFixture = multiLocation ? operation === "intake" ? await intakeLocationServiceFixture() : await locationServiceFixture() : undefined;
const f = locationFixture?.north ?? (services ? operation === "book" ? await serviceBookingFixture() : await intakeServiceFixture() : operation === "staff.request" ? await clinikoStaffCallFlowFixture() : operation === "book" ? await bookingCallFlowFixture() : operation === "cancel" ? await cancellationCallFlowFixture() :
  operation === "reschedule" ? await reschedulingCallFlowFixture(practitionerMove ? { ...(practitionerMove === "directory" ? { practitionerChoices: ["23"] } : { destinationPractitionerId: "23" }), sameTime: practitionerMove === "sameTime",
    practitionerMoves: [{ fromPractitionerId: "22", toPractitionerId: "23", appointmentTypeId: "33", durationMinutes: 30 }] } : {}) : operation === "intake" ? await intakeCallFlowFixture() : operation === "patientUpdate" ? await patientCorrectionCallFlowFixture() : await appointmentEnquiryFixture());
f.flow.dispose();
if (longSearch && "setStarts" in f) f.setStarts(["2026-11-20T04:00:00.000Z"]);
if (locationFixture && operation === "book") {
  const config = locationFixture.southConfig;
  const before = resultValue(await config.policies.read(locationFixture.south.scope));
  resultValue(await config.policies.changeGreeting(locationFixture.south.scope, before.policyVersion,
    { ...before.greeting!, ownerRef: "synthetic-admin", effectiveFrom: "2026-10-04T05:59:00.000Z",
      effectiveUntil: "2026-10-05T06:00:00.000Z", approvedText: "Welcome to the South clinic. How can I help?" }, "synthetic-admin"));
  config.policyVersion = resultValue(await config.policies.read(locationFixture.south.scope)).policyVersion;
}
const c = f.flowConfig;
if (intakeFields) {
  const path = join(f.folder, "intake.json"), approval = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...approval, requiredFields: [...intakeAllowedFields] }), { mode: 0o600 });
}
let mediaElapsedMs = 0;
const now = () => new Date(Date.parse(c.clock!()) + mediaElapsedMs).toISOString();
const apiKey = process.env.ABBY_CLINIKO_API_KEY!, fingerprint = clinikoCredentialFingerprint(apiKey);
process.env.ABBY_TENANT_ID = f.scope.tenantId; process.env.ABBY_CLINIC_ID = f.scope.clinicId; process.env.ABBY_LOCATION_ID = f.scope.locationId;
process.env.ABBY_TWILIO_TEST_CALLER_NUMBER = f.inbound.presentedCallerNumber;
// These files contain synthetic public approval data only. Rebind the fixture
// to the runner's guarded credential; no real key or patient record is read.
const fixtureRows = locationFixture ? [{ fixture: locationFixture.north, config: c }, { fixture: locationFixture.south, config: locationFixture.southConfig }] : [{ fixture: f, config: c }];
for (const { fixture: f, config: c } of fixtureRows) {
const approvalPaths = new Set([
  ...(await readdir(f.folder)).filter(file => file.endsWith(".json")).map(file => join(f.folder, file)),
  ...Object.values(c.approvals),
  ...(c.enquiry ? [c.enquiry.callerApprovalPath, c.enquiry.readApprovalPath] : []),
  ...(c.staff ? [c.staff.callerApprovalPath, c.staff.staffApprovalPath] : []),
  ...(c.catalogue ? [c.catalogue.approvalPath, ...c.catalogue.practitioners.map(p => p.bookingApprovalPath)] : []),
  ...(c.reschedulingPractitioners ? c.reschedulingPractitioners.map(member => member.bookingApprovalPath) : []),
]);
for (const path of approvalPaths) {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
  if (value && typeof value === "object" && "credentialFingerprint" in value) {
    await writeFile(path, JSON.stringify({ ...value, credentialFingerprint: fingerprint,
      ...("policyVersion" in value ? { policyVersion: c.policyVersion } : {}),
      ...(longSearch && "bookingPolicyVersion" in value ? { maxAdvanceDays: 90, availabilityPlan: { mode: "online", maxSearchDays: 90 } } : {}),
      ...(offlineCalendar && "bookingPolicyVersion" in value ? { availabilityPlan: { ...rosterPlan, maxSearchDays: longSearch ? 90 : 30,
        ...(recurringBusy === "approved" ? { busyRecurrence: "nativeOccurrences" } : {}),
        ...(recurringOpening === "approved" ? { openingRecurrence: "nativeOccurrences" } : {}) } } : {}),
      ...(longSearch && "services" in value && Array.isArray(value.services)
        ? { services: value.services.map(service => ({ ...service, searchDays: 90 })) } : {}) }), { mode: 0o600 });
  }
}
}
const taskSource = taskSequence ? await syntheticTaskSequence({ ...c, cliniko: { ...c.cliniko, apiKey } }, f.folder) : undefined;
const taskNative = taskSequence ? syntheticMultiTaskBookingProvider() : undefined;
const publicInputs: string[] = [], privateInputs: string[] = [];
let denied = false, lostWrite = false, mailLost = false, mutatePolicy = false, intakeFieldMismatch = false;
let appointmentReadMode: "shown" | "unavailable" | "empty" = "shown";
let readCorrectionStatus: (() => Promise<string | undefined>) | undefined;
process.on("message", message => {
  if (!message || typeof message !== "object" || !("kind" in message)) return;
  if (message.kind === "input" && "text" in message && typeof message.text === "string") { publicInputs.push(message.text); process.send?.({ kind: "inputAccepted" }); }
  if (message.kind === "privateInput" && "text" in message && typeof message.text === "string") { privateInputs.push(message.text); process.send?.({ kind: "privateInputAccepted" }); }
  if (multiLocation && message.kind === "advanceClock" && "milliseconds" in message && typeof message.milliseconds === "number") { mediaElapsedMs = Math.max(mediaElapsedMs, message.milliseconds); process.send?.({ kind: "clockAdvanced" }); }
  if (message.kind === "inspectCorrectionState" && readCorrectionStatus) {
    void readCorrectionStatus().then(actionStatus => process.send?.({ kind: "correctionState", actionStatus }))
      .catch(() => process.send?.({ kind: "correctionState", actionStatus: "unavailable" }));
  }
  if (message.kind === "mismatchIntakeField") intakeFieldMismatch = true;
  if (message.kind === "denyPermission") denied = true;
  if (operation === "appointments.read" && message.kind === "appointmentReadMode" && "mode" in message &&
      (message.mode === "shown" || message.mode === "unavailable" || message.mode === "empty")) {
    appointmentReadMode = message.mode;
    process.send?.({ kind: "appointmentReadModeChanged" });
  }
  if (message.kind === "loseWrite") lostWrite = true;
  if (message.kind === "loseMail") mailLost = true;
  if (message.kind === "changePolicy") mutatePolicy = true;
  if (offlineCalendar && message.kind === "occupyCalendar") {
    for (const [selection, calendar] of calendars) {
      const [businessId, practitionerId] = selection.split(":");
      const busy = rosterInterval("unavailable_blocks", "106", recurringBusy ? "2026-10-08T03:00:00.000Z" : "2026-10-08T02:00:00.000Z",
        recurringBusy ? "2026-10-08T04:00:00.000Z" : "2026-10-08T03:00:00.000Z", businessId!, practitionerId!);
      if (recurringBusy) busy.repeat_rule = { repeat_type: "Weekly", number_of_repeats: 6, repeating_interval: 1 };
      calendar.rows.unavailable_blocks!.push(busy);
    }
    process.send?.({ kind: "calendarOccupied" });
  }
});
function policyFor(c: typeof f.flowConfig) {
const policies = withApprovedSyntheticVoice(c.policies);
return new Proxy(policies, { get(target, key) {
  if (key === "read") return async (...args: Parameters<typeof target.read>) => {
    const value = await target.read(...args);
    if (!value.ok) return value;
    const captured = await captureVoicePolicy(value.value, value.value.voiceSettings!, voiceProfiles);
    return captured.ok && mutatePolicy ? ok({ ...captured.value, policyVersion: "changed-policy" }) : captured;
  };
  const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
} });
}
const base = "https://api.au5.cliniko.com/v1";
let after: Record<string, unknown> | undefined, patient: Record<string, unknown> | undefined;
function providerFor(c: typeof f.flowConfig): typeof fetch {
let calendarPort = c.fetchPort!;
if (offlineCalendar) {
  const members = new Set(c.serviceCatalogue!.services.flatMap(service => service.practitioners.map(p => p.practitionerId)));
  for (const practitionerId of members) {
    const businessId = c.cliniko.businessId, key = `${businessId}:${practitionerId}`;
    let calendar = calendars.get(key);
    if (!calendar) {
      calendar = syntheticRosterProvider({ businessId, practitionerId }); calendars.set(key, calendar);
      if (recurringBusy) {
        const rule = { repeat_type: "Weekly", number_of_repeats: 6, repeating_interval: 1 };
        for (const name of ["individual_appointments", "group_appointments", "unavailable_blocks"])
          for (const row of calendar.rows[name]!) row.repeat_rule = rule;
        const busy = rosterInterval("unavailable_blocks", "110", "2026-10-08T02:00:00.000Z", "2026-10-08T03:00:00.000Z", businessId === "11" ? "12" : "11", practitionerId);
        busy.repeat_rule = rule; calendar.rows.unavailable_blocks!.push(busy);
      }
      if (recurringOpening) {
        calendar.rows.daily_availabilities = [];
        for (const row of calendar.rows.availability_blocks!) row.repeat_rule = { repeat_type: "Weekly", number_of_repeats: 6, repeating_interval: 2 };
      }
      if (missingBusy) calendar.fail("group_appointments");
      if (practitionerId === "24") calendar.rows.availability_blocks = [rosterInterval("availability_blocks", "102", "2026-10-08T01:00:00.000Z", "2026-10-08T03:00:00.000Z", businessId, practitionerId)];
      if (longSearch) {
        calendar.rows.daily_availabilities = [];
        calendar.rows.availability_blocks = [rosterInterval("availability_blocks", "102", "2026-11-20T04:00:00.000Z", "2026-11-20T06:00:00.000Z", businessId, practitionerId)];
        calendar.rows.group_appointments = Array.from({ length: 1200 }, (_, n) => {
          const start = Date.parse("2026-10-08T08:00:00Z") + Math.floor(n / 20) * 86_400_000 + (n % 20) * 60_000;
          return rosterInterval("group_appointments", String(200 + n), new Date(start).toISOString(), new Date(start + 5 * 60_000).toISOString(), n % 2 ? "12" : "11", practitionerId);
        });
      }
    }
    calendarPort = calendar.wrap(calendarPort);
  }
}
const taskPort = taskNative?.wrap(calendarPort);
return async (value, init) => {
  const url = new URL(String(value)), method = init?.method ?? "GET";
  process.send?.({ kind: "providerRequest", method, path: url.pathname, scope: c.receipt.scope });
  if (operation === "appointments.read" && method === "GET" && url.pathname === "/v1/individual_appointments") {
    if (appointmentReadMode === "unavailable") return new Response(null, { status: 503 });
    if (appointmentReadMode === "empty") return Response.json({ total_entries: 0, individual_appointments: [] });
  }
  if (taskPort) {
    if (method !== "GET") process.send?.({ kind: "providerMutation", method, path: url.pathname, body: JSON.parse(String(init?.body)) });
    if (lostWrite && method === "POST" && url.pathname === "/v1/individual_appointments") taskNative!.loseResponse();
    return taskPort(value, init);
  }
  if (operation === "patientUpdate" && (method === "PATCH" && url.pathname.startsWith("/v1/patients/") || method === "POST" && url.pathname === "/v1/recalls")) {
    const body = JSON.parse(String(init?.body)); process.send?.({ kind: "providerMutation", method, path: url.pathname, body });
    const response = await c.fetchPort!(value, init);
    if (lostWrite && method === "PATCH") throw new Error("synthetic unknown correction write");
    return response;
  }
  if (operation === "staff.request" && method === "POST" && url.pathname === "/v1/recalls") {
    const body = JSON.parse(String(init?.body));
    process.send?.({ kind: "providerMutation", method, path: url.pathname, body });
    const response = await c.fetchPort!(value, init);
    if (lostWrite) throw new Error("synthetic unknown staff request write");
    return response;
  }
  if (patient && method === "GET" && url.pathname === "/v1/patients/42") return Response.json(intakeFieldMismatch ? { ...patient, post_code: "inspection-mismatch" } : patient);
  if (method === "POST" && url.pathname === "/v1/patients") {
    const body = JSON.parse(String(init?.body)); patient = { ...body, id: "42", archived_at: null };
    process.send?.({ kind: "providerMutation", method, path: url.pathname, body });
    if (lostWrite) throw new Error("synthetic unknown creation");
    return Response.json(patient, { status: 201 });
  }
  if (after && method === "GET" && url.pathname === `/v1/individual_appointments/${after.id}`) return Response.json(after);
  if (url.pathname.endsWith("/conflicts")) return Response.json({ conflicts: { exist: false } });
  if ((method === "POST" && url.pathname === "/v1/individual_appointments") ||
      (method === "PATCH" && url.pathname.startsWith("/v1/individual_appointments/"))) {
    const body = JSON.parse(String(init?.body)), id = method === "POST" ? "91" : url.pathname.split("/")[3]!;
    const before = method === "PATCH" ? await (await c.fetchPort!(`${base}/individual_appointments/${id}`, { method: "GET", redirect: "error", ...(init?.signal ? { signal: init.signal } : {}) })).json() : {};
    const starts = body.starts_at ?? before.starts_at, patientId = body.patient_id ?? (operation === "intake" ? "42" : "482746192837465");
    after = { ...before, id, notes: body.notes ?? before.notes, starts_at: starts,
      ends_at: new Date(Date.parse(starts) + (services ? body.appointment_type_id === "34" ? 60 : body.appointment_type_id === "33" ? 30 : 45 : 30) * 60_000).toISOString(), archived_at: null, deleted_at: null,
      cancelled_at: url.pathname.endsWith("/cancel") ? now() : null,
      patient: { links: { self: `${base}/patients/${patientId}` } }, business: { links: { self: `${base}/businesses/${body.business_id ?? c.cliniko.businessId}` } },
      practitioner: { links: { self: `${base}/practitioners/${body.practitioner_id ?? "22"}` } }, appointment_type: { links: { self: `${base}/appointment_types/${body.appointment_type_id ?? "33"}` } } };
    process.send?.({ kind: "providerMutation", method, path: url.pathname, body });
    if (lostWrite) throw new Error("synthetic unknown appointment write");
    return url.pathname.endsWith("/cancel") ? new Response(null, { status: 204 }) : Response.json(after, { status: method === "POST" ? 201 : 200 });
  }
  const response = await calendarPort(value, init);
  if (multiLocation && c.receipt.scope.locationId === "south" && method === "GET" && url.pathname.startsWith("/v1/patients/")) {
    return Response.json({ ...await response.json(), email: "south-registered@example.test" }, { status: response.status });
  }
  return response;
}; }
const provider = providerFor(c);
const speech: typeof fetch = async (url, init) => {
  if (String(url) !== "https://api.openai.com/v1/audio/speech") throw new Error("synthetic speech endpoint required");
  const body = JSON.parse(String(init?.body)); process.send?.({ kind: "speech", text: body.input });
  const pcm = Buffer.alloc(960); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  return new Response(pcm, { headers: { "content-type": "audio/pcm" } });
};
const transcription = (privateField: boolean, scope?: typeof f.scope) => (sessionId: string) => ({
  async accept() { process.send?.({ kind: privateField ? "privateFrame" : "ordinaryFrame", ...(scope ? { scope } : {}) }); return ok([]); },
  async flush(generation: number) {
    const text = (privateField ? privateInputs : publicInputs).shift();
    if (!text) throw new Error("synthetic caller input missing");
    process.send?.({ kind: privateField ? "privateFinal" : "ordinaryFinal", text, ...(scope ? { scope } : {}) });
    return ok([{ kind: "segmentFinal" as const, sessionId, generation, utteranceId: crypto.randomUUID(), text, quality: "clear" as const }]);
  },
});
const voiceProfiles = new OpenAIVoiceProfileHost({ apiKey: "synthetic-openai", mode: "conversation", fetch: speech,
  customTranscription: { version: "host-transcription.v1", create: transcription(false) },
  quality: (_scope, configurationHash) => ok({ configurationHash, qualityVersion: "synthetic-clinical-runner.v1" }) });
async function intakeFor(c: typeof f.flowConfig, folder: string) { return c.intake ? { policy: resultValue(await OwnerFileIntakePolicy.capture({ ...c.intake.policy.binding(),
  credentialFingerprint: fingerprint, businessId: c.cliniko.businessId, path: join(folder, "intake.json"), directory: c.directory, intakeEnabled: true, clock: now })),
  permission: { allows: async (...args: Parameters<typeof c.intake.permission.allows>) => {
    const allowed = !denied && await c.intake!.permission.allows(...args); process.send?.({ kind: "permissionDecision", operation: "patients.intake", allowed, scope: c.receipt.scope }); return allowed;
  } } } : undefined; }
const locationRows = await Promise.all(fixtureRows.map(async ({ fixture, config }) => {
  const policies = policyFor(config);
  if (config.intake) {
    const path = join(fixture.folder, "intake.json"), approval = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...approval, businessId: config.cliniko.businessId }), { mode: 0o600 });
  }
  const intake = await intakeFor(config, fixture.folder);
  const correction = config.correction ? { ...config.correction, policy: resultValue(await OwnerFilePatientUpdatePolicy.capture({ ...config.correction.policy.binding(),
    credentialFingerprint: fingerprint, path: join(fixture.folder, "correction.json"), directory: config.directory, correctionsEnabled: true, clock: now })) } : undefined;
  return { intake, correction, scope: fixture.scope, config, policies, snapshot: resultValue(await policies.read(fixture.scope)), provider: providerFor(config) };
}));
process.send?.({ kind: "fixtureReady", scope: f.scope, policyVersion: c.policyVersion, locations: locationRows.map(row => ({ scope: row.scope, policyVersion: row.config.policyVersion, businessId: row.config.cliniko.businessId })) });
async function run(delivery?: PatientCodeDelivery) {
  await serveClinikoVoice({ clinikoFetch: provider, openaiFetch: speech, syntheticClock: now, transcriptionFactory: transcription(false), voiceProfiles,
    ...(operation === "patientUpdate" ? { clinikoCredentialAliases: [fingerprint, clinikoCredentialFingerprint("synthetic-secondary-au5")] } : {}),
    speechQuality: (_scope, configurationHash) => ok({ configurationHash, qualityVersion: "synthetic-clinical-runner.v1" }),
    ...(multiLocation ? { clinicalLocations: (context: Parameters<NonNullable<VoiceRunnerPorts["clinicalHost"]>>[0]) => locationRows.map((row, index) => ({ scope: row.scope, spokenName: index ? "South" : "North", host: createHost({ ...context, scope: row.scope }, row) })) }
      : { clinicalHost: (context: Parameters<NonNullable<VoiceRunnerPorts["clinicalHost"]>>[0]) => createHost(context, locationRows[0]!) }),
  });
  function createHost(context: Parameters<NonNullable<VoiceRunnerPorts["clinicalHost"]>>[0], row: typeof locationRows[number]) {
      const c = row.config, clinicPolicy = row.policies, provider = row.provider, intake = row.intake, correction = row.correction;
      const greeting = row.snapshot.greeting!;
      return new ClinikoVoiceClinicalHost({ ...c, ...(taskSource ? { taskSequence: taskSource.config.taskSequence } : {}), scope: context.scope, policies: clinicPolicy, greeting,
        cliniko: { ...c.cliniko, apiKey: context.apiKey, contactEmail: context.contactEmail, rateBudget: context.rateBudget, contactRevision: context.contactRevision }, fetchPort: provider,
        permission: { allows: async (...args) => { const allowed = !denied && await c.permission.allows(...args);
          process.send?.({ kind: "permissionDecision", operation: args[2], allowed, scope: context.scope }); return allowed; } },
        delivery: { send: async (email, code, signal) => {
          const accepted = !mailLost && (delivery ? await delivery.send(email, code, signal) : true);
          process.send?.({ kind: "verificationEmail", email, code, accepted, scope: context.scope }); return accepted;
        } },
        ...(c.enquiry ? { enquiry: { ...c.enquiry, permission: { allows: async (...args) => !denied && c.enquiry!.permission.allows(...args) } } } : {}),
        ...(c.staff ? { staff: { ...c.staff, permission: { allows: async (...args) => {
          const allowed = !denied && await c.staff!.permission.allows(...args);
          process.send?.({ kind: "permissionDecision", operation: args[2], allowed }); return allowed;
        } } } } : {}),
        ...(intake ? { intake, privateIntakeTranscription: transcription(true, context.scope) } : {}),
        ...(correction ? { correction: { ...correction, contactRevision: context.contactRevision,
          permission: { allows: async (...args: Parameters<typeof correction.permission.allows>) => !denied && correction.permission.allows(...args) } },
          privateCorrectionTranscription: transcription(true, context.scope) } : {}),
        intent(owner) {
          const submit = owner.submitCode.bind(owner);
          owner.submitCode = async code => { const result = await submit(code); process.send?.({ kind: "verificationResult", verified: result.verified }); return result; };
          if (taskSequence) return createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-intent", model: "synthetic-model", clinicDate: () => "2026-10-04",
            fetch: async (_value, init) => {
              const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText; process.send?.({ kind: "modelTurn", text });
              const decisions = {
                "Book an appointment.": { kind: "workflow", operation: "book", stage: null, from: null, to: null, choice: null },
                "Book another appointment.": { kind: "workflow", operation: "book", stage: null, from: null, to: null, choice: null },
                "Show times on October 8.": { kind: "menu", operation: null, stage: null, from: "2026-10-08", to: "2026-10-08", choice: null },
                "What happened?": { kind: "outcome", operation: null, stage: null, from: null, to: null, choice: null },
              };
              const decision = decisions[text as keyof typeof decisions]; if (!decision) throw new Error("unexpected synthetic task sequence turn");
              return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
            } });
          if (operation === "patientUpdate") {
            readCorrectionStatus = async () => (await owner.publicIntentContext())?.lastAction?.status;
            return createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-intent", model: "synthetic-model", clinicDate: () => "2026-10-04",
            fetch: async (_value, init) => {
              const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
              process.send?.({ kind: "modelTurn", text });
              return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ kind: "outcome", operation: null, stage: null, from: null, to: null, choice: null }) }] }] });
            } });
          }
          if (practitionerMove === "directory") return createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-intent", model: "synthetic-model", clinicDate: () => "2026-10-04",
            fetch: async (_value, init) => {
              const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
              process.send?.({ kind: "modelTurn", text });
              const decisions = {
                "I need to move an appointment.": { kind: "workflow", operation: "reschedule", stage: null, from: null, to: null, choice: null },
                "Show my existing appointments from October 4 through October 9.": { kind: "menu", operation: null, stage: "targets", from: "2026-10-04", to: "2026-10-09", choice: null },
                "Show move times on October 8.": { kind: "menu", operation: null, stage: "offers", from: "2026-10-08", to: "2026-10-08", choice: null },
              };
              const decision = decisions[text as keyof typeof decisions]; if (!decision) throw new Error("unexpected synthetic directory classified turn");
              return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
            } });
          if (services) return createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-intent", model: "synthetic-model", clinicDate: () => "2026-10-04",
            fetch: async (_value, init) => {
              const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
              process.send?.({ kind: "modelTurn", text });
              if (!["Show times on October 8.", "Save my details.", ...(longSearch ? ["Show times between October 5 and November 30."] : [])].includes(text)) throw new Error("unexpected synthetic classified turn");
              return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text",
                text: JSON.stringify(text === "Save my details." ? { kind: "save", operation: null, stage: null, from: null, to: null, choice: null }
                  : { kind: "menu", operation: null, stage: null, from: longSearch ? "2026-10-05" : "2026-10-08", to: longSearch ? "2026-11-30" : "2026-10-08", choice: null }) }] }] });
            } });
          return async turn => {
          process.send?.({ kind: "modelTurn", text: turn.text });
          if (operation === "staff.request") {
            const request = staffRequestLanguage(turn.text);
            return request ? ok(request) : err({ kind: "intentUnavailable" });
          }
          if (turn.text === "Start") return ok({ kind: "workflow", operation: operation as "book" | "cancel" | "reschedule" | "intake" | "appointments.read" });
          if (turn.text === "Yes") return ok({ kind: "affirm" });
          if (turn.text === "Save") return owner.intakeDraftRef ? ok({ kind: "intake", draftRef: owner.intakeDraftRef }) : err({ kind: "intentUnavailable" });
          if (operation === "book" || operation === "intake") return turn.text === "Times" ? ok({ kind: "bookingMenu", from: "2026-10-08", to: "2026-10-08" }) : ok({ kind: "bookingChoice", choice: 2 });
          if (operation === "reschedule") return turn.text === "Source" || turn.text === "Destination" ? ok({ kind: "reschedulingMenu", stage: turn.text === "Source" ? "targets" : "offers",
            from: turn.text === "Source" ? now() : "2026-10-08", to: turn.text === "Source" ? "2026-10-09T06:00:00.000Z" : "2026-10-08" }) :
            ok({ kind: "reschedulingChoice", stage: turn.text === "Select source" ? "targets" : "offers", choice: turn.text === "Select source" || practitionerMove === "sameTime" ? 1 : 2 });
          if (operation === "appointments.read") return ok({ kind: "appointmentEnquiry", from: now(), to: "2026-10-09T06:00:00.000Z" });
          const grant = await owner.cancellationProof();
          if (!grant) return err({ kind: "intentUnavailable" });
          return turn.text === "Appointments" ? ok({ kind: "appointments", verificationRef: grant.verificationRef, from: now(), to: "2026-10-09T06:00:00.000Z" }) :
            ok({ kind: "cancel", verificationRef: grant.verificationRef, targetRef: "selected" });
        }; },
      });
  }
}
try {
  if (smtpMode) await withSmtpVerificationServer(async smtp => {
    const actual = new SmtpPatientCodeDelivery(smtp.config);
    await run({ send: async (email, code, signal) => {
      const accepted = await actual.send(email, code, signal);
      process.send?.({ kind: "smtpDelivery", accepted, messages: smtp.messages.length,
        envelopeMatches: smtp.commands.includes(`RCPT TO:<${email}>`), codeMatches: smtp.messages.at(-1)?.includes(code) === true });
      return accepted;
    } });
  });
  else await run();
} catch (error) {
  process.send?.({ kind: "fixtureFailure", stage: error instanceof Error && "killed" in error && error.killed === true
    ? "fixtureProcessKilled" : "runnerStartupUnavailable" });
  process.stderr.write("synthetic clinical runner unavailable\n"); process.exitCode = 1;
} finally { await (locationFixture ? locationFixture.close() : f.close()); if (process.connected) process.disconnect(); }
