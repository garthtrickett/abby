import { withSmtpVerificationServer } from "./smtp-verification-server.ts";
import { SmtpPatientCodeDelivery } from "../../src/standalone/smtp-patient-code-delivery.ts";
import type { PatientCodeDelivery } from "../../src/standalone/email-patient-authority.ts";
import { serviceBookingFixture } from "./service-booking-catalogue.ts";
import { intakeServiceFixture } from "./intake-service-catalogue.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serveClinikoVoice } from "../../scripts/serve-cliniko-voice.ts";
import { ClinikoVoiceClinicalHost } from "../../src/standalone/cliniko-voice-clinical-host.ts";
import { OwnerFileIntakePolicy } from "../../src/standalone/owner-file-intake-policy.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { err, ok } from "../../src/core/model.ts";
import { bookingCallFlowFixture, cancellationCallFlowFixture, reschedulingCallFlowFixture, intakeCallFlowFixture } from "./cliniko-call-flow.ts";
import { appointmentEnquiryFixture } from "./cliniko-appointment-enquiry.ts";
import { clinikoStaffCallFlowFixture } from "./cliniko-staff-call-flow.ts";
import { staffRequestLanguage } from "../../src/standalone/staff-request-language.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { withApprovedSyntheticVoice } from "./approved-voice.ts";
import { captureVoicePolicy } from "../../src/core/voice-policy.ts";
import { OpenAIVoiceProfileHost } from "../../src/voice/openai-voice-profile.ts";

const operation = process.env.ABBY_SYNTHETIC_CLINICAL_OPERATION;
if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.ABBY_VOICE_TEST_MODE !== "1" ||
    process.env.ABBY_CLINIKO_API_KEY !== "synthetic-key-au5" || !process.env.DATABASE_URL?.includes("/abby_test_voice_") ||
    process.env.ABBY_TWILIO_ACCOUNT_SID !== `AC${"1".repeat(32)}` ||
    !["book", "cancel", "reschedule", "intake", "appointments.read", "staff.request"].includes(operation ?? "")) {
  throw new Error("synthetic clinical runner requires an isolated fixture");
}
const services = process.env.ABBY_SYNTHETIC_SERVICE_MODE === "1", smtpMode = process.env.ABBY_SYNTHETIC_SMTP_MODE === "1";
if (services && !["book", "intake"].includes(operation!) || process.env.ABBY_SYNTHETIC_SERVICE_MODE && !services || process.env.ABBY_SYNTHETIC_SMTP_MODE && !smtpMode) throw new Error("invalid synthetic integration mode");
const f = services ? operation === "book" ? await serviceBookingFixture() : await intakeServiceFixture() : operation === "staff.request" ? await clinikoStaffCallFlowFixture() : operation === "book" ? await bookingCallFlowFixture() : operation === "cancel" ? await cancellationCallFlowFixture() :
  operation === "reschedule" ? await reschedulingCallFlowFixture() : operation === "intake" ? await intakeCallFlowFixture() : await appointmentEnquiryFixture();
