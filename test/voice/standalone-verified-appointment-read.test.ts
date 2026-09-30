import assert from "node:assert/strict";
import test from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { AppointmentHost } from "../../src/core/host.ts";
import { err, ok } from "../../src/core/model.ts";
import type { AppointmentReadFailure, CallPolicy, LocationScope, Result } from "../../src/core/model.ts";
import { DisabledStandaloneHost } from "../../src/standalone/disabled-host.ts";
import { VerifiedAppointmentReadSession } from "../../src/standalone/verified-appointment-read-session.ts";
import type { PatientAuthority } from "../../src/standalone/transient-patient-proof.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { CallAdmissionService, callIdFor } from "../../src/voice/admission.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";

const scope: LocationScope = { tenantId: "verified-tenant", clinicId: "verified-clinic", locationId: "verified-location" };
const initial = "2026-09-30T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(initial) + seconds * 1000).toISOString();
const until = "2026-10-05T10:00:00.000Z";
const token = "trustedHostTokenForCall";
let sequence = 0;

function value<T, E extends { kind: string }>(result: Result<T, E>): T {
  assert.equal(result.ok, true, result.ok ? "" : result.error.kind);
  return result.value;
}

class StandalonePolicy extends MemoryPolicyStore {
  override async read(requestScope: LocationScope) {
    const policy: CallPolicy = { ...referenceDefaultPolicy(requestScope), automationEnabled: true,
      staffWorkEnabled: false,
      capabilities: { book: "unavailable", cancel: "unavailable", reschedule: "unavailable",
        intake: "unavailable", transfer: "unavailable" } };
    return ok(policy);
  }
}

type Appointment = Readonly<{ id: string; patientId?: string; startsAt: string; endsAt: string;
  cancelledAt?: string | null }>;

