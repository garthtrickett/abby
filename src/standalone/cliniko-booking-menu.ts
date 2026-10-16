import { copyBookingSearchWindow, validBookingSearchWindow } from "../core/booking-search-window.ts";
import type { BookingSearchWindow } from "../core/booking-search-window.ts";
import type { BookingMenuHost, BookingMenuQuery, BookingMenuReadQuery, HostReadFailure } from "../core/host.ts";
import type { BookingMenuRead } from "../core/booking-menu.ts";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import { ClinikoBookingOffers } from "./cliniko-booking-offers.ts";
import type { BookingChoices } from "./cliniko-booking-offers.ts";
import { clinicDateAt } from "./clinic-clock.ts";

type Config = Readonly<{ verification: Pick<CallerVerificationSession, "verified">; offers: ClinikoBookingOffers;
  scope: BookingMenuQuery["scope"]; callId: string; sessionId: string; policyVersion: string }>;
type Menu = Readonly<{ turnId: string; verificationRef: string; choices: BookingChoices }>;
const denied = <T>(): Result<T, HostReadFailure> => err({ kind: "unavailable", target: "offer" });

/** Private volatile menu mapping; only caller-safe facts cross the SAM read seam. */
export class ClinikoBookingMenu implements BookingMenuHost {
  readonly #config: Config;
  readonly #lifetime = new AbortController();
  #menu: Menu | undefined;
  #previous: Menu | undefined;
  #epoch = 0;
  #window: BookingSearchWindow | undefined;
  constructor(config: Config) { this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) }); }
  bookingMenuAvailable(): boolean { return !this.#lifetime.signal.aborted; }
  #matches(query: BookingMenuQuery): boolean {
    const config = this.#config;
    return !this.#lifetime.signal.aborted && !query.signal.aborted && query.scope.tenantId === config.scope.tenantId &&
      query.scope.clinicId === config.scope.clinicId && query.scope.locationId === config.scope.locationId && query.callId === config.callId &&
      query.sessionId === config.sessionId && query.policyVersion === config.policyVersion;
  }
  async readBookingMenu(incoming: BookingMenuReadQuery): Promise<Result<BookingMenuRead, HostReadFailure>> {
    const query = { ...incoming, scope: { ...incoming.scope } };
    if (!this.#matches(query)) return denied();
    if (query.window !== undefined && query.window !== null && !validBookingSearchWindow(query.window)) return denied();
    if (query.window !== undefined) this.#window = query.window === null ? undefined : copyBookingSearchWindow(query.window);
    const epoch = ++this.#epoch; this.#menu = undefined;
    this.#previous = undefined;
    const signal = AbortSignal.any([query.signal, this.#lifetime.signal]);
    // This is only private routing metadata. The concrete offers reader
    // revalidates native patient authority before and after reading availability.
    const verification = this.#config.verification;
    const grant = verification instanceof CallerVerificationSession && verification.constructor === CallerVerificationSession
      ? await verification.ownedGrant("appointments.book", signal) : await verification.verified(signal);
    if (!grant || !this.#matches(query) || signal.aborted || epoch !== this.#epoch) return denied();
    const result = await this.#config.offers.list(query.scope, grant.verificationRef, query.from, query.to, query.now, signal, this.#window);
    if (!result.ok || !this.#matches(query) || signal.aborted || epoch !== this.#epoch) return denied();
    const choices = structuredClone(result.value);
    this.#menu = { turnId: query.turnId, verificationRef: grant.verificationRef, choices };
    const { scope, callId, sessionId, policyVersion, observedAt, timeZone, practitionerName, appointmentTypeName, reservable } = choices;
    return ok({ scope: { ...scope }, callId, sessionId, policyVersion, observedAt, timeZone, practitionerName, appointmentTypeName, reservable, ...(choices.window ? { window: choices.window } : {}),
      ...(choices.maxSearchDays !== undefined ? { maxSearchDays: choices.maxSearchDays } : {}),
      choices: choices.choices.map(({ startsAt, endsAt, expiresAt }) => ({ startsAt, endsAt, expiresAt })) });
  }
  async selectBookingMenu(incoming: BookingMenuQuery & Readonly<{ menuTurnId: string; choice: 1 | 2 | 3 }>):
    Promise<Result<Readonly<{ verificationRef: string; offerRef: string }>, HostReadFailure>> {
    const query = { ...incoming, scope: { ...incoming.scope } }, menu = this.#menu;
    if (!this.#matches(query) || !menu || query.menuTurnId !== menu.turnId || ![1,2,3].includes(query.choice)) return denied();
    this.#menu = undefined; ++this.#epoch; // One selection consumes this menu before any asynchronous work.
    const choice = menu.choices.choices[query.choice-1];
    const signal = AbortSignal.any([query.signal, this.#lifetime.signal]);
    // Selecting these private references grants no patient access or booking.
    // The proposal guard validates native authority before it can create SAM
    // confirmation speech; later send/inspection validates it independently.
    const verification = this.#config.verification;
    const grant = verification instanceof CallerVerificationSession && verification.constructor === CallerVerificationSession
      ? await verification.ownedGrant("appointments.book", signal) : await verification.verified(signal);
    if (!choice || !grant || grant.verificationRef !== menu.verificationRef || !this.#matches(query) || signal.aborted ||
        Date.parse(choice.expiresAt) <= Date.parse(query.now)) return denied();
    this.#previous = menu;
    return ok({ verificationRef: grant.verificationRef, offerRef: choice.offerRef });
  }
  async correctBookingMenu(incoming: BookingMenuQuery & Readonly<{ menuTurnId: string; startsAt: string }>) {
    const query = { ...incoming, scope: { ...incoming.scope } }, previous = this.#previous;
    const choice = previous?.choices.choices.find(item => item.startsAt === query.startsAt);
    if (!this.#matches(query) || !previous || previous.turnId !== query.menuTurnId || !choice ||
        Date.parse(choice.expiresAt) <= Date.parse(query.now)) return denied<Readonly<{ verificationRef: string; offerRef: string }>>();
    const epoch = ++this.#epoch, signal = AbortSignal.any([query.signal, this.#lifetime.signal]);
    const grant = await this.#config.verification.verified(signal);
    if (!grant || grant.verificationRef !== previous.verificationRef || !this.#matches(query) || signal.aborted || epoch !== this.#epoch)
      return denied<Readonly<{ verificationRef: string; offerRef: string }>>();
    const day = clinicDateAt(previous.choices.timeZone, new Date(query.startsAt));
    const fresh = await this.#config.offers.list(query.scope, grant.verificationRef, day, day, query.now, signal, previous.choices.window);
    const selected = fresh.ok ? fresh.value.choices.find(item => item.startsAt === query.startsAt && item.endsAt === choice.endsAt) : undefined;
    if (!selected || !this.#matches(query) || signal.aborted || epoch !== this.#epoch) return denied<Readonly<{ verificationRef: string; offerRef: string }>>();
    return ok({ verificationRef: grant.verificationRef, offerRef: selected.offerRef });
  }
  dispose(): void { ++this.#epoch; this.#lifetime.abort(); this.#menu = undefined; this.#previous = undefined; this.#window = undefined; }
}
