import assert from "node:assert/strict";
import test from "node:test";
import { EffectWorker } from "../../src/core/effect-worker.ts";
import { EffectRecovery } from "../../src/core/effect-recovery.ts";
import { captureNotificationPolicy, defaultNotificationSettings } from "../../src/core/notification-policy.ts";
import { notificationKind, unknownNotification } from "../../src/core/notification-effects.ts";
import type { NotificationIntent, NotificationObservation } from "../../src/core/notification-effects.ts";
import type { ActionKind, ActionRequest, TurnInterpretation } from "../../src/core/model.ts";
import type { TimerPort } from "../../src/core/timer.ts";
import { notificationRegistry } from "../support/notification-settings-contract.ts";
import { deadline, now, setup, success } from "./fixture.ts";

const afterDelay = "2026-09-28T10:01:01.000Z";
const afterDeadline = "2026-09-29T10:01:01.000Z";

async function fixture(id: string, owner: "host" | "abby" = "host", managed = true) {
  const app = await setup(`notification-${id}`, { cancel: "execute", reschedule: "execute" });
  const callId = `${app.callId}:managed`;
  const settings = { ...defaultNotificationSettings(), version: "1",
    owners: { bookingConfirmation: owner, cancellationConfirmation: owner, reschedulingConfirmation: owner } };
  const policy = await captureNotificationPolicy(app.policy, settings, managed ? notificationRegistry() : undefined);
  success(await app.runtime.start(callId, policy));
  const sends: NotificationIntent[] = [];
  const observations: NotificationIntent[] = [];
  const host = Object.assign(app.host, {
    dispatchNotification: async (intent: NotificationIntent): Promise<NotificationObservation> => {
      sends.push(structuredClone(intent));
      const during = success(await app.runtime.read(callId));
      assert.equal(during.effects[`${intent.notificationKey}:notification`]?.status, "possiblySent");
      return { ...unknownNotification(intent), kind: "sent", deliveryRef: "delivery-one" };
    },
    observeNotification: async (intent: NotificationIntent): Promise<NotificationObservation> => {
      observations.push(structuredClone(intent));
      return { ...unknownNotification(intent), kind: "sent", deliveryRef: "delivery-one" };
    },
  });
  host.writeResult = mutation => ({ kind: "committed", actionKey: mutation.actionKey, hostRef: "host-booking",
    ...(mutation.notification ? { notification: structuredClone(mutation.notification) } : {}) });
  const worker = new EffectWorker(app.runtime, host);
  const turn = (turnId: string, interpretation: TurnInterpretation) => app.runtime.acceptTurn(
    { callId, turnId, text: "Synthetic caller turn", quality: "clear", at: now }, interpretation, now);
  async function prepare(kind: Extract<ActionKind, "book" | "cancel" | "reschedule"> = "book") {
    const target = { scope: app.scope, appointmentRef: "host-appointment", patientRef: app.patient.patientRef,
      startsAt: "2026-09-29T11:00:00.000Z", endsAt: "2026-09-29T11:30:00.000Z", timeZone: "Australia/Sydney" };
    const terms = { version: "terms-v1", approvedText: "Clinic-approved change terms.", expiresAt: deadline };
    const request: ActionRequest = kind === "book" ? app.book() : kind === "cancel"
      ? { kind, patient: app.patient, target, terms }
      : { kind, patient: app.patient, target, offer: { ...app.offer(), startsAt: "2026-09-29T12:00:00.000Z" }, terms };
    const proposed = success(await turn(`proposal-${kind}`, { kind: "requestAction", request }));
    const action = Object.values(proposed.actions).find(item => item.kind === kind);
    assert.ok(action);
    success(await app.runtime.startPresentation(callId, action.presentationId));
    success(await app.runtime.resolvePresentation(callId, action.presentationId, "played"));
    success(await turn(`confirm-${kind}`, { kind: "affirm", actionKey: action.key, digest: action.digest, affirmative: true }));
    return action;
  }
  async function commit(kind: Extract<ActionKind, "book" | "cancel" | "reschedule"> = "book") {
    const action = await prepare(kind);
    await worker.process(callId, `${action.key}:write`, now);
    const state = success(await app.runtime.read(callId));
    const notification = Object.values(state.effects).find(effect => effect.kind === "notification");
    assert.ok(notification && notification.kind === "notification");
    return { action, notification };
  }
  const state = () => app.runtime.read(callId).then(success);
  return { ...app, policy, callId, worker, host, sends, observations, prepare, commit, state, turn };
}

