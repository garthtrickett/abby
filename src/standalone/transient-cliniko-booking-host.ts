import { randomUUID } from "node:crypto";
import { ClinikoBookingWriter } from "../cliniko/booking-write.ts";
import type { ClinikoBookingRequest, ClinikoBookingSelection } from "../cliniko/booking-write.ts";
import { digestActionRequest } from "../core/digest.ts";
import type { BookingEvidenceHost, HostEffects, PolicyStore, HostReadFailure } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { ActionRequest, BookableOffer, CallState, HostMutation, HostWriteReceipt, LocationScope,
  ReconcileObservation, Result, StaffItem, StaffTaskObservation, StaffTaskReceipt } from "../core/model.ts";
import { NoStoredKnowledge } from "./no-stored-knowledge.ts";
import { TransientPatientProofHost } from "./transient-patient-proof.ts";

type BookingRequest = Extract<ActionRequest, { kind: "book" }>;

export type HostBookingOfferEvidence = Readonly<{
  scope: LocationScope;
  callId: string;
  sessionId: string;
  policyVersion: string;
  patientId: string;
  businessId: string;
  practitionerId: string;
  appointmentTypeId: string;
  offer: BookableOffer;
  /** A host must back this with an independently proven safe commit mechanism.
   * A Cliniko available-time response alone cannot grant this permit. */
  exclusiveCommitPermitted: boolean;
}>;

export type BookingOfferAuthority = Readonly<{
  /** Recheck the selected business, practitioner, appointment type and exclusive commit authority at both phases. */
  resolve(query: Readonly<{
    scope: LocationScope;
    callId: string;
    sessionId: string;
    policyVersion: string;
    patientId: string;
    offerRef: string;
    phase: "proposal" | "commit";
    signal: AbortSignal;
  }>): Promise<Result<HostBookingOfferEvidence, HostReadFailure>>;
}>;

export type TransientClinikoBookingConfig = Readonly<{
  scope: LocationScope;
  callId: string;
  sessionId: string;
  policyVersion: string;
  ledger: LedgerStore;
  policy: PolicyStore;
  proof: TransientPatientProofHost;
  offers: BookingOfferAuthority;
  writer: ClinikoBookingWriter;
  clock?: () => string;
}>;

type Attempt = Readonly<{ actionKey: string; digest: string; request: ClinikoBookingRequest }>;
const idPattern = /^[1-9][0-9]{0,18}$/;
const refPattern = /^[A-Za-z0-9:_-]{1,256}$/;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const appointmentInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId &&
    left.locationId === right.locationId;
}

function validScope(value: unknown): value is LocationScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  return [scope.tenantId, scope.clinicId, scope.locationId].every(part =>
    typeof part === "string" && !!part.trim() && part.length <= 256);
}

