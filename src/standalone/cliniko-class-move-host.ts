import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { digestActionRequest } from "../core/digest.ts";
import { noticePresentationId } from "../core/notice-presentation-id.ts";
import { matchesBookingSearchWindow, validBookingSearchWindow } from "../core/booking-search-window.ts";
import { err, ok } from "../core/model.ts";
import type { ActionRequest, CallState, HostMutation, HostWriteReceipt, LocationScope, ReconcileObservation, Result, StaffItem, StaffTaskObservation, StaffTaskReceipt } from "../core/model.ts";
import type { AppointmentChangeEvidenceHost, AppointmentChangeEvidenceQuery, BookingEvidenceHost, BookingMenuQuery, HostEffects, HostReadFailure, PolicyStore, ReschedulingMenuHost, ReschedulingMenuQuery, ReschedulingMenuReadQuery } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import type { ReschedulingMenuRead } from "../core/rescheduling-menu.ts";
import { ClinikoClassAttendanceReader } from "../cliniko/class-attendance-read.ts";
import type { ClinikoClassSession as Occurrence } from "../cliniko/class-attendance-read.ts";
import type { ClinikoAttendanceConfig } from "../cliniko/class-attendance-write.ts";
import { checkClinikoHeadroom, clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { observedClassMoveRequests } from "../cliniko/class-move-workload.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import { ClinikoClassAttendanceMove } from "./cliniko-class-attendance-move.ts";
import type { ClinikoClassMovePhase } from "./cliniko-class-attendance-move.ts";
import type { ClinikoClassMoveRequest } from "./cliniko-class-attendance-move.ts";
import { ClinikoClassPassMovement } from "./cliniko-class-pass-movement.ts";
import type { ClassPassMoveAuthority } from "./cliniko-class-pass-movement.ts";
import type { ClassMovementPass } from "../cliniko/review-request.ts";
import { clinicDayStartUtc } from "./clinic-clock.ts";
import { OwnerFileClassMovePolicy } from "./owner-file-class-move-policy.ts";
import { approvalInstant } from "./owner-file-clinic-approval.ts";
import type { ClassMoveApproval } from "./owner-file-class-move-policy.ts";
import { OwnerFileClassPolicy } from "./owner-file-class-policy.ts";
import type { ClassApproval } from "./owner-file-class-policy.ts";
import { NoStoredKnowledge } from "./no-stored-knowledge.ts";
import { preparationMayBeDiscarded } from "./prepared-proposal.ts";

export type ClassMovePermission = Readonly<{ allows(query: Readonly<{
  operation: "reschedule"; scope: LocationScope; callId: string; sessionId: string; policyVersion: string;
  patientId: string; sourceClassSessionId: string; sourceAttendeeId: string; destinationClassSessionId?: string;
  phase: "targets" | "offers" | "proposal" | ClinikoClassMovePhase; termsVersion: string; signal: AbortSignal;
}>): Promise<boolean> }>;
export type ClinikoClassMoveHostConfig = Readonly<{
  scope: LocationScope; callId: string; sessionId: string; policyVersion: string;
  ledger: LedgerStore; policies: PolicyStore; verification: CallerVerificationSession;
  sourcePolicy: OwnerFileClassPolicy; destinationPolicy: OwnerFileClassPolicy; movePolicy: OwnerFileClassMovePolicy;
  permission: ClassMovePermission; cliniko: Omit<ClinikoAttendanceConfig, "scope">;
  classPassMoveAuthority?: ClassPassMoveAuthority;
  clock: () => string; signal: AbortSignal; fetchPort?: typeof fetch;
}>;
type Move = Extract<ActionRequest, { kind: "reschedule" }>;
type Context = Readonly<{ source: ClassApproval; destination: ClassApproval; move: ClassMoveApproval; grant: Readonly<{ verificationRef: string; expiresAt: string }>; version: string }>;
type Target = Readonly<{ ref: string; session: Occurrence; attendeeId: string; verificationRef: string; patientId: string; expiresAt: string; version: string }>;
type Offer = Readonly<{ ref: string; session: Occurrence; expiresAt: string; version: string; pass?: ClassMovementPass }>;
type Menu = Readonly<{ turnId: string; stage: "targets" | "offers"; version: string; targets?: readonly Target[]; offers?: readonly Offer[] }>;
type Prepared = Readonly<{ request: Move; target: Target; offer: Offer; revision: number; version: string }>;
const denied = <T>(): Result<T, HostReadFailure> => err({ kind: "unavailable", target: "appointment" });
const signature = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** One verified caller owns two played native occurrence selections and one SAM
 * proposal. Native IDs and recovery state remain private to this owner. */
export class ClinikoClassMoveHost extends NoStoredKnowledge implements ReschedulingMenuHost, AppointmentChangeEvidenceHost, BookingEvidenceHost, HostEffects {
  readonly effectDeadlineMs = 30000;
  readonly #config: ClinikoClassMoveHostConfig;
  readonly #source: ClinikoClassAttendanceReader;
  readonly #destination: ClinikoClassAttendanceReader;
  readonly #lifetime = new AbortController();
  #menu: Menu | undefined;
  #previous: Readonly<{ menu: Menu; target: Target; selectionTurnId: string }> | undefined;
  #target: Target | undefined;
  #offers = new Map<string, Offer>();
  #prepared: Prepared | undefined;
  #busy = false;
  #attempted = false;
  #epoch = 0;
  readonly #onClose = () => this.dispose();
  private constructor(config: ClinikoClassMoveHostConfig, source: ClassApproval, destination: ClassApproval) {
    super(); this.#config = config;
    const proof = { verifyPatient: (scope: LocationScope, ref: string, now: string, signal?: AbortSignal) => config.verification.proof.verifyOperation(scope, ref, "appointments.reschedule", now, signal) };
    const make = (approval: ClassApproval) => ClinikoClassAttendanceReader.create({ ...config.cliniko, scope: config.scope,
      practitionerId: approval.practitionerId, appointmentTypeId: approval.appointmentTypeId, className: approval.className }, proof, config.fetchPort, config.clock);
    const first = make(source), second = make(destination);
    if (!first.ok || !second.ok) throw new TypeError("invalid class move readers");
    this.#source = first.value;
    this.#destination = source.practitionerId === destination.practitionerId && source.appointmentTypeId === destination.appointmentTypeId ? first.value : second.value;
    config.signal.addEventListener("abort", this.#onClose, { once: true });
  }
  static async create(input: ClinikoClassMoveHostConfig): Promise<Result<ClinikoClassMoveHost, HostReadFailure>> {
    try {
      if (!(input.signal instanceof AbortSignal) || input.signal.aborted || !(input.verification instanceof CallerVerificationSession) ||
          !(input.sourcePolicy instanceof OwnerFileClassPolicy) || !(input.destinationPolicy instanceof OwnerFileClassPolicy) || !(input.movePolicy instanceof OwnerFileClassMovePolicy) ||
          !input.verification.proof.matchesCall(input.scope, input.callId, input.sessionId, input.policyVersion) ||
          !input.verification.matchesClinikoAccount(clinikoCredentialFingerprint(input.cliniko.apiKey)) || typeof input.permission?.allows !== "function") return denied();
      const config = Object.freeze({ ...input, scope: Object.freeze({ ...input.scope }), cliniko: Object.freeze({ ...input.cliniko }) });
      const signal = AbortSignal.any([config.signal, AbortSignal.timeout(15000)]);
      const [source, destination, move] = await Promise.all([config.sourcePolicy.current(config.scope), config.destinationPolicy.current(config.scope), config.movePolicy.current(config.scope)]);
      if (!source.ok || !destination.ok || !move.ok || signal.aborted || !this.#bindings(config, source.value, destination.value, move.value)) return denied();
      return ok(new ClinikoClassMoveHost(config, source.value, destination.value));
    } catch { return denied(); }
  }
  static #bindings(c: ClinikoClassMoveHostConfig, source: ClassApproval, destination: ClassApproval, move: ClassMoveApproval) {
    return source.membership === move.membership && destination.membership === move.membership &&
      (move.membership === "nativeCaseSessions" ? !!move.passMovement && typeof c.classPassMoveAuthority?.select === "function" && typeof c.classPassMoveAuthority?.allows === "function" :
        !move.passMovement && c.classPassMoveAuthority === undefined) && [source, destination, move].every(row => sameScope(row.scope, c.scope) && row.policyVersion === c.policyVersion &&
      row.businessId === c.cliniko.businessId && row.credentialFingerprint === clinikoCredentialFingerprint(c.cliniko.apiKey) && row.recallTypeId === move.recallTypeId && row.timeZone === move.timeZone) &&
      source.practitionerId === c.cliniko.practitionerId && source.appointmentTypeId === c.cliniko.appointmentTypeId &&
      source.serviceRef === move.sourceServiceRef && destination.serviceRef === move.destinationServiceRef;
  }
  #signal(external?: AbortSignal, ms = 15000) { return AbortSignal.any([this.#config.signal, this.#lifetime.signal, AbortSignal.timeout(ms), ...(external ? [external] : [])]); }
  #now() { return this.#config.clock(); }
  #proofRequestFloor(): 0 | 1 {
    return this.#config.verification.matchesClinikoAccount(clinikoCredentialFingerprint(this.#config.cliniko.apiKey)) ? 1 : 0;
  }
  #nativeRequest(context: Context, target: Target, offer: Offer): ClinikoClassMoveRequest {
    return { scope: this.#config.scope, patientId: target.patientId, verificationRef: target.verificationRef, actionId: randomUUID(),
      expiresAt: new Date(Math.min(Date.parse(target.expiresAt), Date.parse(offer.expiresAt))).toISOString(),
      source: { sessionId: target.session.sessionRef, attendeeId: target.attendeeId, startsAt: target.session.startsAt, endsAt: target.session.endsAt },
      destination: { sessionId: offer.session.sessionRef, startsAt: offer.session.startsAt, endsAt: offer.session.endsAt },
      cancellationReason: context.move.cancellationReason, compensation: context.move.compensation, ...(offer.pass ? { pass: offer.pass } : {}) };
  }
  #passEvidence(context: Context, target: Target, termsVersion?: string) {
    const c = this.#config, fee = OwnerFileClassMovePolicy.termsFor(context.move, target.session.startsAt, this.#now());
    if (!fee || !context.move.passMovement || !c.classPassMoveAuthority) return undefined;
    return new ClinikoClassPassMovement({ scope: c.scope, cliniko: c.cliniko, policyVersion: c.policyVersion,
      termsVersion: termsVersion ?? `class-move:${signature([context.version, fee.version])}`, timeZone: context.move.timeZone,
      source: context.source, destination: context.destination, authority: c.classPassMoveAuthority, stagingContractVersion: context.move.passMovement.version,
      proof: { verifyPatient: (scope, ref, at, signal) => c.verification.proof.verifyOperation(scope, ref, "appointments.reschedule", at, signal) },
      clock: c.clock, fetchPort: c.fetchPort ?? fetch });
  }
  async #ready(signal: AbortSignal, mutation?: HostMutation): Promise<CallState | undefined> {
    const c = this.#config, now = Date.parse(this.#now());
    const checked = await awaitUntilAbort(Promise.all([c.ledger.read(c.callId, c.scope), c.policies.read(c.scope), c.ledger.readWriteStop(c.scope)]), signal);
    if (!checked || signal.aborted || this.#lifetime.signal.aborted || !Number.isFinite(now)) return undefined;
    const [found, current, stop] = checked;
    if (!found.ok || !current.ok || !stop.ok || stop.value.stopped) return undefined;
    const valid = (p: CallState["policy"]) => sameScope(p.scope, c.scope) && p.policyVersion === c.policyVersion && p.automationEnabled && p.reschedulingEnabled === true && p.capabilities.reschedule === "execute" && p.staffWorkEnabled === true;
    const state = found.value;
    if (!valid(state.policy) || !valid(current.value) || state.lifecycle !== "active" || state.callerIdentityDenied || state.callId !== c.callId || !state.admission ||
        state.sessionLease?.sessionId !== c.sessionId || (!Number.isFinite(Date.parse(state.sessionLease.expiresAt)) || Date.parse(state.sessionLease.expiresAt) <= now)) return undefined;
    if (mutation) {
      const action = state.actions[mutation.actionKey], effect = state.effects[`${mutation.actionKey}:write`];
      if (action?.kind !== "reschedule" || action.status !== "dispatched" || action.digest !== mutation.payloadDigest || digestActionRequest(action.mutation.request) !== mutation.payloadDigest ||
          state.presentations[action.presentationId]?.status !== "played" || effect?.kind !== "hostWrite" || effect.status !== "possiblySent" || effect.mutation.actionKey !== mutation.actionKey || effect.mutation.payloadDigest !== mutation.payloadDigest) return undefined;
    }
    return state;
  }
  async #context(signal: AbortSignal, ref?: string, mutation?: HostMutation): Promise<Context | undefined> {
    const c = this.#config;
    if (!await this.#ready(signal, mutation)) return undefined;
    const [source, destination, move, grant] = await Promise.all([c.sourcePolicy.current(c.scope), c.destinationPolicy.current(c.scope), c.movePolicy.current(c.scope), c.verification.ownedGrant("appointments.reschedule", signal)]);
    if (!source.ok || !destination.ok || !move.ok || !grant || ref && ref !== grant.verificationRef || !ClinikoClassMoveHost.#bindings(c, source.value, destination.value, move.value) || !await this.#ready(signal, mutation)) return undefined;
    return { source: source.value, destination: destination.value, move: move.value, grant, version: signature([source.value, destination.value, move.value]) };
  }
  async #permit(context: Context, target: Target, offer: Offer | undefined, phase: "targets" | "offers" | "proposal" | ClinikoClassMovePhase, signal: AbortSignal): Promise<boolean> {
    const c = this.#config;
    try { return await awaitUntilAbort(c.permission.allows({ operation: "reschedule", scope: { ...c.scope }, callId: c.callId, sessionId: c.sessionId, policyVersion: c.policyVersion,
      patientId: target.patientId, sourceClassSessionId: target.session.sessionRef, sourceAttendeeId: target.attendeeId,
      ...(offer ? { destinationClassSessionId: offer.session.sessionRef } : {}), phase, termsVersion: context.version, signal }), signal) === true && !signal.aborted; }
    catch { return false; }
  }
  #matches(query: BookingMenuQuery) {
    const c = this.#config, now = Date.parse(query.now), actual = Date.parse(this.#now());
    return sameScope(query.scope, c.scope) && query.callId === c.callId && query.sessionId === c.sessionId && query.policyVersion === c.policyVersion && !query.signal.aborted &&
      Number.isFinite(now) && Number.isFinite(actual) && Math.abs(now - actual) <= 30000;
  }
  #expires(context: Context) { return new Date(Math.min(Date.parse(this.#now()) + Math.min(context.source.offerTtlSeconds, context.destination.offerTtlSeconds, context.move.offerTtlSeconds) * 1000,
    ...[context.source.effectiveUntil, context.destination.effectiveUntil, context.move.effectiveUntil, context.grant.expiresAt].map(Date.parse))).toISOString(); }
  #range(query: ReschedulingMenuReadQuery, context: Context) {
    if (query.stage === "targets") {
      const first = approvalInstant(query.from), last = approvalInstant(query.to), now = Date.parse(this.#now());
      if (first !== undefined && last !== undefined) {
        const from = Math.max(first, now);
        return Number.isFinite(now) && last > from && last - first <= 7 * 86400000 && last - now <= context.move.maxAdvanceDays * 86400000
          ? { from: new Date(from).toISOString(), to: query.to } : undefined;
      }
    }
    const day = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if (!day(query.from) || !day(query.to) || query.from > query.to || Date.parse(query.to) - Date.parse(query.from) > 6 * 86400000) return undefined;
    const from = new Date(Math.max(Date.parse(this.#now()), Date.parse(clinicDayStartUtc(context.move.timeZone, query.from)))).toISOString();
    const to = clinicDayStartUtc(context.move.timeZone, new Date(Date.parse(query.to) + 86400000).toISOString().slice(0, 10));
    return Date.parse(to) > Date.parse(from) && Date.parse(to) - Date.parse(this.#now()) <= context.move.maxAdvanceDays * 86400000 ? { from, to } : undefined;
  }
  #snapshot(context: Context, stage: "targets" | "selectedTarget" | "offers", choices: readonly (Target | Offer)[]): ReschedulingMenuRead {
    const c = this.#config;
    return { scope: { ...c.scope }, callId: c.callId, sessionId: c.sessionId, policyVersion: c.policyVersion, observedAt: this.#now(), timeZone: context.move.timeZone, stage,
      reservable: false, choices: choices.map(choice => ({ startsAt: choice.session.startsAt, endsAt: choice.session.endsAt, expiresAt: choice.expiresAt })),
      ...(stage === "offers" ? { practitionerName: context.destination.practitionerName, appointmentTypeName: context.destination.className, locationName: context.destination.locationName } : {}) } as ReschedulingMenuRead;
  }
  reschedulingMenuAvailable() { return !this.#attempted && !this.#lifetime.signal.aborted && !this.#config.signal.aborted; }
  async readReschedulingMenu(query: ReschedulingMenuReadQuery): Promise<Result<ReschedulingMenuRead, HostReadFailure>> {
    if (!this.#matches(query) || this.#busy || this.#attempted || query.stage === "practitioners" || query.nextPractitioners ||
        query.window != null && !validBookingSearchWindow(query.window)) return denied();
    this.#busy = true; const epoch = ++this.#epoch, signal = this.#signal(query.signal);
    try {
      const state = await this.#ready(signal), context = await this.#context(signal);
      if (!state || !context || this.#prepared && !preparationMayBeDiscarded(state, this.#prepared.request, this.#prepared.revision)) return denied();
      const range = this.#range(query, context); if (!range) return denied();
      const target = this.#target;
      const correcting = query.stage === "offers" && query.correctingAppointmentRef === target?.ref && !!this.#prepared &&
        this.#prepared.target === target && preparationMayBeDiscarded(state, this.#prepared.request, this.#prepared.revision);
      if (query.correctingAppointmentRef !== undefined && !correcting) return denied();
      if (query.stage === "offers" && (!target || target.version !== context.version || Date.parse(target.expiresAt) <= Date.parse(this.#now()) ||
          !correcting && (!query.priorTurnId || state.processedTurnIds.at(-1) !== query.priorTurnId || state.presentations[noticePresentationId(this.#config.callId, query.priorTurnId)]?.status !== "played"))) return denied();
      this.#menu = undefined; this.#previous = undefined; this.#offers.clear(); this.#prepared = undefined;
      if (query.stage === "targets") this.#target = undefined;
      const read = await (query.stage === "targets" ? this.#source : this.#destination).candidates(query.scope, context.grant.verificationRef, range.from, range.to, this.#now(), signal);
      if (!read.ok || query.stage === "offers" && read.value.patientRef !== target!.patientId || read.value.timeZone !== context.move.timeZone) return denied();
      const expiresAt = this.#expires(context), targets: Target[] = [], offers: Offer[] = [];
      for (const session of read.value.sessions) {
        if (session.attendance.kind === "ambiguous") return denied();
        const duration = Date.parse(session.endsAt) - Date.parse(session.startsAt);
        if (query.stage === "targets") {
          if (session.attendance.kind !== "one") continue;
          if (duration !== context.source.durationMinutes * 60000 || !OwnerFileClassMovePolicy.termsFor(context.move, session.startsAt, this.#now())) return denied();
          const item: Target = { ref: `class-move-target:${randomUUID()}`, session, attendeeId: session.attendance.attendeeRef, patientId: read.value.patientRef,
            verificationRef: context.grant.verificationRef, expiresAt, version: context.version };
          if (!await this.#permit(context, item, undefined, "targets", signal)) return denied();
          targets.push(item);
        } else {
          if (session.sessionRef === target!.session.sessionRef || session.attendance.kind !== "none" || session.remainingPlaces < 1 || session.overCapacity ||
              duration !== context.destination.durationMinutes * 60000 || Date.parse(session.startsAt) < Date.parse(this.#now()) + context.destination.minNoticeMinutes * 60000 ||
              Date.parse(session.startsAt) - Date.parse(this.#now()) > Math.min(context.move.maxAdvanceDays, context.destination.maxAdvanceDays) * 86400000 ||
              query.window && !matchesBookingSearchWindow(session.startsAt, context.move.timeZone, query.window)) continue;
          let item: Offer = { ref: `class-move-offer:${randomUUID()}`, session, expiresAt, version: context.version };
          if (!await this.#permit(context, target!, item, "offers", signal)) return denied();
          if (context.move.membership === "nativeCaseSessions") {
            const observed = await this.#passEvidence(context, target!)?.selectWithWorkload(this.#nativeRequest(context, target!, item), "proposal", signal);
            const requests = observed && observedClassMoveRequests(observed.minimumNativeRequests, target!.session, item.session, this.#source === this.#destination);
            if (!observed || requests === undefined || requests + 9 * this.#proofRequestFloor() > 180) continue;
            const pass = observed.binding;
            Object.freeze(pass.source); Object.freeze(pass.destination); Object.freeze(pass);
            item = { ...item, pass };
          }
          offers.push(item);
        }
      }
      const choices = query.stage === "targets" ? targets : offers;
      choices.sort((a, b) => a.session.startsAt.localeCompare(b.session.startsAt));
      if (new Set(choices.map(item => item.session.startsAt)).size !== choices.length) return denied();
      const current = await this.#context(signal, context.grant.verificationRef);
      if (!current || current.version !== context.version || !await this.#ready(signal) || epoch !== this.#epoch) return denied();
      this.#menu = { turnId: query.turnId, stage: query.stage, version: context.version,
        ...(query.stage === "targets" ? { targets: targets.slice(0, 3) } : { offers: offers.slice(0, 3) }) };
      const snapshot = this.#snapshot(context, query.stage, choices.slice(0, 3));
      return ok(snapshot.stage === "offers" && query.window ? { ...snapshot, window: structuredClone(query.window) } : snapshot);
    } catch { return denied(); }
    finally { this.#busy = false; }
  }
  async selectReschedulingMenu(query: ReschedulingMenuQuery & Readonly<{ menuTurnId: string; choice: 1 | 2 | 3 }>) {
    const menu = this.#menu;
    if (!menu || menu.turnId !== query.menuTurnId || menu.stage !== query.stage || ![1, 2, 3].includes(query.choice) || !this.#matches(query) || this.#busy || this.#attempted) return denied<never>();
    this.#busy = true; this.#menu = undefined; const signal = this.#signal(query.signal), epoch = ++this.#epoch;
    try {
      const context = await this.#context(signal), state = await this.#ready(signal);
      if (!context || !state || context.version !== menu.version || state.pendingPresentationId || state.processedTurnIds.at(-1) !== menu.turnId ||
          state.presentations[noticePresentationId(query.callId, menu.turnId)]?.status !== "played") return denied<never>();
      const target = menu.stage === "targets" ? menu.targets?.[query.choice - 1] : this.#target, offer = menu.stage === "offers" ? menu.offers?.[query.choice - 1] : undefined;
      if (!target || Date.parse(target.expiresAt) <= Date.parse(this.#now()) || menu.stage === "offers" && (!offer || Date.parse(offer.expiresAt) <= Date.parse(this.#now())) ||
          !await this.#config.verification.verifiedSubject("appointments.reschedule", signal) || !await this.#permit(context, target, offer, "proposal", signal) || epoch !== this.#epoch) return denied<never>();
      const current = await this.#context(signal, target.verificationRef);
      if (!current || current.version !== menu.version) return denied<never>();
      if (menu.stage === "targets") { this.#target = target; return ok({ kind: "targetSelected" as const, snapshot: this.#snapshot(context, "selectedTarget", [target]) as Exclude<ReschedulingMenuRead, import("../core/rescheduling-menu.ts").ReschedulingPractitionerRead> }); }
      this.#previous = { menu, target, selectionTurnId: query.turnId };
      this.#offers.set(offer!.ref, offer!);
      return ok({ kind: "actionSelection" as const, verificationRef: target.verificationRef, targetRef: target.ref, offerRef: offer!.ref });
    } catch { return denied<never>(); }
    finally { this.#busy = false; }
  }
  async correctReschedulingMenu(query: ReschedulingMenuQuery & Readonly<{ menuTurnId: string; startsAt: string }>): Promise<Result<Readonly<{ verificationRef: string; targetRef: string; offerRef: string }>, HostReadFailure>> {
    const previous = this.#previous, target = previous?.target, offer = previous?.menu.offers?.find(item => item.session.startsAt === query.startsAt);
    if (!previous || !target || !offer || query.stage !== "offers" || previous.menu.turnId !== query.menuTurnId ||
        !this.#matches(query) || this.#busy || this.#attempted || !this.#prepared || this.#target !== target ||
        this.#prepared.request.offer.startsAt === offer.session.startsAt) return denied();
    this.#busy = true; const signal = this.#signal(query.signal), epoch = ++this.#epoch;
    try {
      const state = await this.#ready(signal), context = await this.#context(signal, target.verificationRef);
      if (!state || !context || previous.menu.version !== context.version || target.version !== context.version || offer.version !== context.version ||
          state.processedTurnIds.at(-1) !== previous.selectionTurnId ||
          state.presentations[noticePresentationId(query.callId, previous.menu.turnId)]?.status !== "played" ||
          !preparationMayBeDiscarded(state, this.#prepared.request, this.#prepared.revision) ||
          !this.#request(context, target, offer) || !await this.#config.verification.verifiedSubject("appointments.reschedule", signal) ||
          !await this.#permit(context, target, offer, "proposal", signal)) return denied();
      const current = await this.#context(signal, target.verificationRef);
      if (!current || current.version !== context.version || signal.aborted || epoch !== this.#epoch || this.#previous !== previous) return denied();
      // Only map an already played private choice. Ordinary proposal resolution
      // must still re-inspect both exact occurrences before new SAM consent.
      this.#offers.set(offer.ref, offer);
      this.#previous = { ...previous, selectionTurnId: query.turnId };
      return ok({ verificationRef: target.verificationRef, targetRef: target.ref, offerRef: offer.ref });
    } catch { return denied(); }
    finally { this.#busy = false; }
  }
  async #nativePair(context: Context, target: Target, offer: Offer, signal: AbortSignal) {
    const from = target.session.startsAt < offer.session.startsAt ? target.session.startsAt : offer.session.startsAt, to = target.session.endsAt > offer.session.endsAt ? target.session.endsAt : offer.session.endsAt;
    const reads = this.#source === this.#destination ? [await this.#source.inspectPair(this.#config.scope, target.verificationRef, [target.session.sessionRef, offer.session.sessionRef], from, to, this.#now(), signal)] :
      [await this.#source.inspect(this.#config.scope, target.verificationRef, target.session.sessionRef, from, to, this.#now(), signal),
        await this.#destination.inspect(this.#config.scope, target.verificationRef, offer.session.sessionRef, from, to, this.#now(), signal)];
    if (reads.some(read => !read.ok || read.value.patientRef !== target.patientId || read.value.timeZone !== context.move.timeZone)) return false;
    const sessions = reads.flatMap(read => read.ok ? read.value.sessions : []), source = sessions.find(row => row.sessionRef === target.session.sessionRef), destination = sessions.find(row => row.sessionRef === offer.session.sessionRef);
    if (!(!!source && source.startsAt === target.session.startsAt && source.endsAt === target.session.endsAt && source.attendance.kind === "one" && source.attendance.attendeeRef === target.attendeeId &&
      !!destination && destination.startsAt === offer.session.startsAt && destination.endsAt === offer.session.endsAt && destination.attendance.kind === "none" && destination.remainingPlaces > 0 && !destination.overCapacity &&
      ((context.move.membership === "nativeCaseSessions") === !!offer.pass))) return false;
    if (!offer.pass) return true;
    const current = await this.#passEvidence(context, target)?.selectWithWorkload(this.#nativeRequest(context, target, offer), "proposal", signal);
    const requests = current && observedClassMoveRequests(current.minimumNativeRequests, source, destination, this.#source === this.#destination);
    return !!current && isDeepStrictEqual(current.binding, offer.pass) && requests !== undefined && requests + 9 * this.#proofRequestFloor() <= 180;
  }
  #request(context: Context, target: Target, offer: Offer): Move | undefined {
    const now = this.#now(), at = Date.parse(now), start = Date.parse(offer.session.startsAt), end = Date.parse(offer.session.endsAt);
    if (!Number.isFinite(at) || !Number.isFinite(start) || !Number.isFinite(end) ||
        start - at < context.destination.minNoticeMinutes * 60000 ||
        start - at > Math.min(context.move.maxAdvanceDays, context.destination.maxAdvanceDays) * 86400000 ||
        end - start !== context.destination.durationMinutes * 60000) return undefined;
    const fee = OwnerFileClassMovePolicy.termsFor(context.move, target.session.startsAt, now);
    const expiresAt = new Date(Math.min(Date.parse(target.expiresAt), Date.parse(offer.expiresAt))).toISOString();
    if (!fee || Date.parse(expiresAt) <= at) return undefined;
    if ((context.move.membership === "nativeCaseSessions") !== !!offer.pass) return undefined;
    const passTerms = offer.pass ? OwnerFileClassMovePolicy.passTermsFor(context.move, offer.pass) : undefined;
    if (offer.pass && !passTerms) return undefined;
    const approvedText = `Move only your ${context.source.className} attendance. ${fee.approvedText} ${passTerms ? `${passTerms.approvedText} ` : ""}${context.move.recoveryTerms.approvedText}`;
    if (approvedText.length > 500) return undefined;
    return { kind: "reschedule", patient: { scope: { ...context.source.scope }, patientRef: target.patientId, verificationRef: target.verificationRef, expiresAt: context.grant.expiresAt }, target: { scope: { ...context.source.scope }, appointmentRef: target.ref, patientRef: target.patientId,
      startsAt: target.session.startsAt, endsAt: target.session.endsAt, timeZone: context.move.timeZone }, offer: { scope: { ...context.source.scope }, offerRef: offer.ref,
      serviceRef: context.destination.serviceRef, startsAt: offer.session.startsAt, expiresAt, presentation: { timeZone: context.move.timeZone, practitionerName: context.destination.practitionerName,
        appointmentTypeName: context.destination.className, locationName: context.destination.locationName, durationMinutes: context.destination.durationMinutes } },
      terms: { version: `class-move:${signature([context.version, fee.version, ...(offer.pass ? [passTerms!.version, offer.pass] : [])])}`, approvedText, expiresAt },
      ...(context.source.practitionerId !== context.destination.practitionerId ? { practitionerChange: true as const } : {}),
      ...(context.source.serviceRef !== context.destination.serviceRef || context.source.durationMinutes !== context.destination.durationMinutes ? { serviceChange: { fromServiceName: context.source.className } } : {}) };
  }
  async resolveAppointmentChange(query: AppointmentChangeEvidenceQuery, external?: AbortSignal): Promise<Result<Move, HostReadFailure>> {
    const c = this.#config, target = this.#target, offer = query.kind === "reschedule" ? this.#offers.get(query.offerRef) : undefined;
    if (query.kind !== "reschedule" || !target || !offer || query.targetRef !== target.ref || query.verificationRef !== target.verificationRef || !sameScope(query.scope, c.scope) ||
        query.callId !== c.callId || query.sessionId !== c.sessionId || query.policyVersion !== c.policyVersion || this.#busy || this.#attempted) return denied();
    this.#busy = true; const signal = this.#signal(external);
    try {
      const state = await this.#ready(signal), context = await this.#context(signal, target.verificationRef);
      if (!state || !context || context.version !== target.version || context.version !== offer.version || this.#prepared && !preparationMayBeDiscarded(state, this.#prepared.request, this.#prepared.revision) ||
          !await this.#permit(context, target, offer, "proposal", signal) || !await this.#nativePair(context, target, offer, signal)) return denied();
      const current = await this.#context(signal, target.verificationRef), after = await this.#ready(signal);
      if (!current || current.version !== context.version || !after || after.conversationRevision !== state.conversationRevision || !await this.#permit(current, target, offer, "proposal", signal)) return denied();
      const request = this.#request(current, target, offer); if (!request) return denied();
      this.#prepared = { request, target, offer, version: context.version, revision: state.conversationRevision };
      return ok(request);
    } catch { return denied(); }
    finally { this.#busy = false; }
  }
  async resolveBooking(): Promise<Result<Extract<ActionRequest, { kind: "book" }>, HostReadFailure>> { return denied(); }
  async checkConfirmationCapacity(query: BookingMenuQuery & Readonly<{ actionKey: string; digest: string }>): Promise<Result<Readonly<{ kind: "ready" }> | Readonly<{ kind: "wait"; seconds: number }>, HostReadFailure>> {
    const p = this.#prepared;
    if (!p || this.#busy || this.#attempted || !this.#matches(query) || digestActionRequest(p.request) !== query.digest) return denied();
    const signal = this.#signal(query.signal), state = await this.#ready(signal), context = await this.#context(signal, p.target.verificationRef);
    const pending = (value: CallState | undefined) => value?.actions[query.actionKey]?.status === "awaitingConfirmation" &&
      value.actions[query.actionKey]!.digest === query.digest && value.presentations[value.actions[query.actionKey]!.presentationId]?.status === "played";
    const request = context ? this.#request(context, p.target, p.offer) : undefined;
    if (!pending(state) || !context || context.version !== p.version || !request || digestActionRequest(request) !== query.digest ||
        !await this.#permit(context, p.target, p.offer, "review", signal) || p.offer.pass &&
        await this.#passEvidence(context, p.target, request.terms.version)?.authorized(p.offer.pass, this.#nativeRequest(context, p.target, p.offer), "commit", signal) !== true) return denied();
    const same = context.source.practitionerId === context.destination.practitionerId && context.source.appointmentTypeId === context.destination.appointmentTypeId;
    const capacity = await checkClinikoHeadroom(this.#config.cliniko.rateBudget, p.offer.pass ? 180 : same ? 120 : 180);
    const after = await this.#context(signal, p.target.verificationRef), current = await this.#ready(signal);
    const refreshed = after ? this.#request(after, p.target, p.offer) : undefined;
    if (!after || after.version !== p.version || !pending(current) || current!.conversationRevision !== state!.conversationRevision ||
        !refreshed || digestActionRequest(refreshed) !== query.digest || this.#prepared !== p || signal.aborted ||
        !await this.#permit(after, p.target, p.offer, "review", signal) || p.offer.pass &&
        await this.#passEvidence(after, p.target, refreshed.terms.version)?.authorized(p.offer.pass, this.#nativeRequest(after, p.target, p.offer), "commit", signal) !== true) return denied();
    if (capacity === null) return ok({ kind: "ready" });
    if (capacity.kind !== "rateLimited" || !Number.isSafeInteger(capacity.retryAfterMs) || capacity.retryAfterMs! < 1 || capacity.retryAfterMs! > 60000) return denied();
    const seconds = Math.ceil(capacity.retryAfterMs! / 1000);
    if (Date.parse(request.terms.expiresAt) <= Date.parse(this.#now()) + (seconds + 3) * 1000) return err({ kind: "expired", target: "offer" });
    return ok({ kind: "wait", seconds });
  }
  async write(mutation: HostMutation, now: string, external?: AbortSignal): Promise<HostWriteReceipt> {
    const p = this.#prepared, c = this.#config, reject = (): HostWriteReceipt => ({ kind: "rejected", actionKey: mutation.actionKey, reason: "forbidden" });
    if (!p || this.#attempted || this.#busy || mutation.kind !== "reschedule" || mutation.request.kind !== "reschedule" || mutation.notification || !sameScope(mutation.scope, c.scope) ||
        mutation.policyVersion !== c.policyVersion || mutation.payloadDigest !== digestActionRequest(p.request) || digestActionRequest(mutation.request) !== mutation.payloadDigest ||
        !Number.isFinite(Date.parse(now)) || Math.abs(Date.parse(now) - Date.parse(this.#now())) > 30000) return reject();
    this.#attempted = true; const signal = this.#signal(external, 30000), context = await this.#context(signal, p.target.verificationRef, mutation);
    const request = context ? this.#request(context, p.target, p.offer) : undefined;
    if (!context || context.version !== p.version || !request || digestActionRequest(request) !== mutation.payloadDigest) return reject();
    const sameService = context.source.practitionerId === context.destination.practitionerId && context.source.appointmentTypeId === context.destination.appointmentTypeId;
    if (await checkClinikoHeadroom(c.cliniko.rateBudget, p.offer.pass ? 180 : sameService ? 120 : 180) !== null || signal.aborted) return reject();
    const mover = ClinikoClassAttendanceMove.create({ scope: c.scope, cliniko: c.cliniko,
      source: { practitionerId: context.source.practitionerId, appointmentTypeId: context.source.appointmentTypeId, className: context.source.className },
      destination: { practitionerId: context.destination.practitionerId, appointmentTypeId: context.destination.appointmentTypeId, className: context.destination.className },
      proof: { verifyPatient: (scope, ref, at, stop) => c.verification.proof.verifyOperation(scope, ref, "appointments.reschedule", at, stop) },
      policyVersion: c.policyVersion, termsVersion: p.request.terms.version, timeZone: context.move.timeZone, recallTypeId: context.move.recallTypeId, clock: c.clock, signal,
      proofNativeRequestFloor: this.#proofRequestFloor(),
      ...(p.offer.pass && context.move.passMovement && c.classPassMoveAuthority ? { casePass: { authority: c.classPassMoveAuthority, stagingContractVersion: context.move.passMovement.version } } : {}),
      ...(c.fetchPort ? { fetchPort: c.fetchPort } : {}) });
    if (!mover.ok) return reject();
    const result = await mover.value.executeOnce({ ...this.#nativeRequest(context, p.target, p.offer), expiresAt: p.request.terms.expiresAt }, signal, async query => {
        const current = await this.#context(query.signal, p.target.verificationRef, mutation);
        const fresh = current ? this.#request(current, p.target, p.offer) : undefined;
        if (!current || current.version !== p.version || !fresh || digestActionRequest(fresh) !== mutation.payloadDigest || !await this.#permit(current, p.target, p.offer, query.phase, query.signal)) return false;
        const after = await this.#context(query.signal, p.target.verificationRef, mutation);
        return !!after && after.version === p.version && !!await this.#ready(query.signal, mutation) && await this.#permit(after, p.target, p.offer, query.phase, query.signal);
      });
    if (!result.ok || result.value.kind === "notSent" && result.value.review !== "uncertain" || result.value.kind === "restored") return reject();
    if (result.value.kind === "moved" && !signal.aborted && await this.#ready(signal, mutation)) return { kind: "committed", actionKey: mutation.actionKey, hostRef: result.value.replacementAttendeeRef! };
    return { kind: "uncertain", actionKey: mutation.actionKey, reconcileAfter: now, deadline: new Date(Date.parse(now) + 300000).toISOString() };
  }
  async reconcile(mutation: HostMutation): Promise<ReconcileObservation> { return { kind: "stillUnknown", actionKey: mutation.actionKey }; }
  async openTask(item: StaffItem): Promise<StaffTaskReceipt> { return { kind: "rejected", taskKey: item.key }; }
  async reconcileTask(item: StaffItem): Promise<StaffTaskObservation> { return { kind: "stillUnknown", taskKey: item.key }; }
  dispose() { this.#config.signal.removeEventListener("abort", this.#onClose); this.#lifetime.abort(); this.#menu = undefined; this.#previous = undefined; this.#target = undefined; this.#offers.clear(); this.#prepared = undefined; ++this.#epoch; }
}
