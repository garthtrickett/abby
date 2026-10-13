import type { BookingSearchWindow } from "../core/booking-search-window.ts";
import type { AppointmentHost, HostReadFailure } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { AppointmentChangeAuthority } from "./appointment-change-authority.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { ClinikoAppointmentSelection } from "./cliniko-appointment-selection.ts";
import type { ClinikoAppointmentSelectionConfig } from "./cliniko-appointment-selection.ts";
import type { SelectedAppointmentEvidence } from "./cliniko-appointment-selection.ts";
import { ClinikoBookingOffers } from "./cliniko-booking-offers.ts";
import type { BookingChoices, ClinikoBookingOffersConfig } from "./cliniko-booking-offers.ts";
import { OwnerFileReschedulingPolicy } from "./owner-file-rescheduling-policy.ts";
import { OwnerFileBookingPolicy } from "./owner-file-booking-policy.ts";
import { ClinikoAvailabilityReader } from "../cliniko/availability.ts";
import { normalizedSpokenName } from "../core/pending-location.ts";

export type ClinikoReschedulingAuthorityConfig = Omit<ClinikoBookingOffersConfig, "operation"> &
  Readonly<{ feePolicy: OwnerFileReschedulingPolicy; practitionerPolicies?: readonly OwnerFileBookingPolicy[] }>;
const denied = <T>(): Result<T, HostReadFailure> => err({ kind: "unavailable", target: "offer" });
type PractitionerDirectory = Readonly<{ choices: readonly Readonly<{ practitionerId: string; name: string; expiresAt: string }>[];
  hasMore: boolean; timeZone: string }>;

/** Protected source and destination selection for an approved same-duration in-place move.
 * Neither public policy nor observed availability issues patient permission or reserves a time. */