async function fixture(options: {
  candidates?: readonly string[];
  selectedPatient?: string;
  authority?: PatientAuthority;
  appointments?: readonly Appointment[];
  providerFailure?: number | "timeout";
  enabled?: boolean;
  onAppointmentRead?: (number: number) => void;
  selectionOverride?: NonNullable<AppointmentHost["select"]>;
} = {}) {
  const suffix = ++sequence;
  const key = { accountRef: `account-${suffix}`, providerCallRef: `call-${suffix}` };
  const callId = callIdFor(key);
  const sessionId = `verified-session-${suffix}`;
  const inbound = { key, presentedCallerNumber: "+61400111222", dialedNumber: "+6125550100", receivedAt: initial };
  let enabled = options.enabled ?? true;
  const requests: URL[] = [];
  const spoken: string[] = [];
  let appointments = options.appointments ?? [{ id: "33", startsAt: "2026-10-01T10:00:00.000Z",
    endsAt: "2026-10-01T10:30:00.000Z" }];
  let providerFailure = options.providerFailure;
  let clockTime = at(3);
  let appointmentReadNumber = 0;
  const provider: typeof fetch = async input => {
    const url = new URL(String(input));
    requests.push(url);
    if (providerFailure === "timeout") throw new DOMException("synthetic provider timeout", "TimeoutError");
    if (providerFailure) return new Response("", { status: providerFailure });
    if (url.pathname === "/v1/businesses/11") return new Response(JSON.stringify({ id: "11",
      time_zone_identifier: "Australia/Sydney", archived_at: null }));
    assert.equal(url.pathname, "/v1/individual_appointments");
    appointmentReadNumber += 1;
    options.onAppointmentRead?.(appointmentReadNumber);
    return new Response(JSON.stringify({ total_entries: appointments.length, individual_appointments: appointments.map(item => ({
      id: item.id, starts_at: item.startsAt, ends_at: item.endsAt,
      patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${item.patientId ?? "22"}` } },
      business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/11" } },
      cancelled_at: item.cancelledAt ?? null, archived_at: null, deleted_at: null,
      patient_name: "PRIVATE PATIENT CANARY", notes: "PRIVATE NOTE CANARY",
    })) }));
  };
  const authority: PatientAuthority = options.authority ?? { async attest(request) {
    return ok({ scope: request.scope, callId: request.callId, sessionId: request.sessionId,
      patientId: options.selectedPatient ?? "22", operations: [request.operation],
      policyVersion: request.policyVersion });
  } };
  const ledger = new MemoryLedger();
  const policy = new StandalonePolicy();
  const admitted = value(await new CallAdmissionService(ledger, async () => policy.read(scope),
    () => initial, async () => ok(true)).begin(inbound));
  const actualCallId = admitted.receipt.callId;
  assert.equal(actualCallId, callId, "the proof is bound to the authenticated provider call");
  const verified = value(VerifiedAppointmentReadSession.create({ receipt: admitted.receipt, inbound, sessionId,
    policyVersion: "verification-v1", maxAttempts: 2,
    lookup: { async candidates() { return ok({ kind: "multiple" as const,
      candidateIds: options.candidates ?? ["22", "23"] }); } },
    authority, policy: { async current() { return ok({ scope, enabled, version: "verification-v1" }); } },
    clock: () => clockTime, cliniko: { apiKey: "synthetic-key-au5", contactEmail: "dev@example.test",
      businessId: "11" }, fetchPort: provider }));
  const host = new DisabledStandaloneHost();
  const appointmentHost = options.selectionOverride
    ? { list: verified.appointments.list, select: options.selectionOverride } : verified.appointments;
  const reception = new TextReception(ledger, policy, host, undefined, appointmentHost, undefined, host);
  let verificationRef = "unverified-reference";
  const voice = new VoiceSession(actualCallId, sessionId, scope, ledger, reception,
    { async enqueue(_playbackId, text) { spoken.push(text); return "queued"; }, async clear() { return true; } },
    async turn => turn.text.startsWith("Choose ")
      ? ok({ kind: "appointmentSelection", verificationRef,
        choice: turn.text === "Choose first" ? 1 as const : turn.text === "Choose second" ? 2 as const : 3 as const })
      : ok({ kind: "appointments", verificationRef, from: at(3), to: until }));
  value(await voice.attach(at(1)));
  let turnCount = 0;
  let lastActionSec = 5;
  async function turn(text = "What is my appointment?", played = true) {
    const startSec = 2 + turnCount * 5;
    const generation = value(await voice.speechStarted(at(startSec)));
    value(voice.acceptTranscript({ kind: "segmentFinal", sessionId, generation, utteranceId: `request-${turnCount}`,
      text, quality: "clear" }));
    clockTime = at(startSec + 1);
    const state = value(await voice.finishTurn(clockTime));
    const delivery = value(await voice.dispatchPending(at(startSec + 2)));
    assert.equal(delivery.kind, "queued");
    if (played) value(await voice.acceptPlaybackResult(delivery.playbackId!, "played", at(startSec + 3)));
    lastActionSec = startSec + 3;
    turnCount += 1;
    return state;
  }
  return { verified, ledger, requests, spoken, turn, end: async () => {
    value(await voice.end(at(lastActionSec + 1), "callerDisconnected"));
    verified.dispose();
  }, issue: async () => {
    verificationRef = value(await verified.issueReadProof(token)).verificationRef;
    return verificationRef;
  }, setEnabled: (next: boolean) => { enabled = next; },
  setAppointments: (next: readonly Appointment[]) => { appointments = next; },
  setProviderFailure: (next: number | "timeout" | undefined) => { providerFailure = next; } };
}

test("E2E-202 verified standalone voice read speaks only the selected patient's Cliniko appointment", async () => {
  const app = await fixture({ selectedPatient: "23", appointments: [{ id: "44", patientId: "23",
    startsAt: "2026-10-01T10:00:00.000Z", endsAt: "2026-10-01T10:30:00.000Z" }] });
  const proofRef = await app.issue();
  const state = await app.turn();
  assert.equal(state.appointmentReads.at(-1)?.status, "shown");
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1]?.searchParams.getAll("q[]").includes("patient_id:=23"), true);
  assert.match(app.spoken[0] ?? "", /Thursday 1 October/);
  assert.equal(JSON.stringify(app.spoken).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(state).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(state).includes('"patientRef"'), false);
  assert.equal(JSON.stringify(state).includes('"appointmentRef"'), false);
  await app.end();
  assert.equal((await app.verified.issueReadProof(token)).ok, false, "disconnect revokes the call proof");
  const afterEnd = await app.verified.appointments.list(scope, proofRef, at(3), until, at(3));
  assert.equal(afterEnd.ok, false);
  assert.equal(app.requests.length, 2, "disconnect cannot trigger another protected read");
});

test("E2E-202 unverified, wrong-patient and revoked calls disclose nothing", async () => {
  const unverified = await fixture();
  const denied = await unverified.turn();
  assert.equal(denied.appointmentReads.at(-1)?.status, "failed");
  assert.equal(unverified.requests.length, 0);
  assert.deepEqual(unverified.spoken, ["I can't send a staff request from this call. Please contact the clinic directly."]);
  await unverified.end();

  const wrong = await fixture({ authority: { async attest(request) { return ok({ scope: request.scope,
    callId: request.callId, sessionId: request.sessionId, patientId: "24",
    operations: [request.operation], policyVersion: request.policyVersion }); } } });
  assert.equal((await wrong.verified.issueReadProof(token)).ok, false);
  await wrong.turn();
  assert.equal(wrong.requests.length, 0);
  assert.equal(JSON.stringify(wrong.spoken).includes("appointment on"), false);
  await wrong.end();

  const revoked = await fixture();
  await revoked.issue();
  revoked.setEnabled(false);
  await revoked.turn();
  assert.equal(revoked.requests.length, 0);
  assert.equal(JSON.stringify(revoked.spoken).includes("appointment on"), false);
  await revoked.end();
});

test("E2E-202 empty, multiple, cancelled and unavailable reads remain truthful", async () => {
  for (const [appointments, expected] of [
    [[], /couldn't find an appointment/],
    [[{ id: "33", startsAt: "2026-10-01T10:00:00.000Z", endsAt: "2026-10-01T10:30:00.000Z" },
      { id: "34", startsAt: "2026-10-02T10:00:00.000Z", endsAt: "2026-10-02T10:30:00.000Z" }], /found 2 appointments/],
    [[{ id: "33", startsAt: "2026-10-01T10:00:00.000Z", endsAt: "2026-10-01T10:30:00.000Z",
      cancelledAt: "2026-09-30T09:00:00.000Z" }], /couldn't find an appointment/],
  ] as const) {
    const app = await fixture({ appointments });
    await app.issue();
    await app.turn();
    assert.match(app.spoken[0] ?? "", expected);
    assert.equal(JSON.stringify(app.spoken).includes("PRIVATE"), false);
    await app.end();
  }
  for (const providerFailure of [503, "timeout"] as const) {
    const unavailable = await fixture({ providerFailure });
    await unavailable.issue();
    const state = await unavailable.turn();
    assert.equal(state.appointmentReads.at(-1)?.status, "failed");
    assert.deepEqual(unavailable.spoken, ["I can't send a staff request from this call. Please contact the clinic directly."]);
    await unavailable.end();
  }
  const crossed = await fixture({ appointments: [{ id: "55", patientId: "24",
    startsAt: "2026-10-01T10:00:00.000Z", endsAt: "2026-10-01T10:30:00.000Z" }] });
  await crossed.issue();
  const state = await crossed.turn();
  assert.equal(state.appointmentReads.at(-1)?.status, "failed");
  assert.deepEqual(crossed.spoken, ["I can't send a staff request from this call. Please contact the clinic directly."]);
  assert.equal(JSON.stringify(crossed.spoken).includes("PRIVATE"), false);
  await crossed.end();
});

const twoAppointments: readonly Appointment[] = [
  { id: "33", startsAt: "2026-10-01T10:00:00.000Z", endsAt: "2026-10-01T10:30:00.000Z" },
  { id: "34", startsAt: "2026-10-02T10:00:00.000Z", endsAt: "2026-10-02T10:30:00.000Z" },
];

test("E2E-203 a played list permits one exact second choice after a fresh Cliniko read", async () => {
  const app = await fixture({ appointments: twoAppointments });
  await app.issue();
  const offered = await app.turn();
  assert.equal(offered.appointmentReads.at(-1)?.shownCount, 2);
  assert.match(app.spoken[0] ?? "", /found 2 appointments/);
  assert.match(app.spoken[0] ?? "", /option one, Thursday 1 October.*option two, Friday 2 October/);
  const selected = await app.turn("Choose second");
  assert.equal(selected.appointmentReads.at(-1)?.shownCount, 1);
  assert.match(app.spoken[1] ?? "", /Friday 2 October/);
  assert.equal((app.spoken[1] ?? "").includes("Thursday 1 October"), false);
  assert.equal(app.requests.length, 4, "the exact choice is re-read, including its business");
  assert.equal(JSON.stringify(selected).includes('"appointmentRef"'), false);
  assert.equal(JSON.stringify(selected).includes('"patientRef"'), false);
  assert.equal(JSON.stringify(app.spoken).includes("PRIVATE"), false);
  await app.end();
});

test("E2E-203 interrupted options, invalid ordinal and replay cannot select an appointment", async () => {
  const interrupted = await fixture({ appointments: twoAppointments });
  await interrupted.issue();
  await interrupted.turn(undefined, false);
  const interruptedResult = await interrupted.turn("Choose second");
  assert.equal(interruptedResult.appointmentReads.at(-1)?.status, "failed");
  assert.equal(interrupted.requests.length, 2);
  assert.match(interrupted.spoken.at(-1) ?? "", /contact the clinic directly/);
  await interrupted.end();

  const invalid = await fixture({ appointments: twoAppointments });
  await invalid.issue();
  await invalid.turn();
  const rejected = await invalid.turn("Choose third");
  assert.equal(rejected.appointmentReads.at(-1)?.status, "failed");
  assert.equal(invalid.requests.length, 2);
  await invalid.end();

  const replay = await fixture({ appointments: twoAppointments });
  await replay.issue();
  await replay.turn();
  await replay.turn("Choose second");
  const repeated = await replay.turn("Choose first");
  assert.equal(repeated.appointmentReads.at(-1)?.status, "failed");
  assert.equal(replay.requests.length, 4);
  await replay.end();
});

test("E2E-203 a moved, cancelled, foreign-patient or unavailable target is never spoken", async () => {
  for (const changed of [
    [{ ...twoAppointments[0]!, }, { ...twoAppointments[1]!, startsAt: "2026-10-03T10:00:00.000Z",
      endsAt: "2026-10-03T10:30:00.000Z" }],
    [{ ...twoAppointments[0]! }, { ...twoAppointments[1]!, cancelledAt: "2026-09-30T09:00:00.000Z" }],
    [{ ...twoAppointments[0]! }, { ...twoAppointments[1]!, patientId: "24" }],
  ] satisfies readonly (readonly Appointment[])[]) {
    const app = await fixture({ appointments: twoAppointments });
    await app.issue();
    await app.turn();
    app.setAppointments(changed);
    const state = await app.turn("Choose second");
    assert.equal(state.appointmentReads.at(-1)?.status, "failed");
    assert.equal(app.spoken.length, 2);
    assert.equal((app.spoken[1] ?? "").includes("Friday 2 October"), false);
    assert.match(app.spoken[1] ?? "", /contact the clinic directly/);
    assert.equal(app.requests.length, 4);
    await app.end();
  }
  const unavailable = await fixture({ appointments: twoAppointments });
  await unavailable.issue();
  await unavailable.turn();
  unavailable.setProviderFailure(503);
  const state = await unavailable.turn("Choose second");
  assert.equal(state.appointmentReads.at(-1)?.status, "failed");
  assert.match(unavailable.spoken[1] ?? "", /contact the clinic directly/);
  assert.equal(unavailable.requests.length, 3);
  await unavailable.end();
});

test("E2E-203 indistinguishable appointment times never become selectable options", async () => {
  const app = await fixture({ appointments: [twoAppointments[0]!, { ...twoAppointments[1]!,
    startsAt: twoAppointments[0]!.startsAt }] });
  await app.issue();
  const state = await app.turn();
  assert.equal(state.appointmentReads.at(-1)?.status, "failed");
  assert.deepEqual(app.spoken, ["I can't send a staff request from this call. Please contact the clinic directly."]);
  assert.equal(app.requests.length, 2);
  await app.end();
});

test("E2E-203 disabling verification during either provider read suppresses appointment speech", async () => {
  for (const disableOnRead of [1, 2]) {
    let app!: Awaited<ReturnType<typeof fixture>>;
    app = await fixture({ appointments: twoAppointments,
      onAppointmentRead(number) { if (number === disableOnRead) app.setEnabled(false); } });
    await app.issue();
    if (disableOnRead === 2) await app.turn();
    const state = await app.turn(disableOnRead === 2 ? "Choose second" : undefined);
    assert.equal(state.appointmentReads.at(-1)?.status, "failed");
    assert.match(app.spoken.at(-1) ?? "", /contact the clinic directly/);
    assert.equal(app.requests.length, disableOnRead === 1 ? 2 : 4);
    await app.end();
  }
});

test("E2E-203 a host cannot turn one selection into a multiple-appointment disclosure", async () => {
  let app!: Awaited<ReturnType<typeof fixture>>;
  app = await fixture({ appointments: twoAppointments,
    selectionOverride: async (readScope, verificationRef, _choice, now) => {
      const reread = await app.verified.appointments.list(readScope, verificationRef, now, until, now);
      return reread.ok ? ok({ snapshot: reread.value, from: now, to: until }) : reread;
    } });
  await app.issue();
  await app.turn();
  const state = await app.turn("Choose second");
  assert.equal(state.appointmentReads.at(-1)?.status, "failed");
  assert.match(app.spoken[1] ?? "", /contact the clinic directly/);
  assert.equal((app.spoken[1] ?? "").includes("Friday 2 October"), false);
  await app.end();
});

test("invalid provider configuration never creates a verified read session", () => {
  const inbound = { key: { accountRef: "account", providerCallRef: "call" },
    dialedNumber: "+6125550100", presentedCallerNumber: "+61400111222", receivedAt: initial };
  const receipt = { callId: callIdFor(inbound.key), scope,
    admission: { key: inbound.key, dialedNumber: inbound.dialedNumber, acceptedAt: initial, deadline: at(30) },
    lifecycle: "starting" as const };
  const result: Result<VerifiedAppointmentReadSession, AppointmentReadFailure> = VerifiedAppointmentReadSession.create({
    receipt, inbound, sessionId: "session",
    policyVersion: "v1", maxAttempts: 1,
    lookup: { async candidates() { return err({ kind: "unavailable" as const }); } },
    authority: { async attest() { return err({ kind: "unavailable" as const }); } },
    policy: { async current() { return err({ kind: "unavailable" as const }); } },
    cliniko: { apiKey: "bad", contactEmail: "dev@example.test", businessId: "11" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "invalidConfig");
  const wrongRoute = VerifiedAppointmentReadSession.create({ receipt,
    inbound: { ...inbound, dialedNumber: "+6125550199" }, sessionId: "session", policyVersion: "v1", maxAttempts: 1,
    lookup: { async candidates() { return err({ kind: "unavailable" as const }); } },
    authority: { async attest() { return err({ kind: "unavailable" as const }); } },
    policy: { async current() { return err({ kind: "unavailable" as const }); } },
    cliniko: { apiKey: "synthetic-key-au5", contactEmail: "dev@example.test", businessId: "11" },
  });
  assert.equal(wrongRoute.ok, false);
  assert.equal(wrongRoute.error.kind, "invalidConfig");
});
