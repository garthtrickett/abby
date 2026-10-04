import type { ClinikoAppointmentChangeGuardConfig, PreparedClinikoChange } from "./cliniko-appointment-change-guard.ts";
import { ClinikoAppointmentChangeGuard } from "./cliniko-appointment-change-guard.ts";
import { ClinikoCancellationWriter } from "../cliniko/cancellation-write.ts";
import { ClinikoRescheduleWriter } from "../cliniko/reschedule-write.ts";
import type { ClinikoCancellationRequest, ClinikoRescheduleRequest } from "../cliniko/appointment-write.ts";
import { digestActionRequest } from "../core/digest.ts";
import type { AppointmentChangeEvidenceHost, AppointmentChangeEvidenceQuery, BookingEvidenceHost, HostEffects,
  HostReadFailure } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { ActionRequest, HostMutation, HostWriteReceipt, LocationScope,
  ReconcileObservation, Result, StaffItem, StaffTaskObservation, StaffTaskReceipt } from "../core/model.ts";
import { sameScope } from "./appointment-change-authority.ts";
import type { AppointmentChangeRequest as Change } from "./appointment-change-authority.ts";
import { NoStoredKnowledge } from "./no-stored-knowledge.ts";

export type TransientClinikoAppointmentChangeConfig = ClinikoAppointmentChangeGuardConfig & Readonly<{
  rescheduling: ClinikoRescheduleWriter;
  /** An embedded buyer must provide a patient-specific queue for uncertain outcomes. */
  staff: Pick<HostEffects, "openTask" | "reconcileTask">;
}>;
type Prepared = PreparedClinikoChange;
type Attempt = Readonly<{ actionKey: string; digest: string; prepared: Prepared }>;
const refPattern = /^[A-Za-z0-9:_-]{1,256}$/;

function validScope(value: unknown): value is LocationScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  return [scope.tenantId, scope.clinicId, scope.locationId].every(part =>
    typeof part === "string" && !!part.trim() && part.length <= 256);
}