for (const owner of ["host", "abby"] as const) {
  for (const kind of ["book", "cancel", "reschedule"] as const) {
    test(`E2E-257 ${owner} owns ${kind} confirmation: exact suppression receipt queues one captured notification after commit`, async () => {
      const app = await fixture(`${owner}-${kind}`, owner);
      const action = await app.prepare(kind);
      assert.equal(Object.values((await app.state()).effects).some(effect => effect.kind === "notification"), false);
      await app.worker.process(app.callId, `${action.key}:write`, now);
      const notification = Object.values((await app.state()).effects).find(effect => effect.kind === "notification");
      assert.ok(notification && notification.kind === "notification");
      assert.equal(notification.status, "pending");
      assert.deepEqual(notification.intent, { ...action.mutation.notification, callId: app.callId, actionKey: action.key,
        policyVersion: app.policy.policyVersion, hostRef: "host-booking" });
      assert.equal(notification.intent.owner, owner);
      assert.equal(notification.intent.kind, notificationKind(kind));
      assert.equal(notification.intent.settingsVersion, "1");
      assert.equal(notification.intent.hostVersion, "notifications-v1");
      assert.deepEqual(app.host.writes[0]!.notification, action.mutation.notification);
      await app.worker.process(app.callId, notification.id, now);
      const final = await app.state();
      assert.equal(final.actions[action.key]!.status, "committed");
      const delivered = final.effects[notification.id];
      assert.ok(delivered?.kind === "notification");
      assert.equal(delivered.status, "completed");
      assert.equal(delivered.observation?.kind, "sent");
      assert.equal(app.sends.length, 1);
      success(await app.runtime.acceptHostResult(app.callId, `${action.key}:write`,
        { kind: "committed", actionKey: action.key, hostRef: "host-booking",
          ...(action.mutation.notification ? { notification: action.mutation.notification } : {}) }, now));
      assert.equal(Object.values((await app.state()).effects).filter(effect => effect.kind === "notification").length, 1);
      assert.equal(success(await new EffectRecovery(app.ledger, () => app.host, app.scope).recover(now)).processed, 0);
      assert.equal(app.sends.length, 1);
      assert.equal(final.callerMessages.some(text => /notification.*sent|confirmation.*sent/i.test(text)), false);
    });
  }
}

test("E2E-257 unproven notification ownership does not add managed directives or send effects", async () => {
  const app = await fixture("unproven", "abby", false);
  const action = await app.prepare();
  assert.equal(action.mutation.notification, undefined);
  await app.worker.process(app.callId, `${action.key}:write`, now);
  assert.equal((await app.state()).actions[action.key]!.status, "committed");
  assert.equal(Object.values((await app.state()).effects).some(effect => effect.kind === "notification"), false);
  assert.equal(app.sends.length, 0);
});

for (const reply of ["missing", "wrongOwner", "wrongKey", "wrongVersion", "extraData"] as const) {
  test(`E2E-257 a ${reply} suppression acknowledgement never permits a second notification send`, async () => {
    const app = await fixture(`suppression-${reply}`, "abby");
    app.host.writeResult = mutation => {
      const notification = mutation.notification!;
      const changed = reply === "wrongOwner" ? { ...notification, owner: "host" as const }
        : reply === "wrongKey" ? { ...notification, notificationKey: "another-notification" }
        : reply === "wrongVersion" ? { ...notification, hostVersion: "other-version" }
        : reply === "extraData" ? { ...notification, privateData: "not-approved" } : undefined;
      return { kind: "committed", actionKey: mutation.actionKey, hostRef: "host-booking", ...(changed ? { notification: changed } : {}) };
    };
    const { action, notification } = await app.commit();
    assert.equal(notification.status, "needsReview");
    assert.equal(notification.blockedReason, "suppressionUnproven");
    assert.equal((await app.state()).actions[action.key]!.status, "committed");
    assert.equal(success(await new EffectRecovery(app.ledger, () => app.host, app.scope).recover(now)).scanned, 0);
    assert.equal(app.sends.length, 0);
  });
}

