import assert from "node:assert/strict";
import test from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
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
} = {}) {
  const suffix = ++sequence;
  const key = { accountRef: `account-${suffix}`, providerCallRef: `call-${suffix}` };
  const callId = callIdFor(key);
  const sessionId = `verified-session-${suffix}`;
  const inbound = { key, presentedCallerNumber: "+61400111222", dialedNumber: "+6125550100", receivedAt: initial };
  let enabled = options.enabled ?? true;
  const requests: URL[] = [];
  const spoken: string[] = [];
  const appointments = options.appointments ?? [{ id: "33", startsAt: "2026-10-01T10:00:00.000Z",
    endsAt: "2026-10-01T10:30:00.000Z" }];
  const provider: typeof fetch = async input => {
    const url = new URL(String(input));
    requests.push(url);
    if (options.providerFailure === "timeout") throw new DOMException("synthetic provider timeout", "TimeoutError");
    if (options.providerFailure) return new Response("", { status: options.providerFailure });
    if (url.pathname === "/v1/businesses/11") return new Response(JSON.stringify({ id: "11",
      time_zone_identifier: "Australia/Sydney", archived_at: null }));
    assert.equal(url.pathname, "/v1/individual_appointments");
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
    clock: () => at(3), cliniko: { apiKey: "synthetic-key-au5", contactEmail: "dev@example.test",
      businessId: "11" }, fetchPort: provider }));
  const host = new DisabledStandaloneHost();
  const reception = new TextReception(ledger, policy, host, undefined, verified.appointments, undefined, host);
  let verificationRef = "unverified-reference";
  const voice = new VoiceSession(actualCallId, sessionId, scope, ledger, reception,
    { async enqueue(_playbackId, text) { spoken.push(text); return "queued"; }, async clear() { return true; } },
    async () => ok({ kind: "appointments", verificationRef, from: at(3), to: until }));
  value(await voice.attach(at(1)));
  async function turn() {
    const generation = value(await voice.speechStarted(at(2)));
    value(voice.acceptTranscript({ kind: "segmentFinal", sessionId, generation, utteranceId: "request",
      text: "What is my appointment?", quality: "clear" }));
    const state = value(await voice.finishTurn(at(3)));
    const delivery = value(await voice.dispatchPending(at(4)));
    assert.equal(delivery.kind, "queued");
    value(await voice.acceptPlaybackResult(delivery.playbackId!, "played", at(5)));
    return state;
  }
  return { verified, ledger, requests, spoken, turn, end: async () => {
    value(await voice.end(at(6), "callerDisconnected"));
    verified.dispose();
  }, issue: async () => {
    verificationRef = value(await verified.issueReadProof(token)).verificationRef;
    return verificationRef;
  }, setEnabled: (next: boolean) => { enabled = next; } };
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
