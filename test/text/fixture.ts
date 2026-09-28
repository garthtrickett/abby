import assert from "node:assert/strict";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { ActionRequest, CallPolicy, CallState, FinalCallerTurn, HostMutation, HostWriteReceipt, ReconcileObservation, Result, StaffItem, StaffTaskObservation, StaffTaskReceipt, TransitionFailure, TurnInterpretation } from "../../src/core/model.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { EffectWorker } from "../../src/core/effect-worker.ts";
import type { HostEffects } from "../../src/core/host.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import type { Kysely } from "kysely";
import type Database from "../../src/storage/generated/Database.ts";
import type { AutomationReadiness } from "../../src/core/readiness.ts";

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

export class FakeHost implements HostEffects {
  readonly writes: HostMutation[] = [];
  readonly reconciliations: HostMutation[] = [];
  readonly tasks: StaffItem[] = [];
  writeResult: ((mutation: HostMutation) => HostWriteReceipt) = mutation => ({ kind: "committed", actionKey: mutation.actionKey, hostRef: "host-booking-1" });
  reconcileResult: ((mutation: HostMutation) => ReconcileObservation) = mutation => ({ kind: "stillUnknown", actionKey: mutation.actionKey });
  taskResult: ((item: StaffItem) => StaffTaskReceipt) = item => ({ kind: "opened", taskKey: item.key, hostTaskRef: "host-task-1", destination: item.destination });
  taskObservation: ((item: StaffItem) => StaffTaskObservation) = item => ({ kind: "stillUnknown", taskKey: item.key });

  async write(mutation: HostMutation, _now: string): Promise<HostWriteReceipt> {
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
  async reconcileTask(item: StaffItem): Promise<StaffTaskObservation> {
    return this.taskObservation(item);
  }
}

let postgresDb: Kysely<Database> | undefined;

export async function setup(id: string, modes?: Partial<CallPolicy["capabilities"]>, readiness?: AutomationReadiness) {
  const scope = { tenantId: `tenant-${id}`, clinicId: `clinic-${id}`, locationId: `location-${id}` };
  const policy: CallPolicy = {
    scope,
    policyVersion: "policy-1",
    automationVersion: "0",
    automationEnabled: true,
    bookingEnabled: true,
    capabilities: { book: "execute", cancel: "requestOnly", reschedule: "requestOnly", intake: "execute", transfer: "requestOnly", ...modes },
    staffDestination: { kind: "owner", ownerRef: `staff-${id}` },
    operatorQueue: { kind: "queue", queueRef: `operator-${id}` },
    greeting: { scope, version: "test-greeting-v1", ownerRef: "test-clinic-owner",
      approvedText: "Hello. How can I help you?", approved: true },
  };
  const callId = `call-${id}`;
  if (process.env.ABBY_LEDGER === "postgres" && !postgresDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required for PostgreSQL text tests");
    postgresDb = connectPostgres(url);
  }
  const ledger = process.env.ABBY_LEDGER === "postgres" ? new PostgresLedger(postgresDb!, suggestedAt => suggestedAt, readiness) : new MemoryLedger(readiness);
  const runtime = new CallRuntime(ledger, scope);
  const host = new FakeHost();
  const worker = new EffectWorker(runtime, host);
  success(await runtime.start(callId, policy));
  const patient = { scope, patientRef: `patient-${id}`, verificationRef: `verified-${id}`, expiresAt: deadline };
  const offer = (serviceRef = "physio", offerRef = "offer-1") => ({ scope, offerRef, serviceRef, startsAt: "2026-09-29T11:00:00.000Z", expiresAt: deadline });
  const book = (serviceRef = "physio", offerRef = "offer-1"): ActionRequest => ({ kind: "book", patient, offer: offer(serviceRef, offerRef) });
  const intake: ActionRequest = { kind: "intake", scope, approvedDraftRef: "draft-1", consentRef: "consent-1", duplicateCheckRef: "check-1" };
  async function turn(turnId: string, text: string, interpretation: TurnInterpretation, at = now): Promise<CallState> {
    const message: FinalCallerTurn = { callId, turnId, text, quality: "clear", at };
    return success(await runtime.acceptTurn(message, interpretation, at));
  }
  async function state(): Promise<CallState> { return success(await runtime.read(callId)); }
  async function pendingAction(): Promise<CallState["actions"][string]> {
    const item = Object.values((await state()).actions).find(action => action.status === "awaitingConfirmation");
    assert.ok(item);
    return item;
  }
  async function confirm(actionKey: string, turnId = "affirm-1"): Promise<CallState> {
    const action = (await state()).actions[actionKey];
    assert.ok(action);
    success(await runtime.startPresentation(callId, action.presentationId));
    success(await runtime.resolvePresentation(callId, action.presentationId, "played"));
    return turn(turnId, "Yes, confirm those details", { kind: "affirm", actionKey, digest: action.digest, affirmative: true });
  }
  return { callId, scope, policy, patient, offer, book, intake, ledger, runtime, host, worker, turn, state, pendingAction, confirm };
}
