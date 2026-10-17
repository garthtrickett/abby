import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ClinikoClassAttendanceReader } from "../cliniko/class-attendance-read.ts";
import type { ClinikoClassSession } from "../cliniko/class-attendance-read.ts";
import { ClinikoClassAttendanceWriter } from "../cliniko/class-attendance-write.ts";
import type { ClinikoAttendanceConfig, ClinikoAttendanceRequest, ClinikoAttendanceWrite } from "../cliniko/class-attendance-write.ts";
import { ClinikoRecallWriter } from "../cliniko/recall-write.ts";
import type { ClinikoReviewRequest } from "../cliniko/review-request.ts";
import { checkClinikoHeadroom, clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { digestActionRequest } from "../core/digest.ts";
import { matchesBookingSearchWindow, validBookingSearchWindow } from "../core/booking-search-window.ts";
import type { BookingSearchWindow } from "../core/booking-search-window.ts";
import type { BookingMenuRead } from "../core/booking-menu.ts";
import type { BookingEvidenceHost, BookingMenuHost, BookingMenuQuery, BookingMenuReadQuery, HostEffects, HostReadFailure, PolicyStore } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { ActionRequest, BookableOffer, CallState, HostMutation, HostWriteReceipt, LocationScope, ReconcileObservation, Result, StaffItem, StaffTaskObservation, StaffTaskReceipt, VerifiedPatient } from "../core/model.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import { clinicDateAt, clinicDayStartUtc } from "./clinic-clock.ts";
import { ClinikoReviewedSend } from "./cliniko-reviewed-send.ts";
import { OwnerFileClassPolicy } from "./owner-file-class-policy.ts";
import type { ClassApproval } from "./owner-file-class-policy.ts";
import { approvalInstant, approvalRef } from "./owner-file-clinic-approval.ts";
import { NoStoredKnowledge } from "./no-stored-knowledge.ts";
import { preparationMayBeDiscarded } from "./prepared-proposal.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ClinikoClassPassBooking } from "./cliniko-class-pass-booking.ts";
import type { ClassPassAuthority, ClassPassBookingBinding } from "./cliniko-class-pass-booking.ts";
import { ClinikoFinancialBookingPreparation } from "./cliniko-financial-booking-preparation.ts";
import type { FinancialBookingPreparationConfig } from "./cliniko-financial-booking-preparation.ts";
/** Channel verification cannot establish a membership, pass, fee or booking entitlement. */
export type ClassAttendancePermission = Readonly<{
  allows(query: Readonly<{
    scope: LocationScope;
    callId: string;
    sessionId: string;
    policyVersion: string;
    patientId: string;
    classSessionId: string;
    phase: "proposal" | "commit" | "inspection";
    termsVersion: string;
    signal: AbortSignal;
  }>): Promise<boolean>;
}>;
export type ClinikoClassBookingConfig = Readonly<{
  scope: LocationScope;
  callId: string;
  sessionId: string;
  policyVersion: string;
  ledger: LedgerStore;
  policies: PolicyStore;
  verification: CallerVerificationSession;
  classPolicy: OwnerFileClassPolicy;
  permission: ClassAttendancePermission;
  classPassAuthority?: ClassPassAuthority;
  financial?: FinancialBookingPreparationConfig;
  cliniko: Omit<ClinikoAttendanceConfig, "scope">;
  clock: () => string;
  signal: AbortSignal;
  fetchPort?: typeof fetch;
}>;
type Booking = Extract<ActionRequest, {
  kind: "book";
}>;
type Choice = Readonly<{
  offer: BookableOffer;
  session: ClinikoClassSession;
  patientRef: string;
  verificationRef: string;
  pass?: ClassPassBookingBinding;
}>;
type Prepared = Readonly<{
  request: Booking;
  choice: Choice;
  revision: number;
}>;
const denied = <T>(): Result<T, HostReadFailure> => err({ kind: "unavailable", target: "offer" });
/** The existing SAM book action creates one attendance, not a new shared class.
 * Native IDs, proof, membership and class choice remain in this live host. */
export class ClinikoClassBookingHost extends NoStoredKnowledge implements BookingMenuHost, BookingEvidenceHost, HostEffects {
  readonly effectDeadlineMs = 30000;
  readonly #config: ClinikoClassBookingConfig;
  readonly #reader: ClinikoClassAttendanceReader;
  readonly #writer: ClinikoClassAttendanceWriter;
  readonly #review: ClinikoReviewedSend;
  readonly #passes?: ClinikoClassPassBooking;
  readonly #lifetime = new AbortController();
  readonly financial: ClinikoFinancialBookingPreparation | undefined;
  #financialMarker: string | undefined;
  readonly #choices = new Map<string, Choice>();
  #menu: {
    turnId: string;
    choices: Choice[];
  } | undefined;
  #previous: { turnId: string; choices: Choice[] } | undefined;
  #window: BookingSearchWindow | undefined;
  #prepared: Prepared | undefined;
  #busy = false;
  #attempted = false;
  #epoch = 0;
  #dispatchLeaseExpiry: number | undefined;
  private constructor(config: ClinikoClassBookingConfig, approval: ClassApproval) {
    super();
    this.#config = config;
    if (config.financial && config.financial.native.rateBudget !== config.cliniko.rateBudget) throw new TypeError("Financial class booking must share the physical Cliniko budget");
    this.financial = config.financial ? new ClinikoFinancialBookingPreparation(config.financial, config) : undefined;
    const fetchPort = config.fetchPort ?? fetch;
    const reader = ClinikoClassAttendanceReader.create({ ...config.cliniko, scope: config.scope, className: approval.className }, { verifyPatient: (scope, ref, now, signal) => config.verification.proof.verifyOperation(scope, ref, "appointments.book", now, signal) }, fetchPort, config.clock);
    const writer = ClinikoClassAttendanceWriter.create({ ...config.cliniko, scope: config.scope }, fetchPort);
    const recalls = ClinikoRecallWriter.create({ ...config.cliniko, scope: config.scope }, fetchPort);
    if (!reader.ok || !writer.ok || !recalls.ok)
      throw new TypeError("invalid class provider composition");
    this.#reader = reader.value;
    this.#writer = writer.value;
    if (approval.membership === "nativeCaseSessions") this.#passes = new ClinikoClassPassBooking({ ...config,
      policy: config.classPolicy, authority: config.classPassAuthority!, fetchPort,
      proof: { verifyPatient: (scope, ref, now, signal) => config.verification.proof.verifyOperation(scope, ref, "appointments.book", now, signal) } });
    this.#review = new ClinikoReviewedSend({ scope: config.scope, businessId: approval.businessId, credentialFingerprint: approval.credentialFingerprint,
      policyVersion: config.policyVersion, timeZone: approval.timeZone, recallTypeId: approval.recallTypeId, writer: recalls.value, clock: () => Date.parse(config.clock()) });
    config.signal.addEventListener("abort", this.#onClose, { once: true });
  }
  readonly #onClose = () => this.dispose();
  static async create(input: ClinikoClassBookingConfig): Promise<Result<ClinikoClassBookingHost, HostReadFailure>> {
    try {
      if (!(input.signal instanceof AbortSignal) || input.signal.aborted || !(input.verification instanceof CallerVerificationSession) ||
        !(input.classPolicy instanceof OwnerFileClassPolicy) || !input.verification.proof.matchesCall(input.scope, input.callId, input.sessionId, input.policyVersion) ||
        !input.verification.matchesClinikoAccount(clinikoCredentialFingerprint(input.cliniko.apiKey)) ||
        ![input.callId, input.sessionId, input.policyVersion].every(approvalRef) || typeof input.permission?.allows !== "function" ||
        typeof input.ledger?.read !== "function" || typeof input.ledger?.readWriteStop !== "function" || typeof input.policies?.read !== "function" || typeof input.clock !== "function")
        return denied();
      const config = Object.freeze({ ...input, scope: Object.freeze({ ...input.scope }), cliniko: Object.freeze({ ...input.cliniko }) });
      const approval = await awaitUntilAbort(config.classPolicy.current(config.scope), AbortSignal.any([config.signal, AbortSignal.timeout(15000)]));
      if (!approval?.ok || config.signal.aborted || approval.value.policyVersion !== config.policyVersion || approval.value.credentialFingerprint !== clinikoCredentialFingerprint(config.cliniko.apiKey) ||
        ["businessId", "practitionerId", "appointmentTypeId"].some(key => config.cliniko[key as "businessId"] !== approval.value[key as "businessId"]) ||
        (approval.value.membership === "nativeCaseSessions" ? typeof config.classPassAuthority?.select !== "function" : config.classPassAuthority !== undefined))
        return denied();
      return ok(new ClinikoClassBookingHost(config, approval.value));
    }
    catch {
      return denied();
    }
  }
  #now() { return this.#config.clock(); }
  #signal(external?: AbortSignal, deadlineMs = 15000) { return AbortSignal.any([this.#lifetime.signal, this.#config.signal, AbortSignal.timeout(deadlineMs), ...(external ? [external] : [])]); }
  #time(now: string): number | undefined {
    try {
      const at = approvalInstant(this.#now()), supplied = approvalInstant(now);
      return at !== undefined && supplied !== undefined && Math.abs(at - supplied) <= 30000 ? at : undefined;
    }
    catch {
      return undefined;
    }
  }
  #matches(query: BookingMenuQuery): boolean {
    const c = this.#config;
    return !this.#lifetime.signal.aborted && !query.signal.aborted && sameScope(query.scope, c.scope) && query.callId === c.callId &&
      query.sessionId === c.sessionId && query.policyVersion === c.policyVersion && this.#time(query.now) !== undefined;
  }
  async #ready(now: string, signal: AbortSignal, mutation?: HostMutation): Promise<CallState | undefined> {
    const c = this.#config, at = this.#time(now);
    if (at === undefined || signal.aborted)
      return undefined;
    const found = await awaitUntilAbort(c.ledger.read(c.callId, c.scope), signal), current = await awaitUntilAbort(c.policies.read(c.scope), signal);
    const stop = await awaitUntilAbort(c.ledger.readWriteStop(c.scope), signal);
    if (!found?.ok || !current?.ok || !stop?.ok || stop.value.stopped || signal.aborted || this.#lifetime.signal.aborted)
      return undefined;
    const state = found.value;
    if (state.lifecycle !== "active" || !state.admission || state.callId !== c.callId || !sameScope(state.policy.scope, c.scope) ||
      state.policy.policyVersion !== c.policyVersion || !sameScope(current.value.scope, c.scope) || current.value.policyVersion !== c.policyVersion || !state.policy.automationEnabled || !state.policy.bookingEnabled ||
      state.policy.staffWorkEnabled !== true || state.policy.capabilities.book !== "execute" || !current.value.automationEnabled || !current.value.bookingEnabled ||
      current.value.staffWorkEnabled !== true || current.value.capabilities.book !== "execute" || state.sessionLease?.sessionId !== c.sessionId ||
      approvalInstant(state.sessionLease.expiresAt) === undefined || Date.parse(state.sessionLease.expiresAt) <= at)
      return undefined;
    if (mutation) {
      const action = state.actions[mutation.actionKey], effect = state.effects[`${mutation.actionKey}:write`];
      if (!action || action.kind !== "book" || action.status !== "dispatched" || action.digest !== mutation.payloadDigest ||
        digestActionRequest(action.mutation.request) !== mutation.payloadDigest || state.presentations[action.presentationId]?.status !== "played" ||
        effect?.kind !== "hostWrite" || effect.status !== "possiblySent" || effect.mutation.actionKey !== mutation.actionKey || effect.mutation.payloadDigest !== mutation.payloadDigest)
        return undefined;
    }
    return state;
  }
  async #permission(patient: VerifiedPatient, session: ClinikoClassSession, approval: ClassApproval, phase: "proposal" | "commit" | "inspection", signal: AbortSignal): Promise<boolean> {
    const c = this.#config;
    const permitted = await awaitUntilAbort(Promise.resolve().then(() => c.permission.allows({ scope: { ...c.scope }, callId: c.callId, sessionId: c.sessionId,
      policyVersion: c.policyVersion, patientId: patient.patientRef, classSessionId: session.sessionRef, phase, termsVersion: approval.bookingTerms.version, signal })), signal);
    return permitted === true && !signal.aborted;
  }
  bookingMenuAvailable(): boolean { return !this.#lifetime.signal.aborted && !this.#attempted; }
  async readBookingMenu(query: BookingMenuReadQuery): Promise<Result<BookingMenuRead, HostReadFailure>> {
    this.financial?.invalidate();
    if (!this.#matches(query) || this.#busy || this.#attempted || query.preference !== undefined || query.window != null && !validBookingSearchWindow(query.window))
      return denied();
    const epoch = ++this.#epoch;
    this.#menu = undefined;
    this.#previous = undefined;
    this.#choices.clear();
    this.#busy = true;
    if (query.window !== undefined)
      this.#window = query.window === null ? undefined : structuredClone(query.window);
    const signal = this.#signal(query.signal);
    try {
      if (!await this.#ready(query.now, signal))
        return denied();
      const approval = await this.#config.classPolicy.current(query.scope), grant = await this.#config.verification.verified(signal);
      if (!approval.ok || !grant)
        return denied();
      const a = approval.value, now = this.#time(query.now)!, first = Date.parse(`${query.from}T00:00:00.000Z`), last = Date.parse(`${query.to}T00:00:00.000Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(query.from) || !/^\d{4}-\d{2}-\d{2}$/.test(query.to) || !Number.isFinite(first) || !Number.isFinite(last) ||
        new Date(first).toISOString().slice(0, 10) !== query.from || new Date(last).toISOString().slice(0, 10) !== query.to || last < first || last - first > 89 * 86400000)
        return denied();
      const lower = new Date(Math.max(now, Date.parse(clinicDayStartUtc(a.timeZone, query.from)))).toISOString();
      const upper = new Date(Math.min(now + a.maxAdvanceDays * 86400000, Date.parse(clinicDayStartUtc(a.timeZone, new Date(last + 86400000).toISOString().slice(0, 10))))).toISOString();
      const observed = await this.#reader.list(query.scope, grant.verificationRef, lower, upper, query.now, signal);
      const patient = await this.#config.verification.proof.verifyOperation(query.scope, grant.verificationRef, "appointments.book", query.now, signal);
      if (!observed.ok || !patient.ok || observed.value.patientRef !== patient.value.patientRef || observed.value.timeZone !== a.timeZone)
        return denied();
      const choices: Choice[] = [], starts = new Set<string>();
      for (const session of observed.value.sessions) {
        if (session.attendance.kind !== "none" || session.remainingPlaces < 1 || session.overCapacity || Date.parse(session.startsAt) < now + a.minNoticeMinutes * 60000 ||
          Date.parse(session.endsAt) - Date.parse(session.startsAt) !== a.durationMinutes * 60000 || !matchesBookingSearchWindow(session.startsAt, a.timeZone, this.#window) ||
          !await this.#permission(patient.value, session, a, "proposal", signal))
          continue;
        if (starts.has(session.startsAt))
          return denied();
        const pass = this.#passes ? await this.#passes.select(patient.value, session, a, query.now, signal) : undefined;
        if (this.#passes && !pass) continue;
        starts.add(session.startsAt);
        const expiresAt = new Date(Math.min(now + a.offerTtlSeconds * 1000, Date.parse(patient.value.expiresAt), Date.parse(a.effectiveUntil))).toISOString();
        const offer: BookableOffer = { scope: { ...query.scope }, offerRef: `class-offer:${randomUUID()}`, serviceRef: a.serviceRef, startsAt: session.startsAt, expiresAt,
          terms: { ...a.bookingTerms, expiresAt }, presentation: { timeZone: a.timeZone, practitionerName: a.practitionerName, appointmentTypeName: a.className, locationName: a.locationName, durationMinutes: a.durationMinutes } };
        choices.push({ offer, session: structuredClone(session), patientRef: patient.value.patientRef, verificationRef: grant.verificationRef,
          ...(pass ? { pass: structuredClone(pass) } : {}) });
      }
      const current = await this.#config.classPolicy.current(query.scope);
      if (!current.ok || !isDeepStrictEqual(current.value, a) || !await this.#ready(query.now, signal) || epoch !== this.#epoch || !this.#matches(query))
        return denied();
      const offered = choices.slice(0, 3);
      for (const choice of offered)
        this.#choices.set(choice.offer.offerRef, choice);
      this.#menu = { turnId: query.turnId, choices: offered };
      return ok({ scope: { ...query.scope }, callId: query.callId, sessionId: query.sessionId, policyVersion: query.policyVersion, observedAt: observed.value.observedAt,
        timeZone: a.timeZone, practitionerName: a.practitionerName, appointmentTypeName: a.className, locationName: a.locationName, reservable: false, maxSearchDays: 90,
        ...(this.#window ? { window: structuredClone(this.#window) } : {}), choices: offered.map(({ offer, session }) => ({ startsAt: offer.startsAt, endsAt: session.endsAt, expiresAt: offer.expiresAt })) });
    }
    catch {
      return denied();
    }
    finally {
      this.#busy = false;
    }
  }
  async selectBookingMenu(query: BookingMenuQuery & {
    menuTurnId: string;
    choice: 1 | 2 | 3;
  }): Promise<Result<{
    verificationRef: string;
    offerRef: string;
  }, HostReadFailure>> {
    this.financial?.invalidate();
    const menu = this.#menu;
    this.#menu = undefined;
    ++this.#epoch;
    if (!this.#matches(query) || !menu || menu.turnId !== query.menuTurnId || ![1, 2, 3].includes(query.choice))
      return denied();
    const choice = menu.choices[query.choice - 1], grant = await this.#config.verification.ownedGrant("appointments.book", this.#signal(query.signal));
    if (!choice || !grant || grant.verificationRef !== choice.verificationRef || Date.parse(choice.offer.expiresAt) <= Date.parse(query.now) || !this.#matches(query))
      return denied();
    this.#previous = menu;
    return ok({ verificationRef: choice.verificationRef, offerRef: choice.offer.offerRef });
  }
  async correctBookingMenu(query: BookingMenuQuery & Readonly<{ menuTurnId: string; startsAt: string }>): Promise<Result<Readonly<{ verificationRef: string; offerRef: string }>, HostReadFailure>> {
    this.financial?.invalidate();
    const previous = this.#previous, choice = previous?.choices.find(item => item.offer.startsAt === query.startsAt);
    if (!this.#matches(query) || this.#busy || this.#attempted || !previous || previous.turnId !== query.menuTurnId || !choice || Date.parse(choice.offer.expiresAt) <= Date.parse(query.now)) return denied();
    const epoch = ++this.#epoch, signal = this.#signal(query.signal);
    // This maps only an already issued private offer, exactly like ordinal
    // selection. resolveBooking performs the fresh patient, permission and
    // native occurrence checks before SAM can present corrected terms.
    const grant = await this.#config.verification.ownedGrant("appointments.book", signal);
    return grant && grant.verificationRef === choice.verificationRef && await this.#ready(query.now, signal) &&
      !signal.aborted && epoch === this.#epoch && this.#previous === previous && this.#matches(query)
      ? ok({ verificationRef: choice.verificationRef, offerRef: choice.offer.offerRef }) : denied();
  }
  async #inspectChoice(choice: Choice, now: string, phase: "proposal" | "commit" | "inspection", signal: AbortSignal, readNative = true): Promise<VerifiedPatient | undefined> {
    const c = this.#config, a = await c.classPolicy.current(c.scope), patient = await c.verification.proof.verifyOperation(c.scope, choice.verificationRef, "appointments.book", now, signal);
    if (!a.ok || !patient.ok || patient.value.patientRef !== choice.patientRef || !await this.#permission(patient.value, choice.session, a.value, phase, signal) ||
      this.#time(now) === undefined || Date.parse(choice.offer.expiresAt) <= this.#time(now)!)
      return undefined;
    if (!isDeepStrictEqual(choice.offer.terms, { ...a.value.bookingTerms, expiresAt: choice.offer.expiresAt })) return undefined;
    if ((a.value.membership === "nativeCaseSessions") !== !!choice.pass || !!choice.pass !== !!this.#passes) return undefined;
    let selected = choice.session;
    if (readNative) {
      const day = clinicDateAt(a.value.timeZone, new Date(choice.session.startsAt)), lower = clinicDayStartUtc(a.value.timeZone, day);
      const next = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);
      const read = await this.#reader.inspect(c.scope, choice.verificationRef, choice.session.sessionRef, new Date(Math.max(Date.parse(lower), this.#time(now)!)).toISOString(), clinicDayStartUtc(a.value.timeZone, next), now, signal);
      const observed = read.ok ? read.value.sessions[0] : undefined;
      if (!read.ok || !observed || read.value.patientRef !== choice.patientRef || read.value.timeZone !== a.value.timeZone || observed.startsAt !== choice.session.startsAt || observed.endsAt !== choice.session.endsAt ||
        observed.capacity !== choice.session.capacity || observed.overCapacity || (phase === "inspection" ? observed.attendance.kind !== "one" : observed.attendance.kind !== "none" || observed.remainingPlaces < 1)) return undefined;
      selected = observed;
    }
    if (choice.pass && this.#passes && !(phase === "inspection"
      ? await this.#passes.authorized(choice.pass, patient.value, selected, a.value, phase, signal)
      : await this.#passes.unchanged(choice.pass, patient.value, selected, a.value, phase, now, signal))) return undefined;
    const current = await c.classPolicy.current(c.scope), fresh = await c.verification.proof.verifyOperation(c.scope, choice.verificationRef, "appointments.book", now, signal);
    return current.ok && isDeepStrictEqual(current.value, a.value) && fresh.ok && fresh.value.patientRef === choice.patientRef &&
      await this.#permission(fresh.value, selected, a.value, phase, signal) && !signal.aborted ? fresh.value : undefined;
  }
  async resolveBooking(scope: LocationScope, ref: string, offerRef: string, now: string, external?: AbortSignal): Promise<Result<Booking, HostReadFailure>> {
    const choice = this.#choices.get(offerRef);
    if (!choice || ref !== choice.verificationRef || !sameScope(scope, this.#config.scope) || this.#busy || this.#attempted) {
      this.financial?.invalidate();
      return denied();
    }
    this.#busy = true;
    const signal = this.#signal(external);
    try {
      const state = await this.#ready(now, signal);
      if (!state || this.#prepared && !preparationMayBeDiscarded(state, this.#prepared.request, this.#prepared.revision))
        return denied();
      this.#prepared = undefined;
      const patient = await this.#inspectChoice(choice, now, "proposal", signal), again = await this.#ready(now, signal);
      if (!patient || !again || again.conversationRevision !== state.conversationRevision) {
        this.financial?.invalidate();
        return denied();
      }
      const request: Booking = { kind: "book", patient, offer: structuredClone(choice.offer) };
      this.#prepared = { request: structuredClone(request), choice: structuredClone(choice), revision: state.conversationRevision };
      if (this.financial) {
        const current = await this.#config.classPolicy.current(scope); if (!current.ok) return denied();
        const a = current.value;
        const financial = await this.financial.prepare({ request,
          evidence: { callId: this.#config.callId, sessionId: this.#config.sessionId, businessId: a.businessId,
            credentialFingerprint: a.credentialFingerprint, practitionerId: a.practitionerId, appointmentTypeId: a.appointmentTypeId,
            endsAt: choice.session.endsAt, timeZone: a.timeZone },
          booking: { kind: "classBook", sessionId: choice.session.sessionRef, ...(choice.pass ? { pass: choice.pass } : {}) } }, signal);
        const fresh = await this.#ready(this.#now(), signal);
        if (!financial || !fresh || fresh.conversationRevision !== state.conversationRevision) { this.financial.invalidate(); return denied(); }
        this.#financialMarker = financial.marker;
        if (financial.kind === "pending") return err({ kind: "financialConsentRequired", target: "offer" });
      }
      return ok(request);
    }
    catch {
      return denied();
    }
    finally {
      this.#busy = false;
    }
  }
  async #authorize(prepared: Prepared, mutation: HostMutation, phase: "commit" | "inspection", signal: AbortSignal, readNative = true): Promise<boolean> {
    const now = this.#now();
    if (!await this.#ready(now, signal, mutation) || mutation.payloadDigest !== digestActionRequest(prepared.request))
      return false;
    const patient = await this.#inspectChoice(prepared.choice, now, phase, signal, readNative);
    return !!patient && patient.patientRef === prepared.request.patient.patientRef && patient.verificationRef === prepared.request.patient.verificationRef && !!await this.#ready(this.#now(), signal, mutation);
  }
  /** All pass/history, policy, permission and SAM work precedes final capacity. */
  async #authorizeForSend(prepared: Prepared, mutation: HostMutation, signal: AbortSignal): Promise<boolean> {
    const c = this.#config, choice = prepared.choice, now = this.#now();
    this.#dispatchLeaseExpiry = undefined;
    if (!await this.#ready(now, signal, mutation) || mutation.payloadDigest !== digestActionRequest(prepared.request)) return false;
    const patient = await this.#inspectChoice(choice, now, "commit", signal, false);
    const approval = await c.classPolicy.current(c.scope);
    if (!patient || !approval.ok || patient.patientRef !== prepared.request.patient.patientRef ||
        patient.verificationRef !== prepared.request.patient.verificationRef ||
        !isDeepStrictEqual(choice.offer.terms, { ...approval.value.bookingTerms, expiresAt: choice.offer.expiresAt }) ||
        (approval.value.membership === "nativeCaseSessions") !== !!choice.pass) return false;
    const state = await this.#ready(this.#now(), signal, mutation);
    if (!state) return false;
    this.#dispatchLeaseExpiry = Date.parse(state.sessionLease!.expiresAt);
    const day = clinicDateAt(approval.value.timeZone, new Date(choice.session.startsAt));
    const lower = clinicDayStartUtc(approval.value.timeZone, day);
    const next = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);
    const read = await this.#reader.inspectForSend(c.scope, choice.verificationRef, choice.session.sessionRef,
      new Date(Math.max(Date.parse(lower), Date.parse(this.#now()))).toISOString(), clinicDayStartUtc(approval.value.timeZone, next), this.#now(), signal);
    const observed = read.ok ? read.value.sessions[0] : undefined;
    return !!read.ok && !!observed && this.#currentForSend(prepared, signal) && read.value.patientRef === choice.patientRef &&
      read.value.timeZone === approval.value.timeZone && observed.startsAt === choice.session.startsAt && observed.endsAt === choice.session.endsAt &&
      observed.capacity === choice.session.capacity && !observed.overCapacity && observed.attendance.kind === "none" && observed.remainingPlaces > 0;
  }
  /** Synchronous captured expiry and local proof/lifetime checks at dispatch. */
  #currentForSend(prepared: Prepared, signal: AbortSignal): boolean {
    const now = this.#now(), at = this.#time(now), choice = prepared.choice;
    return at !== undefined && this.#dispatchLeaseExpiry !== undefined && this.#dispatchLeaseExpiry > at &&
      this.#prepared === prepared && !this.#lifetime.signal.aborted && !signal.aborted &&
      this.#config.verification.proof.ownsLiveReference(choice.verificationRef, "appointments.book", now) &&
      Date.parse(prepared.request.patient.expiresAt) > at && Date.parse(choice.offer.expiresAt) > at && Date.parse(choice.session.startsAt) > at &&
      (!this.financial || this.financial.currentForSend(signal));
  }
  async checkConfirmationCapacity(query: BookingMenuQuery & Readonly<{ actionKey: string; digest: string }>): Promise<Result<Readonly<{ kind: "ready" }> | Readonly<{ kind: "wait"; seconds: number }>, HostReadFailure>> {
    if (!this.#passes) return ok({ kind: "ready" });
    const p = this.#prepared;
    if (!p?.choice.pass || this.#busy || this.#attempted || !this.#matches(query) || digestActionRequest(p.request) !== query.digest) return denied();
    const signal = this.#signal(query.signal);
    // This non-disclosing admission check does not read protected native data
    // or spend quota. All native proof/case/capacity checks still run at write.
    const current = async () => {
      const state = await this.#ready(this.#now(), signal), a = await this.#config.classPolicy.current(query.scope);
      const grant = await this.#config.verification.ownedGrant("appointments.book", signal), action = state?.actions[query.actionKey];
      if (!state || !a.ok || !grant || grant.verificationRef !== p.choice.verificationRef || action?.status !== "awaitingConfirmation" ||
        action.digest !== query.digest || state.presentations[action.presentationId]?.status !== "played" || this.#prepared !== p ||
        Date.parse(p.choice.offer.expiresAt) <= Date.parse(this.#now()) || !isDeepStrictEqual(p.choice.offer.terms, { ...a.value.bookingTerms, expiresAt: p.choice.offer.expiresAt }) ||
        !await this.#permission(p.request.patient, p.choice.session, a.value, "commit", signal) ||
        !await this.#passes!.authorized(p.choice.pass!, p.request.patient, p.choice.session, a.value, "commit", signal)) return undefined;
      return state;
    };
    const before = await current(); if (!before) return denied();
    // The exact financial source read precedes the ordinary bounded class send.
    // Observation retention follows ACK and cannot be a clinical success gate.
    const capacity = await checkClinikoHeadroom(this.#config.cliniko.rateBudget, 180 + (this.financial ? 1 : 0)), after = await current();
    if (!after || after.conversationRevision !== before.conversationRevision || signal.aborted || this.#prepared !== p) return denied();
    if (capacity === null) return ok({ kind: "ready" });
    if (capacity.kind !== "rateLimited" || !Number.isSafeInteger(capacity.retryAfterMs) || capacity.retryAfterMs! < 1 || capacity.retryAfterMs! > 60000) return denied();
    const seconds = Math.ceil(capacity.retryAfterMs! / 1000);
    if (Date.parse(p.choice.offer.expiresAt) <= Date.parse(this.#now()) + (seconds + 3) * 1000) return err({ kind: "expired", target: "offer" });
    return ok({ kind: "wait", seconds });
  }
  async write(mutation: HostMutation, now: string, external?: AbortSignal,
    onBookingAcknowledged?: Parameters<HostEffects["write"]>[3]): Promise<HostWriteReceipt> {
    const prepared = this.#prepared, c = this.#config, reject = (): HostWriteReceipt => ({ kind: "rejected", actionKey: mutation.actionKey, reason: "forbidden" });
    if (!prepared || this.#attempted || this.#busy || this.#lifetime.signal.aborted || mutation.kind !== "book" || mutation.request.kind !== "book" || mutation.notification ||
      !sameScope(mutation.scope, c.scope) || mutation.policyVersion !== c.policyVersion || digestActionRequest(mutation.request) !== mutation.payloadDigest ||
      mutation.payloadDigest !== digestActionRequest(prepared.request) || !approvalRef(mutation.actionKey) || this.#time(now) === undefined)
      return reject();
    this.#attempted = true;
    const signal = this.#signal(external, 30000), choice = prepared.choice, actionId = this.#financialMarker ?? randomUUID();
    const uncertain = (): HostWriteReceipt => ({ kind: "uncertain", actionKey: mutation.actionKey, reconcileAfter: now, deadline: new Date(Date.parse(now) + 300000).toISOString() });
    const a = await c.classPolicy.current(c.scope);
    if (!a.ok || choice.pass && await checkClinikoHeadroom(c.cliniko.rateBudget, 180 + (this.financial ? 1 : 0)) !== null)
      return reject();
    const financialCapture = this.financial ? await this.financial.capture(signal) : undefined;
    if (this.financial && !financialCapture) return reject();
    const provider: Extract<ClinikoAttendanceRequest, { kind: "book" }> = { kind: "book", scope: c.scope, patientId: choice.patientRef, sessionId: choice.session.sessionRef, actionId,
      ...(choice.pass ? { patientCaseId: choice.pass.selection.patientCaseId } : {}) };
    const review: ClinikoReviewRequest = { scope: c.scope, patientId: choice.patientRef, businessId: a.value.businessId, credentialFingerprint: a.value.credentialFingerprint, policyVersion: c.policyVersion,
      termsVersion: a.value.bookingTerms.version, timeZone: a.value.timeZone, createdAt: now, operation: { kind: "classBook", sessionId: choice.session.sessionRef, attendanceActionId: actionId,
        practitionerId: a.value.practitionerId, appointmentTypeId: a.value.appointmentTypeId, startsAt: choice.session.startsAt, endsAt: choice.session.endsAt,
        ...(choice.pass ? { pass: { ...choice.pass.selection, usageFingerprint: choice.pass.usageFingerprint, maximum: choice.pass.maximum, used: choice.pass.used } } : {}) } };
    let acknowledged: Extract<ClinikoAttendanceWrite, { kind: "accepted" }> | undefined;
    let committed: Extract<HostWriteReceipt, { kind: "committed" }> | undefined;
    const result = await this.#review.run(review, {
      authorize: (_request, stop) => this.#authorize(prepared, mutation, "commit", stop),
      acknowledgedBooking: () => acknowledged ? ok(acknowledged) : undefined,
      send: async (_request, stop) => {
        if (this.financial && !await this.financial.beforeSend(stop)) return err({ kind: "forbidden" });
        const checks = {
          beforeSend: (final: AbortSignal) => this.#authorizeForSend(prepared, mutation, final),
          current: (final: AbortSignal) => this.#currentForSend(prepared, final),
          acknowledged: (receipt: Extract<ClinikoAttendanceWrite, { kind: "accepted" }>) => {
          acknowledged = receipt;
          committed = Object.freeze({ kind: "committed", actionKey: mutation.actionKey, hostRef: receipt.attendeeRef });
          try { onBookingAcknowledged?.(committed); } catch { /* Native success survives observer failure. */ }
          },
        };
        if (financialCapture?.kind === "required") {
          const captured = await financialCapture.capture.classBook(this.#writer, provider, stop, checks);
          if (!captured.ok) return err({ kind: "forbidden" });
          if (captured.value.observation.kind === "captured") await this.financial!.retain(financialCapture, captured.value.observation.notes);
          return captured.value.native;
        }
        return this.#writer.executeBookingOnce(provider, stop, checks);
      },
    }, signal);
    if (committed) return committed;
    if (!result.ok)
      return ["reviewUncertain", "mutationUncertain"].includes(result.error.kind) ? uncertain() : reject();
    if (!result.value.outcome.ok)
      return reject();
    return result.value.outcome.value.kind === "accepted" && !signal.aborted ? { kind: "committed", actionKey: mutation.actionKey, hostRef: result.value.outcome.value.attendeeRef } : uncertain();
  }
  async reconcile(mutation: HostMutation): Promise<ReconcileObservation> { return { kind: "stillUnknown", actionKey: mutation.actionKey }; }
  async openTask(item: StaffItem): Promise<StaffTaskReceipt> { return { kind: "rejected", taskKey: item.key }; }
  async reconcileTask(item: StaffItem): Promise<StaffTaskObservation> { return { kind: "stillUnknown", taskKey: item.key }; }
  dispose(): void { this.#config.signal.removeEventListener("abort", this.#onClose); this.#lifetime.abort(); this.financial?.dispose(); this.#review.close(); this.#choices.clear(); this.#menu = undefined; this.#previous = undefined; this.#prepared = undefined; ++this.#epoch; }
}
