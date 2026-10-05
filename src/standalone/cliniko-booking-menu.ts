import type { BookingMenuHost, BookingMenuQuery, HostReadFailure } from "../core/host.ts";
import type { BookingMenuRead } from "../core/booking-menu.ts";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import { ClinikoBookingOffers } from "./cliniko-booking-offers.ts";
import type { BookingChoices } from "./cliniko-booking-offers.ts";

type Config = Readonly<{ verification: Pick<CallerVerificationSession, "verified">; offers: ClinikoBookingOffers;
  scope: BookingMenuQuery["scope"]; callId: string; sessionId: string; policyVersion: string }>;
const denied = <T>(): Result<T, HostReadFailure> => err({ kind: "unavailable", target: "offer" });

/** Private volatile menu mapping; only caller-safe facts cross the SAM read seam. */
export class ClinikoBookingMenu implements BookingMenuHost {
  readonly #config: Config;
  readonly #lifetime = new AbortController();
  #menu: Readonly<{ turnId: string; verificationRef: string; choices: BookingChoices }> | undefined;
  #epoch = 0;
  constructor(config: Config) { this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) }); }
  bookingMenuAvailable(): boolean { return !this.#lifetime.signal.aborted; }
  #matches(query: BookingMenuQuery): boolean {
    const config = this.#config;
    return !this.#lifetime.signal.aborted && !query.signal.aborted && query.scope.tenantId === config.scope.tenantId &&
      query.scope.clinicId === config.scope.clinicId && query.scope.locationId === config.scope.locationId && query.callId === config.callId &&
      query.sessionId === config.sessionId && query.policyVersion === config.policyVersion;
  }
  async readBookingMenu(incoming: BookingMenuQuery & Readonly<{ from: string; to: string }>): Promise<Result<BookingMenuRead, HostReadFailure>> {
    const query = { ...incoming, scope: { ...incoming.scope } };
    if (!this.#matches(query)) return denied();
    const epoch = ++this.#epoch; this.#menu = undefined;
    const signal = AbortSignal.any([query.signal, this.#lifetime.signal]);
    const grant = await this.#config.verification.verified(signal);
    if (!grant || !this.#matches(query) || signal.aborted || epoch !== this.#epoch) return denied();
    const result = await this.#config.offers.list(query.scope, grant.verificationRef, query.from, query.to, query.now, signal);
    if (!result.ok || !this.#matches(query) || signal.aborted || epoch !== this.#epoch) return denied();
    const choices = structuredClone(result.value);
    this.#menu = { turnId: query.turnId, verificationRef: grant.verificationRef, choices };
    const { scope, callId, sessionId, policyVersion, observedAt, timeZone, practitionerName, appointmentTypeName, reservable } = choices;
    return ok({ scope: { ...scope }, callId, sessionId, policyVersion, observedAt, timeZone, practitionerName, appointmentTypeName, reservable,
      choices: choices.choices.map(({ startsAt, endsAt, expiresAt }) => ({ startsAt, endsAt, expiresAt })) });
  }
  async selectBookingMenu(incoming: BookingMenuQuery & Readonly<{ menuTurnId: string; choice: 1 | 2 | 3 }>):
    Promise<Result<Readonly<{ verificationRef: string; offerRef: string }>, HostReadFailure>> {
    const query = { ...incoming, scope: { ...incoming.scope } }, menu = this.#menu;
    if (!this.#matches(query) || !menu || query.menuTurnId !== menu.turnId || ![1,2,3].includes(query.choice)) return denied();
    this.#menu = undefined; ++this.#epoch; // One selection consumes this menu before any asynchronous work.
    const choice = menu.choices.choices[query.choice-1];
    const signal = AbortSignal.any([query.signal, this.#lifetime.signal]);
    const grant = await this.#config.verification.verified(signal);
    if (!choice || !grant || grant.verificationRef !== menu.verificationRef || !this.#matches(query) || signal.aborted ||
        Date.parse(choice.expiresAt) <= Date.parse(query.now)) return denied();
    return ok({ verificationRef: grant.verificationRef, offerRef: choice.offerRef });
  }
  dispose(): void { ++this.#epoch; this.#lifetime.abort(); this.#menu = undefined; }
}