f.flow.dispose();
const c = f.flowConfig, now = c.clock!, apiKey = process.env.ABBY_CLINIKO_API_KEY!, fingerprint = clinikoCredentialFingerprint(apiKey);
process.env.ABBY_TENANT_ID = f.scope.tenantId; process.env.ABBY_CLINIC_ID = f.scope.clinicId; process.env.ABBY_LOCATION_ID = f.scope.locationId;
process.env.ABBY_TWILIO_TEST_CALLER_NUMBER = f.inbound.presentedCallerNumber;
// These files contain synthetic public approval data only. Rebind the fixture
// to the runner's guarded credential; no real key or patient record is read.
const approvalPaths = new Set([
  ...(await readdir(f.folder)).filter(file => file.endsWith(".json")).map(file => join(f.folder, file)),
  ...Object.values(c.approvals),
  ...(c.enquiry ? [c.enquiry.callerApprovalPath, c.enquiry.readApprovalPath] : []),
  ...(c.staff ? [c.staff.callerApprovalPath, c.staff.staffApprovalPath] : []),
  ...(c.catalogue ? [c.catalogue.approvalPath, ...c.catalogue.practitioners.map(p => p.bookingApprovalPath)] : []),
]);
for (const path of approvalPaths) {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
  if (value && typeof value === "object" && "credentialFingerprint" in value) {
    await writeFile(path, JSON.stringify({ ...value, credentialFingerprint: fingerprint }), { mode: 0o600 });
  }
}
const publicInputs: string[] = [], privateInputs: string[] = [];
let denied = false, lostWrite = false, mailLost = false, mutatePolicy = false;
process.on("message", message => {
  if (!message || typeof message !== "object" || !("kind" in message)) return;
  if (message.kind === "input" && "text" in message && typeof message.text === "string") { publicInputs.push(message.text); process.send?.({ kind: "inputAccepted" }); }
  if (message.kind === "privateInput" && "text" in message && typeof message.text === "string") { privateInputs.push(message.text); process.send?.({ kind: "privateInputAccepted" }); }
  if (message.kind === "denyPermission") denied = true;
  if (message.kind === "loseWrite") lostWrite = true;
  if (message.kind === "loseMail") mailLost = true;
  if (message.kind === "changePolicy") mutatePolicy = true;
});
const policies = withApprovedSyntheticVoice(c.policies);
const clinicPolicy = new Proxy(policies, { get(target, key) {
  if (key === "read") return async (...args: Parameters<typeof target.read>) => {
    const value = await target.read(...args);
    if (!value.ok) return value;
    const captured = await captureVoicePolicy(value.value, value.value.voiceSettings!, voiceProfiles);
    return captured.ok && mutatePolicy ? ok({ ...captured.value, policyVersion: "changed-policy" }) : captured;
  };
  const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
} });
const base = "https://api.au5.cliniko.com/v1";
let after: Record<string, unknown> | undefined, patient: Record<string, unknown> | undefined;
const provider: typeof fetch = async (value, init) => {
  const url = new URL(String(value)), method = init?.method ?? "GET";
  process.send?.({ kind: "providerRequest", method, path: url.pathname });
  if (operation === "staff.request" && method === "POST" && url.pathname === "/v1/recalls") {
    const body = JSON.parse(String(init?.body));
    process.send?.({ kind: "providerMutation", method, path: url.pathname, body });
    const response = await c.fetchPort!(value, init);
    if (lostWrite) throw new Error("synthetic unknown staff request write");
    return response;
  }
  if (patient && method === "GET" && url.pathname === "/v1/patients/42") return Response.json(patient);
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
      patient: { links: { self: `${base}/patients/${patientId}` } }, business: { links: { self: `${base}/businesses/11` } },
      practitioner: { links: { self: `${base}/practitioners/${body.practitioner_id ?? "22"}` } }, appointment_type: { links: { self: `${base}/appointment_types/${body.appointment_type_id ?? "33"}` } } };
    process.send?.({ kind: "providerMutation", method, path: url.pathname, body });
    if (lostWrite) throw new Error("synthetic unknown appointment write");
    return url.pathname.endsWith("/cancel") ? new Response(null, { status: 204 }) : Response.json(after, { status: method === "POST" ? 201 : 200 });
  }
  return c.fetchPort!(value, init);
};
const speech: typeof fetch = async (url, init) => {
  if (String(url) !== "https://api.openai.com/v1/audio/speech") throw new Error("synthetic speech endpoint required");
  const body = JSON.parse(String(init?.body)); process.send?.({ kind: "speech", text: body.input });
  const pcm = Buffer.alloc(960); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  return new Response(pcm, { headers: { "content-type": "audio/pcm" } });
};
const transcription = (privateField: boolean) => (sessionId: string) => ({
  async accept() { process.send?.({ kind: privateField ? "privateFrame" : "ordinaryFrame" }); return ok([]); },
  async flush(generation: number) {
    const text = (privateField ? privateInputs : publicInputs).shift();
    if (!text) throw new Error("synthetic caller input missing");
    process.send?.({ kind: privateField ? "privateFinal" : "ordinaryFinal", text });
    return ok([{ kind: "segmentFinal" as const, sessionId, generation, utteranceId: crypto.randomUUID(), text, quality: "clear" as const }]);
  },
});
const voiceProfiles = new OpenAIVoiceProfileHost({ apiKey: "synthetic-openai", mode: "conversation", fetch: speech,
  customTranscription: { version: "host-transcription.v1", create: transcription(false) },
  quality: (_scope, configurationHash) => ok({ configurationHash, qualityVersion: "synthetic-clinical-runner.v1" }) });
