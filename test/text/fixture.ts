import assert from "node:assert/strict";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { ActionRequest, CallPolicy, CallState, FinalCallerTurn, HostMutation, HostWriteReceipt, ReconcileObservation, Result, StaffItem, StaffTaskReceipt, TransitionFailure, TurnInterpretation } from "../../src/core/model.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { ReferenceEffectWorker } from "../../src/reference/effect-worker.ts";
import type { ReferenceHost } from "../../src/reference/effect-worker.ts";

export const now = "2026-09-28T10:00:00.000Z";
export const deadline = "2026-09-29T10:00:00.000Z";

export function success<T>(result: Result<T, TransitionFailure>): T {
  assert.equal(result.ok, true, result.ok ? "" : result.error.kind);
  return result.value;
}

export function failure<T>(result: Result<T, TransitionFailure>, kind: TransitionFailure["kind"]): void {
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, kind);
}

export class FakeHost implements ReferenceHost {
  readonly writes: HostMutation[] = [];
  readonly reconciliations: HostMutation[] = [];
  readonly tasks: StaffItem[] = [];
  writeResult: ((mutation: HostMutation) => HostWriteReceipt) = mutation => ({ kind: "committed", actionKey: mutation.actionKey, hostRef: "host-booking-1" });
  reconcileResult: ((mutation: HostMutation) => ReconcileObservation) = mutation => ({ kind: "stillUnknown", actionKey: mutation.actionKey });
  taskResult: ((item: StaffItem) => StaffTaskReceipt) = item => ({ kind: "opened", taskKey: item.key, hostTaskRef: "host-task-1", destination: item.destination });

  async write(mutation: HostMutation): Promise<HostWriteReceipt> {
    this.writes.push(mutation);
    return this.writeResult(mutation);
  }
  async reconcile(mutation: HostMutation): Promise<ReconcileObservation> {
    this.reconciliations.push(mutation);
    return this.reconcileResult(mutation);
  }
  async openTask(item: StaffItem): Promise<StaffTaskReceipt> {
    this.tasks.push(item);
    return this.taskResult(item);
  }
}

export function setup(id: string, modes?: Partial<CallPolicy["capabilities"]>) {
  const scope = { tenantId: `tenant-${id}`, clinicId: `clinic-${id}`, locationId: `location-${id}` };
  const policy: CallPolicy = {
    scope,
    policyVersion: "policy-1",
    capabilities: { book: "execute", cancel: "requestOnly", reschedule: "requestOnly", intake: "execute", ...modes },
    staffDestination: { kind: "owner", ownerRef: `staff-${id}` },
    operatorQueue: { kind: "queue", queueRef: `operator-${id}` },
  };
  const callId = `call-${id}`;
  const runtime = new CallRuntime(new MemoryLedger());
  const host = new FakeHost();
  const worker = new ReferenceEffectWorker(runtime, host);
  success(runtime.start(callId, policy));
  const patient = { scope, patientRef: `patient-${id}`, verificationRef: `verified-${id}`, expiresAt: deadline };
  const offer = (serviceRef = "physio", offerRef = "offer-1") => ({ scope, offerRef, serviceRef, startsAt: "2026-09-29T11:00:00.000Z", expiresAt: deadline });
  const book = (serviceRef = "physio", offerRef = "offer-1"): ActionRequest => ({ kind: "book", patient, offer: offer(serviceRef, offerRef) });
  const intake: ActionRequest = { kind: "intake", scope, approvedDraftRef: "draft-1", consentRef: "consent-1", duplicateCheckRef: "check-1" };
  function turn(turnId: string, text: string, interpretation: TurnInterpretation, at = now): CallState {
    const message: FinalCallerTurn = { callId, turnId, text, quality: "clear", at };
    return success(runtime.acceptTurn(message, interpretation, at));
  }
  function state(): CallState { return success(runtime.read(callId)); }
  function pendingAction(): CallState["actions"][string] {
    const item = Object.values(state().actions).find(action => action.status === "awaitingConfirmation");
    assert.ok(item);
    return item;
  }
  function confirm(actionKey: string, turnId = "affirm-1"): CallState {
    const action = state().actions[actionKey];
    assert.ok(action);
    success(runtime.startPresentation(callId, action.presentationId));
    success(runtime.resolvePresentation(callId, action.presentationId, "played"));
    return turn(turnId, "Yes, confirm those details", { kind: "affirm", actionKey, digest: action.digest, affirmative: true });
  }
  return { callId, scope, policy, patient, offer, book, intake, runtime, host, worker, turn, state, pendingAction, confirm };
}
