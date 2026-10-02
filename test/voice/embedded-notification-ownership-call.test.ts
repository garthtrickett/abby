import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import type { EffectCallLeaseStore } from "../../src/core/effect-call-lease.ts";
import { EffectRecovery } from "../../src/core/effect-recovery.ts";
import type { PolicyStore, AppointmentChangeEvidenceQuery } from "../../src/core/host.ts";
import { err, ok } from "../../src/core/model.ts";
import type { ActionRequest, HostMutation, HostWriteReceipt, LocationScope, Result } from "../../src/core/model.ts";
import { notificationKind, unknownNotification } from "../../src/core/notification-effects.ts";
import type { NotificationIntent, NotificationObservation } from "../../src/core/notification-effects.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { createEmbeddedVoiceComposition } from "../../src/reference/embedded-voice-composition.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { callIdFor } from "../../src/voice/admission.ts";
import { notificationRegistry } from "../support/notification-settings-contract.ts";
import type { NotificationRegistry } from "../../src/core/notification-policy.ts";

const now = "2026-10-02T10:00:00.000Z";
const readiness = async () => ok(true as const);
function value<T>(result: Result<T, { kind: string }>): T { assert.ok(result.ok, result.ok ? "" : result.error.kind); return result.value; }
type Stores = { scope: LocationScope; ledger: LedgerStore & EffectCallLeaseStore; policy: PolicyStore; ready: boolean; hostVersion: string };
type Kind = "book" | "cancel" | "reschedule";

