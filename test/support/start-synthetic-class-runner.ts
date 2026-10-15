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
import { classMoveCallFlowFixture } from "./class-move-call-flow.ts";
import type { ClassPassCancellationEffect } from "../../src/standalone/cliniko-class-pass-cancellation.ts";
import type { ClassServiceConfig } from "../../src/standalone/class-service-catalogue.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { classAttendee, classLink } from "./class-attendance.ts";
import { claimClinikoBudget } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";

const operation = process.env.ABBY_SYNTHETIC_CLINICAL_OPERATION;
if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.ABBY_VOICE_TEST_MODE !== "1" ||
    process.env.ABBY_CLINIKO_API_KEY !== "synthetic-key-au5" || !process.env.DATABASE_URL?.includes("/abby_test_voice_") ||
    process.env.ABBY_TWILIO_ACCOUNT_SID !== `AC${"1".repeat(32)}` || operation !== "book" && operation !== "cancel" && operation !== "reschedule") {
  throw new Error("synthetic class runner requires an isolated attendance fixture");
}
const multiple = process.env.ABBY_SYNTHETIC_MULTIPLE_CLASSES === "1";
const passes = process.env.ABBY_SYNTHETIC_CLASS_PASSES === "1";
if (process.env.ABBY_SYNTHETIC_CLASS_PASSES && (!passes || operation !== "book" || multiple)) throw new Error("invalid synthetic class pass mode");
const cancellationMode = process.env.ABBY_SYNTHETIC_CLASS_PASS_CANCELLATION;
if (cancellationMode && (!["releaseOne", "unchanged", "consumeOne"].includes(cancellationMode) || operation !== "cancel" || multiple || passes)) throw new Error("invalid synthetic pass cancellation mode");
const passCancellation = cancellationMode as ClassPassCancellationEffect | undefined;
const moveMode = process.env.ABBY_SYNTHETIC_CLASS_PASS_MOVE;
if (moveMode && (!["full", "transfer"].includes(moveMode) || operation !== "reschedule" || passes || passCancellation)) throw new Error("invalid synthetic pass movement mode");
const historyText = process.env.ABBY_SYNTHETIC_CLASS_PASS_HISTORY;
if (historyText !== undefined && (!moveMode || !["201", "301", "501", "999"].includes(historyText))) throw new Error("invalid synthetic pass history");
const history = historyText === undefined ? undefined : Number(historyText);
const f = operation === "reschedule" ? await classMoveCallFlowFixture(process.env.ABBY_SYNTHETIC_DIFFERENT_CLASS === "1", multiple,
  moveMode === "full" ? { full: true, ...(history === undefined ? {} : { history }) } : moveMode === "transfer" ? { differentCase: true, ...(history === undefined ? {} : { history }) } : undefined) : await classCallFlowFixture(operation, multiple, passes, passCancellation); f.flow.dispose();
