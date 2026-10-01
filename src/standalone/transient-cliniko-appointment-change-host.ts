import { ClinikoCancellationWriter } from "../cliniko/cancellation-write.ts";
import { ClinikoRescheduleWriter } from "../cliniko/reschedule-write.ts";
import type { ClinikoCancellationRequest, ClinikoRescheduleRequest } from "../cliniko/appointment-write.ts";
import { digestActionRequest } from "../core/digest.ts";
import type { AppointmentChangeEvidenceHost, AppointmentChangeEvidenceQuery, BookingEvidenceHost, HostEffects,
  HostReadFailure, PolicyStore } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { ActionRequest, CallState, HostMutation, HostWriteReceipt, LocationScope,
  ReconcileObservation, Result, StaffItem, StaffTaskObservation, StaffTaskReceipt } from "../core/model.ts";
import { appointmentChangeEvidenceFailure } from "../core/transition.ts";
import { providerRequest, sameProviderRequest, sameScope, validClinikoId } from "./appointment-change-authority.ts";
import type { AppointmentChangeAuthority, AppointmentChangeRequest as Change,
  ClinikoChangeProviderRequest } from "./appointment-change-authority.ts";
import { NoStoredKnowledge } from "./no-stored-knowledge.ts";
import { TransientPatientProofHost } from "./transient-patient-proof.ts";

type Kind = Change["kind"];

export type TransientClinikoAppointmentChangeConfig = Readonly<{
  scope: LocationScope;
  callId: string;
  sessionId: string;
  policyVersion: string;
  ledger: LedgerStore;
  policy: PolicyStore;
  proof: TransientPatientProofHost;
  authority: AppointmentChangeAuthority;
  businessId: string;
  credentialFingerprint: string;
  cancellation: ClinikoCancellationWriter;
  rescheduling: ClinikoRescheduleWriter;
  /** An embedded buyer must provide a patient-specific queue for uncertain outcomes. */
  staff: Pick<HostEffects, "openTask" | "reconcileTask">;
  clock?: () => string;
}>;

type Prepared = Readonly<{
  request: Change;
  selection: AppointmentChangeEvidenceQuery;
  provider: ClinikoChangeProviderRequest;
}>;
type Attempt = Readonly<{ actionKey: string; digest: string; prepared: Prepared }>;
const refPattern = /^[A-Za-z0-9:_-]{1,256}$/;

function validScope(value: unknown): value is LocationScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  return [scope.tenantId, scope.clinicId, scope.locationId].every(part =>
    typeof part === "string" && !!part.trim() && part.length <= 256);
}