test("E2E-257 an uncertain appointment cannot notify until exact reconciliation proves commit and suppression", async () => {
  const app = await fixture("reconciled-booking");
  app.host.writeResult = mutation => ({ kind: "uncertain", actionKey: mutation.actionKey, reconcileAfter: now, deadline });
  const action = await app.prepare();
  await app.worker.process(app.callId, `${action.key}:write`, now);
  assert.equal(Object.values((await app.state()).effects).some(effect => effect.kind === "notification"), false);
  app.host.reconcileResult = mutation => ({ kind: "exactCommit", actionKey: mutation.actionKey, hostRef: "host-booking",
    ...(mutation.notification ? { notification: mutation.notification } : {}) });
  await app.worker.process(app.callId, `${action.key}:write:reconcile`, now);
  const effect = Object.values((await app.state()).effects).find(item => item.kind === "notification");
  assert.ok(effect && effect.kind === "notification");
  assert.equal(effect.status, "pending");
  await app.worker.process(app.callId, effect.id, now);
  assert.equal(app.sends.length, 1);
  assert.equal(app.host.writes.length, 1);
});

test("E2E-257 a thrown notification send reconciles its captured owner without resending or changing the appointment result", async () => {
  const app = await fixture("send-unknown", "abby");
  const { action, notification } = await app.commit();
  app.host.dispatchNotification = async intent => { app.sends.push(structuredClone(intent)); throw new Error("reply lost after send"); };
  await app.worker.process(app.callId, notification.id, now);
  const uncertain = (await app.state()).effects[notification.id];
  assert.ok(uncertain?.kind === "notification");
  assert.equal(uncertain.status, "uncertain");
  assert.equal((await app.state()).actions[action.key]!.status, "committed");
  const recovery = new EffectRecovery(app.ledger, () => app.host, app.scope);
  assert.equal(success(await recovery.recover(afterDelay)).processed, 1);
  const final = (await app.state()).effects[notification.id];
  assert.ok(final?.kind === "notification");
  assert.equal(final.observation?.kind, "sent");
  assert.equal(app.sends.length, 1);
  assert.equal(app.observations.length, 1);
  assert.equal(app.observations[0]!.owner, "abby");
});

test("E2E-257 a process loss after the notification barrier recovers to observation and never repeats the send", async () => {
  const app = await fixture("barrier-process-loss");
  const { notification } = await app.commit();
  success(await app.runtime.notificationAction(app.callId, { kind: "markNotificationPossiblySent", effectId: notification.id, now }));
  const recovery = new EffectRecovery(app.ledger, () => app.host, app.scope);
  assert.equal(success(await recovery.recover(now)).scanned, 0);
  assert.equal(success(await recovery.recover(afterDelay)).recovered, 1);
  assert.equal(success(await recovery.recover(afterDelay)).processed, 1);
  const final = (await app.state()).effects[notification.id];
  assert.ok(final?.kind === "notification");
  assert.equal(final.status, "completed");
  assert.equal(app.sends.length, 0);
  assert.equal(app.observations.length, 1);
});

test("E2E-257 a persistently unknown notification becomes review-required at its deadline without a retry", async () => {
  const app = await fixture("unknown-deadline");
  const { notification } = await app.commit();
  app.host.dispatchNotification = async intent => { app.sends.push(intent); return unknownNotification(intent); };
  app.host.observeNotification = async intent => { app.observations.push(intent); return unknownNotification(intent); };
  await app.worker.process(app.callId, notification.id, now);
  await app.worker.process(app.callId, `${notification.id}:reconcile`, afterDelay);
  assert.equal((await app.state()).effects[notification.id]?.status, "uncertain");
  await app.worker.process(app.callId, `${notification.id}:reconcile`, afterDeadline);
  assert.equal((await app.state()).effects[notification.id]?.status, "needsReview");
  assert.equal(success(await new EffectRecovery(app.ledger, () => app.host, app.scope).recover(afterDeadline)).scanned, 0);
  assert.equal(app.sends.length, 1);
});

test("E2E-257 a wrong-owner delivery reply remains unknown; the host observes the original owner", async () => {
  const app = await fixture("wrong-receipt", "abby");
  const { notification } = await app.commit();
  app.host.dispatchNotification = async intent => { app.sends.push(intent); return { ...unknownNotification(intent), owner: "host",
    kind: "sent", deliveryRef: "wrong-owner-delivery" }; };
  await app.worker.process(app.callId, notification.id, now);
  assert.equal((await app.state()).effects[notification.id]?.status, "uncertain");
  await app.worker.process(app.callId, `${notification.id}:reconcile`, afterDelay);
  assert.equal(app.observations[0]!.owner, "abby");
  assert.equal(app.sends.length, 1);
});

