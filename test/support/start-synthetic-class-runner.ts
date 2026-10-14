import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serveClinikoVoice } from "../../scripts/serve-cliniko-voice.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { ok } from "../../src/core/model.ts";
import { captureVoicePolicy } from "../../src/core/voice-policy.ts";
import { ClinikoVoiceClinicalHost } from "../../src/standalone/cliniko-voice-clinical-host.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { OpenAIVoiceProfileHost } from "../../src/voice/openai-voice-profile.ts";
import { withApprovedSyntheticVoice } from "./approved-voice.ts";
import { classCallFlowFixture } from "./class-call-flow.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { classAttendee } from "./class-attendance.ts";

const operation = process.env.ABBY_SYNTHETIC_CLINICAL_OPERATION;
if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.ABBY_VOICE_TEST_MODE !== "1" ||
    process.env.ABBY_CLINIKO_API_KEY !== "synthetic-key-au5" || !process.env.DATABASE_URL?.includes("/abby_test_voice_") ||
    process.env.ABBY_TWILIO_ACCOUNT_SID !== `AC${"1".repeat(32)}` || operation !== "book" && operation !== "cancel") {
  throw new Error("synthetic class runner requires an isolated book/cancel fixture");
}
const f = await classCallFlowFixture(operation); f.flow.dispose();
const c = f.flowConfig, apiKey = process.env.ABBY_CLINIKO_API_KEY!, now = c.clock!;
process.env.ABBY_TENANT_ID = f.scope.tenantId; process.env.ABBY_CLINIC_ID = f.scope.clinicId; process.env.ABBY_LOCATION_ID = f.scope.locationId;
process.env.ABBY_TWILIO_TEST_CALLER_NUMBER = f.inbound.presentedCallerNumber;
// Only public synthetic approvals are rebound. The runtime supplies its actual
// shared request budget, contact revision and authenticated admission below.
for (const file of (await readdir(f.folder)).filter(file => file.endsWith(".json"))) {
  const path = join(f.folder, file), value = JSON.parse(await readFile(path, "utf8"));
  if (value && typeof value === "object" && !Array.isArray(value) && "credentialFingerprint" in value)
    await writeFile(path, JSON.stringify({ ...value, credentialFingerprint: clinikoCredentialFingerprint(apiKey) }), { mode: 0o600 });
}
f.native.config.contactEmail = process.env.ABBY_CLINIKO_CONTACT_EMAIL!;
f.native.business.business_name = "Demo Clinic"; f.native.business.show_in_online_bookings = true;
f.native.type.name = "Mat Pilates"; f.native.type.show_in_online_bookings = true;

let denied = false, classDenied = false, mailLost = false, lostWrite = false, policyChanged = false;
const inputs: string[] = [];
const occupyClass = () => { for (let index = 0; index < 3; index++) f.native.attendees.push(classAttendee(String(851 + index), "94", String(951 + index))); };
process.on("message", message => {
  if (!message || typeof message !== "object" || !("kind" in message)) return;
  if (message.kind === "input" && "text" in message && typeof message.text === "string") { inputs.push(message.text); process.send?.({ kind: "inputAccepted" }); }
  if (message.kind === "denyPermission") denied = true;
  if (message.kind === "denyClassPermission") classDenied = true;
  if (message.kind === "loseMail") mailLost = true;
  if (message.kind === "loseWrite") lostWrite = true;
  if (message.kind === "changePolicy") policyChanged = true;
  if (message.kind === "revokeClass") void f.replacePolicy({ enabled: false }).then(() => process.send?.({ kind: "classRevoked" }));
  if (message.kind === "fillClass") { occupyClass(); process.send?.({ kind: "classOccupied" }); }
  if (message.kind === "overbookAfterWrite") { f.onWrite(async () => occupyClass()); process.send?.({ kind: "classRaceArmed" }); }
});
const provider: typeof fetch = async (value, init) => {
  const url = new URL(String(value)), method = init?.method ?? "GET";
  process.send?.({ kind: "providerRequest", method, path: url.pathname, elapsedMs: Math.round(performance.now()) });
  if (method === "GET" && url.pathname === "/v1/practitioners/22") return Response.json({ id: "22", active: true, show_in_online_bookings: true, display_name: "Demo Instructor" });
  if (method === "GET" && url.pathname === "/v1/businesses/11/practitioners") return Response.json({ practitioners: [{ id: "22" }], total_entries: 1 });
  if (method !== "GET") process.send?.({ kind: "providerMutation", method, path: url.pathname, body: JSON.parse(String(init?.body)) });
  const response = await c.fetchPort!(value, init);
  if (lostWrite && (method === "POST" && url.pathname === "/v1/attendees" || method === "PATCH" && /^\/v1\/attendees\/[1-9][0-9]*\/cancel$/.test(url.pathname)))
    throw new Error("synthetic lost class mutation response");
  return response;
};
const speech: typeof fetch = async (value, init) => {
  assert.equal(String(value), "https://api.openai.com/v1/audio/speech");
  process.send?.({ kind: "speech", text: JSON.parse(String(init?.body)).input });
  const pcm = Buffer.alloc(960); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  return new Response(pcm, { headers: { "content-type": "audio/pcm" } });
};
const transcription = (sessionId: string) => ({
  async accept() { process.send?.({ kind: "ordinaryFrame" }); return ok([]); },
  async flush(generation: number) {
    const text = inputs.shift(); if (!text) throw new Error("synthetic class input missing");
    process.send?.({ kind: "ordinaryFinal", text });
    return ok([{ kind: "segmentFinal" as const, sessionId, generation, utteranceId: crypto.randomUUID(), text, quality: "clear" as const }]);
  },
});
const profiles = new OpenAIVoiceProfileHost({ apiKey: "synthetic-openai", mode: "conversation", fetch: speech,
  customTranscription: { version: "host-transcription.v1", create: transcription },
  quality: (_scope, configurationHash) => ok({ configurationHash, qualityVersion: "synthetic-class-runner.v1" }) });