function instant(value: unknown): number | undefined {
  if (typeof value !== "string" || !instantPattern.test(value)) return undefined;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function appointmentInstant(value: unknown): number | undefined {
  if (typeof value !== "string" || !appointmentInstantPattern.test(value)) return undefined;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10) !== value.slice(0, 10)) {
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

/** One admitted call owns one volatile booking attempt. The live runner never constructs this host. */
export class TransientClinikoBookingHost extends NoStoredKnowledge implements BookingEvidenceHost, HostEffects {
  readonly #scope: LocationScope;
  readonly #callId: string;
  readonly #sessionId: string;
  readonly #policyVersion: string;
  readonly #ledger: LedgerStore;
  readonly #policy: PolicyStore;
  readonly #proof: TransientPatientProofHost;
  readonly #offers: BookingOfferAuthority;
  readonly #writer: ClinikoBookingWriter;
  readonly #selection: ClinikoBookingSelection;
  readonly #clock: () => string;
  #prepared: BookingRequest | undefined;
  #attempt: Attempt | undefined;
  #conflictObserved = false;
  #busy = false;
  #closed = false;
  readonly #lifetime = new AbortController();

  constructor(config: TransientClinikoBookingConfig) {
    super();
    if (!validScope(config.scope) || ![config.callId, config.sessionId, config.policyVersion].every(value =>
      typeof value === "string" && refPattern.test(value)) ||
      !config.ledger || typeof config.ledger.read !== "function" ||
      typeof config.ledger.readWriteStop !== "function" ||
      !config.policy || typeof config.policy.read !== "function" ||
      !(config.proof instanceof TransientPatientProofHost) ||
      !config.offers || typeof config.offers.resolve !== "function" ||
      !(config.writer instanceof ClinikoBookingWriter) ||
      (config.clock !== undefined && typeof config.clock !== "function")) {
      throw new TypeError("invalid transient booking host configuration");
    }
    this.#scope = Object.freeze(structuredClone(config.scope));
    this.#callId = config.callId;
    this.#sessionId = config.sessionId;
    this.#policyVersion = config.policyVersion;
    this.#ledger = config.ledger;
    this.#policy = config.policy;
    this.#proof = config.proof;
    this.#offers = config.offers;
    this.#writer = config.writer;
    this.#selection = config.writer.selection();
    if (!sameScope(this.#selection.scope, this.#scope)) {
      throw new TypeError("booking writer scope mismatch");
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

  async #activeState(now: number, signal: AbortSignal): Promise<CallState | undefined> {
    if (this.#closed || signal.aborted) return undefined;
    try {
      const state = await untilAbort(this.#ledger.read(this.#callId, this.#scope), signal);
      const leaseExpiry = instant(state?.ok ? state.value.sessionLease?.expiresAt : undefined);
      if (!state?.ok || this.#closed || signal.aborted || state.value.lifecycle !== "active" ||
          !state.value.admission || state.value.callId !== this.#callId ||
          !sameScope(state.value.policy.scope, this.#scope) ||
          state.value.policy.policyVersion !== this.#policyVersion ||
          state.value.sessionLease?.sessionId !== this.#sessionId ||
          leaseExpiry === undefined || leaseExpiry <= now) return undefined;
      return state.value;
    } catch { return undefined; }
  }

  async #callReady(now: number, signal: AbortSignal, mutation?: HostMutation): Promise<boolean> {
    const state = await this.#activeState(now, signal);
    if (!state || !state.policy.bookingEnabled || state.policy.capabilities.book !== "execute") return false;
    try {
      if (mutation) {
        const action = state.actions[mutation.actionKey];
        const effect = state.effects[`${mutation.actionKey}:write`];
        if (action?.status !== "dispatched" || action.digest !== mutation.payloadDigest ||
            action.mutation.policyVersion !== mutation.policyVersion ||
            digestActionRequest(action.mutation.request) !== mutation.payloadDigest ||
            state.presentations[action.presentationId]?.status !== "played" ||
            effect?.kind !== "hostWrite" || effect.status !== "possiblySent" ||
            effect.mutation.actionKey !== mutation.actionKey ||
            effect.mutation.payloadDigest !== mutation.payloadDigest) return false;
        const stop = await untilAbort(this.#ledger.readWriteStop(this.#scope), signal);
        if (!stop?.ok || stop.value.stopped || this.#closed || signal.aborted) return false;
      }
      const current = await untilAbort(this.#policy.read(this.#scope), signal);
      return !!current?.ok && !this.#closed && !signal.aborted &&
        sameScope(current.value.scope, this.#scope) &&
        current.value.policyVersion === this.#policyVersion && current.value.bookingEnabled === true &&
        current.value.capabilities.book === "execute";
    } catch { return false; }
  }

  async #evidence(verificationRef: string, offerRef: string, now: string,
                  phase: "proposal" | "commit", signal: AbortSignal):
    Promise<Result<BookingRequest, HostReadFailure>> {
    const nowMs = this.#time(now);
    if (nowMs === undefined || signal.aborted || this.#closed) return err({ kind: "unavailable", target: "offer" });
    if (!await this.#callReady(nowMs, signal)) return err({ kind: "unavailable", target: "offer" });
    try {
      const patient = await untilAbort(this.#proof.verifyOperation(this.#scope,
        verificationRef, "appointments.book", now), signal);
      if (!patient?.ok || this.#closed || signal.aborted ||
          !idPattern.test(patient.value.patientRef) ||
          !sameScope(patient.value.scope, this.#scope) ||
          instant(patient.value.expiresAt)! <= nowMs) {
        return err({ kind: "notFound", target: "patient" });
      }
      const host = await untilAbort(Promise.resolve().then(() => this.#offers.resolve({
        scope: this.#scope, callId: this.#callId, sessionId: this.#sessionId,
        policyVersion: this.#policyVersion, patientId: patient.value.patientRef,
        offerRef, phase, signal,
      })), signal);
      if (!host?.ok || this.#closed || signal.aborted) {
        return err({ kind: host?.ok === false && host.error.kind === "notFound" ? "notFound" : "unavailable",
          target: "offer" });
      }
      const evidence = host.value;
      const offer = evidence.offer;
      const freshMs = this.#time(now);
      if (!validScope(evidence.scope) || !sameScope(evidence.scope, this.#scope) ||
          evidence.callId !== this.#callId || evidence.sessionId !== this.#sessionId ||
          evidence.policyVersion !== this.#policyVersion ||
          evidence.patientId !== patient.value.patientRef ||
          evidence.businessId !== this.#selection.businessId ||
          evidence.practitionerId !== this.#selection.practitionerId ||
          evidence.appointmentTypeId !== this.#selection.appointmentTypeId ||
          evidence.exclusiveCommitPermitted !== true ||
          !offer || !validScope(offer.scope) || !sameScope(offer.scope, this.#scope) ||
          offer.offerRef !== offerRef || typeof offer.serviceRef !== "string" ||
          !offer.serviceRef.trim() || offer.serviceRef.length > 256 ||
          freshMs === undefined || instant(offer.expiresAt) === undefined ||
          instant(offer.expiresAt)! <= freshMs ||
          appointmentInstant(offer.startsAt) === undefined ||
          appointmentInstant(offer.startsAt)! <= freshMs ||
          instant(patient.value.expiresAt)! <= freshMs ||
          !await this.#callReady(freshMs, signal)) {
        return err({ kind: "unavailable", target: "offer" });
      }
      const finalPatient = await untilAbort(this.#proof.verifyOperation(this.#scope,
        verificationRef, "appointments.book", now), signal);
      if (!finalPatient?.ok || this.#closed || signal.aborted ||
          digestActionRequest({ kind: "book", patient: finalPatient.value, offer }) !==
          digestActionRequest({ kind: "book", patient: patient.value, offer })) {
        return err({ kind: "notFound", target: "patient" });
      }
      return ok({ kind: "book", patient: structuredClone(patient.value), offer: structuredClone(offer) });
    } catch { return err({ kind: "unavailable", target: "offer" }); }
  }

  async resolveBooking(scope: LocationScope, verificationRef: string, offerRef: string, now: string):
    Promise<Result<BookingRequest, HostReadFailure>> {
    if (this.#closed || this.#attempt || this.#busy || !validScope(scope) ||
        !sameScope(scope, this.#scope) || typeof verificationRef !== "string" ||
        !refPattern.test(verificationRef) || typeof offerRef !== "string" || !refPattern.test(offerRef)) {
      return err({ kind: "notFound", target: "offer" });
    }
    this.#busy = true;
    const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(15_000)]);
    try {
      const resolved = await this.#evidence(verificationRef, offerRef, now, "proposal", signal);
      if (resolved.ok && !this.#closed && !signal.aborted) this.#prepared = structuredClone(resolved.value);
      return resolved;
    } finally { this.#busy = false; }
  }

  async write(mutation: HostMutation, now: string, signal?: AbortSignal): Promise<HostWriteReceipt> {
    const reject = (): HostWriteReceipt =>
      ({ kind: "rejected", actionKey: mutation.actionKey, reason: "forbidden" });
    const pending = this.#prepared;
    if (this.#closed || this.#busy || this.#attempt || mutation.kind !== "book" ||
        mutation.request.kind !== "book" || !pending ||
        !validScope(mutation.scope) || !sameScope(mutation.scope, this.#scope) ||
        mutation.policyVersion !== this.#policyVersion ||
        mutation.payloadDigest !== digestActionRequest(pending) ||
        digestActionRequest(mutation.request) !== mutation.payloadDigest ||
        !refPattern.test(mutation.actionKey)) return reject();
    const attempt: Attempt = { actionKey: mutation.actionKey, digest: mutation.payloadDigest,
      request: { scope: this.#scope, patientId: pending.patient.patientRef,
        startsAt: pending.offer.startsAt, marker: randomUUID() } };
    this.#attempt = attempt;
    const combined = signal
      ? AbortSignal.any([this.#lifetime.signal, signal, AbortSignal.timeout(15_000)])
      : AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(15_000)]);
    const nowMs = this.#time(now);
    if (nowMs === undefined || combined.aborted || !await this.#callReady(nowMs, combined, mutation)) return reject();
    const fresh = await this.#evidence(pending.patient.verificationRef, pending.offer.offerRef,
      now, "commit", combined);
    const commitMs = this.#time(now);
    if (!fresh.ok || digestActionRequest(fresh.value) !== attempt.digest ||
        commitMs === undefined || instant(pending.patient.expiresAt)! <= commitMs ||
        instant(pending.offer.expiresAt)! <= commitMs ||
        combined.aborted || this.#closed || !await this.#callReady(commitMs, combined, mutation)) return reject();
    const result = await this.#writer.writeOnce(attempt.request, combined);
    if (this.#closed || combined.aborted || !result.ok && result.error.kind === "unavailable") {
      return { kind: "uncertain", actionKey: mutation.actionKey, reconcileAfter: now,
        deadline: new Date(nowMs + 5 * 60_000).toISOString() };
    }
    if (!result.ok) return { kind: "unsupported", actionKey: mutation.actionKey };
    if (result.value.kind === "accepted") {
      const conflicts = await this.#writer.inspectConflicts(result.value.appointmentRef, combined);
      if (conflicts.ok && conflicts.value) this.#conflictObserved = true;
      if (!this.#closed && !this.#conflictObserved && !combined.aborted && conflicts.ok && !conflicts.value) {
        return { kind: "committed", actionKey: mutation.actionKey, hostRef: result.value.appointmentRef };
      }
    }
    return { kind: "uncertain", actionKey: mutation.actionKey, reconcileAfter: now,
      deadline: new Date(nowMs + 5 * 60_000).toISOString() };
  }

  /** A booking toggle can close new sends without erasing a possible prior commit. */
  async reconcile(mutation: HostMutation, signal?: AbortSignal): Promise<ReconcileObservation> {
    const unknown: ReconcileObservation = { kind: "stillUnknown", actionKey: mutation.actionKey };
    const attempt = this.#attempt;
    if (this.#closed || this.#conflictObserved || !attempt || mutation.kind !== "book" ||
        attempt.actionKey !== mutation.actionKey || attempt.digest !== mutation.payloadDigest ||
        mutation.request.kind !== "book" || !validScope(mutation.scope) ||
        !sameScope(mutation.scope, this.#scope) || mutation.policyVersion !== this.#policyVersion ||
        digestActionRequest(mutation.request) !== attempt.digest) return unknown;
    const combined = signal
      ? AbortSignal.any([this.#lifetime.signal, signal, AbortSignal.timeout(15_000)])
      : AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(15_000)]);
    let now: string;
    try { now = this.#clock(); } catch { return unknown; }
    const nowMs = this.#time(now);
    const state = nowMs === undefined ? undefined : await this.#activeState(nowMs, combined);
    const action = state?.actions[mutation.actionKey];
    const effect = state?.effects[`${mutation.actionKey}:write`];
    if (!state || action?.status !== "uncertain" || action.digest !== attempt.digest ||
        effect?.kind !== "hostWrite" || effect.status !== "uncertain" ||
        effect.mutation.actionKey !== mutation.actionKey ||
        effect.mutation.payloadDigest !== attempt.digest) return unknown;
    const patient = await untilAbort(this.#proof.verifyOperation(this.#scope,
      mutation.request.patient.verificationRef, "appointments.book", now), combined);
    if (!patient?.ok || patient.value.patientRef !== attempt.request.patientId ||
        this.#closed || combined.aborted) return unknown;
    let observed: Awaited<ReturnType<ClinikoBookingWriter["observe"]>>;
    try { observed = await this.#writer.observe(attempt.request, combined); }
    catch { return unknown; }
    if (this.#closed || combined.aborted || !observed.ok || observed.value.kind !== "one" ||
        !observed.value.active || !sameScope(observed.value.scope, this.#scope)) return unknown;
    const conflicts = await this.#writer.inspectConflicts(observed.value.appointmentRef, combined);
    if (conflicts.ok && conflicts.value) this.#conflictObserved = true;
    if (this.#closed || this.#conflictObserved || combined.aborted || !conflicts.ok || conflicts.value) return unknown;
    return { kind: "exactCommit", actionKey: mutation.actionKey,
      hostRef: observed.value.appointmentRef };
  }

  dispose(): void {
    this.#closed = true;
    this.#lifetime.abort();
    this.#prepared = undefined;
    this.#proof.dispose();
  }

  async openTask(item: StaffItem): Promise<StaffTaskReceipt> {
    return { kind: "rejected", taskKey: item.key };
  }

  async reconcileTask(item: StaffItem): Promise<StaffTaskObservation> {
    return { kind: "definitiveNonOpen", taskKey: item.key };
  }
}
