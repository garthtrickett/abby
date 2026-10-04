import { ClinikoBookingWriter } from "../cliniko/booking-write.ts";
import { digestActionRequest } from "../core/digest.ts";
import type { HostReadFailure, PolicyStore } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { CallState, HostMutation, LocationScope, Result } from "../core/model.ts";
import { sameScope, validClinikoId } from "./appointment-change-authority.ts";
import { sameClinikoBookingEvidence, validClinikoBookingEvidence } from "./cliniko-booking-authority.ts";
import type { ClinikoBookingAuthority, ClinikoBookingQuery, PreparedClinikoBooking } from "./cliniko-booking-authority.ts";
import { approvalInstant, approvalRef } from "./owner-file-clinic-approval.ts";
import { TransientPatientProofHost } from "./transient-patient-proof.ts";

export type ClinikoBookingGuardConfig = Readonly<{
  scope: LocationScope; callId: string; sessionId: string; policyVersion: string; ledger: LedgerStore;
  policy: PolicyStore; proof: TransientPatientProofHost; authority: ClinikoBookingAuthority;
  writer: ClinikoBookingWriter; clock?: () => string;
}>;
async function untilAbort<Value>(pending: Promise<Value>, signal: AbortSignal): Promise<Value | undefined> {
  if (signal.aborted) { void pending.catch(() => undefined); return undefined; }
  let onAbort: () => void = () => undefined;
  const stopped = new Promise<undefined>(resolve => { onAbort = () => resolve(undefined); signal.addEventListener("abort", onAbort, { once: true }); });
  try { return await Promise.race([pending, stopped]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

/** Live confirmation/proof/current policy checks for the declared standalone best-effort contract. */
export class ClinikoBookingGuard {
  readonly #config: ClinikoBookingGuardConfig;
  #closed = false;
  constructor(config: ClinikoBookingGuardConfig) {
    if (!config.scope || ![config.scope.tenantId, config.scope.clinicId, config.scope.locationId,
      config.callId, config.sessionId, config.policyVersion].every(approvalRef) ||
        !(config.writer instanceof ClinikoBookingWriter) || !(config.proof instanceof TransientPatientProofHost) ||
        !config.proof.matchesCall(config.scope, config.callId, config.sessionId, config.policyVersion) ||
        typeof config.ledger?.read !== "function" || typeof config.ledger?.readWriteStop !== "function" ||
        typeof config.policy?.read !== "function" || typeof config.authority?.resolve !== "function" ||
        !sameScope(config.writer.selection().scope, config.scope) || (config.clock !== undefined && typeof config.clock !== "function")) {
      throw new TypeError("invalid Cliniko booking guard configuration");
    }
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) });
  }
  #time(now: string): number | undefined {
    try {
      const actual = approvalInstant((this.#config.clock ?? (() => new Date().toISOString()))()), supplied = approvalInstant(now);
      return actual !== undefined && supplied !== undefined && Math.abs(actual - supplied) <= 30_000 ? actual : undefined;
    } catch { return undefined; }
  }
  async #active(now: number, signal: AbortSignal): Promise<CallState | undefined> {
    const config = this.#config;
    const found = await untilAbort(config.ledger.read(config.callId, config.scope), signal);
    if (!found?.ok || this.#closed || signal.aborted || found.value.callId !== config.callId || found.value.lifecycle !== "active" ||
        !found.value.admission || !sameScope(found.value.policy.scope, config.scope) || found.value.policy.policyVersion !== config.policyVersion ||
        found.value.sessionLease?.sessionId !== config.sessionId || approvalInstant(found.value.sessionLease.expiresAt) === undefined ||
        Date.parse(found.value.sessionLease.expiresAt) <= now) return undefined;
    return found.value;
  }
  async #ready(now: number, signal: AbortSignal, mutation?: HostMutation): Promise<boolean> {
    const config = this.#config, state = await this.#active(now, signal);
    if (!state || !state.policy.automationEnabled || !state.policy.bookingEnabled || !state.policy.staffWorkEnabled || state.policy.capabilities.book !== "execute") return false;
    if (mutation) {
      const action = state.actions[mutation.actionKey], effect = state.effects[`${mutation.actionKey}:write`];
      if (action?.kind !== "book" || action.status !== "dispatched" || action.digest !== mutation.payloadDigest ||
          action.mutation.policyVersion !== config.policyVersion || digestActionRequest(action.mutation.request) !== mutation.payloadDigest ||
          state.presentations[action.presentationId]?.status !== "played" || effect?.kind !== "hostWrite" || effect.status !== "possiblySent" ||
          effect.mutation.actionKey !== mutation.actionKey || effect.mutation.payloadDigest !== mutation.payloadDigest) return false;
    }
    const stop = await untilAbort(config.ledger.readWriteStop(config.scope), signal);
    const current = await untilAbort(config.policy.read(config.scope), signal);
    const finalTime = this.#time(new Date(now).toISOString());
    return finalTime !== undefined && Date.parse(state.sessionLease!.expiresAt) > finalTime && !!stop?.ok && !stop.value.stopped && !!current?.ok && !this.#closed && !signal.aborted &&
      sameScope(current.value.scope, config.scope) && current.value.policyVersion === config.policyVersion &&
      current.value.automationEnabled && current.value.bookingEnabled && current.value.staffWorkEnabled === true && current.value.capabilities.book === "execute";
  }
  async resolve(scope: LocationScope, verificationRef: string, offerRef: string, now: string, phase: "proposal" | "commit",
    signal: AbortSignal): Promise<Result<PreparedClinikoBooking, HostReadFailure>> {
    const denied = (): Result<PreparedClinikoBooking, HostReadFailure> => err({ kind: "unavailable", target: "offer" });
    const config = this.#config, at = this.#time(now);
    try {
      if (this.#closed || signal.aborted || !sameScope(scope, config.scope) || !/^[A-Za-z0-9:_-]{1,256}$/.test(verificationRef) || !/^[A-Za-z0-9:_-]{1,256}$/.test(offerRef) ||
          (phase !== "proposal" && phase !== "commit") || at === undefined || !await this.#ready(at, signal)) return denied();
      const patient = await untilAbort(config.proof.verifyOperation(scope, verificationRef, "appointments.book", now, signal), signal);
      if (!patient?.ok || !validClinikoId(patient.value.patientRef) || this.#closed || signal.aborted) return err({ kind: "notFound", target: "patient" });
      const query: ClinikoBookingQuery = Object.freeze({ scope: Object.freeze({ ...config.scope }), callId: config.callId, sessionId: config.sessionId, policyVersion: config.policyVersion,
        patientId: patient.value.patientRef, verificationRef, offerRef, phase, now, signal });
      const evidence = await untilAbort(Promise.resolve().then(() => config.authority.resolve(query)), signal);
      const selected = evidence?.ok ? structuredClone(evidence.value) : undefined;
      const fresh = this.#time(now);
      if (!selected || this.#closed || signal.aborted || fresh === undefined ||
          !validClinikoBookingEvidence(selected, { ...query, now: new Date(fresh).toISOString() }, config.writer.selection(), config.writer.credentialFingerprint()) ||
          Date.parse(patient.value.expiresAt) <= fresh || !await this.#ready(fresh, signal)) return denied();
      const finalPatient = await untilAbort(config.proof.verifyOperation(scope, verificationRef, "appointments.book", now, signal), signal);
      const request = { kind: "book" as const, patient: patient.value, offer: selected.offer };
      const finalTime = this.#time(now);
      if (!finalPatient?.ok || this.#closed || signal.aborted || finalTime === undefined || Date.parse(request.patient.expiresAt) <= finalTime ||
          Date.parse(request.offer.expiresAt) <= finalTime || Date.parse(request.offer.startsAt) <= finalTime ||
          digestActionRequest({ ...request, patient: finalPatient.value }) !== digestActionRequest(request)) return denied();
      const { phase: _phase, signal: _signal, ...bound } = query;
      return ok({ request: structuredClone(request), query: structuredClone(bound), evidence: selected });
    } catch { return denied(); }
  }
  async authorize(prepared: PreparedClinikoBooking, mutation: HostMutation, now: string, signal: AbortSignal): Promise<boolean> {
    try {
      const at = this.#time(now);
      if (at === undefined || !await this.#ready(at, signal, mutation)) return false;
      const fresh = await this.resolve(this.#config.scope, prepared.query.verificationRef, prepared.query.offerRef, now, "commit", signal);
      const current = this.#time(now);
      if (!fresh.ok || current === undefined || this.#closed || signal.aborted || digestActionRequest(fresh.value.request) !== mutation.payloadDigest ||
          !sameClinikoBookingEvidence(fresh.value.evidence, prepared.evidence) || !await this.#ready(current, signal, mutation)) return false;
      const finalTime = this.#time(now);
      return finalTime !== undefined && Date.parse(prepared.request.patient.expiresAt) > finalTime &&
        Date.parse(prepared.request.offer.expiresAt) > finalTime && Date.parse(prepared.request.offer.startsAt) > finalTime && !this.#closed && !signal.aborted;
    } catch { return false; }
  }
  /** Protect result inspection without demanding that the just-booked slot remain available. */
  async mayInspect(prepared: PreparedClinikoBooking, mutation: HostMutation, now: string, signal: AbortSignal): Promise<boolean> {
    try {
      const at = this.#time(now); if (at === undefined || !await this.#ready(at, signal, mutation)) return false;
      const proof = await untilAbort(this.#config.proof.verifyOperation(this.#config.scope, prepared.query.verificationRef, "appointments.book", now, signal), signal);
      const finalTime = this.#time(now);
      return !!proof?.ok && finalTime !== undefined && Date.parse(proof.value.expiresAt) > finalTime &&
        proof.value.patientRef === prepared.request.patient.patientRef && !this.#closed && !signal.aborted;
    } catch { return false; }
  }
  dispose(): void { this.#closed = true; }
}
