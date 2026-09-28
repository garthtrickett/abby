import assert from "node:assert/strict";
import test, { after } from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { CallState, CapabilityMode, FinalCallerTurn, LocationScope, Result } from "../../src/core/model.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import type { GatewayReply } from "../../src/reference/command-gateway.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { createEmbeddedTextComposition } from "../../src/reference/embedded-composition.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { createStandaloneTextComposition } from "../../src/standalone/text-composition.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import type { AvailabilityHost, PolicyStore } from "../../src/core/host.ts";
import type { TextReception } from "../../src/reference/text-reception.ts";

const now = "2026-09-28T10:00:00.000Z";
const expiresAt = "2026-09-29T10:00:00.000Z";
const kinds = process.env.ABBY_LEDGER === "postgres" ? ["embedded", "standalone"] as const : ["embedded"] as const;
const databaseUrl = process.env.DATABASE_URL;
const db = databaseUrl ? connectPostgres(databaseUrl) : undefined;
after(async () => { await db?.destroy(); });

function value<T>(result: Result<T, { kind: string }>): T {
  assert.equal(result.ok, true, result.ok ? "" : result.error.kind);
  return result.value;
}

function error<T>(result: Result<T, { kind: string }>, kind: string): void {
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, kind);
}

function turn(callId: string, turnId: string, text: string): FinalCallerTurn {
  return { callId, turnId, text, quality: "clear", at: now };
}

function proposal(reply: GatewayReply): CallState {
  assert.equal(reply.kind, "bookingProposal");
  return reply.state;
}

function settings(reply: GatewayReply) {
  assert.equal(reply.kind, "settings");
  return reply.policy;
}

function fixture(kind: "embedded" | "standalone", id: string, duplicateProof = false, hostBookingMode: Extract<CapabilityMode, "execute" | "requestOnly"> = "execute", availability?: AvailabilityHost) {
  const scope: LocationScope = { tenantId: `tenant-${id}`, clinicId: `clinic-${id}`, locationId: `location-${id}` };
  const patient = { scope, patientRef: `patient-${id}`, verificationRef: `proof-${id}`, expiresAt };
  const offer = (suffix: string) => ({ scope, offerRef: `offer-${id}-${suffix}`, serviceRef: "physio", startsAt: "2026-09-29T11:00:00.000Z", expiresAt });
  const host = new ReferenceClinicHost(duplicateProof ? [patient, { ...patient, patientRef: `other-patient-${id}` }] : [patient], [offer("one"), offer("two"), offer("three")],
    [{ scope, sourceRef: "hours", version: "hours-v1", ownerRef: `owner-${id}`, approvedText: "We open at 9 am.", approved: true,
      effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: expiresAt }]);
  let reception: TextReception;
  let policy: PolicyStore;
  if (kind === "standalone") {
    assert.ok(db);
    ({ reception, policy } = createStandaloneTextComposition(db, host, hostBookingMode, undefined, availability));
  } else {
    policy = new MemoryPolicyStore(hostBookingMode);
    reception = createEmbeddedTextComposition(new MemoryLedger(), policy, host, availability);
  }
  const admin = new CommandGateway({ actorRef: `admin-${id}`, role: "clinicAdmin", scope }, policy, reception);
  const agent = new CommandGateway({ actorRef: `agent-${id}`, role: "agent", scope }, policy, reception);
  return { scope, patient, offer, host, reception, policy, admin, agent };
}