const approved = withApprovedSyntheticVoice(c.policies);
const policies = new Proxy(approved, { get(target, key) {
  if (key === "read") return async (...args: Parameters<typeof target.read>) => {
    const value = await target.read(...args); if (!value.ok) return value;
    const captured = await captureVoicePolicy(value.value, value.value.voiceSettings!, profiles);
    return captured.ok && policyChanged ? ok({ ...captured.value, policyVersion: "changed-policy" }) : captured;
  };
  const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
} });
const snapshot = resultValue(await policies.read(f.scope));
process.send?.({ kind: "fixtureReady", scope: f.scope, policyVersion: c.policyVersion });
try {
  await serveClinikoVoice({ clinikoFetch: provider, openaiFetch: speech, syntheticClock: now, transcriptionFactory: transcription, voiceProfiles: profiles,
    speechQuality: (_scope, configurationHash) => ok({ configurationHash, qualityVersion: "synthetic-class-runner.v1" }),
    clinicalHost(context) {
      const host = new ClinikoVoiceClinicalHost({ ...c, scope: context.scope, policies, greeting: snapshot.greeting!, fetchPort: provider,
        cliniko: { ...c.cliniko, apiKey: context.apiKey, contactEmail: context.contactEmail, rateBudget: context.rateBudget, contactRevision: context.contactRevision },
        permission: { allows: async (...args) => {
          const allowed = !denied && await c.permission.allows(...args);
          process.send?.({ kind: "permissionDecision", operation: args[2], allowed }); return allowed;
        } },
        classAttendance: { ...c.classAttendance!, bookPermission: { allows: async query => {
          const allowed = !classDenied && await c.classAttendance!.bookPermission.allows(query);
          process.send?.({ kind: "classPermissionDecision", operation: "book", phase: query.phase, allowed }); return allowed;
        } }, cancelPermission: { allows: async query => {
          const allowed = !classDenied && await c.classAttendance!.cancelPermission.allows(query);
          process.send?.({ kind: "classPermissionDecision", operation: "cancel", phase: query.phase, allowed }); return allowed;
        } } },
        delivery: { send: async (email, code) => { process.send?.({ kind: "verificationEmail", email, code, accepted: !mailLost }); return !mailLost; } },
        intent(owner) {
          const submit = owner.submitCode.bind(owner);
          owner.submitCode = async code => { const result = await submit(code); process.send?.({ kind: "verificationResult", verified: result.verified }); return result; };
          const write = owner.write.bind(owner);
          owner.write = async (...args) => {
            const started = performance.now(), result = await write(...args);
            process.send?.({ kind: "classWriteOutcome", actionStatus: result.kind, elapsedMs: Math.round(performance.now() - started) });
            return result;
          };
          return createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-model-key", model: "synthetic-model", clinicDate: () => "2026-10-04",
            fetch: async (_value, init) => {
              const input = JSON.parse(JSON.parse(String(init?.body)).input[1].content);
              process.send?.({ kind: "modelTurn", text: input.callerText });
              const decision = { kind: "unsupported", operation: null as string | null, stage: null, from: null as string | null, to: null as string | null, choice: null as number | null };
              if (input.callerText === "Start") { decision.kind = "classWorkflow"; decision.operation = operation; }
              else if (input.callerText === "Times") { decision.kind = "menu"; decision.from = decision.to = "2026-10-08"; }
              else if (input.callerText === "Appointments") { decision.kind = "appointments"; decision.from = "2026-10-04"; decision.to = "2026-10-09"; }
              else if (input.callerText === "What happened?") decision.kind = "outcome";
              else throw new Error("unexpected synthetic class model turn");
              return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
            } });
        },
      });
      const observe = (host: ClinikoVoiceClinicalHost): ClinikoVoiceClinicalHost => {
        const workflow = host.workflow.bind(host), rebind = host.withContactRevision.bind(host);
        host.workflow = approval => {
          const owned = workflow(approval);
          return { ...owned, create(admission) {
            // Observe the actual transient call's SAM. The fixture still asserts
            // one dispatched, played action at every native attendance mutation.
            f.bindNativeCall(async () => resultValue(await admission.ledger.read(admission.receipt.callId, admission.receipt.scope)));
            return owned.create(admission);
          } };
        };
        // The real runner creates a newly bound host for the contact-revision
        // owner. Carry this test-only observation to that actual host too.
        host.withContactRevision = owner => observe(rebind(owner));
        return host;
      };
      return observe(host);
    },
  });
} catch {
  process.send?.({ kind: "fixtureFailure", stage: "runnerStartupUnavailable" });
  process.stderr.write("synthetic class runner unavailable\n"); process.exitCode = 1;
} finally { await f.close(); if (process.connected) process.disconnect(); }
