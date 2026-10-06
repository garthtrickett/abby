import { validBookingSearchWindow } from "../core/booking-search-window.ts";
import type { BookingSearchWindow } from "../core/booking-search-window.ts";
import type { HostReadFailure, ReschedulingMenuHost, ReschedulingMenuQuery, ReschedulingMenuReadQuery } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { ReschedulingMenuRead, ReschedulingMenuStage } from "../core/rescheduling-menu.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import { ClinikoReschedulingAuthority } from "./cliniko-rescheduling-authority.ts";
import { clinicDateAt } from "./clinic-clock.ts";

type Config = Readonly<{ verification: CallerVerificationSession; authority: ClinikoReschedulingAuthority;
  scope: ReschedulingMenuQuery["scope"]; callId: string; sessionId: string; policyVersion: string }>;
type Choice = Readonly<{ ref: string; startsAt: string; endsAt: string; expiresAt: string }>;
type Target = Readonly<{ turnId: string; verificationRef: string; patientId: string; targetRef: string }>;
type Menu = Readonly<{ stage: ReschedulingMenuStage; turnId: string; verificationRef: string; patientId: string; window?: BookingSearchWindow; choices: readonly Choice[] }>;
const denied = <T>(): Result<T, HostReadFailure> => err({ kind: "unavailable", target: "appointment" });