export class ClinikoReschedulingAuthority implements AppointmentChangeAuthority, AppointmentHost {
  readonly #config: ClinikoReschedulingAuthorityConfig;
  readonly #source: ClinikoAppointmentSelection;
  #offers: ClinikoBookingOffers;
  #destination: OwnerFileBookingPolicy;
  readonly #fetchPort: typeof fetch;
  readonly #routes: readonly OwnerFileBookingPolicy[];
  #epoch = 0;
  readonly #lifetime = new AbortController();
  private constructor(config: ClinikoReschedulingAuthorityConfig, source: ClinikoAppointmentSelection, offers: ClinikoBookingOffers, fetchPort: typeof fetch) {
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) }); this.#source = source; this.#offers = offers;
    this.#destination = config.policy; this.#fetchPort = fetchPort;
    this.#routes = Object.freeze([config.policy, ...(config.practitionerPolicies ?? [])]);
  }
  static create(config: ClinikoReschedulingAuthorityConfig, fetchPort: typeof fetch = fetch):
    Result<ClinikoReschedulingAuthority, Readonly<{ kind: "invalidConfig" }>> {
    try {
      if (!(config.feePolicy instanceof OwnerFileReschedulingPolicy)) return err({ kind: "invalidConfig" });
      if (config.practitionerPolicies !== undefined && (!Array.isArray(config.practitionerPolicies) || config.practitionerPolicies.length > 23)) return err({ kind: "invalidConfig" });
      const fee = config.feePolicy.binding(), destination = config.policy.binding();
      if (!sameScope(fee.scope, destination.scope) ||
          ["policyVersion", "businessId", "credentialFingerprint", "recallTypeId", "timeZone"].some(key =>
            fee[key as keyof typeof fee] !== destination[key as keyof typeof destination])) return err({ kind: "invalidConfig" });
      const ids = new Set<string>();
      for (const policy of [config.policy, ...(config.practitionerPolicies ?? [])]) {
        if (!(policy instanceof OwnerFileBookingPolicy)) return err({ kind: "invalidConfig" });
        const binding = policy.binding();
        if (ids.has(binding.practitionerId) || !sameScope(binding.scope, destination.scope) ||
            ["policyVersion", "businessId", "credentialFingerprint", "recallTypeId", "timeZone", "appointmentTypeId"].some(key =>
              binding[key as keyof typeof binding] !== destination[key as keyof typeof destination])) return err({ kind: "invalidConfig" });
        ids.add(binding.practitionerId);
      }
      const selection: ClinikoAppointmentSelectionConfig = { ...config, policy: config.feePolicy };
      const source = ClinikoAppointmentSelection.create(selection, fetchPort);
      if (!source.ok) return source;
      const offers = ClinikoBookingOffers.create({ ...config, operation: "appointments.reschedule" }, fetchPort);
      if (!offers.ok) { source.value.dispose(); return offers; }
      return ok(new ClinikoReschedulingAuthority(config, source.value, offers.value, fetchPort));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async #bounded<T>(run: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T | undefined> {
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, this.#lifetime.signal, ...(external ? [external] : [])]);
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs ?? 15_000);
    let stop: () => void = () => {};
    const stopped = new Promise<undefined>(resolve => { stop = () => resolve(undefined); signal.addEventListener("abort", stop); if (signal.aborted) stop(); });
    try { return await Promise.race([Promise.resolve().then(() => signal.aborted ? undefined : run(signal)), stopped]); }
    catch { return undefined; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", stop); controller.abort(); }
  }
  list(...args: Parameters<ClinikoAppointmentSelection["list"]>) { return this.#source.list(...args); }
  select(...args: Parameters<ClinikoAppointmentSelection["select"]>) { return this.#source.select(...args); }
  get timeZone(): string { return this.#config.feePolicy.binding().timeZone; }
  get practitionerChoiceEnabled(): boolean { return this.#config.practitionerPolicies !== undefined && this.#routes.length > 1; }
  /** Display fact for the private menu; final authority is rechecked at proposal and send. */
  changesPractitioner(target: SelectedAppointmentEvidence): boolean {
    return sameScope(target.scope, this.#config.scope) && target.practitionerId !== this.#destination.binding().practitionerId;
  }
  async #permitsTarget(target: SelectedAppointmentEvidence, signal: AbortSignal, route = this.#destination): Promise<boolean> {
    const policy = await route.current(this.#config.scope), fee = await this.#config.feePolicy.current(this.#config.scope);
    if (!policy.ok || !fee.ok || signal.aborted || target.businessId !== policy.value.businessId ||
        target.appointmentTypeId !== policy.value.appointmentTypeId || Date.parse(target.target.endsAt) - Date.parse(target.target.startsAt) !== policy.value.durationMinutes * 60_000) return false;
    return target.practitionerId === policy.value.practitionerId || fee.value.practitionerMoves?.some(move =>
      move.fromPractitionerId === target.practitionerId && move.toPractitionerId === policy.value.practitionerId &&
      move.appointmentTypeId === target.appointmentTypeId && move.durationMinutes === policy.value.durationMinutes) === true;
  }
  async resolveTarget(query: Omit<Parameters<AppointmentChangeAuthority["resolve"]>[0], "kind" | "offerRef">) {
    const bound = { ...query, scope: { ...query.scope } };
    return await this.#bounded(async signal => {
      const target = await this.#source.resolveTarget({ ...bound, kind: "reschedule", signal });
      const original = target.ok && this.#config.practitionerPolicies !== undefined ? this.#routes.find(route => route.binding().practitionerId === target.value.practitionerId) : undefined;
      return target.ok && (await this.#permitsTarget(target.value, signal) || original && await this.#permitsTarget(target.value, signal, original)) && !signal.aborted ? target :
        err({ kind: "unavailable" as const, target: "appointment" as const });
    }, bound.signal) ?? err({ kind: "unavailable" as const, target: "appointment" as const });
  }
  #replaceDestination(policy: OwnerFileBookingPolicy): boolean {
    const next = ClinikoBookingOffers.create({ ...this.#config, policy, practitionerId: policy.binding().practitionerId,
      operation: "appointments.reschedule" }, this.#fetchPort);
    if (!next.ok) return false;
    ++this.#epoch; this.#offers.dispose(); this.#offers = next.value; this.#destination = policy;
    return true;
  }
  async #describe(route: OwnerFileBookingPolicy, signal: AbortSignal) {
    const before = await route.current(this.#config.scope); if (!before.ok || signal.aborted) return undefined;
    const reader = ClinikoAvailabilityReader.create({ ...this.#config, practitionerId: route.binding().practitionerId }, this.#fetchPort, this.#config.clock);
    if (!reader.ok) return undefined;
    const native = await reader.value.describeBookingOffering(this.#config.scope, before.value.durationMinutes, signal,
      before.value.availabilityPlan?.mode === "roster");
    const after = await route.current(this.#config.scope);
    return native.ok && native.value.kind === "offering" && native.value.offering && native.value.timeZone === before.value.timeZone &&
      after.ok && JSON.stringify(before.value) === JSON.stringify(after.value) && !signal.aborted ? native.value.offering : undefined;
  }
  /** Reset only when an appointment is newly selected. A directory does not silently switch members. */
  async preferOriginalPractitioner(query: Omit<Parameters<AppointmentChangeAuthority["resolve"]>[0], "kind" | "offerRef">): Promise<boolean> {
    if (this.#config.practitionerPolicies === undefined) return true;
    return await this.#bounded(async signal => {
      const source = await this.#source.resolveTarget({ ...query, kind: "reschedule", signal });
      const route = source.ok ? this.#routes.find(policy => policy.binding().practitionerId === source.value.practitionerId) : undefined;
      return !!route && source.ok && await this.#permitsTarget(source.value, signal, route) && !signal.aborted && this.#replaceDestination(route);
    }, query.signal) ?? false;
  }
  /** Private owner directory. Native IDs are removed by the menu before SAM/model presentation. */
  async practitioners(query: Omit<Parameters<AppointmentChangeAuthority["resolve"]>[0], "kind" | "offerRef">, offset = 0): Promise<Result<PractitionerDirectory, HostReadFailure>> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 21 || offset % 3 !== 0) return denied();
    return await this.#bounded(async (signal): Promise<Result<PractitionerDirectory, HostReadFailure>> => {
      const source = await this.#source.resolveTarget({ ...query, kind: "reschedule", signal });
      if (!source.ok || signal.aborted) return denied();
      const eligible: OwnerFileBookingPolicy[] = [];
      for (const route of this.#routes) if (await this.#permitsTarget(source.value, signal, route)) eligible.push(route);
      const choices = [];
      for (const route of eligible.slice(offset, offset + 3)) {
        const label = await this.#describe(route, signal);
        if (!label || !await this.#permitsTarget(source.value, signal, route)) return denied();
        choices.push({ practitionerId: route.binding().practitionerId, name: label.practitionerName, expiresAt: source.value.terms.expiresAt });
      }
      const final = await this.#source.resolveTarget({ ...query, kind: "reschedule", signal });
      if (!final.ok || JSON.stringify(final.value) !== JSON.stringify(source.value) ||
          new Set(choices.map(choice => normalizedSpokenName(choice.name))).size !== choices.length || signal.aborted) return denied();
      return ok({ choices, hasMore: offset + 3 < eligible.length, timeZone: source.value.target.timeZone });
    }, query.signal) ?? denied();
  }
  async choosePractitioner(query: Omit<Parameters<AppointmentChangeAuthority["resolve"]>[0], "kind" | "offerRef">, practitionerId: string, name: string): Promise<boolean> {
    const epoch = this.#epoch;
    return await this.#bounded(async signal => {
      const source = await this.#source.resolveTarget({ ...query, kind: "reschedule", signal });
      const route = this.#routes.find(policy => policy.binding().practitionerId === practitionerId);
      if (!source.ok || !route || !await this.#permitsTarget(source.value, signal, route)) return false;
      const label = await this.#describe(route, signal);
      const final = await this.#source.resolveTarget({ ...query, kind: "reschedule", signal });
      return !!label && final.ok && JSON.stringify(final.value) === JSON.stringify(source.value) && label.practitionerName === name &&
        !signal.aborted && epoch === this.#epoch && await this.#permitsTarget(final.value, signal, route) && this.#replaceDestination(route);
    }, query.signal) ?? false;
  }
  async listOffers(scope: LocationScope, verificationRef: string, from: string, to: string, now: string, external?: AbortSignal, window?: BookingSearchWindow): Promise<Result<BookingChoices, HostReadFailure>> {
    const bound = { ...scope };
    const epoch = this.#epoch;
    return await this.#bounded(async signal => {
      const policy = await this.#config.feePolicy.current(bound);
      if (!policy.ok || signal.aborted) return denied<BookingChoices>();
      const result = await this.#offers.list(bound, verificationRef, from, to, now, signal, window);
      const current = await this.#config.feePolicy.current(bound);
      return result.ok && current.ok && !signal.aborted && epoch === this.#epoch && JSON.stringify(current.value) === JSON.stringify(policy.value) ? result : denied<BookingChoices>();
    }, external) ?? denied();
  }
  async resolve(incoming: Parameters<AppointmentChangeAuthority["resolve"]>[0]): ReturnType<AppointmentChangeAuthority["resolve"]> {
    if (incoming.kind !== "reschedule" || typeof incoming.offerRef !== "string" || !(incoming.signal instanceof AbortSignal)) return denied();
    const query = { ...incoming, scope: { ...incoming.scope } };
    return await this.#bounded(signal => this.#resolve({ ...query, signal }), query.signal) ?? denied();
  }
  async #resolve(query: Parameters<AppointmentChangeAuthority["resolve"]>[0] & Readonly<{ kind: "reschedule" }>): ReturnType<AppointmentChangeAuthority["resolve"]> {
    const source = await this.#source.resolveTarget(query);
    if (!source.ok || query.signal.aborted || !await this.#permitsTarget(source.value, query.signal)) return denied();
    const destination = await this.#offers.resolve({ ...query, offerRef: query.offerRef });
    if (!destination.ok || query.signal.aborted) return denied();
    const target = source.value, offer = destination.value;
    const changed = target.practitionerId !== offer.practitionerId;
    if (target.businessId !== offer.businessId ||
        target.appointmentTypeId !== offer.appointmentTypeId || target.credentialFingerprint !== offer.credentialFingerprint ||
        target.target.timeZone !== offer.timeZone ||
        Date.parse(target.target.endsAt) - Date.parse(target.target.startsAt) !== Date.parse(offer.endsAt) - Date.parse(offer.offer.startsAt) ||
        !changed && Date.parse(target.target.startsAt) === Date.parse(offer.offer.startsAt) || changed && !offer.offer.presentation) return denied();
    // Destination IO may take time: re-read the protected source/fee before releasing combined evidence.
    const final = await this.#source.resolveTarget(query);
    const now = (this.#config.clock ?? (() => new Date().toISOString()))();
    if (!final.ok || query.signal.aborted || !await this.#permitsTarget(final.value, query.signal) || !this.#offers.retains(offer, query.verificationRef) || JSON.stringify(final.value) !== JSON.stringify(target) ||
        Date.parse(offer.offer.expiresAt) <= Date.parse(now)) return denied();
    return ok({ ...final.value, kind: "reschedule", offer: offer.offer, ...(changed ? { destinationPractitionerId: offer.practitionerId } : {}) });
  }
  dispose(): void { this.#lifetime.abort(); this.#source.dispose(); this.#offers.dispose(); }
}