for (const kind of kinds) {
  test(`${kind}: agent proposal requires caller delivery, affirmation, and keyed host commit`, async () => {
    const app = fixture(kind, `${kind}-booking`);
    assert.deepEqual(app.agent.listPermitted().map(item => item.id), ["settings.read.v1", "booking.propose.v1", "knowledge.answer.v1"]);
    assert.equal(app.admin.listPermitted().some(item => item.id === "settings.appointments.booking.enabled.change.v1"), true);
    error(await app.agent.submit({ kind: "settings.appointments.booking.enabled.change.v1", expectedVersion: "0", enabled: true }), "forbidden");
    const enabled = settings(value(await app.admin.submit({ kind: "settings.appointments.booking.enabled.change.v1", expectedVersion: "0", enabled: true })));
    assert.equal(enabled.capabilities.book, "execute");
    const callId = `call-${kind}-booking`;
    value(await app.reception.startCall(callId, app.scope));
    const planned = proposal(value(await app.agent.submit({ kind: "booking.propose.v1", turn: turn(callId, "turn-1", "Book physio"), verificationRef: app.patient.verificationRef, offerRef: app.offer("one").offerRef, now })));
    const action = Object.values(planned.actions)[0];
    assert.ok(action);
    assert.equal(action.status, "awaitingConfirmation");
    assert.equal(app.host.bookings(app.scope).length, 0);
    value(await app.reception.drain(app.scope, callId, now));
    assert.equal(app.host.bookings(app.scope).length, 0);
    value(await app.reception.acknowledgeTextPresentation(app.scope, callId, action.presentationId));
    const ready = value(await app.reception.affirm(app.scope, turn(callId, "turn-2", "Yes, book it"), action.key, action.digest, now));
    assert.equal(ready.actions[action.key]?.status, "ready");
    assert.equal(app.host.bookings(app.scope).length, 0);
    const committed = value(await app.reception.drain(app.scope, callId, now));
    assert.equal(committed.actions[action.key]?.status, "committed");
    assert.equal(committed.callerMessages.at(-1), "Your booking is confirmed.");
    assert.equal(app.host.bookings(app.scope).length, 1);
    assert.equal(app.host.bookings(app.scope)[0]?.actionKey, action.key);
    assert.equal(committed.actions[action.key]?.hostRef, app.host.bookings(app.scope)[0]?.hostRef);
    const repeated = await app.host.write(action.mutation, now);
    assert.equal(repeated.kind, "committed");
    assert.deepEqual(await app.host.reconcile(action.mutation), { kind: "exactCommit", actionKey: action.key, hostRef: app.host.bookings(app.scope)[0]?.hostRef });
    assert.equal(app.host.bookings(app.scope).length, 1);
    const forged = await app.host.write({ ...action.mutation, scope: { tenantId: "other", clinicId: "other", locationId: "other" } }, now);
    assert.equal(forged.kind, "rejected");
    const mismatched = { ...action.mutation, payloadDigest: "different" };
    assert.equal((await app.host.write(mismatched, now)).kind, "rejected");
    assert.equal((await app.host.reconcile(mismatched)).kind, "stillUnknown");
    assert.equal(app.host.bookings(app.scope).length, 1);
  });

  test(`${kind}: default, enable, disable and next-call setting behavior stays scoped`, async () => {
    const app = fixture(kind, `${kind}-setting`);
    const defaultPolicy = settings(value(await app.agent.submit({ kind: "settings.read.v1" })));
    assert.equal(defaultPolicy.policyVersion, "0");
    assert.equal(defaultPolicy.capabilities.book, "unavailable");
    const first = `call-${kind}-setting-default`;
    const second = `call-${kind}-setting-enabled`;
    const third = `call-${kind}-setting-disabled`;
    value(await app.reception.startCall(first, app.scope));
    const enabled = settings(value(await app.admin.submit({ kind: "settings.appointments.booking.enabled.change.v1", expectedVersion: "0", enabled: true })));
    assert.equal(enabled.policyVersion, "1");
    value(await app.reception.startCall(second, app.scope));
    const disabled = settings(value(await app.admin.submit({ kind: "settings.appointments.booking.enabled.change.v1", expectedVersion: "1", enabled: false })));
    assert.equal(disabled.policyVersion, "2");
    value(await app.reception.startCall(third, app.scope));
    error(await app.admin.submit({ kind: "settings.appointments.booking.enabled.change.v1", expectedVersion: "1", enabled: true }), "versionConflict");
    assert.equal((value(await app.reception.read(app.scope, first))).policy.capabilities.book, "unavailable");
    assert.equal((value(await app.reception.read(app.scope, second))).policy.capabilities.book, "execute");
    assert.equal((value(await app.reception.read(app.scope, third))).policy.capabilities.book, "unavailable");

    const requested = proposal(value(await app.agent.submit({ kind: "booking.propose.v1", turn: turn(first, "request-first", "Book first"), verificationRef: app.patient.verificationRef, offerRef: app.offer("one").offerRef, now })));
    assert.equal(Object.keys(requested.actions).length, 0);
    assert.equal(requested.callerMessages.at(-1), "I can't complete that request here.");
    assert.equal(Object.values(requested.staffItems).length, 0);
    assert.equal(app.host.bookingEvidenceReads(), 0);
    assert.equal(app.host.bookings(app.scope).length, 0);

    const executable = proposal(value(await app.agent.submit({ kind: "booking.propose.v1", turn: turn(second, "request-second", "Book second"), verificationRef: app.patient.verificationRef, offerRef: app.offer("two").offerRef, now })));
    const action = Object.values(executable.actions)[0];
    assert.ok(action);
    value(await app.reception.acknowledgeTextPresentation(app.scope, second, action.presentationId));
    value(await app.reception.affirm(app.scope, turn(second, "affirm-second", "Yes"), action.key, action.digest, now));
    value(await app.reception.drain(app.scope, second, now));
    assert.equal(app.host.bookings(app.scope).length, 1);
    assert.equal(app.host.bookingEvidenceReads() > 0, true);
    const readsAfterEnabled = app.host.bookingEvidenceReads();

    const restricted = proposal(value(await app.agent.submit({ kind: "booking.propose.v1", turn: turn(third, "request-third", "Book third"), verificationRef: app.patient.verificationRef, offerRef: app.offer("three").offerRef, now })));
    assert.equal(Object.keys(restricted.actions).length, 0);
    assert.equal(restricted.callerMessages.at(-1), "I can't complete that request here.");
    assert.equal(app.host.bookingEvidenceReads(), readsAfterEnabled);
    assert.equal(app.host.bookings(app.scope).length, 1);
    assert.equal(app.host.tasks(app.scope).length, 0);

    const reloaded = kind === "standalone" ? new PostgresPolicyStore(db!, referenceDefaultPolicy) : app.policy;
    assert.equal(value(await reloaded.read(app.scope)).policyVersion, "2");
    const otherScope = { tenantId: `${app.scope.tenantId}-other`, clinicId: app.scope.clinicId, locationId: app.scope.locationId };
    assert.equal(value(await reloaded.read(otherScope)).capabilities.book, "unavailable");
    error(await app.reception.read(otherScope, first), "callUnknown");
  });

  test(`${kind}: enabled setting with request-only host support opens staff work`, async () => {
    const app = fixture(kind, `${kind}-request-only`, false, "requestOnly");
    const enabled = settings(value(await app.admin.submit({ kind: "settings.appointments.booking.enabled.change.v1", expectedVersion: "0", enabled: true })));
    assert.equal(enabled.bookingEnabled, true);
    assert.equal(enabled.capabilities.book, "requestOnly");
    const callId = `call-${kind}-request-only`;
    value(await app.reception.startCall(callId, app.scope));
    const requested = proposal(value(await app.agent.submit({ kind: "booking.propose.v1", turn: turn(callId, "request", "Book physio"), verificationRef: app.patient.verificationRef, offerRef: app.offer("one").offerRef, now })));
    assert.equal(Object.keys(requested.actions).length, 0);
    assert.match(requested.callerMessages.at(-1) ?? "", /request staff follow-up/);
    const followedUp = value(await app.reception.drain(app.scope, callId, now));
    assert.equal(Object.values(followedUp.staffItems)[0]?.status, "open");
    assert.equal(app.host.tasks(app.scope).length, 1);
    assert.equal(app.host.bookings(app.scope).length, 0);
  });

  test(`${kind}: ambiguous host evidence routes to staff without a write`, async () => {
    const app = fixture(kind, `${kind}-ambiguous`, true);
    settings(value(await app.admin.submit({ kind: "settings.appointments.booking.enabled.change.v1", expectedVersion: "0", enabled: true })));
    const callId = `call-${kind}-ambiguous`;
    value(await app.reception.startCall(callId, app.scope));
    const result = proposal(value(await app.agent.submit({ kind: "booking.propose.v1", turn: turn(callId, "ambiguous", "Book me"), verificationRef: app.patient.verificationRef, offerRef: app.offer("one").offerRef, now })));
    assert.equal(Object.keys(result.actions).length, 0);
    assert.match(result.callerMessages.at(-1) ?? "", /can't identify the right appointment safely/);
    const fallback = value(await app.reception.drain(app.scope, callId, now));
    assert.equal(Object.values(fallback.staffItems)[0]?.status, "open");
    assert.equal(app.host.tasks(app.scope).length, 1);
    assert.equal(app.host.bookings(app.scope).length, 0);
    const foreignCall = `call-${kind}-foreign`;
    const foreignScope = { tenantId: "foreign", clinicId: "foreign", locationId: "foreign" };
    value(await app.reception.startCall(foreignCall, foreignScope));
    error(await app.agent.submit({ kind: "booking.propose.v1", turn: turn(foreignCall, "intruder", "Book"), verificationRef: app.patient.verificationRef, offerRef: app.offer("one").offerRef, now }), "callUnknown");
  });

  test(`${kind}: agent knowledge command uses host approval and records its source`, async () => {
    const app = fixture(kind, `${kind}-knowledge-command`);
    const callId = `call-${kind}-knowledge-command`;
    value(await app.reception.startCall(callId, app.scope));
    const response = value(await app.agent.submit({ kind: "knowledge.answer.v1", turn: turn(callId, "hours", "Hours?"),
      sourceRefs: ["hours"], proposedText: "We open at 9 am.", now }));
    assert.equal(response.kind, "knowledgeAnswer");
    assert.equal(response.state.callerMessages.at(-1), "We open at 9 am.");
    assert.deepEqual(response.state.knowledgeAnswers, [{ turnId: "hours", sourceRef: "hours", version: "hours-v1", ownerRef: `owner-${kind}-knowledge-command` }]);
    assert.equal(response.state.presentations[response.state.pendingPresentationId!]?.kind, "notice");

    const forged = value(await app.agent.submit({ kind: "knowledge.answer.v1", turn: turn(callId, "forged", "Hours?"),
      sourceRefs: ["hours"], proposedText: "We close at 5 pm.", now }));
    assert.equal(forged.kind, "knowledgeAnswer");
    assert.equal(forged.state.callerMessages.at(-1), "I can't verify that information right now.");
    assert.equal(forged.state.knowledgeAnswers.length, 1);
    assert.equal(app.host.bookings(app.scope).length, 0);

    const other = new CommandGateway({ actorRef: "other-agent", role: "agent",
      scope: { ...app.scope, tenantId: "another-tenant" } }, app.policy, app.reception);
    error(await other.submit({ kind: "knowledge.answer.v1", turn: turn(callId, "foreign", "Hours?"),
      sourceRefs: ["hours"], proposedText: "We open at 9 am.", now }), "callUnknown");
  });

  test(`${kind}: agent availability command uses the configured scoped read and never creates booking evidence`, async () => {
    const reads: LocationScope[] = [];
    const availability: AvailabilityHost = { list: async (scope, from, to) => {
      reads.push(scope);
      assert.deepEqual([from, to], ["2026-10-01", "2026-10-02"]);
      return { ok: true, value: { kind: "times", scope, sourceRef: "reference-availability", timeZone: "Australia/Sydney",
        observedAt: now, startsAt: ["2026-09-30T23:00:00.000Z"], reservable: false } };
    } };
    const app = fixture(kind, `${kind}-availability-command`, false, "requestOnly", availability);
    assert.equal(app.agent.listPermitted().some(item => item.id === "availability.read.v1"), true);
    const callId = `call-${kind}-availability-command`;
    value(await app.reception.startCall(callId, app.scope));
    const reply = value(await app.agent.submit({ kind: "availability.read.v1", turn: turn(callId, "check-times", "Check times"),
      from: "2026-10-01", to: "2026-10-02", now }));
    assert.equal(reply.kind, "availabilityAnswer");
    assert.equal(reply.state.availabilityReads[0]?.status, "shown");
    assert.match(reply.state.callerMessages.at(-1)!, /can't reserve or confirm/);
    assert.equal(Object.keys(reply.state.actions).length, 0);
    assert.equal(app.host.bookings(app.scope).length, 0);
    assert.deepEqual(reads, [app.scope]);

    const other = new CommandGateway({ actorRef: "foreign-agent", role: "agent",
      scope: { ...app.scope, tenantId: "another-tenant" } }, app.policy, app.reception);
    error(await other.submit({ kind: "availability.read.v1", turn: turn(callId, "foreign-check", "Check times"),
      from: "2026-10-01", to: "2026-10-02", now }), "callUnknown");
    assert.equal(reads.length, 1);
  });
}