const snapshot = resultValue(await clinicPolicy.read(f.scope));
const intake = c.intake ? { policy: resultValue(await OwnerFileIntakePolicy.capture({ ...c.intake.policy.binding(),
  credentialFingerprint: fingerprint, path: join(f.folder, "intake.json"), directory: c.directory, intakeEnabled: true, clock: now })),
  permission: { allows: async (...args: Parameters<typeof c.intake.permission.allows>) => {
    const allowed = !denied && await c.intake!.permission.allows(...args); process.send?.({ kind: "permissionDecision", operation: "patients.intake", allowed }); return allowed;
  } } } : undefined;
process.send?.({ kind: "fixtureReady", scope: f.scope, policyVersion: c.policyVersion });
async function run(delivery?: PatientCodeDelivery) {
  await serveClinikoVoice({ clinikoFetch: provider, openaiFetch: speech, syntheticClock: now, transcriptionFactory: transcription(false), voiceProfiles,
    speechQuality: (_scope, configurationHash) => ok({ configurationHash, qualityVersion: "synthetic-clinical-runner.v1" }),
    clinicalHost(context) {
      const greeting = snapshot.greeting!;
      return new ClinikoVoiceClinicalHost({ ...c, scope: context.scope, policies: clinicPolicy, greeting,
        cliniko: { ...c.cliniko, apiKey: context.apiKey, contactEmail: context.contactEmail, rateBudget: context.rateBudget }, fetchPort: provider,
        permission: { allows: async (...args) => { const allowed = !denied && await c.permission.allows(...args);
          process.send?.({ kind: "permissionDecision", operation: args[2], allowed }); return allowed; } },
        delivery: { send: async (email, code, signal) => {
          const accepted = !mailLost && (delivery ? await delivery.send(email, code, signal) : true);
          process.send?.({ kind: "verificationEmail", email, code, accepted }); return accepted;
        } },
        ...(c.enquiry ? { enquiry: { ...c.enquiry, permission: { allows: async (...args) => !denied && c.enquiry!.permission.allows(...args) } } } : {}),
        ...(c.staff ? { staff: { ...c.staff, permission: { allows: async (...args) => {
          const allowed = !denied && await c.staff!.permission.allows(...args);
          process.send?.({ kind: "permissionDecision", operation: args[2], allowed }); return allowed;
        } } } } : {}),
        ...(intake ? { intake, privateIntakeTranscription: transcription(true) } : {}),
        intent(owner) {
          const submit = owner.submitCode.bind(owner);
          owner.submitCode = async code => { const result = await submit(code); process.send?.({ kind: "verificationResult", verified: result.verified }); return result; };
          if (services) return createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-intent", model: "synthetic-model", clinicDate: () => "2026-10-04",
            fetch: async (_value, init) => {
              const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
              process.send?.({ kind: "modelTurn", text });
              if (!["Show times on October 8.", "Save my details."].includes(text)) throw new Error("unexpected synthetic classified turn");
              return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text",
                text: JSON.stringify(text === "Save my details." ? { kind: "save", operation: null, stage: null, from: null, to: null, choice: null }
                  : { kind: "menu", operation: null, stage: null, from: "2026-10-08", to: "2026-10-08", choice: null }) }] }] });
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
            ok({ kind: "reschedulingChoice", stage: turn.text === "Select source" ? "targets" : "offers", choice: turn.text === "Select source" ? 1 : 2 });
          if (operation === "appointments.read") return ok({ kind: "appointmentEnquiry", from: now(), to: "2026-10-09T06:00:00.000Z" });
          const grant = await owner.cancellationProof();
          if (!grant) return err({ kind: "intentUnavailable" });
          return turn.text === "Appointments" ? ok({ kind: "appointments", verificationRef: grant.verificationRef, from: now(), to: "2026-10-09T06:00:00.000Z" }) :
            ok({ kind: "cancel", verificationRef: grant.verificationRef, targetRef: "selected" });
        }; },
      });
    },
  });
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
} catch {
  process.stderr.write("synthetic clinical runner unavailable\n"); process.exitCode = 1;
} finally { await f.close(); if (process.connected) process.disconnect(); }
