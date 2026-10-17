import { observeSyntheticWire } from "./synthetic-wire-observer.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresConfirmationResendJournal } from "../../src/storage/postgres-confirmation-resend-journal.ts";
import { ok } from "../../src/core/model.ts";
import { captureVoicePolicy } from "../../src/core/voice-policy.ts";
import { ClinikoVoiceClinicalHost } from "../../src/standalone/cliniko-voice-clinical-host.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { SmtpPatientCodeDelivery } from "../../src/standalone/smtp-patient-code-delivery.ts";
import { OpenAIVoiceProfileHost } from "../../src/voice/openai-voice-profile.ts";
import { serveClinikoVoice } from "../../scripts/serve-cliniko-voice.ts";
import { confirmationResendFixture } from "./confirmation-resend.ts";
import { withSmtpVerificationServer } from "./smtp-verification-server.ts";
import { withApprovedSyntheticVoice } from "./approved-voice.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

observeSyntheticWire();

const url = process.env.DATABASE_URL, apiKey = process.env.ABBY_CLINIKO_API_KEY;
if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.ABBY_VOICE_TEST_MODE !== "1" ||
    process.env.ABBY_SYNTHETIC_CLINICAL_OPERATION !== "confirmationResend" || apiKey !== "synthetic-key-au5" ||
    !url?.includes("/abby_test_voice_") || process.env.ABBY_TWILIO_ACCOUNT_SID !== `AC${"1".repeat(32)}`) throw new Error("isolated synthetic resend fixture required");
