import { randomBytes } from "node:crypto";
import { ClinikoAvailabilityReader } from "../cliniko/availability.ts";
import { clinikoCredentialFingerprint, isClinikoRequestBudget } from "../cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import type { HostReadFailure } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { BookableOffer, LocationScope, Result } from "../core/model.ts";
import { normalizeEmailAddress } from "../shared/email-address.ts";
import { sameScope } from "./appointment-change-authority.ts";
import type { ClinikoBookingAuthority, ClinikoBookingEvidence, ClinikoBookingQuery } from "./cliniko-booking-authority.ts";
import { clinicDateAt } from "./clinic-clock.ts";
import { approvalInstant } from "./owner-file-clinic-approval.ts";
import { OwnerFileBookingPolicy } from "./owner-file-booking-policy.ts";
import type { BookingApproval } from "./owner-file-booking-policy.ts";
import { TransientPatientProofHost } from "./transient-patient-proof.ts";

export type ClinikoBookingOffersConfig = Readonly<{
  scope: LocationScope; callId: string; sessionId: string; policyVersion: string; apiKey: string; contactEmail: string;
  businessId: string; practitionerId: string; appointmentTypeId: string; proof: TransientPatientProofHost;
  policy: OwnerFileBookingPolicy; operation?: "appointments.book" | "appointments.reschedule"; rateBudget: ClinikoRequestBudget; clock?: () => string; timeoutMs?: number;
}>;
export type BookingChoices = Readonly<{
  scope: LocationScope; callId: string; sessionId: string; policyVersion: string; observedAt: string; timeZone: string;
  serviceRef: string; practitionerName: string; appointmentTypeName: string; reservable: false;
  choices: readonly (BookableOffer & Readonly<{ endsAt: string }>)[];
}>;
type Selected = Readonly<{ evidence: ClinikoBookingEvidence; verificationRef: string; practitionerName: string; appointmentTypeName: string }>;
const ref = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9:_-]{1,256}$/.test(value);
const denied = <T>(): Result<T, HostReadFailure> => err({ kind: "unavailable", target: "offer" });