/** One call and session own one process-local appointment change. Not constructed by the standalone runner. */
export class TransientClinikoAppointmentChangeHost extends NoStoredKnowledge
  implements AppointmentChangeEvidenceHost, BookingEvidenceHost, HostEffects {
  readonly #guard: ClinikoAppointmentChangeGuard;
  readonly #scope: LocationScope;
  readonly #callId: string;
  readonly #sessionId: string;
  readonly #policyVersion: string;
  readonly #cancellation: ClinikoCancellationWriter;
  readonly #rescheduling: ClinikoRescheduleWriter;
  readonly #staff: Pick<HostEffects, "openTask" | "reconcileTask">;
  readonly #clock: () => string;
  readonly #lifetime = new AbortController();
  #prepared: Prepared | undefined;
  #attempt: Attempt | undefined;
  #conflictObserved = false;
  #busy = false;
  #closed = false;

  constructor(config: TransientClinikoAppointmentChangeConfig) {
    super();
    this.#guard = new ClinikoAppointmentChangeGuard(config);
    if (!config.staff || typeof config.staff.openTask !== "function" || typeof config.staff.reconcileTask !== "function") {
      throw new TypeError("invalid embedded appointment staff host");
    }
    this.#scope = Object.freeze({ ...config.scope }); this.#callId = config.callId; this.#sessionId = config.sessionId;
    this.#policyVersion = config.policyVersion; this.#cancellation = config.cancellation;
    this.#rescheduling = config.rescheduling; this.#staff = config.staff;
    this.#clock = config.clock ?? (() => new Date().toISOString());
  }

  async resolveAppointmentChange(query: AppointmentChangeEvidenceQuery): Promise<Result<Change, HostReadFailure>> {
    if (this.#closed || this.#busy || this.#attempt || this.#prepared || !query ||
        !validScope(query.scope) || !sameScope(query.scope, this.#scope) ||
        query.callId !== this.#callId || query.sessionId !== this.#sessionId ||
        query.policyVersion !== this.#policyVersion ||
        ![query.verificationRef, query.targetRef].every(value =>
          typeof value === "string" && refPattern.test(value)) ||
        (query.kind !== "cancel" && query.kind !== "reschedule") ||
        (query.kind === "reschedule" && !refPattern.test(query.offerRef))) {
      return err({ kind: "notFound", target: "appointment" });
    }
    this.#busy = true;
    const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(15_000)]);
    try {
      const prepared = await this.#guard.resolve(query, "proposal", signal);
      if (prepared.ok && !this.#closed && !signal.aborted) this.#prepared = prepared.value;
      return prepared.ok ? ok(prepared.value.request) : prepared;
    } finally { this.#busy = false; }
  }

  async resolveBooking(_scope: LocationScope, _verificationRef: string, _offerRef: string,
                       _now: string): Promise<Result<Extract<ActionRequest, { kind: "book" }>, HostReadFailure>> {
    return err({ kind: "unavailable", target: "offer" });
  }

  async write(mutation: HostMutation, now: string, signal?: AbortSignal): Promise<HostWriteReceipt> {
    const reject = (): HostWriteReceipt =>
      ({ kind: "rejected", actionKey: mutation.actionKey, reason: "forbidden" });
    const prepared = this.#prepared;
    if (this.#closed || this.#busy || this.#attempt || !prepared ||
        (mutation.kind !== "cancel" && mutation.kind !== "reschedule") ||
        mutation.request.kind !== prepared.request.kind || mutation.kind !== prepared.request.kind ||
        !validScope(mutation.scope) || !sameScope(mutation.scope, this.#scope) ||
        mutation.policyVersion !== this.#policyVersion ||
        mutation.payloadDigest !== digestActionRequest(prepared.request) ||
        digestActionRequest(mutation.request) !== mutation.payloadDigest ||
        !refPattern.test(mutation.actionKey)) return reject();
    this.#attempt = { actionKey: mutation.actionKey, digest: mutation.payloadDigest, prepared };
    const combined = signal
      ? AbortSignal.any([this.#lifetime.signal, signal, AbortSignal.timeout(15_000)])
      : AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(15_000)]);
    let current: number;
    try { current = Date.parse(this.#clock()); } catch { return reject(); }
    if (!Number.isFinite(current) || !await this.#guard.authorize(prepared, mutation, now, combined)) return reject();
    let result: Awaited<ReturnType<ClinikoCancellationWriter["cancelOnce"]>> |
      Awaited<ReturnType<ClinikoRescheduleWriter["rescheduleOnce"]>>;
    try {
      if (prepared.request.kind === "cancel" && "cancellationReason" in prepared.provider) {
        result = await this.#cancellation.cancelOnce(prepared.provider, combined);
      } else if (prepared.request.kind === "reschedule" && "newStartsAt" in prepared.provider) {
        result = await this.#rescheduling.rescheduleOnce(prepared.provider, combined);
      } else return reject();
    } catch {
      return { kind: "uncertain", actionKey: mutation.actionKey, reconcileAfter: now,
        deadline: new Date(current + 5 * 60_000).toISOString() };
    }
    if (this.#closed || combined.aborted || !result.ok && result.error.kind === "unavailable") {
      return { kind: "uncertain", actionKey: mutation.actionKey, reconcileAfter: now,
        deadline: new Date(current + 5 * 60_000).toISOString() };
    }
    if (!result.ok) return { kind: "unsupported", actionKey: mutation.actionKey };
    if (result.value.kind === "movedWithConflict") this.#conflictObserved = true;
    if (result.value.kind === "cancelled" || result.value.kind === "moved") {
      return { kind: "committed", actionKey: mutation.actionKey,
        hostRef: prepared.provider.appointmentId };
    }
    return { kind: "uncertain", actionKey: mutation.actionKey, reconcileAfter: now,
      deadline: new Date(current + 5 * 60_000).toISOString() };
  }

  async reconcile(mutation: HostMutation, signal?: AbortSignal): Promise<ReconcileObservation> {
    const unknown: ReconcileObservation = { kind: "stillUnknown", actionKey: mutation.actionKey };
    const attempt = this.#attempt;
    if (this.#closed || this.#conflictObserved || !attempt || mutation.kind !== attempt.prepared.request.kind ||
        attempt.actionKey !== mutation.actionKey || attempt.digest !== mutation.payloadDigest ||
        !validScope(mutation.scope) || !sameScope(mutation.scope, this.#scope) ||
        mutation.policyVersion !== this.#policyVersion ||
        digestActionRequest(mutation.request) !== attempt.digest) return unknown;
    const combined = signal
      ? AbortSignal.any([this.#lifetime.signal, signal, AbortSignal.timeout(15_000)])
      : AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(15_000)]);
    if (!await this.#guard.mayObserve(attempt.prepared, mutation, combined)) return unknown;
    try {
      if (mutation.kind === "cancel" && attempt.prepared.provider &&
          "cancellationReason" in attempt.prepared.provider) {
        const observed = await this.#cancellation.observe(attempt.prepared.provider, combined);
        return !this.#closed && !combined.aborted && observed.ok && observed.value.kind === "cancelled"
          ? { kind: "exactCommit", actionKey: mutation.actionKey,
            hostRef: attempt.prepared.provider.appointmentId } : unknown;
      }
      if (mutation.kind === "reschedule" && "newStartsAt" in attempt.prepared.provider) {
        const observed = await this.#rescheduling.observeReschedule(attempt.prepared.provider, combined);
        return !this.#closed && !combined.aborted && observed.ok && observed.value.kind === "new"
          ? { kind: "exactCommit", actionKey: mutation.actionKey,
            hostRef: attempt.prepared.provider.appointmentId } : unknown;
      }
    } catch { /* Unknown results never authorize another PATCH. */ }
    return unknown;
  }

  dispose(): void {
    this.#closed = true;
    this.#lifetime.abort();
    this.#prepared = undefined;
    this.#guard.dispose();
  }

  openTask(item: StaffItem, signal?: AbortSignal): Promise<StaffTaskReceipt> {
    return this.#staff.openTask(item, signal);
  }

  reconcileTask(item: StaffItem, signal?: AbortSignal): Promise<StaffTaskObservation> {
    return this.#staff.reconcileTask(item, signal);
  }
}