const db = connectPostgres(url);
try {
  await withSmtpVerificationServer(async smtp => {
    const content = process.env.ABBY_SYNTHETIC_RESEND_CONTENT;
    if (content !== undefined && !["telehealth", "cancelled"].includes(content)) throw new Error("unknown synthetic resend content");
    const f = await confirmationResendFixture(db, smtp.config, "appointments.resend", true, apiKey, undefined,
      content ? { template: "appointmentDetails.v2", contentKinds: ["activeInPerson", "activeTelehealth", "cancelled"] } : undefined);
    // Aggregate fixed stage names only. Arguments, IDs, paths, notes and private
    // values never enter these diagnostics. Real source calls still execute.
    const sourceCalls = new Map<string, { count: number; pending: number; totalMs: number; maximumMs: number }>();
    const observe = <Args extends unknown[], Value>(name: string, run: (...args: Args) => Value | Promise<Value>) => async (...args: Args): Promise<Value> => {
      const row = sourceCalls.get(name) ?? { count: 0, pending: 0, totalMs: 0, maximumMs: 0 };
      sourceCalls.set(name, row); row.count++; row.pending++; const start = performance.now();
      try { return await run(...args); }
      finally { const elapsed = performance.now() - start; row.pending--; row.totalMs += elapsed; row.maximumMs = Math.max(row.maximumMs, elapsed); }
    };
    const observedDirectory = <Directory extends Pick<OwnerFileAdminDirectory, "findByRef">>(directory: Directory, name: string): Directory => {
      if (!Reflect.set(directory, "findByRef", observe(name, directory.findByRef.bind(directory)))) throw new Error("synthetic membership observation unavailable");
      return directory;
    };
    const diagnostic = () => Object.fromEntries([...sourceCalls].map(([name, row]) => [name, { ...row,
      totalMs: Math.round(row.totalMs), maximumMs: Math.round(row.maximumMs) }]));
    const inputs: string[] = []; let denied = false, loseMail = false;
    f.setChoices([{ id: "81", starts_at: "2026-10-08T04:00:00.000Z", ends_at: "2026-10-08T04:30:00.000Z" },
      { id: "82", starts_at: "2026-10-09T04:00:00.000Z", ends_at: "2026-10-09T04:30:00.000Z" }]);
    if (content === "telehealth") {
      f.setType({ telehealth_enabled: true });
      f.setAppointment({ telehealth_url: "https://synthetic-clinic.cliniko.com/appointments/81/connect" });
    }
    if (content === "cancelled") f.setChoices([{ id: "81", starts_at: "2026-10-03T04:00:00.000Z", ends_at: "2026-10-03T04:30:00.000Z", cancelled_at: "2026-10-02T06:00:00.000Z" }]);
    const receive = (message: unknown) => {
      if (!message || typeof message !== "object" || !("kind" in message)) return;
      if (message.kind === "resendDiagnostics") process.send?.({ kind: "resendSourceDiagnostic", diagnostic: diagnostic() });
      if (message.kind === "input" && "text" in message && typeof message.text === "string") { inputs.push(message.text); process.send?.({ kind: "inputAccepted" }); }
      if (message.kind === "pagedAppointments") {
        f.setChoices(Array.from({ length: 7 }, (_, i) => ({ id: String(81 + i), starts_at: `2026-10-${String(8 + i).padStart(2, "0")}T04:00:00.000Z`, ends_at: `2026-10-${String(8 + i).padStart(2, "0")}T04:30:00.000Z` })));
        process.send?.({ kind: "appointmentsPaged" });
      }
      if (message.kind === "changeAppointments") {
        f.setChoices([{ id: "81", starts_at: "2026-10-08T05:00:00.000Z", ends_at: "2026-10-08T05:30:00.000Z" }]);
        process.send?.({ kind: "appointmentsChanged" });
      }
      if (message.kind === "denyPermission") denied = true;
      if (message.kind === "loseMail") loseMail = true;
      if (message.kind === "changePolicy") void f.replace({ enabled: false }).then(() => process.send?.({ kind: "policyChanged" }));
    };
    process.on("message", receive);
    const speech: typeof fetch = async (value, init) => {
      if (String(value) !== "https://api.openai.com/v1/audio/speech") throw new Error("synthetic speech endpoint required");
      const body = JSON.parse(String(init?.body)); process.send?.({ kind: "speech", text: body.input });
      const pcm = Buffer.alloc(960); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
      return new Response(pcm, { headers: { "content-type": "audio/pcm" } });
    };
    const transcription = (sessionId: string) => ({
      async accept() { process.send?.({ kind: "ordinaryFrame" }); return ok([]); },
      async flush(generation: number) {
        const text = inputs.shift(); if (!text) throw new Error("synthetic input missing");
        process.send?.({ kind: "ordinaryFinal", text });
        return ok([{ kind: "segmentFinal" as const, sessionId, generation, utteranceId: crypto.randomUUID(), text, quality: "clear" as const }]);
      },
    });
    const now = f.sessionConfig.clock;
    const voiceProfiles = new OpenAIVoiceProfileHost({ apiKey: "synthetic-openai", mode: "conversation", fetch: speech,
      customTranscription: { version: "host-transcription.v1", create: transcription },
      quality: (_scope, configurationHash) => ok({ configurationHash, qualityVersion: "synthetic-clinical-runner.v1" }) });
    const base = withApprovedSyntheticVoice(f.policies);
    const policies = new Proxy(base, { get(target, key) {
      if (key === "read") return async (...args: Parameters<typeof target.read>) => {
        const value = await observe("clinicPolicy", target.read.bind(target))(...args); return value.ok ? captureVoicePolicy(value.value, value.value.voiceSettings!, voiceProfiles) : value;
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const provider: typeof fetch = observe("nativeProvider", async (value: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const path = new URL(String(value)).pathname, method = init?.method ?? "GET";
      process.send?.({ kind: "providerRequest", method, path });
      if (method !== "GET") process.send?.({ kind: "providerMutation", method, path, body: JSON.parse(String(init?.body)) });
      if (method === "GET" && path === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1, practitioners: [{ id: "22" }], links: {} });
      if (method === "GET" && path === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1, appointment_types: [{ id: "33" }], links: {} });
      const result = await f.config.fetchPort(value, init);
      if (method === "GET" && path === "/v1/businesses/11") return Response.json({ ...await result.json(), show_in_online_bookings: true, appointment_type_ids: ["33"] });
      if (method === "GET" && path === "/v1/practitioners/22") return Response.json({ ...await result.json(), active: true, show_in_online_bookings: true });
      if (method === "GET" && path === "/v1/appointment_types/33") return Response.json({ ...await result.json(), show_in_online_bookings: true });
      if (method === "POST" && path === "/v1/recalls" && loseMail) smtp.fault("dropAfterData");
      return result;
    });
    process.env.ABBY_TENANT_ID = f.scope.tenantId; process.env.ABBY_CLINIC_ID = f.scope.clinicId; process.env.ABBY_LOCATION_ID = f.scope.locationId;
    const submitMail = f.config.email.send.bind(f.config.email);
    f.config.email.send = async (...args) => {
      const result = await submitMail(...args), message = smtp.messages.at(-1) ?? "";
      const body = Buffer.from(message.slice(message.indexOf("\r\n\r\n") + 4).replace(/\r\n/g, ""), "base64").toString("utf8");
      process.send?.({ kind: "resendContentResult", accepted: result.kind === "accepted", allowed: content === "telehealth" ?
        body.includes("Patient join link: https://synthetic-clinic.cliniko.com/c/private-patient-join") && !body.includes("/connect") && !body.includes("Address:") :
        body.includes("Status: Cancelled") && !body.includes("join link:") && !body.includes("Address:") && !body.includes("refund") });
      return result;
    };
    process.send?.({ kind: "fixtureReady", scope: f.scope, policyVersion: f.sessionConfig.policyVersion });
    const greeting = resultValue(await policies.read(f.scope)).greeting!;
    try {
      const codeDelivery = new SmtpPatientCodeDelivery(smtp.config);
      await serveClinikoVoice({ clinikoFetch: provider, openaiFetch: speech, voiceProfiles, transcriptionFactory: transcription, syntheticClock: now,
        speechQuality: (_scope, configurationHash) => ok({ configurationHash, qualityVersion: "synthetic-clinical-runner.v1" }),
        clinicalHost: context => new ClinikoVoiceClinicalHost({ ...f.config, scope: f.scope, policies,
          greeting, directory: observedDirectory(new OwnerFileAdminDirectory(f.accountPath, f.scope), "hostMembership"), lookup: f.sessionConfig.lookup,
          verificationBudget: f.sessionConfig.budget,
          cliniko: { ...f.config.cliniko, apiKey: context.apiKey, rateBudget: context.rateBudget, contactRevision: context.contactRevision, practitionerId: "22", appointmentTypeId: "33" },
          approvals: { bookCaller: f.path, cancelCaller: f.path, rescheduleCaller: f.path, booking: f.path, cancellation: f.path, rescheduling: f.path },
          fetchPort: provider,
          permission: { allows: async () => !denied && f.config.permission.allows() },
          delivery: { send: async (email, code, signal) => {
            const accepted = await codeDelivery.send(email, code, signal); process.send?.({ kind: "verificationEmail", email, code, accepted }); return accepted;
          } },
          resend: { ...f.config, callerApprovalPath: f.path, contactRevision: context.contactRevision,
            journal: new PostgresConfirmationResendJournal(context.db, f.scope, f.config.policy.bindingFingerprint()),
            permission: { allows: async () => !denied && f.config.permission.allows() } },
          intent(owner) {
            const list = owner.listResendAppointments.bind(owner), select = owner.selectResendAppointment.bind(owner);
            const menuPlayed = owner.resendMenuPlaybackCompleted.bind(owner);
            owner.resendMenuPlaybackCompleted = async () => { const accepted = await menuPlayed(); process.send?.({ kind: "privateMenuPlayback", accepted }); return accepted; };
            owner.listResendAppointments = async signal => { process.send?.({ kind: "privateMenuStarted" }); const result = await observe("menu", list)(signal); process.send?.({ kind: "privateMenuResult", accepted: result.ok }); return result; };
            owner.selectResendAppointment = async (choice, signal) => { process.send?.({ kind: "privateChoiceStarted" }); const result = await observe("choice", select)(choice, signal); process.send?.({ kind: "privateChoiceResult", accepted: result.ok, diagnostic: diagnostic() }); return result; };
            const page = owner.pageResendAppointments.bind(owner);
            owner.pageResendAppointments = async (direction, signal) => { const result = await page(direction, signal); process.send?.({ kind: "privatePageResult", accepted: result.ok }); return result; };
            const submit = owner.submitCode.bind(owner);
            owner.submitCode = async code => { const result = await submit(code); process.send?.({ kind: "verificationResult", verified: result.verified }); return result; };
            return createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-intent", model: "synthetic-model", clinicDate: () => "2026-10-04",
              fetch: async (_value, init) => {
                const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText; process.send?.({ kind: "modelTurn", text });
                return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ kind: "outcome", operation: null, stage: null, from: null, to: null, choice: null }) }] }] });
              } });
          },
        }),
      });
    } finally { process.off("message", receive); await f.close(); }
  });
} catch {
  process.send?.({ kind: "fixtureFailure", stage: "runnerStartupUnavailable" }); process.stderr.write("synthetic resend runner unavailable\n"); process.exitCode = 1;
} finally { await db.destroy(); if (process.connected) process.disconnect(); }