/** One admitted call's approved, patient-bound offers. Availability is an observation, never a reservation. */
export class ClinikoBookingOffers implements ClinikoBookingAuthority {
  readonly #config: ClinikoBookingOffersConfig;
  readonly #reader: ClinikoAvailabilityReader;
  readonly #lifetime = new AbortController();
  readonly #offers = new Map<string, Selected>();
  #epoch = 0;
  private constructor(config: ClinikoBookingOffersConfig, reader: ClinikoAvailabilityReader) {
    this.#config = config; this.#reader = reader;
  }
  static create(incoming: ClinikoBookingOffersConfig, fetchPort: typeof fetch = fetch):
    Result<ClinikoBookingOffers, Readonly<{ kind: "invalidConfig" }>> {
    try {
      const config = Object.freeze({ ...incoming, scope: Object.freeze({ ...incoming.scope }) });
      if ((config.operation !== undefined && !["appointments.book", "appointments.reschedule"].includes(config.operation)) ||
          !(config.proof instanceof TransientPatientProofHost) ||
          !config.proof.matchesCall(config.scope, config.callId, config.sessionId, config.policyVersion) ||
          !(config.policy instanceof OwnerFileBookingPolicy) ||
          !normalizeEmailAddress(config.contactEmail) || typeof config.apiKey !== "string" || /[\u0000-\u001f\u007f]/.test(config.apiKey) ||
          !isClinikoRequestBudget(config.rateBudget) || ![config.callId, config.sessionId, config.policyVersion].every(ref) ||
          typeof fetchPort !== "function" || (config.clock !== undefined && typeof config.clock !== "function") ||
          (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 20_000))) return err({ kind: "invalidConfig" });
      const bound = config.policy.binding();
      if (!sameScope(bound.scope, config.scope) || bound.policyVersion !== config.policyVersion ||
          bound.businessId !== config.businessId || bound.practitionerId !== config.practitionerId || bound.appointmentTypeId !== config.appointmentTypeId ||
          bound.credentialFingerprint !== clinikoCredentialFingerprint(config.apiKey)) return err({ kind: "invalidConfig" });
      const reader = ClinikoAvailabilityReader.create(config, fetchPort, config.clock);
      return reader.ok ? ok(new ClinikoBookingOffers(config, reader.value)) : err({ kind: "invalidConfig" });
    } catch { return err({ kind: "invalidConfig" }); }
  }
  #now(): string { return (this.#config.clock ?? (() => new Date().toISOString()))(); }
  #time(now: string): number | undefined {
    try {
      const supplied = approvalInstant(now), actual = approvalInstant(this.#now());
      return supplied !== undefined && actual !== undefined && Math.abs(actual - supplied) <= 30_000 ? actual : undefined;
    } catch { return undefined; }
  }
  async #bounded<T>(run: (signal: AbortSignal) => Promise<T | undefined>, external?: AbortSignal): Promise<T | undefined> {
    const local = new AbortController(), signal = AbortSignal.any([local.signal, this.#lifetime.signal, ...(external ? [external] : [])]);
    const timer = setTimeout(() => local.abort(), this.#config.timeoutMs ?? 15_000);
    let stop: () => void = () => undefined;
    const stopped = new Promise<undefined>(resolve => { stop = () => resolve(undefined); signal.addEventListener("abort", stop); if (signal.aborted) stop(); });
    try { return await Promise.race([Promise.resolve().then(() => signal.aborted ? undefined : run(signal)), stopped]); }
    catch { return undefined; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", stop); local.abort(); }
  }
  async #current(verificationRef: string, now: string, signal: AbortSignal) {
    const config = this.#config;
    const policy = await config.policy.current(config.scope);
    if (!policy.ok || signal.aborted || this.#time(now) === undefined) return undefined;
    const proof = await config.proof.verifyOperation(config.scope, verificationRef, config.operation ?? "appointments.book", this.#now(), signal);
    if (!proof.ok || signal.aborted) return undefined;
    const finalPolicy = await config.policy.current(config.scope), at = this.#time(now);
    if (!finalPolicy.ok || JSON.stringify(finalPolicy.value) !== JSON.stringify(policy.value) || at === undefined ||
        signal.aborted || Date.parse(proof.value.expiresAt) <= at) return undefined;
    return { policy: finalPolicy.value, patient: proof.value, at };
  }
  #expiry(policy: BookingApproval, proofExpiry: string, at: number): string {
    return new Date(Math.min(at + policy.offerTtlSeconds * 1000, Date.parse(policy.effectiveUntil), Date.parse(proofExpiry))).toISOString();
  }
  async list(scope: LocationScope, verificationRef: string, from: string, to: string, now: string, external?: AbortSignal):
    Promise<Result<BookingChoices, HostReadFailure>> {
    const config = this.#config;
    if (!sameScope(scope, config.scope) || !ref(verificationRef) || this.#time(now) === undefined || this.#lifetime.signal.aborted) return denied();
    const epoch = ++this.#epoch; this.#offers.clear();
    const result = await this.#bounded(async signal => {
      const before = await this.#current(verificationRef, now, signal);
      if (!before) return undefined;
      const read = await this.#reader.listBooking(config.scope, from, to, before.policy.durationMinutes, signal);
      if (!read.ok || read.value.kind !== "times" || !read.value.offering || read.value.timeZone !== before.policy.timeZone || signal.aborted) return undefined;
      const fresh = await this.#current(verificationRef, now, signal);
      if (!fresh || fresh.patient.patientRef !== before.patient.patientRef || epoch !== this.#epoch ||
          JSON.stringify(fresh.policy) !== JSON.stringify(before.policy)) return undefined;
      const at = this.#time(now);
      if (at === undefined || signal.aborted) return undefined;
      const expiresAt = this.#expiry(fresh.policy, fresh.patient.expiresAt, at);
      const offered = read.value.startsAt.filter(start => OwnerFileBookingPolicy.allows(fresh.policy, start, new Date(at).toISOString())).slice(0, 3);
      const offering = read.value.offering;
      const selections = offered.map(startsAt => {
        const offer = { scope: config.scope, offerRef: randomBytes(24).toString("base64url"), serviceRef: fresh.policy.serviceRef, startsAt, expiresAt,
          presentation: { ...offering, timeZone: fresh.policy.timeZone, durationMinutes: fresh.policy.durationMinutes } };
        const evidence: ClinikoBookingEvidence = { scope: config.scope, callId: config.callId, sessionId: config.sessionId, policyVersion: config.policyVersion,
          patientId: fresh.patient.patientRef, businessId: config.businessId, practitionerId: config.practitionerId, appointmentTypeId: config.appointmentTypeId,
          credentialFingerprint: fresh.policy.credentialFingerprint, offer, endsAt: new Date(Date.parse(startsAt) + fresh.policy.durationMinutes * 60_000).toISOString(),
          timeZone: fresh.policy.timeZone, bookingPolicyVersion: fresh.policy.bookingPolicyVersion, contract: "bestEffort" };
        return { evidence, verificationRef, ...offering };
      });
      if (signal.aborted || epoch !== this.#epoch) return undefined;
      for (const selected of selections) this.#offers.set(selected.evidence.offer.offerRef, selected);
      return structuredClone({ scope: config.scope, callId: config.callId, sessionId: config.sessionId, policyVersion: config.policyVersion,
        observedAt: new Date(at).toISOString(), timeZone: fresh.policy.timeZone, serviceRef: fresh.policy.serviceRef, ...offering,
        reservable: false as const, choices: selections.map(({ evidence }) => ({ ...evidence.offer, endsAt: evidence.endsAt })) });
    }, external);
    return result ? ok(result) : denied();
  }
  async resolve(incoming: ClinikoBookingQuery): Promise<Result<ClinikoBookingEvidence, HostReadFailure>> {
    const query = { ...incoming, scope: { ...incoming.scope } }, config = this.#config, selected = this.#offers.get(query.offerRef);
    if (!selected || !sameScope(query.scope, config.scope) || query.callId !== config.callId || query.sessionId !== config.sessionId ||
        query.policyVersion !== config.policyVersion || query.patientId !== selected.evidence.patientId || query.verificationRef !== selected.verificationRef ||
        !["proposal", "commit"].includes(query.phase) || !(query.signal instanceof AbortSignal) || this.#time(query.now) === undefined) return denied();
    const result = await this.#bounded(async signal => {
      const before = await this.#current(query.verificationRef, query.now, signal), evidence = selected.evidence;
      if (!before || before.patient.patientRef !== evidence.patientId || Date.parse(evidence.offer.expiresAt) <= before.at ||
          !OwnerFileBookingPolicy.allows(before.policy, evidence.offer.startsAt, new Date(before.at).toISOString())) return undefined;
      const date = clinicDateAt(evidence.timeZone, new Date(evidence.offer.startsAt));
      const read = await this.#reader.listBooking(config.scope, date, date, before.policy.durationMinutes, signal);
      if (!read.ok || read.value.kind !== "times" || read.value.timeZone !== evidence.timeZone ||
          read.value.offering?.practitionerName !== selected.practitionerName || read.value.offering?.appointmentTypeName !== selected.appointmentTypeName ||
          !read.value.startsAt.includes(evidence.offer.startsAt) || signal.aborted) return undefined;
      const fresh = await this.#current(query.verificationRef, query.now, signal), at = this.#time(query.now);
      if (!fresh || at === undefined || fresh.patient.patientRef !== evidence.patientId || this.#offers.get(query.offerRef) !== selected ||
          Date.parse(evidence.offer.expiresAt) <= at || signal.aborted || JSON.stringify(fresh.policy) !== JSON.stringify(before.policy) ||
          !OwnerFileBookingPolicy.allows(fresh.policy, evidence.offer.startsAt, new Date(at).toISOString())) return undefined;
      return structuredClone(evidence);
    }, query.signal);
    return result ? ok(result) : denied();
  }
  /** Memory fence only: does not recheck provider state or issue patient permission. */
  retains(evidence: ClinikoBookingEvidence, verificationRef: string): boolean {
    try {
      const selected = this.#offers.get(evidence.offer.offerRef), at = this.#time(this.#now());
      return !this.#lifetime.signal.aborted && at !== undefined && !!selected && selected.verificationRef === verificationRef &&
        Date.parse(selected.evidence.offer.expiresAt) > at && JSON.stringify(selected.evidence) === JSON.stringify(evidence);
    } catch { return false; }
  }
  dispose(): void { this.#epoch++; this.#lifetime.abort(); this.#offers.clear(); }
}
