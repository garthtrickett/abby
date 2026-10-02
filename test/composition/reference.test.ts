import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import type { EffectCallLeaseStore } from "../../src/core/effect-call-lease.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { err, ok } from "../../src/core/model.ts";
import type { AutomationReadiness } from "../../src/core/readiness.ts";
import type { CallState, CapabilityMode, FinalCallerTurn, LocationScope, Result } from "../../src/core/model.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import type { GatewayCommand, GatewayReply, HostActor } from "../../src/reference/command-gateway.ts";
import { matchesSchema } from "../../src/reference/schema-shapes.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { createEmbeddedTextComposition } from "../../src/reference/embedded-composition.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { createReferenceStandaloneTextComposition } from "../support/reference-standalone-composition.ts";
import { createStandaloneTextComposition } from "../../src/standalone/text-composition.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { CallAdmissionService } from "../../src/voice/admission.ts";
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

async function proposal(scope: LocationScope, reception: TextReception, reply: GatewayReply): Promise<CallState> {
  assert.equal(reply.kind, "bookingProposal");
  const state = value(await reception.read(scope, reply.progress.callId));
  assert.equal(reply.progress.callVersion, state.version);
  assert.equal(JSON.stringify(reply).includes("verificationRef"), false);
  assert.equal(JSON.stringify(reply).includes("approvedText"), false);
  return state;
}

function settings(reply: GatewayReply) {
  assert.equal(reply.kind, "settings");
  return reply.policy;
}

function bookingAudit(reply: GatewayReply) {
  assert.equal(reply.kind, "bookingSettingAudit");
  return reply.page;
}

function fixture(kind: "embedded" | "standalone", id: string, duplicateProof = false, hostBookingMode: Extract<CapabilityMode, "execute" | "requestOnly"> = "execute", availability?: AvailabilityHost, readiness?: AutomationReadiness, suppliedLedger?: LedgerStore & EffectCallLeaseStore) {
  const scope: LocationScope = { tenantId: `tenant-${id}`, clinicId: `clinic-${id}`, locationId: `location-${id}` };
  const patient = { scope, patientRef: `patient-${id}`, verificationRef: `proof-${id}`, expiresAt };
  const offer = (suffix: string) => ({ scope, offerRef: `offer-${id}-${suffix}`, serviceRef: "physio", startsAt: "2026-09-29T11:00:00.000Z", expiresAt });
  const host = new ReferenceClinicHost(duplicateProof ? [patient, { ...patient, patientRef: `other-patient-${id}` }] : [patient], [offer("one"), offer("two"), offer("three")],
    [{ scope, sourceRef: "hours", version: "hours-v1", ownerRef: `owner-${id}`, approvedText: "We open at 9 am.", approved: true,
      effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: expiresAt }]);
  let reception: TextReception;
  let policy: PolicyStore;
  const ledger = suppliedLedger ?? (kind === "standalone" ? new PostgresLedger(db!, undefined, readiness, "unsafeReference") : new MemoryLedger(readiness));
  if (kind === "standalone") {
    assert.ok(db);
    ({ reception, policy } = createReferenceStandaloneTextComposition(db, host, hostBookingMode, ledger, availability, undefined, readiness, undefined, host));
  } else {
    policy = new MemoryPolicyStore(hostBookingMode, undefined, readiness);
    reception = createEmbeddedTextComposition(ledger, policy, host, availability);
  }
  const admin = new CommandGateway({ actorRef: `admin-${id}`, role: "clinicAdmin", scope }, policy, reception,
    undefined, undefined, undefined, ledger);
  const agent = new CommandGateway({ actorRef: `agent-${id}`, role: "agent", scope }, policy, reception,
    undefined, undefined, undefined, ledger);
  return { scope, patient, offer, host, ledger, reception, policy, admin, agent };
}