function newCall(stores: Stores, kind: Kind, sendUnknown = false, suppression = true) {
  const { scope, ledger, policy } = stores;
  const event = { key: { accountRef: "buyer-provider", providerCallRef: `notifications-${randomUUID()}` },
    dialedNumber: "+6125550199", receivedAt: now };
  const callId = callIdFor(event.key);
  const sessionId = `session-${randomUUID()}`;
  const patient = { scope, patientRef: "synthetic-patient", verificationRef: "synthetic-proof", expiresAt: "2026-10-02T11:00:00.000Z" };
  const offer = { scope, offerRef: "synthetic-offer", serviceRef: "physio", startsAt: "2026-10-03T12:00:00.000Z", expiresAt: patient.expiresAt };
  const target = { scope, appointmentRef: "synthetic-appointment", patientRef: patient.patientRef,
    startsAt: "2026-10-03T11:00:00.000Z", endsAt: "2026-10-03T11:30:00.000Z", timeZone: "Australia/Sydney" };
  const terms = { version: "terms-v1", approvedText: "Clinic-approved appointment change terms.", expiresAt: patient.expiresAt };
  const writes: HostMutation[] = [];
  const sends: NotificationIntent[] = [];
  const observations: NotificationIntent[] = [];
  const spoken: string[] = [];
  const chunks = new Map<string, number[]>();
  let utterance = 0;
  let mediaSequence = 0;
  const host = Object.assign(new ReferenceClinicHost([patient], [offer]), {
    async resolveAppointmentChange(query: AppointmentChangeEvidenceQuery): Promise<Result<Extract<ActionRequest, { kind: "cancel" | "reschedule" }>, { kind: "notFound"; target: "appointment" }>> {
      assert.deepEqual(query.scope, scope);
      assert.equal(query.callId, callId); assert.equal(query.sessionId, sessionId);
      assert.equal(query.verificationRef, patient.verificationRef); assert.equal(query.targetRef, target.appointmentRef);
      return ok(query.kind === "cancel" ? { kind: "cancel", patient, target, terms }
        : { kind: "reschedule", patient, target, terms, offer });
    },
    async write(mutation: HostMutation): Promise<HostWriteReceipt> {
      assert.deepEqual(mutation.scope, scope); assert.equal(mutation.kind, kind);
      assert.equal(writes.length, 0, "voice confirmation may commit the appointment only once");
      writes.push(structuredClone(mutation));
      return { kind: "committed", actionKey: mutation.actionKey, hostRef: "synthetic-commit",
        ...(suppression && mutation.notification ? { notification: structuredClone(mutation.notification) } : {}) };
    },
    async dispatchNotification(intent: NotificationIntent): Promise<NotificationObservation> {
      assert.equal(writes.length, 1, "notification delivery follows the appointment commit");
      assert.equal(sends.length, 0, "a possibly sent notification cannot be replayed");
      const state = value(await ledger.read(callId, scope));
      assert.equal(state.effects[`${intent.notificationKey}:notification`]?.status, "possiblySent");
      assert.deepEqual(intent.scope, scope); assert.equal(intent.callId, callId);
      assert.deepEqual(writes[0]!.notification, { scope: intent.scope, kind: intent.kind, owner: intent.owner,
        settingsVersion: intent.settingsVersion, hostVersion: intent.hostVersion, notificationKey: intent.notificationKey });
      sends.push(structuredClone(intent));
      if (sendUnknown) throw new Error("synthetic provider reply lost after send");
      return { ...unknownNotification(intent), kind: "sent", deliveryRef: "synthetic-delivery" };
    },
    async observeNotification(intent: NotificationIntent): Promise<NotificationObservation> {
      observations.push(structuredClone(intent));
      assert.deepEqual(intent, sends[0]);
      return { ...unknownNotification(intent), kind: "sent", deliveryRef: "synthetic-delivery" };
    },
  });
  const call = createEmbeddedVoiceComposition({ event, sessionId, ledger, policy, host, readiness, now: () => now,
    routing: new ReferenceNumberRoutingHost([{ ...scope, accountRef: event.key.accountRef, dialedNumber: event.dialedNumber, routeVersion: "route-v1" }]),
    resolveIntent: async () => utterance > 1 ? ok({ kind: "affirm" }) : kind === "book"
      ? ok({ kind, verificationRef: patient.verificationRef, offerRef: offer.offerRef }) : kind === "cancel"
        ? ok({ kind, verificationRef: patient.verificationRef, targetRef: target.appointmentRef })
        : ok({ kind, verificationRef: patient.verificationRef, targetRef: target.appointmentRef, offerRef: offer.offerRef }),
    transcription: { async accept() { return ok([]); }, async flush(generation) {
      return ok([{ kind: "segmentFinal", sessionId, generation, utteranceId: `request-${++utterance}`,
        text: utterance === 1 ? "Please change my appointment" : "Yes", quality: "clear" }]);
    } },
    synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } },
    output: { async queueChunk(playbackId, sequence) { chunks.set(playbackId, [...(chunks.get(playbackId) ?? []), sequence]); return "queued" as const; },
      async finishQueue() { return "queued" as const; }, async clear() { return true; } }, mediaOptions: { silenceMs: 100 },
  });
  async function play(delivery: { kind: string; playbackId?: string }) {
    assert.equal(delivery.kind, "queued"); assert.ok(delivery.playbackId);
    const sequences = chunks.get(delivery.playbackId); assert.ok(sequences?.length);
    value(await call.acceptPlaybackCompletion({ playbackId: delivery.playbackId, lastSequence: sequences.at(-1)!, status: "played" }, now));
  }
  async function begin() { const admitted = value(await call.begin(now)); assert.equal(admitted.kind, "admitted"); await play(admitted.delivery); }
  async function speak() {
    let completed: Awaited<ReturnType<typeof call.acceptMedia>> | undefined;
    for (let frame = 0; frame < 7; frame += 1) {
      const bytes = new Uint8Array(640);
      if (frame < 2) { const view = new DataView(bytes.buffer); for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, 1_200, true); }
      completed = await call.acceptMedia({ sessionId, sequence: mediaSequence, capturedAt: new Date(Date.parse(now) + mediaSequence * 20).toISOString(), bytes });
      mediaSequence += 1; value(completed);
    }
    assert.ok(completed?.ok); assert.equal(completed.value.kind, "turnCompleted"); return completed.value;
  }
  async function confirm() {
    const proposal = await speak(); assert.equal(writes.length, 0); assert.equal(sends.length, 0);
    await play(proposal.delivery);
    const confirmation = await speak(); assert.equal(writes.length, 1); await play(confirmation.delivery);
    const state = value(await ledger.read(callId, scope)); assert.equal(Object.values(state.actions)[0]?.status, "committed");
  }
  const recovery = new EffectRecovery(ledger, () => host, scope);
  return { call, begin, speak, play, confirm, writes, sends, observations, spoken, recovery,
    state: async () => value(await ledger.read(callId, scope)) };
}