test("E2E-257 a proven unsent notification is terminal and leaves the appointment committed", async () => {
  const app = await fixture("definitive-unsent");
  const { action, notification } = await app.commit();
  app.host.dispatchNotification = async intent => { app.sends.push(intent); return { ...unknownNotification(intent), kind: "definitiveUnsent" }; };
  await app.worker.process(app.callId, notification.id, now);
  const result = (await app.state()).effects[notification.id];
  assert.ok(result?.kind === "notification");
  assert.equal(result.status, "completed");
  assert.equal(result.observation?.kind, "definitiveUnsent");
  assert.equal((await app.state()).actions[action.key]!.status, "committed");
  assert.equal(success(await new EffectRecovery(app.ledger, () => app.host, app.scope).recover(afterDelay)).scanned, 0);
  assert.equal(app.sends.length, 1);
});

test("E2E-257 emergency stop fences an unsent notification and records an already possible send", async () => {
  const pending = await fixture("stop-pending");
  const { action, notification } = await pending.commit();
  assert.ok((await pending.ledger.stopWrites(pending.scope, "owner", "Stop new writes")).ok);
  await pending.worker.process(pending.callId, notification.id, now);
  const blocked = (await pending.state()).effects[notification.id];
  assert.ok(blocked?.kind === "notification");
  assert.equal(blocked.status, "canceled");
  assert.equal(blocked.blockedReason, "emergencyStop");
  assert.equal((await pending.state()).actions[action.key]!.status, "committed");
  assert.equal(pending.sends.length, 0);
  const sent = await fixture("stop-possible");
  const possible = await sent.commit();
  success(await sent.runtime.notificationAction(sent.callId,
    { kind: "markNotificationPossiblySent", effectId: possible.notification.id, now }));
  const status = success(await sent.ledger.stopWrites(sent.scope, "owner", "Stop new writes"));
  assert.ok(status.inFlight.some(item => item.effectId === possible.notification.id && item.status === "possiblySent"));
  const recovery = new EffectRecovery(sent.ledger, () => sent.host, sent.scope);
  success(await recovery.recover(afterDelay));
  success(await recovery.recover(afterDelay));
  assert.equal(sent.sends.length, 0);
  assert.equal(sent.observations.length, 1);
});

test("E2E-257 concurrent recovery workers dispatch one notification through the call lease", async () => {
  const app = await fixture("concurrent-dispatch");
  const { notification } = await app.commit();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  app.host.dispatchNotification = async intent => {
    app.sends.push(intent); entered(); await wait;
    return { ...unknownNotification(intent), kind: "sent", deliveryRef: "one-delivery" };
  };
  const first = new EffectRecovery(app.ledger, () => app.host, app.scope).recover(now);
  await started;
  try {
    const other = success(await new EffectRecovery(app.ledger, () => app.host, app.scope).recover(now));
    // A pending scan racing the mark, or an already possibly-sent scan, cannot cross the barrier again.
    assert.equal(other.processed, 0);
    assert.equal(app.sends.length, 1);
  } finally { release(); }
  assert.equal(success(await first).processed, 1);
  assert.equal((await app.state()).effects[notification.id]?.status, "completed");
  assert.equal(app.sends.length, 1);
});

for (const outcome of ["rejected", "unsupported"] as const) {
  test(`E2E-257 a ${outcome} appointment cannot create a notification intent`, async () => {
    const app = await fixture(`appointment-${outcome}`);
    app.host.writeResult = mutation => outcome === "rejected" ? { kind: outcome, actionKey: mutation.actionKey, reason: "conflict" }
      : { kind: outcome, actionKey: mutation.actionKey };
    const action = await app.prepare();
    await app.worker.process(app.callId, `${action.key}:write`, now);
    assert.equal((await app.state()).actions[action.key]!.status, outcome);
    assert.equal(Object.values((await app.state()).effects).some(effect => effect.kind === "notification"), false);
    assert.equal(app.sends.length, 0);
  });
}

