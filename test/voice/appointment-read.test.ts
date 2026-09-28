import assert from "node:assert/strict";
import test, { after } from "node:test";
import { ClinikoAppointmentReader } from "../../src/cliniko/appointments.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { err, ok } from "../../src/core/model.ts";
import type { Result } from "../../src/core/model.ts";
import { CallReview } from "../../src/reference/call-review.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { createEmbeddedTextComposition } from "../../src/reference/embedded-composition.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { createStandaloneTextComposition } from "../../src/standalone/text-composition.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { CallAdmissionService } from "../../src/voice/admission.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";

const kinds = process.env.ABBY_LEDGER === "postgres" ? ["memory", "postgres"] as const : ["memory"] as const;
const db = process.env.DATABASE_URL ? connectPostgres(process.env.DATABASE_URL) : undefined;
after(async () => { await db?.destroy(); });
const now = "2026-09-28T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(now) + seconds * 1000).toISOString();
const to = "2026-10-05T10:00:00.000Z";

function value<T>(result: Result<T, { kind: string }>): T {
  assert.equal(result.ok, true, result.ok ? "" : result.error.kind);
  return result.value;
}

async function fixture(kind: "memory" | "postgres", suffix: string, verified = true) {
  const scope = { tenantId: `appointment-tenant-${suffix}`, clinicId: `appointment-clinic-${suffix}`, locationId: `appointment-location-${suffix}` };
  const patient = { scope, patientRef: "22", verificationRef: "host-proof", expiresAt: at(86_400) };
  const host = new ReferenceClinicHost(verified ? [patient] : [], []);
  const requests: URL[] = [];
  const port: typeof fetch = async input => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname === "/v1/businesses/11") return new Response(JSON.stringify({ id: "11", time_zone_identifier: "Australia/Sydney" }));
    assert.equal(url.pathname, "/v1/individual_appointments");
    return new Response(JSON.stringify({ total_entries: 1, individual_appointments: [{
      id: "33", starts_at: "2026-09-30T11:00:00Z", ends_at: "2026-09-30T11:30:00Z",
      patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/22" } },
      business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/11" } },
      notes: "Never say or return this note", patient_name: "Private Patient",
      cancelled_at: null, archived_at: null, deleted_at: null,
    }] }));
  };
  const reader = value(ClinikoAppointmentReader.create({ scope, apiKey: "synthetic-key-au5", contactEmail: "dev@example.test", businessId: "11" }, host, port, () => at(3)));
  const ledger = kind === "postgres" ? new PostgresLedger(db!, suggestedAt => suggestedAt) : new MemoryLedger();
  const composed = kind === "postgres"
    ? createStandaloneTextComposition(db!, host, "execute", ledger, undefined, reader)
    : { policy: new MemoryPolicyStore(), reception: undefined };
  const policy = composed.policy;
  const reception = kind === "postgres" ? composed.reception : createEmbeddedTextComposition(ledger, policy, host, undefined, reader);
  assert.ok(reception);
  const admission = new CallAdmissionService(ledger, async () => {
    const result = await policy.read(scope);
    return result.ok ? ok({ ...result.value, automationEnabled: true }) : err({ kind: "routeUnavailable" as const });
  }, () => now, async () => ok(true));
  const callId = value(await admission.begin({ key: { accountRef: `account-${suffix}`, providerCallRef: `call-${suffix}` },
    dialedNumber: "+6125550100", receivedAt: now })).receipt.callId;
  const sessionId = `session-${suffix}`;
  const queued: string[] = [];
  const playback = { enqueue: async (_id: string, text: string) => { queued.push(text); return "queued" as const; }, clear: async () => true };
  const session = new VoiceSession(callId, sessionId, scope, ledger, reception, playback,
    async () => ok({ kind: "appointments" as const, verificationRef: "host-proof", from: at(3), to }));
  value(await session.attach(at(1)));
  return { scope, host, ledger, policy, reception, reader, requests, queued, session, sessionId, callId };
}