function instant(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function untilAbort<Value>(pending: Promise<Value>, signal: AbortSignal): Promise<Value | undefined> {
  if (signal.aborted) { void pending.catch(() => undefined); return undefined; }
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<undefined>(resolve => {
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([pending, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

/** One call and session own one process-local appointment change. Not constructed by the standalone runner. */
export class TransientClinikoAppointmentChangeHost extends NoStoredKnowledge
  implements AppointmentChangeEvidenceHost, BookingEvidenceHost, HostEffects {
  readonly #scope: LocationScope;
  readonly #callId: string;
  readonly #sessionId: string;
  readonly #policyVersion: string;
  readonly #ledger: LedgerStore;
  readonly #policy: PolicyStore;
  readonly #proof: TransientPatientProofHost;
  readonly #authority: AppointmentChangeAuthority;
  readonly #businessId: string;
  readonly #credentialFingerprint: string;
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
    if (!validScope(config.scope) ||
        ![config.callId, config.sessionId, config.policyVersion, config.businessId].every(value =>
          typeof value === "string" && refPattern.test(value)) || !validClinikoId(config.businessId) ||
        typeof config.credentialFingerprint !== "string" ||
        !/^[0-9a-f]{64}$/.test(config.credentialFingerprint) ||
        !config.ledger || typeof config.ledger.read !== "function" ||
        typeof config.ledger.readWriteStop !== "function" ||
        !config.policy || typeof config.policy.read !== "function" ||
        !(config.proof instanceof TransientPatientProofHost) ||
        !config.authority || typeof config.authority.resolve !== "function" ||
        !(config.cancellation instanceof ClinikoCancellationWriter) ||
        !(config.rescheduling instanceof ClinikoRescheduleWriter) ||
        !config.staff || typeof config.staff.openTask !== "function" ||
        typeof config.staff.reconcileTask !== "function" ||
        (config.clock !== undefined && typeof config.clock !== "function")) {
      throw new TypeError("invalid transient appointment change host configuration");
    }
    this.#scope = Object.freeze(structuredClone(config.scope));
    this.#callId = config.callId;
    this.#sessionId = config.sessionId;
    this.#policyVersion = config.policyVersion;
    this.#ledger = config.ledger;
    this.#policy = config.policy;
    this.#proof = config.proof;
    this.#authority = config.authority;
    this.#businessId = config.businessId;
    this.#credentialFingerprint = config.credentialFingerprint;
    this.#cancellation = config.cancellation;
    this.#rescheduling = config.rescheduling;
    this.#staff = config.staff;
    const cancelSelection = this.#cancellation.selection();
    const moveSelection = this.#rescheduling.selection();
    if (!sameScope(cancelSelection.scope, this.#scope) ||
        !sameScope(moveSelection.scope, this.#scope) ||
        cancelSelection.businessId !== this.#businessId ||
        moveSelection.businessId !== this.#businessId ||
        cancelSelection.credentialFingerprint !== this.#credentialFingerprint ||
        moveSelection.credentialFingerprint !== this.#credentialFingerprint) {
      throw new TypeError("appointment change writer selection mismatch");
    }
    this.#clock = config.clock ?? (() => new Date().toISOString());
  }

  #time(now: string): number | undefined {
    let actual: number | undefined;
    try { actual = instant(this.#clock()); } catch { return undefined; }
    const supplied = instant(now);
    return actual !== undefined && supplied !== undefined && Math.abs(actual - supplied) <= 30_000
      ? actual : undefined;
  }

  async #active(now: number, signal: AbortSignal): Promise<CallState | undefined> {
    if (this.#closed || signal.aborted) return undefined;
    try {
      const state = await untilAbort(this.#ledger.read(this.#callId, this.#scope), signal);
      const leaseExpiry = instant(state?.ok ? state.value.sessionLease?.expiresAt : undefined);
      return state?.ok && !this.#closed && !signal.aborted && state.value.lifecycle === "active" &&
        !!state.value.admission && state.value.callId === this.#callId &&
        sameScope(state.value.policy.scope, this.#scope) &&
        state.value.policy.policyVersion === this.#policyVersion &&
        state.value.sessionLease?.sessionId === this.#sessionId &&
        leaseExpiry !== undefined && leaseExpiry > now ? state.value : undefined;
    } catch { return undefined; }
  }

  async #ready(kind: Kind, now: number, signal: AbortSignal, mutation?: HostMutation): Promise<boolean> {
    const state = await this.#active(now, signal);
    if (!state || !state.policy.automationEnabled || !state.policy.staffWorkEnabled ||
        state.policy.capabilities[kind] !== "execute") return false;
    if (mutation) {
      const action = state.actions[mutation.actionKey];
      const effect = state.effects[`${mutation.actionKey}:write`];
      if (action?.status !== "dispatched" || action.kind !== kind ||
          action.digest !== mutation.payloadDigest ||
          action.mutation.policyVersion !== mutation.policyVersion ||
          digestActionRequest(action.mutation.request) !== mutation.payloadDigest ||
          state.presentations[action.presentationId]?.status !== "played" ||
          effect?.kind !== "hostWrite" || effect.status !== "possiblySent" ||
          effect.mutation.actionKey !== mutation.actionKey ||
          effect.mutation.payloadDigest !== mutation.payloadDigest) return false;
      const stop = await untilAbort(this.#ledger.readWriteStop(this.#scope), signal);
      if (!stop?.ok || stop.value.stopped || this.#closed || signal.aborted) return false;
    }
    try {
      const current = await untilAbort(this.#policy.read(this.#scope), signal);
      return !!current?.ok && !this.#closed && !signal.aborted &&
        sameScope(current.value.scope, this.#scope) &&
        current.value.policyVersion === this.#policyVersion &&
        current.value.automationEnabled === true && current.value.staffWorkEnabled === true &&
        current.value.capabilities[kind] === "execute";
    } catch { return false; }
  }

  async #resolve(query: AppointmentChangeEvidenceQuery, phase: "proposal" | "commit",
                 signal: AbortSignal): Promise<Result<Prepared, HostReadFailure>> {
    const now = this.#time(query.now);
    if (now === undefined || this.#closed || signal.aborted || !await this.#ready(query.kind, now, signal)) {
      return err({ kind: "unavailable", target: "appointment" });
    }
    try {
      const patient = await untilAbort(this.#proof.verifyOperation(this.#scope,
        query.verificationRef, query.kind === "cancel" ? "appointments.cancel" : "appointments.reschedule",
        query.now), signal);
      if (!patient?.ok || this.#closed || signal.aborted || !validClinikoId(patient.value.patientRef)) {
        return err({ kind: "notFound", target: "patient" });
      }
      const evidence = await untilAbort(Promise.resolve().then(() => this.#authority.resolve({
        ...query, patientId: patient.value.patientRef, phase, signal,
      })), signal);
      if (!evidence?.ok || this.#closed || signal.aborted) {
        return err({ kind: evidence?.ok === false && evidence.error.kind === "ambiguous"
          ? "ambiguous" : "unavailable", target: "appointment" });
      }
      const selected = evidence.value;
      if (!validScope(selected.scope) || !sameScope(selected.scope, this.#scope) ||
          selected.callId !== this.#callId || selected.sessionId !== this.#sessionId ||
          selected.policyVersion !== this.#policyVersion || selected.patientId !== patient.value.patientRef ||
          selected.targetRef !== query.targetRef || selected.kind !== query.kind ||
          selected.businessId !== this.#businessId ||
          selected.credentialFingerprint !== this.#credentialFingerprint ||
          (query.kind === "reschedule" && (selected.kind !== "reschedule" ||
            selected.offer.offerRef !== query.offerRef))) {
        return err({ kind: "unavailable", target: "appointment" });
      }
      const request: Change = selected.kind === "cancel"
        ? { kind: "cancel", patient: patient.value, target: selected.target, terms: selected.terms }
        : { kind: "reschedule", patient: patient.value, target: selected.target,
          offer: selected.offer, terms: selected.terms };
      const provider = providerRequest(request, selected, this.#scope);
      const fresh = this.#time(query.now);
      if (!provider || appointmentChangeEvidenceFailure(this.#scope, request, query.now) ||
          fresh === undefined || instant(patient.value.expiresAt)! <= fresh ||
          Date.parse(request.terms.expiresAt) <= fresh ||
          !await this.#ready(query.kind, fresh, signal)) {
        return err({ kind: "unavailable", target: "appointment" });
      }
      if (phase === "proposal") {
        const observed = request.kind === "cancel" && "cancellationReason" in provider
          ? await this.#cancellation.observe(provider, signal)
          : request.kind === "reschedule" && "newStartsAt" in provider
            ? await this.#rescheduling.observeReschedule(provider, signal) : undefined;
        if (!observed?.ok || observed.value.kind !== (request.kind === "cancel" ? "active" : "old") ||
            this.#closed || signal.aborted) {
          return err({ kind: "unavailable", target: "appointment" });
        }
      }
      const finalPatient = await untilAbort(this.#proof.verifyOperation(this.#scope,
        query.verificationRef, query.kind === "cancel" ? "appointments.cancel" : "appointments.reschedule",
        query.now), signal);
      if (!finalPatient?.ok || this.#closed || signal.aborted ||
          digestActionRequest({ ...request, patient: finalPatient.value }) !== digestActionRequest(request)) {
        return err({ kind: "notFound", target: "patient" });
      }
      return ok({ request: structuredClone(request), selection: structuredClone(query),
        provider: structuredClone(provider) });
    } catch { return err({ kind: "unavailable", target: "appointment" }); }
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
      const prepared = await this.#resolve(query, "proposal", signal);
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
    const current = this.#time(now);
    if (current === undefined || combined.aborted ||
        !await this.#ready(prepared.request.kind, current, combined, mutation)) return reject();
    const fresh = await this.#resolve({ ...prepared.selection, now }, "commit", combined);
    const commitTime = this.#time(now);
    if (!fresh.ok || commitTime === undefined || combined.aborted || this.#closed ||
        digestActionRequest(fresh.value.request) !== this.#attempt.digest ||
        !sameProviderRequest(fresh.value.provider, prepared.provider) ||
        Date.parse(prepared.request.terms.expiresAt) <= commitTime ||
        !await this.#ready(prepared.request.kind, commitTime, combined, mutation)) return reject();
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
    let now: string;
    try { now = this.#clock(); } catch { return unknown; }
    const at = this.#time(now);
    const state = at === undefined ? undefined : await this.#active(at, combined);
    const action = state?.actions[mutation.actionKey];
    const effect = state?.effects[`${mutation.actionKey}:write`];
    if (!state || action?.status !== "uncertain" || action.digest !== attempt.digest ||
        effect?.kind !== "hostWrite" || effect.status !== "uncertain" ||
        effect.mutation.payloadDigest !== attempt.digest) return unknown;
    const patient = await untilAbort(this.#proof.verifyOperation(this.#scope,
      attempt.prepared.request.patient.verificationRef,
      mutation.kind === "cancel" ? "appointments.cancel" : "appointments.reschedule", now), combined);
    if (!patient?.ok || patient.value.patientRef !== attempt.prepared.provider.patientId ||
        this.#closed || combined.aborted) return unknown;
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
    this.#proof.dispose();
  }

  openTask(item: StaffItem, signal?: AbortSignal): Promise<StaffTaskReceipt> {
    return this.#staff.openTask(item, signal);
  }

  reconcileTask(item: StaffItem, signal?: AbortSignal): Promise<StaffTaskObservation> {
    return this.#staff.reconcileTask(item, signal);
  }
}