test("E2E-257 intake does not send a booking confirmation or add a notification directive", async () => {
  const app = await fixture("intake-no-notification");
  const proposed = success(await app.turn("intake-proposal", { kind: "requestAction", request: app.intake }));
  const action = Object.values(proposed.actions)[0]!;
  assert.equal(action.kind, "intake");
  assert.equal(action.mutation.notification, undefined);
  success(await app.runtime.startPresentation(app.callId, action.presentationId));
  success(await app.runtime.resolvePresentation(app.callId, action.presentationId, "played"));
  success(await app.turn("intake-confirm", { kind: "affirm", actionKey: action.key, digest: action.digest, affirmative: true }));
  await app.worker.process(app.callId, `${action.key}:write`, now);
  assert.equal((await app.state()).actions[action.key]!.status, "committed");
  assert.equal(Object.values((await app.state()).effects).some(effect => effect.kind === "notification"), false);
});

test("E2E-257 a missing sender cancels a notification before the barrier without undoing the appointment", async () => {
  const app = await fixture("missing-sender");
  const { action, notification } = await app.commit();
  const host = { write: app.host.write.bind(app.host), reconcile: app.host.reconcile.bind(app.host),
    openTask: app.host.openTask.bind(app.host), reconcileTask: app.host.reconcileTask.bind(app.host) };
  await new EffectWorker(app.runtime, host).process(app.callId, notification.id, now);
  const effect = (await app.state()).effects[notification.id];
  assert.ok(effect?.kind === "notification");
  assert.equal(effect.status, "canceled");
  assert.equal(effect.blockedReason, "hostUnavailable");
  assert.equal(effect.possiblySentAt, undefined);
  assert.equal((await app.state()).actions[action.key]!.status, "committed");
  assert.equal(app.sends.length, 0);
});

test("E2E-257 a notification provider deadline aborts the send and ignores a late receipt without replay", async () => {
  const app = await fixture("provider-deadline");
  const { notification } = await app.commit();
  let fire!: () => void;
  let entered!: () => void;
  let release!: (observation: NotificationObservation) => void;
  let observedSignal: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const late = new Promise<NotificationObservation>(resolve => { release = resolve; });
  const timer: TimerPort = { schedule: (callback, delay) => { assert.equal(delay, 1000); fire = callback; return "deadline"; },
    cancel: handle => assert.equal(handle, "deadline") };
  const host = { ...app.host,
    write: app.host.write.bind(app.host), reconcile: app.host.reconcile.bind(app.host),
    openTask: app.host.openTask.bind(app.host), reconcileTask: app.host.reconcileTask.bind(app.host),
    dispatchNotification: async (intent: NotificationIntent, signal?: AbortSignal): Promise<NotificationObservation> => {
      app.sends.push(intent); observedSignal = signal; entered(); return late;
    },
    observeNotification: app.host.observeNotification,
  };
  const sending = new EffectWorker(app.runtime, host, undefined, undefined, { timer, hostDeadlineMs: 1000 })
    .process(app.callId, notification.id, now);
  await started;
  fire();
  await sending;
  assert.equal(observedSignal?.aborted, true);
  assert.equal((await app.state()).effects[notification.id]?.status, "uncertain");
  release({ ...unknownNotification(notification.intent), kind: "sent", deliveryRef: "late-delivery" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await app.state()).effects[notification.id]?.status, "uncertain");
  success(await new EffectRecovery(app.ledger, () => app.host, app.scope).recover(afterDelay));
  assert.equal(app.sends.length, 1);
  assert.equal(app.observations.length, 1);
});

for (const phase of ["send", "observe"] as const) {
  test(`E2E-257 a corrupted ${phase} intent cannot reach a foreign host scope`, async () => {
    const app = await fixture(`corrupt-${phase}`);
    const { notification } = await app.commit();
    let effectId = notification.id;
    if (phase === "observe") {
      app.host.dispatchNotification = async intent => { app.sends.push(intent); return unknownNotification(intent); };
      await app.worker.process(app.callId, effectId, now);
      effectId += ":reconcile";
    }
    const originalRead = app.runtime.read.bind(app.runtime);
    app.runtime.read = async callId => {
      const result = await originalRead(callId);
      if (!result.ok) return result;
      const effect = result.value.effects[effectId];
      assert.ok(effect && (effect.kind === "notification" || effect.kind === "notificationReconcile"));
      result.value.effects[effectId] = { ...effect, intent: { ...effect.intent, scope: { ...effect.intent.scope, tenantId: "foreign" } } };
      return result;
    };
    await assert.rejects(() => app.worker.process(app.callId, effectId, afterDelay), /storageCorrupt/);
    assert.equal(app.sends.length, phase === "observe" ? 1 : 0);
    assert.equal(app.observations.length, 0);
  });
}