for (const kind of kinds) {
  test(`${kind}: verified Cliniko appointment is spoken only after a final turn and durable presentation`, async () => {
    const app = await fixture(kind, `${kind}-verified`);
    const generation = value(await app.session.speechStarted(at(2)));
    value(app.session.acceptTranscript({ kind: "partial", sessionId: app.sessionId, generation, utteranceId: "request", text: "What is my..." }));
    assert.equal(app.requests.length, 0);
    value(app.session.acceptTranscript({ kind: "segmentFinal", sessionId: app.sessionId, generation, utteranceId: "request",
      text: "What is my appointment?", quality: "clear" }));
    const state = value(await app.session.finishTurn(at(3)));
    assert.equal(app.requests.length, 2);
    assert.equal(state.appointmentReads.at(-1)?.status, "shown");
    assert.equal(app.queued.length, 0);
    assert.match(state.callerMessages.at(-1) ?? "", /Wednesday 30 September/);
    const dispatched = value(await app.session.dispatchPending(at(4)));
    assert.equal(dispatched.kind, "queued");
    assert.deepEqual(app.queued, [state.callerMessages.at(-1)]);
    assert.equal(JSON.stringify(app.queued).includes("Private Patient"), false);
    assert.equal(JSON.stringify(state.appointmentReads).includes("22"), false);
    value(await app.session.acceptPlaybackResult(dispatched.playbackId!, "played", at(5)));
    const review = value(await new CallReview(app.ledger).read(app.callId, app.scope));
    assert.deepEqual(review.appointmentReads, [{ status: "shown", sourceRef: "cliniko:business:11:appointments", shownCount: 1 }]);
    assert.equal(JSON.stringify(review).includes("Private Patient"), false);
  });

  test(`${kind}: failed proof produces staff work and no provider read or appointment disclosure`, async () => {
    const app = await fixture(kind, `${kind}-unverified`, false);
    const generation = value(await app.session.speechStarted(at(2)));
    value(app.session.acceptTranscript({ kind: "segmentFinal", sessionId: app.sessionId, generation, utteranceId: "request",
      text: "What is my appointment?", quality: "clear" }));
    const state = value(await app.session.finishTurn(at(3)));
    assert.equal(app.requests.length, 0);
    assert.deepEqual(state.appointmentReads.at(-1), { turnId: state.processedTurnIds.at(-1), status: "failed", reason: "invalidProof" });
    assert.equal(Object.values(state.staffItems)[0]?.reason, "verificationFailed");
    value(await app.session.dispatchPending(at(4)));
    assert.deepEqual(app.queued, ["I can't verify whose appointment to check. I'll request staff follow-up."]);
  });

  test(`${kind}: agent command returns redacted progress through the same call transition`, async () => {
    const app = await fixture(kind, `${kind}-agent`);
    const gateway = new CommandGateway({ actorRef: "clinic-agent", role: "agent", scope: app.scope }, app.policy, app.reception,
      new CallReview(app.ledger));
    assert.equal(gateway.listPermitted().some(item => item.id === "appointments.read.v1"), true);
    const agentCallId = `agent-call-${kind}`;
    value(await app.reception.startCall(agentCallId, app.scope));
    const reply = value(await gateway.submit({ kind: "appointments.read.v1", turn: { callId: agentCallId, turnId: "agent-read",
      text: "Check appointment", quality: "clear", at: at(3) }, verificationRef: "host-proof", from: at(3), to, now: at(3) }));
    assert.equal(reply.kind, "appointmentAnswer");
    assert.deepEqual(reply.progress.appointments, { status: "shown", sourceRef: "cliniko:business:11:appointments", shownCount: 1 });
    assert.equal(JSON.stringify(reply).includes("patientRef"), false);
    assert.equal(JSON.stringify(reply).includes("appointmentRef"), false);
    assert.equal(JSON.stringify(reply).includes("Private Patient"), false);
    assert.equal(app.requests.length, 2);
  });
}