/** One call's private two-stage menu. Agent/caller input supplies dates and ordinals, never proof/provider references. */
export class ClinikoReschedulingMenu implements ReschedulingMenuHost {
  readonly #config: Config;
  readonly #lifetime = new AbortController();
  #menu: Menu | undefined;
  #target: Target | undefined;
  #previous: Readonly<{ menu: Menu; target: Target }> | undefined;
  #epoch = 0;
  #window: BookingSearchWindow | undefined;
  constructor(config: Config) { this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) }); }
  reschedulingMenuAvailable(): boolean { return !this.#lifetime.signal.aborted; }
  #matches(query: ReschedulingMenuQuery): boolean {
    const config = this.#config;
    return !this.#lifetime.signal.aborted && !query.signal.aborted && sameScope(query.scope, config.scope) &&
      query.callId === config.callId && query.sessionId === config.sessionId && query.policyVersion === config.policyVersion;
  }
  async #fresh(query: ReschedulingMenuQuery, verificationRef: string, epoch: number, signal: AbortSignal): Promise<boolean> {
    const grant = await this.#config.verification.verified(signal);
    return !!grant && grant.verificationRef === verificationRef && this.#matches(query) && !signal.aborted && epoch === this.#epoch;
  }
  #bound(query: ReschedulingMenuQuery, verificationRef: string, patientId: string, targetRef: string, signal: AbortSignal) {
    return { ...query, verificationRef, patientId, targetRef, phase: "proposal" as const, signal };
  }
  #snapshot(query: ReschedulingMenuQuery, stage: "targets" | "selectedTarget", timeZone: string, choices: readonly Choice[]): ReschedulingMenuRead {
    return { scope: query.scope, callId: query.callId, sessionId: query.sessionId, policyVersion: query.policyVersion,
      observedAt: query.now, stage, timeZone, reservable: false, choices: choices.map(({ startsAt, endsAt, expiresAt }) => ({ startsAt, endsAt, expiresAt })) };
  }
  async readReschedulingMenu(incoming: ReschedulingMenuReadQuery):
    Promise<Result<ReschedulingMenuRead, HostReadFailure>> {
    const query = { ...incoming, scope: { ...incoming.scope } };
    if (!this.#matches(query) || !["targets", "offers"].includes(query.stage)) return denied();
    if (query.stage === "targets" && query.window !== undefined || query.window !== undefined && query.window !== null && !validBookingSearchWindow(query.window)) return denied();
    if (query.window !== undefined) this.#window = query.window === null ? undefined : Object.freeze({ ...query.window });
    const correction = this.#previous;
    if (query.correctingAppointmentRef && (query.stage !== "offers" || !correction)) return denied();
    const epoch = ++this.#epoch, target = query.correctingAppointmentRef ? correction!.target : this.#target, previous = this.#menu; this.#menu = undefined;
    this.#previous = undefined;
    if (query.stage === "targets") { this.#target = undefined; this.#window = undefined; }
    const signal = AbortSignal.any([query.signal, this.#lifetime.signal]);
    const grant = await this.#config.verification.verified(signal);
    if (!grant || !this.#matches(query) || signal.aborted || epoch !== this.#epoch) return denied();
    if (query.stage === "targets") {
      const found = await this.#config.authority.list(query.scope, grant.verificationRef, query.from, query.to, query.now, signal);
      if (!found.ok) return denied();
      const choices: Choice[] = [];
      // Exclude appointments outside this approved provider/type/duration before speaking choices.
      for (const item of found.value.appointments) {
        const resolved = await this.#config.authority.resolveTarget(this.#bound(query, grant.verificationRef, found.value.patientRef, item.appointmentRef, signal));
        if (resolved.ok) choices.push({ ref: item.appointmentRef, startsAt: item.startsAt, endsAt: item.endsAt,
          expiresAt: new Date(Math.min(Date.parse(grant.expiresAt), Date.parse(resolved.value.terms.expiresAt))).toISOString() });
      }
      if (!await this.#fresh(query, grant.verificationRef, epoch, signal)) return denied();
      this.#menu = { stage: query.stage, turnId: query.turnId, verificationRef: grant.verificationRef, patientId: found.value.patientRef, choices };
      return ok(this.#snapshot(query, "targets", found.value.timeZone, choices));
    }
    if (!target || (!query.correctingAppointmentRef && query.priorTurnId !== target.turnId && !(previous?.stage === "offers" && query.priorTurnId === previous.turnId && previous.verificationRef === target.verificationRef && previous.patientId === target.patientId)) || grant.verificationRef !== target.verificationRef) return denied();
    const current = await this.#config.authority.resolveTarget(this.#bound(query, grant.verificationRef, target.patientId, target.targetRef, signal));
    if (!current.ok || query.correctingAppointmentRef && current.value.target.appointmentRef !== query.correctingAppointmentRef) return denied();
    const found = await this.#config.authority.listOffers(query.scope, grant.verificationRef, query.from, query.to, query.now, signal, this.#window);
    if (!found.ok || !await this.#fresh(query, grant.verificationRef, epoch, signal) || !query.correctingAppointmentRef && this.#target !== target) return denied();
    this.#target = target;
    const choices = found.value.choices.filter(item => item.startsAt !== current.value.target.startsAt);
    this.#menu = { stage: query.stage, turnId: query.turnId, verificationRef: grant.verificationRef, patientId: target.patientId, ...(found.value.window ? { window: found.value.window } : {}),
      choices: choices.map(item => ({ ref: item.offerRef, startsAt: item.startsAt, endsAt: item.endsAt, expiresAt: item.expiresAt })) };
    return ok({ stage: "offers", scope: query.scope, callId: query.callId, sessionId: query.sessionId, policyVersion: query.policyVersion,
      observedAt: found.value.observedAt, timeZone: found.value.timeZone, practitionerName: found.value.practitionerName,
      appointmentTypeName: found.value.appointmentTypeName, ...(found.value.window ? { window: found.value.window } : {}), reservable: false, choices: choices.map(({ startsAt, endsAt, expiresAt }) => ({ startsAt, endsAt, expiresAt })) });
  }
  async selectReschedulingMenu(incoming: ReschedulingMenuQuery & Readonly<{ menuTurnId: string; choice: 1 | 2 | 3 }>):
    ReturnType<ReschedulingMenuHost["selectReschedulingMenu"]> {
    const query = { ...incoming, scope: { ...incoming.scope } }, menu = this.#menu;
    if (!this.#matches(query) || !menu || menu.stage !== query.stage || menu.turnId !== query.menuTurnId || ![1,2,3].includes(query.choice)) return denied();
    this.#menu = undefined; const epoch = ++this.#epoch, target = this.#target;
    const chosen = menu.choices[query.choice-1], signal = AbortSignal.any([query.signal, this.#lifetime.signal]);
    const grant = await this.#config.verification.verified(signal);
    if (!chosen || !grant || grant.verificationRef !== menu.verificationRef || !this.#matches(query) || signal.aborted ||
        epoch !== this.#epoch || Date.parse(chosen.expiresAt) <= Date.parse(query.now)) return denied();
    if (query.stage === "targets") {
      const resolved = await this.#config.authority.resolveTarget(this.#bound(query, grant.verificationRef, menu.patientId, chosen.ref, signal));
      if (!resolved.ok || !await this.#fresh(query, grant.verificationRef, epoch, signal)) return denied();
      this.#target = { turnId: query.turnId, verificationRef: grant.verificationRef, patientId: menu.patientId, targetRef: chosen.ref };
      return ok({ kind: "targetSelected", snapshot: this.#snapshot(query, "selectedTarget", resolved.value.target.timeZone, [chosen]) });
    }
    this.#target = undefined;
    if (!target || target.patientId !== menu.patientId || target.verificationRef !== grant.verificationRef) return denied();
    this.#previous = { menu, target };
    return ok({ kind: "actionSelection", verificationRef: grant.verificationRef, targetRef: target.targetRef, offerRef: chosen.ref });
  }
  async correctReschedulingMenu(incoming: ReschedulingMenuQuery & Readonly<{ menuTurnId: string; startsAt: string }>):
    Promise<Result<Readonly<{ verificationRef: string; targetRef: string; offerRef: string }>, HostReadFailure>> {
    const query = { ...incoming, scope: { ...incoming.scope } }, previous = this.#previous;
    const chosen = previous?.menu.choices.find(item => item.startsAt === query.startsAt);
    if (!this.#matches(query) || query.stage !== "offers" || !previous || previous.menu.turnId !== query.menuTurnId ||
        !chosen || Date.parse(chosen.expiresAt) <= Date.parse(query.now)) return denied();
    const epoch = ++this.#epoch, signal = AbortSignal.any([query.signal, this.#lifetime.signal]), target = previous.target;
    if (!await this.#fresh(query, target.verificationRef, epoch, signal)) return denied();
    const current = await this.#config.authority.resolveTarget(this.#bound(query, target.verificationRef, target.patientId, target.targetRef, signal));
    if (!current.ok || current.value.target.startsAt === query.startsAt) return denied();
    const day = clinicDateAt(current.value.target.timeZone, new Date(query.startsAt));
    const fresh = await this.#config.authority.listOffers(query.scope, target.verificationRef, day, day, query.now, signal, previous.menu.window);
    const selected = fresh.ok ? fresh.value.choices.find(item => item.startsAt === query.startsAt && item.endsAt === chosen.endsAt) : undefined;
    if (!selected || !await this.#fresh(query, target.verificationRef, epoch, signal)) return denied();
    return ok({ verificationRef: target.verificationRef, targetRef: target.targetRef, offerRef: selected.offerRef });
  }
  dispose(): void { ++this.#epoch; this.#lifetime.abort(); this.#menu = undefined; this.#target = undefined; this.#previous = undefined; this.#window = undefined; }
}