if (operation === "reschedule" && (process.env.ABBY_SYNTHETIC_DIFFERENT_CLASS === "1" || process.env.ABBY_SYNTHETIC_CLASS_DATE_CORRECTION === "1"))
  f.native.groups.push({ ...structuredClone(f.native.groups[1]!), id: "95", ...classLink("group_appointments", "95"),
    starts_at: `2026-10-${process.env.ABBY_SYNTHETIC_CLASS_DATE_CORRECTION === "1" ? "10" : "09"}T12:00:00.000Z`,
    ends_at: `2026-10-${process.env.ABBY_SYNTHETIC_CLASS_DATE_CORRECTION === "1" ? "10" : "09"}T${process.env.ABBY_SYNTHETIC_DIFFERENT_CLASS === "1" ? "12:30" : "13:00"}:00.000Z` });
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
let sharedBudget: ClinikoRequestBudget | undefined;
const inputs: string[] = [];
const occupyClass = () => { for (let index = 0; index < 3; index++) f.native.attendees.push(classAttendee(String(851 + index), "94", String(951 + index))); };
process.on("message", message => {
  if (!message || typeof message !== "object" || !("kind" in message)) return;
  if (message.kind === "input" && "text" in message && typeof message.text === "string") { inputs.push(message.text); process.send?.({ kind: "inputAccepted" }); }
  if (message.kind === "advanceClock" && "milliseconds" in message && Number.isSafeInteger(message.milliseconds) &&
      typeof message.milliseconds === "number" && message.milliseconds >= 0 && message.milliseconds <= 15000) {
    f.setTime(new Date(Date.parse(now()) + message.milliseconds).toISOString()); process.send?.({ kind: "clockAdvanced" });
  }
  if (moveMode && "movePass" in f && f.movePass) {
    if (message.kind === "denyMovePass") { f.movePass.deny(); process.send?.({ kind: "movePassChanged" }); }
    if (message.kind === "changeMovePass") { const selected = f.movePass.selection(); f.movePass.select({ ...selected, destination: { ...selected.destination, entitlementRef: "changed-move-entitlement" } }); process.send?.({ kind: "movePassChanged" }); }
    if (message.kind === "moveCaseRule") { f.movePass.records[f.movePass.sourceCaseId]!.include_cancelled_attendees = true; process.send?.({ kind: "movePassChanged" }); }
    if (message.kind === "movePassRace") {
      f.onWrite(async phase => { if (phase === "association" && "movePass" in f && f.movePass)
        f.native.attendees.push({ ...classAttendee("605", "705", f.movePass.queries[0]!.patientId), arrived: null, patient_case: classLink("patient_cases", f.movePass.destinationCaseId) });
      }); process.send?.({ kind: "movePassRaceArmed" });
    }
    if (message.kind === "movePassLastPage") {
      f.onWrite(async phase => { if (phase === "association" && "movePass" in f && f.movePass)
        f.movePass.caseRows(f.movePass.destinationCaseId).at(-2)!.booking = classLink("bookings", "799999");
      }); process.send?.({ kind: "movePassRaceArmed" });
    }
    if (message.kind === "loseAssociation" && "lose" in f) { f.lose("association"); process.send?.({ kind: "movePassChanged" }); }
  }
  if (passes && "pass" in f) {
    if (message.kind === "denyPass") { f.pass.deny(); process.send?.({ kind: "passChanged" }); }
    if (message.kind === "changePass") { f.pass.select({ patientCaseId: "811222333444555667", entitlementRef: f.pass.entitlementRef }); process.send?.({ kind: "passChanged" }); }
    if (message.kind === "depletePass") { f.pass.record.max_sessions = 1; process.send?.({ kind: "passChanged" }); }
    if (message.kind === "extraPassUseAfterWrite") {
      f.onWrite(async () => {
        if (!("pass" in f)) throw new Error("missing synthetic pass fixture");
        f.pass.rows.push({ ...classAttendee("602", "82", f.pass.queries[0]!.patientId), arrived: null, patient_case: classLink("patient_cases", f.pass.caseId) });
        (f.pass.record.attendee_ids as string[]).push("602");
      });
      process.send?.({ kind: "passRaceArmed" });
    }
  }
  if (passCancellation && "pass" in f) {
    if (message.kind === "denyPassCancellation") { f.pass.deny(); process.send?.({ kind: "passCancelChanged" }); }
    if (message.kind === "changePassCancellation") { f.pass.select({ patientCaseId: "811222333444555667", entitlementRef: f.pass.entitlementRef }); process.send?.({ kind: "passCancelChanged" }); }
    if (message.kind === "changePassCancelRule") { f.pass.record.include_cancelled_attendees = true; process.send?.({ kind: "passCancelChanged" }); }
    if (message.kind === "passCancelRace") {
      f.onWrite(async () => {
        if (!("pass" in f)) throw new Error("missing synthetic pass cancellation fixture");
        f.pass.rows.push({ ...classAttendee("602", "82", f.pass.queries[0]!.patientId), arrived: null, patient_case: classLink("patient_cases", f.pass.caseId) });
        (f.pass.record.attendee_ids as string[]).push("602");
      }); process.send?.({ kind: "passCancelRaceArmed" });
    }
  }
  if (message.kind === "denyPermission") denied = true;
  if (message.kind === "denyClassPermission") classDenied = true;
  if (message.kind === "loseMail") mailLost = true;
  if (message.kind === "loseWrite") lostWrite = true;
  if (message.kind === "changePolicy") policyChanged = true;
  if (message.kind === "revokeClass") void ("replaceSource" in f ? f.replaceSource({ enabled: false }) : f.replacePolicy({ enabled: false })).then(() => process.send?.({ kind: "classRevoked" }));
  if (message.kind === "revokeMove" && "replaceMove" in f) void f.replaceMove({ enabled: false }).then(() => process.send?.({ kind: "moveRevoked" }));
  if (message.kind === "revokeDestination" && "replaceDestination" in f) void f.replaceDestination({ enabled: false }).then(() => process.send?.({ kind: "destinationRevoked" }));
  if (message.kind === "changeMember") void f.replaceAccount({ membershipVersion: "changed-member" }).then(() => process.send?.({ kind: "membershipChanged" }));
  if (message.kind === "loseReview" && "lose" in f) f.lose("review");
  if (message.kind === "loseOriginal" && "lose" in f) f.lose("original");
  if (message.kind === "denyOriginalCancel" && "phasePermission" in f) f.phasePermission(phase => phase !== "cancelOriginal");
  if (message.kind === "fillClass") { occupyClass(); process.send?.({ kind: "classOccupied" }); }
  if (message.kind === "overbookAfterWrite" || message.kind === "overbookExhaustedRecovery") {
    if ("phasePermission" in f) f.onWrite(async phase => {
      if (phase === "replacement") occupyClass();
      if (phase === "compensation" && message.kind === "overbookExhaustedRecovery") {
        assert.ok(sharedBudget);
        // Real claims model other in-flight account consumers after the known
        // compensation send. No limit, clock, lease or stored row is altered.
        for (let index = 0; index < 180; index++) if (await claimClinikoBudget(sharedBudget) !== null) break;
        process.send?.({ kind: "classRecoveryBudgetConsumed" });
      }
    });
    else f.onWrite(async () => occupyClass());
    process.send?.({ kind: "classRaceArmed" });
  }
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
const permissions = (service: ClassServiceConfig): ClassServiceConfig => ({ ...service,
  bookPermission: { allows: async query => {
    const allowed = !classDenied && await service.bookPermission.allows(query);
    process.send?.({ kind: "classPermissionDecision", operation: "book", phase: query.phase, allowed }); return allowed;
  } }, cancelPermission: { allows: async query => {
    const allowed = !classDenied && await service.cancelPermission.allows(query);
    process.send?.({ kind: "classPermissionDecision", operation: "cancel", phase: query.phase, allowed }); return allowed;
  } }, ...(service.move ? { move: { ...service.move, permission: { allows: async query => {
    const allowed = !classDenied && await service.move!.permission.allows(query);
    process.send?.({ kind: "classPermissionDecision", operation: "reschedule", phase: query.phase, allowed }); return allowed;
  } } } } : {}) });
process.send?.({ kind: "fixtureReady", scope: f.scope, policyVersion: c.policyVersion });
try {
  await serveClinikoVoice({ clinikoFetch: provider, openaiFetch: speech, syntheticClock: now, transcriptionFactory: transcription, voiceProfiles: profiles,
    speechQuality: (_scope, configurationHash) => ok({ configurationHash, qualityVersion: "synthetic-class-runner.v1" }),
    clinicalHost(context) {
      sharedBudget = context.rateBudget;
      const host = new ClinikoVoiceClinicalHost({ ...c, scope: context.scope, policies, greeting: snapshot.greeting!, fetchPort: provider,
        cliniko: { ...c.cliniko, apiKey: context.apiKey, contactEmail: context.contactEmail, rateBudget: context.rateBudget, contactRevision: context.contactRevision },
        permission: { allows: async (...args) => {
          const allowed = !denied && await c.permission.allows(...args);
          process.send?.({ kind: "permissionDecision", operation: args[2], allowed }); return allowed;
        } },
        ...(multiple ? { classServices: c.classServices!.map(permissions) } : { classAttendance: permissions(c.classAttendance!) }),
        delivery: { send: async (email, code) => { process.send?.({ kind: "verificationEmail", email, code, accepted: !mailLost }); return !mailLost; } },
        intent(owner) {
          const submit = owner.submitCode.bind(owner);
          owner.submitCode = async code => { const result = await submit(code); process.send?.({ kind: "verificationResult", verified: result.verified }); return result; };
          const write = owner.write.bind(owner);
          owner.write = async (...args) => {
            const started = performance.now(), result = await write(...args);
            process.send?.({ kind: "classWriteOutcome", actionStatus: result.kind, elapsedMs: Math.round(performance.now() - started) });
            if (operation === "reschedule") process.send?.({ kind: "classMoveState",
              originalActive: f.native.attendees.find(row => row.id === "101")?.cancelled_at === null,
              replacementActive: f.native.attendees.find(row => row.id === "401")?.cancelled_at === null });
            if (moveMode && "movePass" in f && f.movePass) {
              const pass = f.movePass, used = (id: string) => pass.caseRows(id).filter(row => row.archived_at === null && row.deleted_at === null &&
                (row.cancelled_at !== null ? pass.records[id]!.include_cancelled_attendees : row.arrived === false ? pass.records[id]!.include_dna_attendees : true)).length;
              process.send?.({ kind: "classPassMoveState", sourceUsed: used(pass.sourceCaseId), destinationUsed: used(pass.destinationCaseId),
                caseLinked: pass.caseRows(pass.destinationCaseId).some(row => row.id === "401") });
            }
            return result;
          };
          return createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-model-key", model: "synthetic-model", clinicDate: () => "2026-10-04",
            fetch: async (_value, init) => {
              const input = JSON.parse(JSON.parse(String(init?.body)).input[1].content);
              process.send?.({ kind: "modelTurn", text: input.callerText });
              const decision = { kind: "unsupported", operation: null as string | null, stage: null as string | null, from: null as string | null, to: null as string | null, choice: null as number | null };
              if (input.callerText === "Start") { decision.kind = "classWorkflow"; decision.operation = operation; }
              else if (input.callerText === "Times") { decision.kind = "menu"; decision.from = decision.to = operation === "reschedule" ? "2026-10-09" : "2026-10-08"; decision.stage = operation === "reschedule" ? "offers" : null; }
              else if (input.callerText === "Appointments") { decision.kind = operation === "reschedule" ? "menu" : "appointments"; decision.stage = operation === "reschedule" ? "targets" : null;
                decision.from = operation === "reschedule" ? "2026-10-08" : "2026-10-04"; decision.to = operation === "reschedule" ? "2026-10-08" : "2026-10-09"; }
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
