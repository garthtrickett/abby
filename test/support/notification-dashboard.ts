import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { err, ok } from "../../src/core/model.ts";
import type { NotificationIntent, NotificationObservation } from "../../src/core/notification-effects.ts";
import { unknownNotification } from "../../src/core/notification-effects.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { EffectWorker } from "../../src/core/effect-worker.ts";
import { CallReview } from "../../src/reference/call-review.ts";
import { CallOutcomeReport } from "../../src/reference/call-outcome-report.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { createHostAuthenticatedDashboardServer } from "../../src/standalone/dashboard/server.ts";
import { notificationRegistry } from "../support/notification-settings-contract.ts";

export async function dashboard(ready = true) {
  const scope = { tenantId: `notification-browser-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  let hostReady = ready;
  const supported = notificationRegistry();
  const readiness = async () => ok(true as const);
  const policy = new MemoryPolicyStore(undefined, undefined, readiness, undefined, undefined, {
    resolve: (...args) => hostReady ? supported.resolve(...args)
      : Promise.resolve(err({ kind: "readinessFailed", missing: ["notificationOwner"] })),
  });
  const ledger = new MemoryLedger(readiness);
  const reception = new TextReception(ledger, policy, new ReferenceClinicHost([], []));
  const server = await createHostAuthenticatedDashboardServer({ publicOrigin: "http://127.0.0.1:0",
    resolveActor: request => request.headers.cookie === "session=notification-owner" ? { actorRef: "notification-owner", role: "clinicAdmin", scope }
      : request.headers.cookie === "session=notification-staff" ? { actorRef: "notification-staff", role: "staff", scope } : null,
    gatewayFor: actor => new CommandGateway(actor, policy, reception, new CallReview(ledger), undefined, new CallOutcomeReport(ledger)),
  }, resolve("dist/dashboard/app.js"));
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  return { scope, policy, ledger, reception, url, headers: { Cookie: "session=notification-owner", Origin: url },
    setReady: (value: boolean) => { hostReady = value; },
    close: () => new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); }) };
}

export async function committedCall(app: Awaited<ReturnType<typeof dashboard>>, suppress = true) {
  const { policy, ledger, scope } = app;
  const now = "2026-10-02T21:40:00.000Z";
  const current = await policy.read(scope); assert.ok(current.ok);
  if (!current.value.bookingEnabled) assert.ok((await policy.changeBookingEnabled(scope, current.value.policyVersion, true, "notification-owner")).ok);
  if (!current.value.automationEnabled) assert.ok((await policy.changeAutomationEnabled(scope, current.value.automationVersion!, true, "notification-owner")).ok);
  if (!current.value.notificationSettings?.owners.bookingConfirmation) assert.ok((await policy.changeNotificationOwner(scope,
    current.value.notificationSettings!.version, "bookingConfirmation", "host", "notification-owner")).ok);
  const snapshot = await policy.read(scope); assert.ok(snapshot.ok);
  const callId = `notification-review-${randomUUID()}`;
  const patient = { scope, patientRef: "PRIVATE_PATIENT_CANARY", verificationRef: "PRIVATE_VERIFICATION_CANARY", expiresAt: "2026-10-02T22:40:00.000Z" };
  const offer = { scope, offerRef: "PRIVATE_OFFER_CANARY", serviceRef: "physio", startsAt: "2026-10-03T12:00:00.000Z", expiresAt: patient.expiresAt };
  const runtime = new CallRuntime(ledger, scope);
  assert.ok((await runtime.start(callId, snapshot.value)).ok);
  const proposed = await runtime.acceptTurn({ callId, turnId: "proposal", text: "PRIVATE_CALLER_TEXT", quality: "clear", at: now },
    { kind: "requestAction", request: { kind: "book", patient, offer } }, now);
  assert.ok(proposed.ok); const action = Object.values(proposed.value.actions)[0]!; assert.ok(action);
  assert.ok((await runtime.startPresentation(callId, action.presentationId)).ok);
  assert.ok((await runtime.resolvePresentation(callId, action.presentationId, "played")).ok);
  assert.ok((await runtime.acceptTurn({ callId, turnId: "affirm", text: "Yes", quality: "clear", at: now },
    { kind: "affirm", actionKey: action.key, digest: action.digest, affirmative: true }, now)).ok);
  let delivery: "unknown" | "sent" | "definitiveUnsent" = "unknown";
  let sends = 0;
  const host = Object.assign(new ReferenceClinicHost([patient], [offer]), {
    async dispatchNotification(intent: NotificationIntent): Promise<NotificationObservation> {
      sends += 1; assert.equal(sends, 1);
      return unknownNotification(intent);
    },
    async observeNotification(intent: NotificationIntent): Promise<NotificationObservation> {
      return delivery === "sent" ? { ...unknownNotification(intent), kind: "sent", deliveryRef: "PRIVATE_DELIVERY_CANARY" }
        : { ...unknownNotification(intent), kind: delivery };
    },
  });
  const write = host.write.bind(host);
  host.write = async (...args) => {
    const result = await write(...args);
    return result.kind === "committed" && suppress ? { ...result, notification: args[0].notification! } : result;
  };
  const worker = new EffectWorker(runtime, host);
  await worker.process(callId, `${action.key}:write`, now);
  const state = await runtime.read(callId); assert.ok(state.ok);
  const notification = Object.values(state.value.effects).find(effect => effect.kind === "notification"); assert.ok(notification);
  return { callId, action, now, send: () => worker.process(callId, notification.id, now),
    resolve: async (outcome: "sent" | "definitiveUnsent") => { delivery = outcome; await worker.process(callId, `${notification.id}:reconcile`, now); },
    state: () => runtime.read(callId), sends: () => sends };
}
