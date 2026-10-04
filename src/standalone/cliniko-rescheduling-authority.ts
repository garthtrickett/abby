import type { AppointmentHost, HostReadFailure } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { AppointmentChangeAuthority } from "./appointment-change-authority.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { ClinikoAppointmentSelection } from "./cliniko-appointment-selection.ts";
import type { ClinikoAppointmentSelectionConfig } from "./cliniko-appointment-selection.ts";
import { ClinikoBookingOffers } from "./cliniko-booking-offers.ts";
import type { BookingChoices, ClinikoBookingOffersConfig } from "./cliniko-booking-offers.ts";
import { OwnerFileReschedulingPolicy } from "./owner-file-rescheduling-policy.ts";

export type ClinikoReschedulingAuthorityConfig = Omit<ClinikoBookingOffersConfig, "operation"> &
  Readonly<{ feePolicy: OwnerFileReschedulingPolicy }>;
const denied = <T>(): Result<T, HostReadFailure> => err({ kind: "unavailable", target: "offer" });

/** Protected source and destination selection for a same-provider, same-duration in-place move.
 * Neither public policy nor observed availability issues patient permission or reserves a time. */
export class ClinikoReschedulingAuthority implements AppointmentChangeAuthority, AppointmentHost {
  readonly #config: ClinikoReschedulingAuthorityConfig;
  readonly #source: ClinikoAppointmentSelection;
  readonly #offers: ClinikoBookingOffers;
  readonly #lifetime = new AbortController();
  private constructor(config: ClinikoReschedulingAuthorityConfig, source: ClinikoAppointmentSelection, offers: ClinikoBookingOffers) {
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) }); this.#source = source; this.#offers = offers;
  }
  static create(config: ClinikoReschedulingAuthorityConfig, fetchPort: typeof fetch = fetch):
    Result<ClinikoReschedulingAuthority, Readonly<{ kind: "invalidConfig" }>> {
    try {
      if (!(config.feePolicy instanceof OwnerFileReschedulingPolicy)) return err({ kind: "invalidConfig" });
      const fee = config.feePolicy.binding(), destination = config.policy.binding();
      if (!sameScope(fee.scope, destination.scope) ||
          ["policyVersion", "businessId", "credentialFingerprint", "recallTypeId", "timeZone"].some(key =>
            fee[key as keyof typeof fee] !== destination[key as keyof typeof destination])) return err({ kind: "invalidConfig" });
      const selection: ClinikoAppointmentSelectionConfig = { ...config, policy: config.feePolicy };
      const source = ClinikoAppointmentSelection.create(selection, fetchPort);
      if (!source.ok) return source;
      const offers = ClinikoBookingOffers.create({ ...config, operation: "appointments.reschedule" }, fetchPort);
      if (!offers.ok) { source.value.dispose(); return offers; }
      return ok(new ClinikoReschedulingAuthority(config, source.value, offers.value));
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
  async resolveTarget(query: Omit<Parameters<AppointmentChangeAuthority["resolve"]>[0], "kind" | "offerRef">) {
    const bound = { ...query, scope: { ...query.scope } };
    return await this.#bounded(async signal => {
      const target = await this.#source.resolveTarget({ ...bound, kind: "reschedule", signal });
      const policy = await this.#config.policy.current(bound.scope);
      return target.ok && policy.ok && !signal.aborted && target.value.practitionerId === policy.value.practitionerId &&
        target.value.appointmentTypeId === policy.value.appointmentTypeId &&
        Date.parse(target.value.target.endsAt)-Date.parse(target.value.target.startsAt) === policy.value.durationMinutes*60_000 ? target :
        err({ kind: "unavailable" as const, target: "appointment" as const });
    }, bound.signal) ?? err({ kind: "unavailable" as const, target: "appointment" as const });
  }
  async listOffers(scope: LocationScope, verificationRef: string, from: string, to: string, now: string, external?: AbortSignal): Promise<Result<BookingChoices, HostReadFailure>> {
    const bound = { ...scope };
    return await this.#bounded(async signal => {
      const policy = await this.#config.feePolicy.current(bound);
      if (!policy.ok || signal.aborted) return denied<BookingChoices>();
      const result = await this.#offers.list(bound, verificationRef, from, to, now, signal);
      const current = await this.#config.feePolicy.current(bound);
      return result.ok && current.ok && !signal.aborted && JSON.stringify(current.value) === JSON.stringify(policy.value) ? result : denied<BookingChoices>();
    }, external) ?? denied();
  }
  async resolve(incoming: Parameters<AppointmentChangeAuthority["resolve"]>[0]): ReturnType<AppointmentChangeAuthority["resolve"]> {
    if (incoming.kind !== "reschedule" || typeof incoming.offerRef !== "string" || !(incoming.signal instanceof AbortSignal)) return denied();
    const query = { ...incoming, scope: { ...incoming.scope } };
    return await this.#bounded(signal => this.#resolve({ ...query, signal }), query.signal) ?? denied();
  }
  async #resolve(query: Parameters<AppointmentChangeAuthority["resolve"]>[0] & Readonly<{ kind: "reschedule" }>): ReturnType<AppointmentChangeAuthority["resolve"]> {
    const source = await this.#source.resolveTarget(query);
    if (!source.ok || query.signal.aborted) return denied();
    const destination = await this.#offers.resolve({ ...query, offerRef: query.offerRef });
    if (!destination.ok || query.signal.aborted) return denied();
    const target = source.value, offer = destination.value;
    if (target.businessId !== offer.businessId || target.practitionerId !== offer.practitionerId ||
        target.appointmentTypeId !== offer.appointmentTypeId || target.credentialFingerprint !== offer.credentialFingerprint ||
        target.target.timeZone !== offer.timeZone ||
        Date.parse(target.target.endsAt) - Date.parse(target.target.startsAt) !== Date.parse(offer.endsAt) - Date.parse(offer.offer.startsAt) ||
        Date.parse(target.target.startsAt) === Date.parse(offer.offer.startsAt)) return denied();
    // Destination IO may take time: re-read the protected source/fee before releasing combined evidence.
    const final = await this.#source.resolveTarget(query);
    const now = (this.#config.clock ?? (() => new Date().toISOString()))();
    if (!final.ok || query.signal.aborted || !this.#offers.retains(offer, query.verificationRef) || JSON.stringify(final.value) !== JSON.stringify(target) ||
        Date.parse(offer.offer.expiresAt) <= Date.parse(now)) return denied();
    return ok({ ...final.value, kind: "reschedule", offer: offer.offer });
  }
  dispose(): void { this.#lifetime.abort(); this.#source.dispose(); this.#offers.dispose(); }
}