test("E2E-257 SET-009 complete embedded notification ownership calls", { timeout: 120_000 }, async t => {
  const adapters = process.env.ABBY_LEDGER === "postgres" ? ["memory", "postgres"] as const : ["memory"] as const;
  const adminUrl = process.env.DATABASE_URL;
  const databaseName = `abby_notification_voice_${randomUUID().replaceAll("-", "")}`;
  const admin = adapters.length === 2 && adminUrl ? connectPostgres(adminUrl) : undefined;
  let db: ReturnType<typeof connectPostgres> | undefined;
  let created = false;
  try {
    if (adapters.length === 2) {
      assert.ok(admin && adminUrl);
      await sql.raw(`create database "${databaseName}"`).execute(admin); created = true;
      const targetUrl = new URL(adminUrl); targetUrl.pathname = `/${databaseName}`;
      db = connectPostgres(targetUrl.toString()); await migrate(db);
    }
    for (const adapter of adapters) {
      const fixture = async () => {
        const scope = { tenantId: `notification-voice-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
        const state = { scope, ready: true, hostVersion: "sender-v1" } as Stores;
        const base = notificationRegistry();
        const registry: NotificationRegistry = { resolve: async (...args: Parameters<typeof base.resolve>) => state.ready
          ? ok({ ...value(await base.resolve(...args)), hostVersion: state.hostVersion })
          : err({ kind: "readinessFailed" as const, missing: ["notificationOwner"] as const }) };
        state.ledger = adapter === "memory" ? new MemoryLedger(readiness) : new PostgresLedger(db!, ref => ref, readiness, "unsafeReference");
        const modes = { cancellation: "execute", rescheduling: "execute" } as const;
        state.policy = adapter === "memory" ? new MemoryPolicyStore("execute", () => now, readiness, modes, undefined, registry)
          : new PostgresPolicyStore(db!, referenceDefaultPolicy, "execute", readiness, true, "unsafeReference", false, modes, undefined, registry);
        value(await state.policy.changeAutomationEnabled(scope, "0", true, "owner"));
        value(await state.policy.changeBookingEnabled(scope, "0", true, "owner"));
        value(await state.policy.changeCancellationEnabled(scope, "1", true, "owner"));
        value(await state.policy.changeReschedulingEnabled(scope, "2", true, "owner"));
        return state;
      };
      for (const owner of ["host", "abby"] as const) for (const kind of ["book", "cancel", "reschedule"] as const) {
        await t.test(`E2E-257 ${adapter}: ${owner} owns ${kind} after exact spoken confirmation and proven commit`, async () => {
          const state = await fixture();
          value(await state.policy.changeNotificationOwner(state.scope, "0", notificationKind(kind)!, owner, "owner"));
          const call = newCall(state, kind); await call.begin(); await call.confirm();
          await call.call.disconnect(now);
          value(await call.recovery.recover(now));
          assert.equal(call.sends.length, 1); assert.equal(call.sends[0]!.owner, owner);
          assert.equal(call.sends[0]!.kind, notificationKind(kind)); assert.equal(call.sends[0]!.hostVersion, "sender-v1");
          assert.equal(Object.values((await call.state()).effects).find(effect => effect.kind === "notification")?.status, "completed");
          value(await call.recovery.recover(now)); assert.equal(call.sends.length, 1);
        });
      }
      await t.test(`E2E-257 ${adapter}: default, future owner edit, clear and withdrawal preserve active call bindings`, async () => {
        const state = await fixture();
        const unset = newCall(state, "book"); await unset.begin(); await unset.confirm();
        value(await unset.recovery.recover(now)); assert.equal(unset.writes[0]!.notification, undefined); assert.equal(unset.sends.length, 0);
        await unset.call.disconnect(now);
        value(await state.policy.changeNotificationOwner(state.scope, "0", "bookingConfirmation", "host", "owner"));
        const active = newCall(state, "book"); await active.begin();
        state.hostVersion = "sender-v2";
        value(await state.policy.changeNotificationOwner({ ...state.scope, locationId: "other" }, "1", "bookingConfirmation", "abby", "other-owner"));
        await active.confirm(); value(await active.recovery.recover(now));
        assert.equal(active.sends[0]!.owner, "host"); assert.equal(active.sends[0]!.settingsVersion, "1"); assert.equal(active.sends[0]!.hostVersion, "sender-v1");
        await active.call.disconnect(now);
        const next = newCall(state, "book"); await next.begin(); await next.confirm(); value(await next.recovery.recover(now));
        assert.equal(next.sends[0]!.owner, "abby"); assert.equal(next.sends[0]!.hostVersion, "sender-v2"); await next.call.disconnect(now);
        state.ready = false;
        const withdrawn = newCall(state, "book"); await withdrawn.begin(); await withdrawn.confirm(); value(await withdrawn.recovery.recover(now));
        assert.equal(withdrawn.writes[0]!.notification, undefined); assert.equal(withdrawn.sends.length, 0); await withdrawn.call.disconnect(now);
        value(await state.policy.changeNotificationOwner(state.scope, "2", "bookingConfirmation", null, "owner")); state.ready = true;
        const cleared = newCall(state, "book"); await cleared.begin(); await cleared.confirm(); value(await cleared.recovery.recover(now));
        assert.equal(cleared.writes[0]!.notification, undefined); assert.equal(cleared.sends.length, 0); await cleared.call.disconnect(now);
      });
      await t.test(`E2E-257 ${adapter}: disconnect before confirmation cannot send; lost delivery observes captured owner without resending`, async () => {
        const state = await fixture();
        value(await state.policy.changeNotificationOwner(state.scope, "0", "bookingConfirmation", "abby", "owner"));
        const abandoned = newCall(state, "book"); await abandoned.begin(); await abandoned.speak(); await abandoned.call.disconnect(now);
        value(await abandoned.recovery.recover(now)); assert.equal(abandoned.writes.length, 0); assert.equal(abandoned.sends.length, 0);
        const unknown = newCall(state, "book", true); await unknown.begin(); await unknown.confirm(); value(await unknown.recovery.recover(now));
        assert.equal(unknown.sends.length, 1); assert.equal(Object.values((await unknown.state()).effects).find(effect => effect.kind === "notification")?.status, "uncertain");
        value(await state.policy.changeNotificationOwner(state.scope, "1", "bookingConfirmation", "host", "owner"));
        await unknown.call.disconnect(now); value(await unknown.recovery.recover(now));
        assert.equal(unknown.sends.length, 1); assert.equal(unknown.observations.length, 1); assert.equal(unknown.observations[0]!.owner, "abby");
        assert.equal(Object.values((await unknown.state()).effects).find(effect => effect.kind === "notification")?.status, "completed");
      });
      await t.test(`E2E-257 ${adapter}: unproven native suppression leaves appointment committed and notification for review`, async () => {
        const state = await fixture(); value(await state.policy.changeNotificationOwner(state.scope, "0", "bookingConfirmation", "host", "owner"));
        const call = newCall(state, "book", false, false); await call.begin(); await call.confirm(); await call.call.disconnect(now);
        value(await call.recovery.recover(now)); assert.equal(call.sends.length, 0);
        const notification = Object.values((await call.state()).effects).find(effect => effect.kind === "notification");
        assert.ok(notification?.kind === "notification"); assert.equal(notification.status, "needsReview"); assert.equal(notification.blockedReason, "suppressionUnproven");
      });
    }
  } finally {
    await db?.destroy();
    if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin!);
    await admin?.destroy();
  }
});