for (const kind of kinds) {
  test(`${kind}: agent catalogue describes the accepted command and redacted result`, async () => {
    const app = fixture(kind, `${kind}-catalogue`);
    const booking = app.agent.listPermitted().find(item => item.id === "booking.propose.v2");
    assert.ok(booking);
    assert.equal(booking.scope, "boundActorLocation");
    assert.deepEqual([booking.inputVersion, booking.outputVersion], [2, 2]);
    assert.equal(booking.approval, "callerConfirmation");
    assert.equal(booking.requiresCallerConfirmation, true);
    assert.equal(booking.inputSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(booking.resultSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(app.agent.listPermitted().some(item => item.id === "settings.appointments.booking.enabled.change.v1"), false);
    assert.equal(app.admin.listPermitted().find(item => item.id === "settings.appointments.booking.enabled.change.v1")?.authority, "clinicAdmin");
    assert.throws(() => new CommandGateway({ actorRef: "forged-role", role: "operator", scope: app.scope } as unknown as HostActor,
      app.policy, app.reception), /host actor identity/);
    const command: GatewayCommand = { kind: "booking.propose.v2", turn: turn(`call-${kind}-catalogue`, "proposal", "Private caller text"),
      verificationRef: app.patient.verificationRef, offerRef: app.offer("one").offerRef, now };
    assert.equal(matchesSchema(booking.inputSchema, command), true);
    const invalid = { ...command, unexpected: "untrusted" } as GatewayCommand;
    assert.equal(matchesSchema(booking.inputSchema, invalid), false);
    error(await app.agent.submit(invalid), "invalid");
    const inherited = Object.create({ kind: "settings.read.v1" }) as GatewayCommand;
    error(await app.agent.submit(inherited), "invalid");
    const throwing = Object.defineProperty({}, "kind", { get() { throw new Error("untrusted getter"); } }) as GatewayCommand;
    error(await app.agent.submit(throwing), "invalid");
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    error(await app.agent.submit({ kind: "knowledge.answer.v2", turn: command.turn,
      sourceRefs: cyclic, proposedText: "An answer", now } as GatewayCommand), "invalid");
    error(await app.agent.submit({ ...command, kind: "booking.propose.v1" } as unknown as GatewayCommand), "forbidden");
    assert.equal(app.host.bookingEvidenceReads(), 0);
    settings(value(await app.admin.submit({ kind: "settings.appointments.booking.enabled.change.v1", expectedVersion: "0", enabled: true })));
    value(await app.reception.startCall(command.turn.callId, app.scope));
    const response = value(await app.agent.submit(command));
    assert.equal(response.kind, "bookingProposal");
    assert.equal(matchesSchema(booking.resultSchema, { ok: true, value: response }), true);
    assert.equal(response.progress.traceKey, "proposal");
    assert.equal(response.progress.actions[0]?.status, "awaitingConfirmation");
    assert.equal(JSON.stringify(response).includes(app.patient.patientRef), false);
    assert.equal(JSON.stringify(response).includes(app.patient.verificationRef), false);
    assert.equal(JSON.stringify(response).includes("Private caller text"), false);
    assert.equal(app.host.bookings(app.scope).length, 0);
    const mutable = booking.inputSchema as { properties?: Record<string, unknown> };
    mutable.properties!.kind = { const: "tampered" };
    assert.equal(matchesSchema(app.agent.listPermitted().find(item => item.id === "booking.propose.v2")!.inputSchema, command), true);
    const staffedPolicy: PolicyStore = {
      read: async () => ({ ok: true, value: { ...referenceDefaultPolicy(app.scope),
        capabilities: { ...referenceDefaultPolicy(app.scope).capabilities, transfer: "execute" },
        transferDestinationRef: "staff-destination",
        staffedCoverage: { startsAt: now, endsAt: expiresAt },
        staffedIntervals: [{ startsAt: now, endsAt: expiresAt }] } }),
      changeBookingEnabled: (...args) => app.policy.changeBookingEnabled(...args),
      listBookingChanges: (...args) => app.policy.listBookingChanges(...args),
      changeCancellationEnabled: (...args) => app.policy.changeCancellationEnabled(...args),
      changeReschedulingEnabled: (...args) => app.policy.changeReschedulingEnabled(...args),
      listCancellationChanges: (...args) => app.policy.listCancellationChanges(...args),
      listReschedulingChanges: (...args) => app.policy.listReschedulingChanges(...args),
      changeAfterHours: (...args) => app.policy.changeAfterHours(...args),
      listAfterHoursChanges: (...args) => app.policy.listAfterHoursChanges(...args),
      changeUrgentResponse: (...args) => app.policy.changeUrgentResponse(...args),
      listUrgentResponseChanges: (...args) => app.policy.listUrgentResponseChanges(...args),
      changeStaffSchedule: (...args) => app.policy.changeStaffSchedule(...args),
      listStaffScheduleChanges: (...args) => app.policy.listStaffScheduleChanges(...args),
      changeGreeting: (...args) => app.policy.changeGreeting(...args),
      listGreetingChanges: (...args) => app.policy.listGreetingChanges(...args),
      changeAutomationEnabled: (...args) => app.policy.changeAutomationEnabled(...args),
      listAutomationChanges: (...args) => app.policy.listAutomationChanges(...args),
    };
    const staffedGateway = new CommandGateway({ actorRef: "staffed-contract", role: "agent", scope: app.scope }, staffedPolicy, app.reception);
    const staffedReply = value(await staffedGateway.submit({ kind: "settings.read.v1" }));
    const settingsDescriptor = staffedGateway.listPermitted().find(item => item.id === "settings.read.v1");
    assert.ok(settingsDescriptor);
    assert.equal(matchesSchema(settingsDescriptor.resultSchema, { ok: true, value: staffedReply }), true);
    const brokenPolicy: PolicyStore = {
      read: async () => ({ ok: true, value: { ...referenceDefaultPolicy(app.scope), capabilities: { book: "execute" } } as unknown as CallState["policy"] }),
      changeBookingEnabled: (...args) => app.policy.changeBookingEnabled(...args),
      listBookingChanges: (...args) => app.policy.listBookingChanges(...args),
      changeCancellationEnabled: (...args) => app.policy.changeCancellationEnabled(...args),
      changeReschedulingEnabled: (...args) => app.policy.changeReschedulingEnabled(...args),
      listCancellationChanges: (...args) => app.policy.listCancellationChanges(...args),
      listReschedulingChanges: (...args) => app.policy.listReschedulingChanges(...args),
      changeAfterHours: (...args) => app.policy.changeAfterHours(...args),
      listAfterHoursChanges: (...args) => app.policy.listAfterHoursChanges(...args),
      changeUrgentResponse: (...args) => app.policy.changeUrgentResponse(...args),
      listUrgentResponseChanges: (...args) => app.policy.listUrgentResponseChanges(...args),
      changeStaffSchedule: (...args) => app.policy.changeStaffSchedule(...args),
      listStaffScheduleChanges: (...args) => app.policy.listStaffScheduleChanges(...args),
      changeGreeting: (...args) => app.policy.changeGreeting(...args),
      listGreetingChanges: (...args) => app.policy.listGreetingChanges(...args),
      changeAutomationEnabled: (...args) => app.policy.changeAutomationEnabled(...args),
      listAutomationChanges: (...args) => app.policy.listAutomationChanges(...args),
    };
    const brokenGateway = new CommandGateway({ actorRef: "contract-check", role: "agent", scope: app.scope }, brokenPolicy, app.reception);
    error(await brokenGateway.submit({ kind: "settings.read.v1" }), "responseContractViolation");
    const lostResponsePolicy: PolicyStore = {
      read: (...args) => app.policy.read(...args),
      changeAutomationEnabled: (...args) => app.policy.changeAutomationEnabled(...args),
      listAutomationChanges: (...args) => app.policy.listAutomationChanges(...args),
      changeBookingEnabled: async (...args) => {
        const committed = await app.policy.changeBookingEnabled(...args);
        if (!committed.ok) return committed;
        throw new Error("acknowledgment lost after commit");
      },
      listBookingChanges: (...args) => app.policy.listBookingChanges(...args),
      changeCancellationEnabled: (...args) => app.policy.changeCancellationEnabled(...args),
      changeReschedulingEnabled: (...args) => app.policy.changeReschedulingEnabled(...args),
      listCancellationChanges: (...args) => app.policy.listCancellationChanges(...args),
      listReschedulingChanges: (...args) => app.policy.listReschedulingChanges(...args),
      changeAfterHours: (...args) => app.policy.changeAfterHours(...args),
      listAfterHoursChanges: (...args) => app.policy.listAfterHoursChanges(...args),
      changeUrgentResponse: (...args) => app.policy.changeUrgentResponse(...args),
      listUrgentResponseChanges: (...args) => app.policy.listUrgentResponseChanges(...args),
      changeStaffSchedule: (...args) => app.policy.changeStaffSchedule(...args),
      listStaffScheduleChanges: (...args) => app.policy.listStaffScheduleChanges(...args),
      changeGreeting: (...args) => app.policy.changeGreeting(...args),
      listGreetingChanges: (...args) => app.policy.listGreetingChanges(...args),
    };
    const uncertainAdmin = new CommandGateway({ actorRef: "lost-response-admin", role: "clinicAdmin", scope: app.scope },
      lostResponsePolicy, app.reception);
    error(await uncertainAdmin.submit({ kind: "settings.appointments.booking.enabled.change.v1", expectedVersion: "1", enabled: false }), "commandOutcomeUnknown");
    assert.equal(value(await app.policy.read(app.scope)).policyVersion, "2");
    assert.equal(value(await app.policy.listBookingChanges(app.scope)).entries.at(-1)?.actorRef, "lost-response-admin");
  });

  test(`${kind}: agent proposal requires caller delivery, affirmation, and keyed host commit`, async () => {
    const app = fixture(kind, `${kind}-booking`);
    assert.deepEqual(app.agent.listPermitted().map(item => item.id), ["settings.read.v1", "booking.propose.v2", "knowledge.answer.v2"]);
    assert.equal(app.admin.listPermitted().some(item => item.id === "settings.appointments.booking.enabled.change.v1"), true);
    error(await app.agent.submit({ kind: "settings.appointments.booking.enabled.change.v1", expectedVersion: "0", enabled: true }), "forbidden");
    const enabled = settings(value(await app.admin.submit({ kind: "settings.appointments.booking.enabled.change.v1", expectedVersion: "0", enabled: true })));
    assert.equal(enabled.capabilities.book, "execute");
    const callId = `call-${kind}-booking`;
    value(await app.reception.startCall(callId, app.scope));
    const planned = await proposal(app.scope, app.reception, value(await app.agent.submit({ kind: "booking.propose.v2", turn: turn(callId, "turn-1", "Book physio"), verificationRef: app.patient.verificationRef, offerRef: app.offer("one").offerRef, now })));
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

    const requested = await proposal(app.scope, app.reception, value(await app.agent.submit({ kind: "booking.propose.v2", turn: turn(first, "request-first", "Book first"), verificationRef: app.patient.verificationRef, offerRef: app.offer("one").offerRef, now })));
    assert.equal(Object.keys(requested.actions).length, 0);
    assert.equal(requested.callerMessages.at(-1), "I can't complete that request here.");
    assert.equal(Object.values(requested.staffItems).length, 0);
    assert.equal(app.host.bookingEvidenceReads(), 0);
    assert.equal(app.host.bookings(app.scope).length, 0);

    const executable = await proposal(app.scope, app.reception, value(await app.agent.submit({ kind: "booking.propose.v2", turn: turn(second, "request-second", "Book second"), verificationRef: app.patient.verificationRef, offerRef: app.offer("two").offerRef, now })));
    const action = Object.values(executable.actions)[0];
    assert.ok(action);
    value(await app.reception.acknowledgeTextPresentation(app.scope, second, action.presentationId));
    value(await app.reception.affirm(app.scope, turn(second, "affirm-second", "Yes"), action.key, action.digest, now));
    value(await app.reception.drain(app.scope, second, now));
    assert.equal(app.host.bookings(app.scope).length, 1);
    assert.equal(app.host.bookingEvidenceReads() > 0, true);
    const readsAfterEnabled = app.host.bookingEvidenceReads();

    const restricted = await proposal(app.scope, app.reception, value(await app.agent.submit({ kind: "booking.propose.v2", turn: turn(third, "request-third", "Book third"), verificationRef: app.patient.verificationRef, offerRef: app.offer("three").offerRef, now })));
    assert.equal(Object.keys(restricted.actions).length, 0);
    assert.equal(restricted.callerMessages.at(-1), "I can't complete that request here.");
    assert.equal(app.host.bookingEvidenceReads(), readsAfterEnabled);
    assert.equal(app.host.bookings(app.scope).length, 1);
    assert.equal(app.host.tasks(app.scope).length, 0);

    const reloaded = kind === "standalone" ? new PostgresPolicyStore(db!, referenceDefaultPolicy, undefined, undefined, true, "unsafeReference") : app.policy;
    assert.equal(value(await reloaded.read(app.scope)).policyVersion, "2");
    const otherScope = { tenantId: `${app.scope.tenantId}-other`, clinicId: app.scope.clinicId, locationId: app.scope.locationId };
    assert.equal(value(await reloaded.read(otherScope)).capabilities.book, "unavailable");
    error(await app.reception.read(otherScope, first), "callUnknown");
  });

  test(`${kind}: admin setting changes keep an attributed, scoped audit across reload`, async () => {
    const app = fixture(kind, `${kind}-setting-audit`);
    assert.deepEqual(bookingAudit(value(await app.admin.submit({ kind: "settings.appointments.booking.audit.v1" }))).entries, []);
    error(await app.agent.submit({ kind: "settings.appointments.booking.audit.v1" }), "forbidden");
    settings(value(await app.admin.submit({ kind: "settings.appointments.booking.enabled.change.v1", expectedVersion: "0", enabled: true })));
    settings(value(await app.admin.submit({ kind: "settings.appointments.booking.enabled.change.v1", expectedVersion: "1", enabled: false })));
    error(await app.admin.submit({ kind: "settings.appointments.booking.enabled.change.v1", expectedVersion: "1", enabled: true }), "versionConflict");
    const history = bookingAudit(value(await app.admin.submit({ kind: "settings.appointments.booking.audit.v1" })));
    assert.deepEqual(history.entries.map(entry => [entry.version, entry.previousEnabled, entry.enabled, entry.provenance, entry.actorRef]), [
      ["1", false, true, "recorded", `admin-${kind}-setting-audit`],
      ["2", true, false, "recorded", `admin-${kind}-setting-audit`],
    ]);
    assert.equal(history.entries.every(entry => !!entry.changedAt && Number.isFinite(Date.parse(entry.changedAt))), true);
    assert.deepEqual(bookingAudit(value(await app.admin.submit({ kind: "settings.appointments.booking.audit.v1", afterVersion: 1 }))).entries.map(entry => entry.version), ["2"]);
    error(await app.admin.submit({ kind: "settings.appointments.booking.audit.v1", afterVersion: -1 }), "invalid");
    const reopened: PolicyStore = kind === "standalone" ? new PostgresPolicyStore(db!, referenceDefaultPolicy, undefined, undefined, true, "unsafeReference") : app.policy;
    const persisted = value(await reopened.listBookingChanges(app.scope));
    assert.deepEqual(persisted.entries, history.entries);
    const otherScope = { ...app.scope, tenantId: `${app.scope.tenantId}-other` };
    assert.deepEqual(value(await reopened.listBookingChanges(otherScope)).entries, []);
    assert.equal(JSON.stringify(history).includes(app.patient.patientRef), false);
  });

  test(`${kind}: clinic-wide automation command gates new calls and preserves admitted calls`, async () => {
    let ready = false;
    const readiness: AutomationReadiness = async () => ready ? ok(true) : err({ kind: "readinessFailed", missing: ["mediaTestCall"] });
    const ledger = kind === "standalone" ? new PostgresLedger(db!, suggestedAt => suggestedAt, undefined, "unsafeReference") : new MemoryLedger();
    const app = fixture(kind, `${kind}-automation-setting`, false, "execute", undefined, readiness, ledger);
    const admission = new CallAdmissionService(ledger, async () => {
      const result = await app.policy.read(app.scope);
      return result.ok ? ok(result.value) : err({ kind: "routeUnavailable" as const });
    }, () => now, readiness);
    const key = { accountRef: `account-${kind}-automation`, providerCallRef: "enabled-call" };
    const event = { key, dialedNumber: "+6125550100", receivedAt: now };
    error(await admission.begin(event), "automationDisabled");
    const defaultPolicy = value(await app.policy.read(app.scope));
    assert.equal(defaultPolicy.automationEnabled, false);
    assert.equal(defaultPolicy.automationVersion, "0");
    error(await app.agent.submit({ kind: "settings.automation.enabled.change.v1", expectedVersion: "0", enabled: true }), "forbidden");
    error(await app.admin.submit({ kind: "settings.automation.enabled.change.v1", expectedVersion: "0", enabled: true }), "readinessFailed");
    assert.deepEqual(value(await app.policy.listAutomationChanges(app.scope)).entries, []);
    ready = true;
    const enabled = settings(value(await app.admin.submit({ kind: "settings.automation.enabled.change.v1", expectedVersion: "0", enabled: true })));
    assert.equal(enabled.automationEnabled, true);
    assert.equal(enabled.automationVersion, "1");
    assert.equal(enabled.policyVersion, "0");
    assert.equal(value(await app.policy.read({ ...app.scope, locationId: "another-location" })).automationEnabled, true);
    assert.equal(value(await app.policy.read({ ...app.scope, tenantId: "another-tenant" })).automationEnabled, false);
    const created = value(await admission.begin(event));
    assert.equal(created.kind, "created");
    ready = false;
    error(await admission.begin({ ...event, key: { ...key, providerCallRef: "not-ready-next" } }), "readinessFailed");
    ready = true;
    const runtime = new CallRuntime(ledger, app.scope);
    value(await runtime.activate(created.receipt.callId, "automation-session", "2026-09-28T10:00:01.000Z"));
    const disabled = settings(value(await app.admin.submit({ kind: "settings.automation.enabled.change.v1", expectedVersion: "1", enabled: false })));
    assert.equal(disabled.automationVersion, "2");
    assert.equal(disabled.automationEnabled, false);
    error(await admission.begin({ ...event, key: { ...key, providerCallRef: "new-after-disable" } }), "automationDisabled");
    assert.equal(value(await admission.begin(event)).kind, "duplicate");
    const ongoing = value(await runtime.acceptTurn({ callId: created.receipt.callId, sessionId: "automation-session",
      turnId: "staff-after-disable", text: "Staff please", quality: "clear", at: "2026-09-28T10:00:02.000Z" },
    { kind: "handoff", reason: "callerRequested" }, "2026-09-28T10:00:02.000Z"));
    assert.equal(ongoing.policy.automationEnabled, true);
    assert.equal(Object.values(ongoing.staffItems)[0]?.reason, "callerRequested");
    const history = value(await app.policy.listAutomationChanges(app.scope));
    assert.deepEqual(history.entries.map(entry => [entry.version, entry.previousEnabled, entry.enabled, entry.actorRef]), [
      ["1", false, true, `admin-${kind}-automation-setting`], ["2", true, false, `admin-${kind}-automation-setting`],
    ]);
    error(await app.admin.submit({ kind: "settings.automation.enabled.change.v1", expectedVersion: "1", enabled: true }), "versionConflict");
    error(await app.admin.submit({ kind: "settings.automation.enabled.change.v1", expectedVersion: "2", enabled: "yes" } as unknown as GatewayCommand), "invalid");
    const reloaded: PolicyStore = kind === "standalone" ? new PostgresPolicyStore(db!, referenceDefaultPolicy, undefined, undefined, true, "unsafeReference") : app.policy;
    assert.equal(value(await reloaded.read(app.scope)).automationVersion, "2");
    assert.deepEqual(value(await reloaded.listAutomationChanges(app.scope)).entries, history.entries);
  });

  test(`${kind}: admin emergency stop blocks a confirmed queued booking and preserves staff work`, async () => {
    let ready = false;
    const readiness: AutomationReadiness = async () => ready ? ok(true) : err({ kind: "readinessFailed", missing: ["mediaTestCall"] });
    const app = fixture(kind, `${kind}-write-stop`, false, "execute", undefined, readiness);
    error(await app.agent.submit({ kind: "calls.writes.stop.v1", reason: "Forged agent stop" }), "forbidden");
    const initial = value(await app.admin.submit({ kind: "calls.writes.stop.read.v1" }));
    assert.equal(initial.kind, "writeStop");
    assert.equal(initial.status.stopped, false);
    settings(value(await app.admin.submit({ kind: "settings.appointments.booking.enabled.change.v1", expectedVersion: "0", enabled: true })));
    const callId = `call-${kind}-write-stop`;
    value(await app.reception.startCall(callId, app.scope));
    const proposed = value(await app.reception.proposeBooking(app.scope, turn(callId, "request", "Book physio"),
      app.patient.verificationRef, app.offer("one").offerRef, now));
    const action = Object.values(proposed.actions)[0];
    assert.ok(action);
    value(await app.reception.acknowledgeTextPresentation(app.scope, callId, action.presentationId));
    value(await app.reception.affirm(app.scope, turn(callId, "affirm", "Yes"), action.key, action.digest, now));
    const stopped = value(await app.admin.submit({ kind: "calls.writes.stop.v1", reason: "Clinic incident" }));
    assert.equal(stopped.kind, "writeStop");
    assert.equal(stopped.status.stopped, true);
    assert.equal(stopped.status.reason, "Clinic incident");
    assert.deepEqual(stopped.status.inFlight, []);
    assert.equal(value(await app.ledger.readWriteStop({ ...app.scope, clinicId: "other-clinic" })).stopped, false);
    const result = value(await app.reception.drain(app.scope, callId, now));
    assert.equal(result.actions[action.key]?.status, "unsupported");
    assert.equal(result.effects[`${action.key}:write`]?.status, "canceled");
    assert.equal(Object.values(result.staffItems)[0]?.reason, "emergencyStopped");
    assert.equal(app.host.bookings(app.scope).length, 0);
    const repeated = value(await app.admin.submit({ kind: "calls.writes.stop.v1", reason: "Second operator" }));
    assert.deepEqual(repeated, stopped);
    error(await app.admin.submit({ kind: "calls.writes.resume.v1", expectedVersion: "1", reason: "Provider recovered" }), "readinessFailed");
    assert.equal(value(await app.ledger.readWriteStop(app.scope)).stopped, true);
    ready = true;
    const resumed = value(await app.admin.submit({ kind: "calls.writes.resume.v1", expectedVersion: "1", reason: "Provider recovered" }));
    assert.equal(resumed.kind, "writeStop");
    assert.equal(resumed.status.stopped, false);
    assert.equal(resumed.status.version, "2");
    error(await app.admin.submit({ kind: "calls.writes.resume.v1", expectedVersion: "1", reason: "Stale tab" }), "versionConflict");
    const nextCallId = `call-${kind}-after-resume`;
    value(await app.reception.startCall(nextCallId, app.scope));
    const next = value(await app.reception.proposeBooking(app.scope, turn(nextCallId, "request", "Book physio"),
      app.patient.verificationRef, app.offer("one").offerRef, now));
    const nextAction = Object.values(next.actions)[0];
    assert.ok(nextAction);
    value(await app.reception.acknowledgeTextPresentation(app.scope, nextCallId, nextAction.presentationId));
    value(await app.reception.affirm(app.scope, turn(nextCallId, "affirm", "Yes"), nextAction.key, nextAction.digest, now));
    assert.equal(value(await app.reception.drain(app.scope, nextCallId, now)).actions[nextAction.key]?.status, "committed");
    assert.equal(app.host.bookings(app.scope).length, 1);
    const secondStop = value(await app.admin.submit({ kind: "calls.writes.stop.v1", reason: "Second incident" }));
    assert.equal(secondStop.kind, "writeStop");
    assert.equal(secondStop.status.version, "3");
    const history = value(await app.admin.submit({ kind: "calls.writes.stop.audit.v1" }));
    assert.equal(history.kind, "writeStopAudit");
    assert.deepEqual(history.page.entries.map(entry => [entry.version, entry.stopped]), [["1", true], ["2", false], ["3", true]]);
    if (kind === "standalone") assert.deepEqual(value(await new PostgresLedger(db!, undefined, undefined, "unsafeReference").readWriteStop(app.scope)), secondStop.status);
  });

  test(`${kind}: enabled setting with request-only host support opens staff work`, async () => {
    const app = fixture(kind, `${kind}-request-only`, false, "requestOnly");
    const enabled = settings(value(await app.admin.submit({ kind: "settings.appointments.booking.enabled.change.v1", expectedVersion: "0", enabled: true })));
    assert.equal(enabled.bookingEnabled, true);
    assert.equal(enabled.capabilities.book, "requestOnly");
    const callId = `call-${kind}-request-only`;
    value(await app.reception.startCall(callId, app.scope));
    const requested = await proposal(app.scope, app.reception, value(await app.agent.submit({ kind: "booking.propose.v2", turn: turn(callId, "request", "Book physio"), verificationRef: app.patient.verificationRef, offerRef: app.offer("one").offerRef, now })));
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
    const result = await proposal(app.scope, app.reception, value(await app.agent.submit({ kind: "booking.propose.v2", turn: turn(callId, "ambiguous", "Book me"), verificationRef: app.patient.verificationRef, offerRef: app.offer("one").offerRef, now })));
    assert.equal(Object.keys(result.actions).length, 0);
    assert.match(result.callerMessages.at(-1) ?? "", /can't identify the right appointment safely/);
    const fallback = value(await app.reception.drain(app.scope, callId, now));
    assert.equal(Object.values(fallback.staffItems)[0]?.status, "open");
    assert.equal(app.host.tasks(app.scope).length, 1);
    assert.equal(app.host.bookings(app.scope).length, 0);
    const foreignCall = `call-${kind}-foreign`;
    const foreignScope = { tenantId: "foreign", clinicId: "foreign", locationId: "foreign" };
    value(await app.reception.startCall(foreignCall, foreignScope));
    error(await app.agent.submit({ kind: "booking.propose.v2", turn: turn(foreignCall, "intruder", "Book"), verificationRef: app.patient.verificationRef, offerRef: app.offer("one").offerRef, now }), "callUnknown");
  });

  test(`${kind}: agent knowledge command uses host approval and records its source`, async () => {
    const app = fixture(kind, `${kind}-knowledge-command`);
    const callId = `call-${kind}-knowledge-command`;
    value(await app.reception.startCall(callId, app.scope, now));
    const response = value(await app.agent.submit({ kind: "knowledge.answer.v2", turn: turn(callId, "hours", "Hours?"),
      sourceRefs: ["hours"], proposedText: "We open at 9 am.", now }));
    assert.equal(response.kind, "knowledgeAnswer");
    assert.deepEqual(response.progress.knowledgeSources, [{ sourceRef: "hours", version: "hours-v1", ownerRef: `owner-${kind}-knowledge-command` }]);
    assert.equal(response.progress.pendingPresentation?.kind, "notice");
    assert.equal(JSON.stringify(response).includes("We open at 9 am."), false);
    const answered = value(await app.reception.read(app.scope, callId));
    assert.equal(answered.callerMessages.at(-1), "We open at 9 am.");
    assert.deepEqual(answered.knowledgeAnswers, [{ turnId: "hours", sourceRef: "hours", version: "hours-v1", ownerRef: `owner-${kind}-knowledge-command` }]);

    const forged = value(await app.agent.submit({ kind: "knowledge.answer.v2", turn: turn(callId, "forged", "Hours?"),
      sourceRefs: ["hours"], proposedText: "We close at 5 pm.", now }));
    assert.equal(forged.kind, "knowledgeAnswer");
    assert.deepEqual(forged.progress.knowledgeSources, []);
    const fallback = value(await app.reception.read(app.scope, callId));
    assert.equal(fallback.callerMessages.at(-1), "I can't verify that information right now.");
    assert.equal(fallback.knowledgeAnswers.length, 1);
    assert.equal(app.host.bookings(app.scope).length, 0);

    const other = new CommandGateway({ actorRef: "other-agent", role: "agent",
      scope: { ...app.scope, tenantId: "another-tenant" } }, app.policy, app.reception);
    error(await other.submit({ kind: "knowledge.answer.v2", turn: turn(callId, "foreign", "Hours?"),
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
    assert.equal(app.agent.listPermitted().some(item => item.id === "availability.read.v2"), true);
    const callId = `call-${kind}-availability-command`;
    value(await app.reception.startCall(callId, app.scope));
    const reply = value(await app.agent.submit({ kind: "availability.read.v2", turn: turn(callId, "check-times", "Check times"),
      from: "2026-10-01", to: "2026-10-02", now }));
    assert.equal(reply.kind, "availabilityAnswer");
    assert.equal(reply.progress.availability?.status, "shown");
    assert.equal(reply.progress.availability?.shownCount, 1);
    assert.equal(JSON.stringify(reply).includes("2026-09-30T23:00:00.000Z"), false);
    const state = value(await app.reception.read(app.scope, callId));
    assert.match(state.callerMessages.at(-1)!, /can't reserve or confirm/);
    assert.equal(Object.keys(state.actions).length, 0);
    assert.equal(app.host.bookings(app.scope).length, 0);
    assert.deepEqual(reads, [app.scope]);

    const other = new CommandGateway({ actorRef: "foreign-agent", role: "agent",
      scope: { ...app.scope, tenantId: "another-tenant" } }, app.policy, app.reception);
    error(await other.submit({ kind: "availability.read.v2", turn: turn(callId, "foreign-check", "Check times"),
      from: "2026-10-01", to: "2026-10-02", now }), "callUnknown");
    assert.equal(reads.length, 1);
  });

  test(`${kind}: staff task commands are scoped, host-confirmed, and unavailable to agents`, async () => {
    const app = fixture(kind, `${kind}-staff-command`);
    const callId = `call-${kind}-staff-command`;
    value(await app.reception.startCall(callId, app.scope));
    value(await app.reception.answer(app.scope, turn(callId, "staff-request", "Please help"), ["missing"], "Unapproved", now));
    const opened = value(await app.reception.drain(app.scope, callId, now));
    const item = Object.values(opened.staffItems)[0];
    assert.ok(item);
    assert.equal(item.status, "open");
    assert.equal(app.admin.listPermitted().some(capability => capability.id === "staff.change.v1"), true);
    assert.equal(app.agent.listPermitted().some(capability => capability.id === "staff.change.v1"), false);
    error(await app.agent.submit({ kind: "staff.change.v1", callId, taskKey: item.key, expectedVersion: opened.version,
      change: { kind: "resolve" }, now }), "forbidden");
    const foreign = new CommandGateway({ actorRef: "foreign-staff", role: "staff",
      scope: { ...app.scope, tenantId: "foreign-tenant" } }, app.policy, app.reception);
    error(await foreign.submit({ kind: "staff.change.v1", callId, taskKey: item.key, expectedVersion: opened.version,
      change: { kind: "resolve" }, now }), "callUnknown");
    const reply = value(await app.admin.submit({ kind: "staff.change.v1", callId, taskKey: item.key,
      expectedVersion: opened.version, change: { kind: "resolve" }, now }));
    assert.equal(reply.kind, "staffChange");
    assert.equal(reply.status, "resolved");
    assert.equal(reply.pending, false);
    assert.equal(app.host.tasks(app.scope)[0]?.status, "resolved");
    error(await app.admin.submit({ kind: "staff.change.v1", callId, taskKey: item.key, expectedVersion: opened.version,
      change: { kind: "acknowledge" }, now }), "versionConflict");
  });
}

test("postgres: pre-audit policy versions stay readable without invented attribution", { skip: !db }, async () => {
  const scope = { tenantId: "audit-legacy-tenant", clinicId: "audit-legacy-clinic", locationId: "audit-legacy-location" };
  const policy = { ...referenceDefaultPolicy(scope), policyVersion: "1", bookingEnabled: true };
  const legacyPolicy = Object.fromEntries(Object.entries(policy).filter(([field]) => field !== "automationEnabled"));
  await sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy)
    values (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, 1, ${JSON.stringify(legacyPolicy)}::jsonb)`.execute(db!);
  const store = new PostgresPolicyStore(db!, referenceDefaultPolicy, undefined, undefined, true, "unsafeReference");
  const history = value(await store.listBookingChanges(scope));
  assert.deepEqual(history.entries, [{ version: "1", enabled: true, provenance: "legacyUnattributed" }]);
  const restored = value(await store.read(scope));
  assert.equal(restored.policyVersion, "1");
  assert.equal(restored.automationEnabled, false);
});

test("postgres: corrupt location policy cannot commit an automation change", { skip: !db }, async () => {
  const scope = { tenantId: "corrupt-policy-tenant", clinicId: "corrupt-policy-clinic", locationId: "corrupt-policy-location" };
  const malformed = { scope, policyVersion: "0" };
  await sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy)
    values (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, 0, ${JSON.stringify(malformed)}::jsonb)`.execute(db!);
  const store = new PostgresPolicyStore(db!, referenceDefaultPolicy, "execute", async () => ok(true), true, "unsafeReference");
  error(await store.changeAutomationEnabled(scope, "0", true, "corrupt-policy-admin"), "storageFailure");
  assert.deepEqual(value(await store.listAutomationChanges(scope)).entries, []);
  const count = await sql<{ count: string }>`select count(*)::text as count from clinic_automation
    where tenant_id = ${scope.tenantId} and clinic_id = ${scope.clinicId}`.execute(db!);
  assert.equal(count.rows[0]?.count, "0");
});

test("standalone patient actions stay unavailable without durable host work", { skip: !db }, async () => {
  const scope = { tenantId: "safe-default-tenant", clinicId: "safe-default-clinic", locationId: "safe-default-location" };
  const patient = { scope, patientRef: "safe-default-patient", verificationRef: "safe-default-proof", expiresAt };
  const offer = { scope, offerRef: "safe-default-offer-canary-8792", serviceRef: "physio", startsAt: "2026-09-29T11:00:00.000Z", expiresAt };
  const { reception, policy } = createStandaloneTextComposition(db!);
  const initial = value(await policy.read(scope));
  assert.equal(initial.capabilities.book, "unavailable");
  assert.equal(initial.capabilities.transfer, "unavailable");
  assert.equal(initial.staffWorkEnabled, false);
  const enabled = value(await policy.changeBookingEnabled(scope, "0", true, "clinic-admin"));
  assert.deepEqual({ book: enabled.capabilities.book, cancel: enabled.capabilities.cancel,
    reschedule: enabled.capabilities.reschedule, intake: enabled.capabilities.intake },
  { book: "unavailable", cancel: "unavailable", reschedule: "unavailable", intake: "unavailable" });
  const callId = randomUUID();
  value(await reception.startCall(callId, scope));
  const requested = value(await reception.proposeBooking(scope, turn(callId, randomUUID(), "Book physio"), patient.verificationRef, offer.offerRef, now));
  assert.equal(Object.keys(requested.actions).length, 0);
  assert.match(requested.callerMessages.at(-1) ?? "", /can't complete that request here/);
  const callerReadText = "private-caller-read-canary-6734";
  const availability = value(await reception.checkAvailability(scope, turn(callId, randomUUID(), callerReadText),
    now, "2026-09-29T18:00:00.000Z", now));
  assert.match(availability.callerMessages.at(-1) ?? "", /contact the clinic directly/);
  const appointments = value(await reception.checkAppointments(scope, turn(callId, randomUUID(), "What is booked?"),
    patient.verificationRef, now, "2026-09-29T18:00:00.000Z", now));
  assert.match(appointments.callerMessages.at(-1) ?? "", /contact the clinic directly/);
  const appointmentRef = "private-appointment-canary-3825";
  const draftRef = "private-intake-canary-4163";
  const target = { scope, patientRef: patient.patientRef, appointmentRef,
    startsAt: "2026-09-29T10:00:00.000Z", endsAt: "2026-09-29T10:30:00.000Z", timeZone: "Australia/Sydney" };
  const terms = { version: "terms-1", approvedText: "No change fee applies.", expiresAt };
  const runtime = new CallRuntime(new PostgresLedger(db!, undefined, undefined, "standaloneText"), scope);
  const cancel = value(await runtime.acceptTurn(turn(callId, randomUUID(), "Cancel my appointment"), {
    kind: "requestAction", request: { kind: "cancel", patient, target, terms },
  }, now));
  assert.deepEqual(Object.keys(cancel.staffItems), []);
  const reschedule = value(await runtime.acceptTurn(turn(callId, randomUUID(), "Move my appointment"), {
    kind: "requestAction", request: { kind: "reschedule", patient, target, offer, terms },
  }, now));
  assert.deepEqual(Object.keys(reschedule.actions), []);
  const intake = value(await runtime.acceptTurn(turn(callId, randomUUID(), "I am a new patient"), {
    kind: "requestAction", request: { kind: "intake", scope, approvedDraftRef: draftRef,
      consentRef: "private-consent-canary-6625", duplicateCheckRef: "private-duplicate-canary-5016" },
  }, now));
  assert.deepEqual(Object.keys(intake.staffItems), []);
  const handoff = value(await runtime.acceptTurn(turn(callId, randomUUID(), "Please ask staff to call me"),
    { kind: "handoff", reason: "callerRequested" }, now));
  assert.deepEqual(Object.keys(handoff.staffItems), []);
  assert.match(handoff.callerMessages.at(-1) ?? "", /contact the clinic directly/);
  const transfer = value(await runtime.acceptTurn(turn(callId, randomUUID(), "Please transfer me"),
    { kind: "transfer", reason: "callerRequested" }, now));
  assert.deepEqual(Object.keys(transfer.staffItems), []);
  assert.equal(transfer.policy.capabilities.transfer, "unavailable");
  const ambiguous = value(await runtime.acceptTurn(turn(callId, randomUUID(), "Which appointment is mine?"),
    { kind: "ambiguousTarget" }, now));
  assert.deepEqual(Object.keys(ambiguous.staffItems), []);
  assert.match(ambiguous.callerMessages.at(-1) ?? "", /contact the clinic directly/);
  const persisted = value(await runtime.read(callId));
  assert.deepEqual(persisted.availabilityReads, []);
  assert.deepEqual(persisted.appointmentReads, []);
  value(await reception.drain(scope, callId, now));
  const unsafeWork = await sql<{ effects: string; staff: string }>`select
    (select count(*)::text from effect_outbox where tenant_id = ${scope.tenantId}) as effects,
    (select count(*)::text from staff_items where tenant_id = ${scope.tenantId}) as staff`.execute(db!);
  assert.deepEqual(unsafeWork.rows, [{ effects: "0", staff: "0" }]);
  const scan = await scanPatientDataCanaries(db!, [
    { label: "default_offer", value: offer.offerRef },
    { label: "appointment", value: appointmentRef },
    { label: "intake", value: draftRef },
    { label: "caller_read", value: callerReadText },
  ]);
  assert.deepEqual(scan, { ok: true, value: [] });
});
