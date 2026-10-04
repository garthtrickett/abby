import { ClinikoCancellationWriter } from "../cliniko/cancellation-write.ts";
import { ClinikoRescheduleWriter } from "../cliniko/reschedule-write.ts";
import { digestActionRequest } from "../core/digest.ts";
import type { AppointmentChangeEvidenceQuery, HostReadFailure, PolicyStore } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { CallState, HostMutation, LocationScope, Result } from "../core/model.ts";
import { appointmentChangeEvidenceFailure } from "../core/transition.ts";
import { providerRequest, sameProviderRequest, sameScope, validClinikoId } from "./appointment-change-authority.ts";
import type { AppointmentChangeAuthority, AppointmentChangeRequest as Change, ClinikoChangeProviderRequest } from "./appointment-change-authority.ts";
import { TransientPatientProofHost } from "./transient-patient-proof.ts";

type Kind = Change["kind"];

export type ClinikoAppointmentChangeGuardConfig = Readonly<{
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
  rescheduling?: ClinikoRescheduleWriter;
  clock?: () => string;
}>;

export type PreparedClinikoChange = Readonly<{
  request: Change;
  selection: AppointmentChangeEvidenceQuery;
  provider: ClinikoChangeProviderRequest;
}>;
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

/** Trusted per-call appointment evidence and commit checks, shared by both host contracts. */
export class ClinikoAppointmentChangeGuard {
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
  readonly #rescheduling: ClinikoRescheduleWriter | undefined;
  readonly #clock: () => string;
  #closed = false;
  constructor(config: ClinikoAppointmentChangeGuardConfig) {
    if (!validScope(config.scope) ||
        ![config.callId, config.sessionId, config.policyVersion, config.businessId].every(value =>
          typeof value === "string" && refPattern.test(value)) || !validClinikoId(config.businessId) ||
        typeof config.credentialFingerprint !== "string" ||
        !/^[0-9a-f]{64}$/.test(config.credentialFingerprint) ||
        !config.ledger || typeof config.ledger.read !== "function" ||
        typeof config.ledger.readWriteStop !== "function" ||
        !config.policy || typeof config.policy.read !== "function" ||
        !(config.proof instanceof TransientPatientProofHost) ||
        !config.proof.matchesCall(config.scope, config.callId, config.sessionId, config.policyVersion) ||
        !config.authority || typeof config.authority.resolve !== "function" ||
        !(config.cancellation instanceof ClinikoCancellationWriter) ||
        (config.rescheduling !== undefined && !(config.rescheduling instanceof ClinikoRescheduleWriter)) ||
        (config.clock !== undefined && typeof config.clock !== "function")) {
      throw new TypeError("invalid appointment change guard configuration");
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
    const cancelSelection = this.#cancellation.selection();
    const moveSelection = this.#rescheduling?.selection();
    if (!sameScope(cancelSelection.scope, this.#scope) ||
        (moveSelection !== undefined && !sameScope(moveSelection.scope, this.#scope)) ||
        cancelSelection.businessId !== this.#businessId ||
        (moveSelection !== undefined && moveSelection.businessId !== this.#businessId) ||
        cancelSelection.credentialFingerprint !== this.#credentialFingerprint ||
        (moveSelection !== undefined && moveSelection.credentialFingerprint !== this.#credentialFingerprint)) {
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

  async resolve(incoming: AppointmentChangeEvidenceQuery, phase: "proposal" | "commit",
                 signal: AbortSignal): Promise<Result<PreparedClinikoChange, HostReadFailure>> {
    const query = incoming && { ...incoming, scope: { ...incoming.scope } };
    if ((phase !== "proposal" && phase !== "commit") || !query || !validScope(query.scope) || !sameScope(query.scope, this.#scope) ||
        query.callId !== this.#callId || query.sessionId !== this.#sessionId || query.policyVersion !== this.#policyVersion ||
        ![query.verificationRef, query.targetRef].every(value => typeof value === "string" && refPattern.test(value)) ||
        (query.kind !== "cancel" && query.kind !== "reschedule") ||
        (query.kind === "reschedule" && (!this.#rescheduling || !refPattern.test(query.offerRef)))) {
      return err({ kind: "notFound", target: "appointment" });
    }
    const now = this.#time(query.now);
    if (now === undefined || this.#closed || signal.aborted || !await this.#ready(query.kind, now, signal)) {
      return err({ kind: "unavailable", target: "appointment" });
    }
    try {
      const patient = await untilAbort(this.#proof.verifyOperation(this.#scope,
        query.verificationRef, query.kind === "cancel" ? "appointments.cancel" : "appointments.reschedule",
        query.now, signal), signal);
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
      const selected = structuredClone(evidence.value);
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
            ? await this.#rescheduling?.observeReschedule(provider, signal) : undefined;
        if (!observed?.ok || observed.value.kind !== (request.kind === "cancel" ? "active" : "old") ||
            this.#closed || signal.aborted) {
          return err({ kind: "unavailable", target: "appointment" });
        }
      }
      const finalPatient = await untilAbort(this.#proof.verifyOperation(this.#scope,
        query.verificationRef, query.kind === "cancel" ? "appointments.cancel" : "appointments.reschedule",
        query.now, signal), signal);
      if (!finalPatient?.ok || this.#closed || signal.aborted ||
          digestActionRequest({ ...request, patient: finalPatient.value }) !== digestActionRequest(request)) {
        return err({ kind: "notFound", target: "patient" });
      }
      return ok({ request: structuredClone(request), selection: structuredClone(query),
        provider: structuredClone(provider) });
    } catch { return err({ kind: "unavailable", target: "appointment" }); }
  }

  /** Recheck played confirmation, exact SAM dispatch, proof, current policy/terms and emergency stop. */
  async authorize(prepared: PreparedClinikoChange, mutation: HostMutation, now: string, signal: AbortSignal): Promise<boolean> {
    const current = this.#time(now);
    if (current === undefined || signal.aborted || !await this.#ready(prepared.request.kind, current, signal, mutation)) return false;
    const fresh = await this.resolve({ ...prepared.selection, now }, "commit", signal);
    const at = this.#time(now);
    return fresh.ok && at !== undefined && !signal.aborted && !this.#closed &&
      digestActionRequest(fresh.value.request) === mutation.payloadDigest &&
      sameProviderRequest(fresh.value.provider, prepared.provider) && Date.parse(prepared.request.terms.expiresAt) > at &&
      await this.#ready(prepared.request.kind, at, signal, mutation);
  }

  /** Protected read-back while the original SAM write is dispatched; a moved source need not still be old. */
  async mayInspect(prepared: PreparedClinikoChange, mutation: HostMutation, now: string, signal: AbortSignal): Promise<boolean> {
    try {
      const at = this.#time(now);
      if (at === undefined || !await this.#ready(prepared.request.kind, at, signal, mutation)) return false;
      const patient = await untilAbort(this.#proof.verifyOperation(this.#scope, prepared.request.patient.verificationRef,
        prepared.request.kind === "cancel" ? "appointments.cancel" : "appointments.reschedule", this.#clock(), signal), signal);
      const fresh = this.#time(now);
      return !!patient?.ok && patient.value.patientRef === prepared.provider.patientId && !signal.aborted && !this.#closed &&
        fresh !== undefined && Date.parse(patient.value.expiresAt) > fresh && await this.#ready(prepared.request.kind, fresh, signal, mutation);
    } catch { return false; }
  }

  async mayObserve(prepared: PreparedClinikoChange, mutation: HostMutation, signal: AbortSignal): Promise<boolean> {
    let now: string;
    try { now = this.#clock(); } catch { return false; }
    const at = this.#time(now), state = at === undefined ? undefined : await this.#active(at, signal);
    const action = state?.actions[mutation.actionKey], effect = state?.effects[`${mutation.actionKey}:write`];
    if (!state || action?.status !== "uncertain" || action.digest !== mutation.payloadDigest ||
        effect?.kind !== "hostWrite" || effect.status !== "uncertain" ||
        effect.mutation.payloadDigest !== mutation.payloadDigest) return false;
    const patient = await untilAbort(this.#proof.verifyOperation(this.#scope,
      prepared.request.patient.verificationRef,
      mutation.kind === "cancel" ? "appointments.cancel" : "appointments.reschedule", now, signal), signal);
    return !!patient?.ok && patient.value.patientRef === prepared.provider.patientId && !this.#closed && !signal.aborted;
  }

  dispose(): void { this.#closed = true; this.#proof.dispose(); }
}
