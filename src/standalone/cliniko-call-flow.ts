import { hasSentPatientWork } from "../core/request-boundary.ts";
import { readClinikoBookingHorizon, requestedDatesOutsideHorizon } from "./cliniko-booking-horizon.ts";
import { validCallerIdentityDenial } from "../core/caller-identity.ts";
import { bookingPreferenceLanguage } from "./booking-preference-language.ts";
import { ClinikoCatalogueBookingHost } from "./cliniko-catalogue-booking-host.ts";
import { normalizedSpokenName } from "../core/pending-location.ts";
import { PlayedMenuSearch } from "./played-menu-search.ts";
import { clinicDateAt } from "./clinic-clock.ts";
import type { AppointmentEnquiryQuery, AppointmentChangeEvidenceQuery, BookingMenuQuery, BookingMenuReadQuery, IntakeEvidenceQuery, ReschedulingMenuQuery, ReschedulingMenuReadQuery, StaffRequestQuery, WorkflowQuery } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { HostMutation, HostWriteReceipt, LocationScope, Result, StaffItem } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { callIdFor } from "../voice/admission.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { ClinikoBookingSession } from "./cliniko-booking-session.ts";
import type { ClinikoBookingSessionConfig } from "./cliniko-booking-session.ts";
import { ClinikoCancellationSession } from "./cliniko-cancellation-session.ts";
import { ClinikoIntakeBookingSession } from "./cliniko-intake-booking-session.ts";
import type { ClinikoIntakeBookingSessionConfig } from "./cliniko-intake-booking-session.ts";
import { ClinikoReschedulingSession } from "./cliniko-rescheduling-session.ts";
import { validCallKnowledgeSource } from "../core/knowledge-evidence.ts";
import { OwnerFileClinicFAQs } from "./owner-file-clinic-faqs.ts";
import { NoStoredKnowledge } from "./no-stored-knowledge.ts";
import type { ClinikoIntakeDraft } from "../cliniko/patient-intake.ts";
import type { FinalCallerTurn } from "../core/model.ts";
import type { VoiceIntent } from "../voice/voice-session.ts";
import { PlayedMenuSelection } from "./played-menu-selection.ts";
import { noticePresentationId } from "../core/transition.ts";
import { ClinikoStaffSession } from "./cliniko-staff-session.ts";
import { ClinikoAppointmentEnquirySession } from "./cliniko-appointment-enquiry-session.ts";
import type { PatientVerificationPermission } from "./email-patient-authority.ts";

export type ClinikoWorkflow = import("../core/model.ts").WorkflowOperation;
export type ClinikoCallFlowConfig = Omit<ClinikoBookingSessionConfig, "callerApprovalPath" | "bookingApprovalPath"> & Readonly<{
  approvals: Readonly<{ bookCaller: string; cancelCaller: string; rescheduleCaller: string; booking: string; cancellation: string; rescheduling: string }>;
  intake?: Pick<ClinikoIntakeBookingSessionConfig, "policy" | "permission" | "presentation">;
  staff?: Readonly<{ callerApprovalPath: string; staffApprovalPath: string; recallTypeId: string; permission: PatientVerificationPermission }>;
  publicKnowledge?: OwnerFileClinicFAQs;
  enquiry?: Readonly<{ callerApprovalPath: string; readApprovalPath: string; permission: PatientVerificationPermission }>;
}>;
type Owner = ClinikoBookingSession | ClinikoCancellationSession | ClinikoReschedulingSession | ClinikoIntakeBookingSession | ClinikoAppointmentEnquirySession;
type Failure = Readonly<{ kind: "workflowUnavailable" }>;
const unavailable = <T>(): Result<T, Failure> => err({ kind: "workflowUnavailable" });
const readDenied = () => err({ kind: "unavailable" as const, target: "appointment" as const });

/** An admitted call owns its current workflow. No eager verifier, model credential, cross-operation grant or implicit intake booking.
 * Concrete workflow owners retain all permission, public approval, SAM, inspection and single-send checks. */
export class ClinikoCallFlow extends NoStoredKnowledge {
  readonly effectDeadlineMs = 30_000;
  readonly #config: ClinikoCallFlowConfig;
  readonly #lifetime = new AbortController();
  readonly #patientLifetime = new AbortController();
  #workflowLifetime = new AbortController();
  readonly #onClose = () => this.dispose();
  #owner: Owner | undefined;
  #staff: ClinikoStaffSession | undefined;
  #staffActive = false;
  #preparingStaff = false;
  #workflow: ClinikoWorkflow | undefined;
  #selecting = false;
  #verificationRequired = false;
  #intakeDraftRef: string | undefined;
  #publicMenu: Readonly<{ kind: "booking" | "rescheduling"; stage: "targets" | "offers" | null }> | undefined;
  #reschedulingTargetSelected = false;
  readonly #searchMenu = new PlayedMenuSearch();
  readonly #spokenMenu = new PlayedMenuSelection();
  private constructor(config: ClinikoCallFlowConfig) {
    super(); this.#config = Object.freeze({ ...config, receipt: structuredClone(config.receipt), inbound: structuredClone(config.inbound),
      cliniko: Object.freeze({ ...config.cliniko }), approvals: Object.freeze({ ...config.approvals }), ...(config.intake ? { intake: Object.freeze({ ...config.intake }) } : {}),
      ...(config.catalogue ? { catalogue: Object.freeze({ ...config.catalogue, practitioners: Object.freeze(config.catalogue.practitioners.map(member => Object.freeze({ ...member }))) }) } : {}),
      ...(config.staff ? { staff: Object.freeze({ ...config.staff }) } : {}),
      ...(config.enquiry ? { enquiry: Object.freeze({ ...config.enquiry }) } : {}) });
    config.signal.addEventListener("abort", this.#onClose, { once: true }); if (config.signal.aborted) this.dispose();
  }
  static create(config: ClinikoCallFlowConfig): Result<ClinikoCallFlow, Failure> {
    try {
      if (!config || !(config.signal instanceof AbortSignal) || config.signal.aborted || config.receipt.callId !== callIdFor(config.inbound.key) ||
          config.receipt.admission.key.accountRef !== config.inbound.key.accountRef || config.receipt.admission.key.providerCallRef !== config.inbound.key.providerCallRef ||
          config.receipt.admission.dialedNumber !== config.inbound.dialedNumber || !config.sessionId || !config.policyVersion ||
          (config.publicKnowledge !== undefined && !(config.publicKnowledge instanceof OwnerFileClinicFAQs)) ||
          !config.approvals || Object.values(config.approvals).some(path => typeof path !== "string" || !path.trim())) return unavailable();
      return ok(new ClinikoCallFlow(config));
    } catch { return unavailable(); }
  }
  async clearUnsupportedWorkflow(query: Readonly<{ scope: LocationScope; callId: string; sessionId: string; turnId: string; conversationRevision: number }>): Promise<boolean> {
    const c = this.#config;
    if (this.closed || !sameScope(query.scope, c.receipt.scope) || query.callId !== c.receipt.callId || query.sessionId !== c.sessionId) return false;
    const state = await c.ledger.read(query.callId, query.scope);
    const now = Date.parse((c.clock ?? (() => new Date().toISOString()))());
    if (!state.ok || this.closed || state.value.lifecycle !== "active" || state.value.sessionLease?.sessionId !== query.sessionId ||
        !Number.isFinite(now) || Date.parse(state.value.sessionLease.expiresAt) <= now ||
        state.value.conversationRevision !== query.conversationRevision || state.value.processedTurnIds.at(-1) !== query.turnId ||
        state.value.lastRequestBoundary?.turnId !== query.turnId) return false;
    this.#publicMenu = undefined; this.#spokenMenu.clear(); this.#searchMenu.clear(); this.#reschedulingTargetSelected = false;
    if (hasSentPatientWork(state.value)) return true; // Do not dispose a sent owner's receipt/recovery state or saved intake proof.
    this.#workflowLifetime.abort(); this.#workflowLifetime = new AbortController();
    this.#owner?.dispose(); this.#staff?.dispose(); this.#owner = undefined; this.#staff = undefined;
    this.#workflow = undefined; this.#staffActive = false; this.#verificationRequired = false; this.#intakeDraftRef = undefined;
    return true;
  }
  async revokeCallerPatientAccess(query: Readonly<{ scope: LocationScope; callId: string; sessionId: string;
    reason: import("../core/caller-identity.ts").CallerIdentityDenial }>): Promise<boolean> {
    const c = this.#config;
    if (this.closed || !validCallerIdentityDenial(query.reason) || !sameScope(query.scope, c.receipt.scope) || query.callId !== c.receipt.callId || query.sessionId !== c.sessionId) return false;
    const state = await c.ledger.read(query.callId, query.scope);
    const now = Date.parse((c.clock ?? (() => new Date().toISOString()))());
    if (!state.ok || this.closed || state.value.lifecycle !== "active" || state.value.sessionLease?.sessionId !== query.sessionId ||
        !Number.isFinite(now) || Date.parse(state.value.sessionLease.expiresAt) <= now || state.value.callerIdentityDenied !== query.reason) return false;
    this.#patientLifetime.abort();
    this.#owner?.dispose(); this.#staff?.dispose(); this.#owner = undefined; this.#staff = undefined;
    this.#workflow = undefined; this.#staffActive = false; this.#verificationRequired = false; this.#intakeDraftRef = undefined;
    this.#publicMenu = undefined; this.#reschedulingTargetSelected = false; this.#spokenMenu.clear(); this.#searchMenu.clear();
    return true;
  }
  binding() { return { callId: this.#config.receipt.callId, sessionId: this.#config.sessionId }; }
  async readBookingHorizon(query: import("../core/host.ts").BookingHorizonQuery) {
    return this.#readHorizon(query);
  }
  async #readHorizon(query: import("../core/host.ts").BookingHorizonQuery, incoming?: import("../core/booking-search-preference.ts").BookingSearchPreference) {
    if (this.closed || this.#patientLifetime.signal.aborted || this.#staffActive || this.#workflow && !["book", "reschedule", "intake"].includes(this.#workflow))
      return err({ kind: "bookingHorizonUnavailable" as const });
    const host = this.#booking(), prior = host instanceof ClinikoCatalogueBookingHost ? host.currentSearchPreference() : undefined;
    return readClinikoBookingHorizon(this.#config, { ...query, signal: AbortSignal.any([query.signal, this.#lifetime.signal]) }, this.#workflow === "reschedule" ? "reschedule" : "book",
      incoming?.practitioner ?? prior?.practitioner);
  }
  async #horizonFailure(query: BookingMenuReadQuery | ReschedulingMenuReadQuery) {
    const state = await this.#config.ledger.read(query.callId, query.scope);
    if (!state.ok) return undefined;
    const limits = await this.#readHorizon({ ...query, expectedConversationRevision: state.value.conversationRevision }, "preference" in query ? query.preference : undefined);
    return limits.ok && requestedDatesOutsideHorizon(limits.value, query.from, query.to, this.#config.cliniko.timeZone)
      ? { kind: "outsideHorizon" as const, target: "offer" as const, snapshot: limits.value } : undefined;
  }
  get workflow(): ClinikoWorkflow | undefined { return this.#workflow; }
  get patientAccessDenied(): boolean { return this.#patientLifetime.signal.aborted; }
  get closed(): boolean { return this.#lifetime.signal.aborted; }
  /** Non-secret transport state. The input owner closes ordinary media before mail starts. */
  get verificationRequired(): boolean { return this.#verificationRequired; }
  async spokenMenuIntent(text: string) {
    if (this.closed || this.#verificationRequired) return undefined;
    const state = await this.#config.ledger.read(this.#config.receipt.callId, this.#config.receipt.scope);
    if (!state.ok || this.closed || state.value.sessionLease?.sessionId !== this.#config.sessionId) return undefined;
    return this.#spokenMenu.resolve(text, state.value, (this.#config.clock ?? (() => new Date().toISOString()))());
  }
  async preferenceMenuIntent(text: string): Promise<VoiceIntent | undefined> {
    const preference = bookingPreferenceLanguage(text);
    if (!preference) return undefined;
    const denied = { kind: "clarify", reason: "searchPreferenceUnavailable" } as const;
    if (this.closed || this.#staffActive || this.#verificationRequired || !(this.#owner instanceof ClinikoBookingSession)) return denied;
    const state = await this.#config.ledger.read(this.#config.receipt.callId, this.#config.receipt.scope);
    if (!state.ok || this.closed || state.value.sessionLease?.sessionId !== this.#config.sessionId) return denied;
    if (Object.values(state.value.actions).some(action => ["committed", "uncertain", "needsReview", "dispatched"].includes(action.status)))
      return { kind: "clarify", reason: "changeAfterSend" };
    const host = this.#owner.effects;
    if (!(host instanceof ClinikoCatalogueBookingHost)) return denied;
    const profile = await host.searchProfile();
    if (!profile || this.closed) return denied;
    const deniedAt = { ...denied, approvedLocation: profile.locationName };
    if (preference.location && normalizedSpokenName(preference.location) !== normalizedSpokenName(profile.locationName)) return deniedAt;
    if (preference.practitioner && preference.practitioner !== "any" &&
        !profile.practitioners.some(member => normalizedSpokenName(member.name) === normalizedSpokenName(preference.practitioner))) return deniedAt;
    const from = clinicDateAt(profile.timeZone, new Date((this.#config.clock ?? (() => new Date().toISOString()))()));
    const to = new Date(Date.parse(`${from}T00:00:00.000Z`) + (profile.searchDays - 1) * 86_400_000).toISOString().slice(0, 10);
    return { kind: "bookingMenu", from, to, preference };
  }
  async searchMenuIntent(text: string): Promise<VoiceIntent | undefined> {
    if (this.closed || this.#staffActive || this.#verificationRequired ||
        this.#workflow !== "book" && this.#workflow !== "intake" && !(this.#workflow === "reschedule" && this.#reschedulingTargetSelected)) return undefined;
    const found = await this.#config.ledger.read(this.#config.receipt.callId, this.#config.receipt.scope);
    if (!found.ok || this.closed || found.value.lifecycle !== "active" || found.value.sessionLease?.sessionId !== this.#config.sessionId) return undefined;
    const now = (this.#config.clock ?? (() => new Date().toISOString()))();
    return this.#searchMenu.resolve(text, found.value, clinicDateAt(this.#config.cliniko.timeZone, new Date(now)), this.#config.cliniko.timeZone,
      this.#workflow === "reschedule" ? "rescheduling" : "booking");
  }
  async correctionIntent(turn: FinalCallerTurn, external?: AbortSignal): Promise<VoiceIntent | undefined> {
    if (this.closed || this.#verificationRequired || turn.callId !== this.#config.receipt.callId || turn.sessionId !== this.#config.sessionId) return undefined;
    const found = await this.#config.ledger.read(turn.callId, this.#config.receipt.scope);
    if (!found.ok || this.closed) return undefined;
    const now = (this.#config.clock ?? (() => new Date().toISOString()))();
    const correction = this.#spokenMenu.correction(turn.text, found.value, now);
    if (!correction) return undefined;
    if (correction.kind === "clarify") return correction;
    const signal = AbortSignal.any([this.#workflowLifetime.signal, this.#patientLifetime.signal, this.#lifetime.signal, AbortSignal.timeout(15_000), ...(external ? [external] : [])]);
    const query = { scope: this.#config.receipt.scope,
      callId: turn.callId, sessionId: this.#config.sessionId, policyVersion: this.#config.policyVersion,
      turnId: turn.turnId, now, signal, menuTurnId: correction.menuTurnId, startsAt: correction.startsAt };
    let intent: VoiceIntent | undefined;
    if (correction.menuKind === "booking") {
      const selection = await awaitUntilAbort(this.#booking()?.correctBookingMenu(query) ?? Promise.resolve(readDenied()), signal);
      if (selection?.ok) intent = { kind: "book", ...selection.value };
    } else if (this.#owner instanceof ClinikoReschedulingSession) {
      const selection = await awaitUntilAbort(this.#owner.effects.correctReschedulingMenu({ ...query, stage: "offers" }), signal);
      if (selection?.ok) intent = { kind: "reschedule", ...selection.value };
    }
    if (!intent || signal.aborted || this.closed) return { kind: "clarify", reason: "menuUnavailable" };
    this.#spokenMenu.corrected(turn.turnId, correction.startsAt);
    return intent;
  }
  /** The model sees only routing and action-status enums; patient data and host refs stay in this owner. */
  async publicIntentContext(): Promise<Readonly<{ workflow: ClinikoWorkflow | null; verificationRequired: boolean; callerIdentityDenied?: import("../core/caller-identity.ts").CallerIdentityDenial;
    lastAction: Readonly<{ kind: "book" | "cancel" | "reschedule" | "intake"; status: string; confirmationPlayed: boolean }> | null;
    now: string; timeZone: string;
    lastMenu: Readonly<{ kind: "booking" | "rescheduling"; stage: "targets" | "offers" | null }> | null;
    reschedulingTargetSelected: boolean; staffRequestActive: boolean }> | undefined> {
    if (this.closed) return undefined;
    const binding = this.binding(), found = await this.#config.ledger.read(binding.callId, this.#config.receipt.scope);
    if (!found.ok || this.closed || found.value.lifecycle !== "active" || found.value.sessionLease?.sessionId !== binding.sessionId) return undefined;
    const denied = found.value.callerIdentityDenied;
    if (denied) return { workflow: null, verificationRequired: false, callerIdentityDenied: denied, lastAction: null,
      now: (this.#config.clock ?? (() => new Date().toISOString()))(), timeZone: this.#config.cliniko.timeZone,
      lastMenu: null, reschedulingTargetSelected: false, staffRequestActive: false };
    const last = Object.values(found.value.actions).at(-1);
    return { workflow: this.#workflow ?? null, verificationRequired: this.#verificationRequired,
      lastAction: last ? { kind: last.kind, status: last.status,
        confirmationPlayed: found.value.presentations[last.presentationId]?.status === "played" } : null,
      now: (this.#config.clock ?? (() => new Date().toISOString()))(), timeZone: this.#config.cliniko.timeZone,
      lastMenu: this.#publicMenu ?? null, reschedulingTargetSelected: this.#reschedulingTargetSelected, staffRequestActive: this.#staffActive };
  }
  /** Only current, call-pinned public facts may enter the classifier. */
  async publicFAQChoices() {
    if (this.closed || !this.#config.publicKnowledge) return [];
    const found = await this.#config.ledger.read(this.#config.receipt.callId, this.#config.receipt.scope);
    const policy = await this.#config.policies.read(this.#config.receipt.scope);
    if (!found.ok || !policy.ok || !policy.value.automationEnabled || this.closed ||
        policy.value.policyVersion !== this.#config.policyVersion || found.value.lifecycle !== "active" ||
        found.value.sessionLease?.sessionId !== this.#config.sessionId) return [];
    const now = (this.#config.clock ?? (() => new Date().toISOString()))();
    const facts = await this.#config.publicKnowledge.listModelKnowledge(this.#config.receipt.scope, now);
    return facts.ok && !this.closed ? facts.value.filter(fact => validCallKnowledgeSource(fact, found.value.policy, now)) : [];
  }
  override async readKnowledge(scope: LocationScope, refs: readonly string[]) {
    if (this.closed) return err({ kind: "unavailable" as const });
    return this.#config.publicKnowledge?.readKnowledge(scope, refs) ?? super.readKnowledge(scope, refs);
  }
  override async listModelKnowledge(scope: LocationScope, now: string) {
    if (this.closed) return err({ kind: "unavailable" as const });
    return this.#config.publicKnowledge?.listModelKnowledge(scope, now) ?? super.listModelKnowledge(scope, now);
  }
  /** Trusted owner wiring only; the classifier receives no private draft reference. */
  get intakeDraftRef(): string | undefined { return !this.closed && !this.#verificationRequired ? this.#intakeDraftRef : undefined; }
  async prepareStaffRequest(query: StaffRequestQuery) {
    const denied = () => err({ kind: "staffUnavailable" as const });
    const c = this.#config;
    if (!c.staff || c.staff.recallTypeId === c.cliniko.recallTypeId || this.#patientLifetime.signal.aborted || this.closed || this.#preparingStaff || !sameScope(query.scope, c.receipt.scope) || query.callId !== c.receipt.callId ||
        query.sessionId !== c.sessionId || query.policyVersion !== c.policyVersion || query.signal.aborted) return denied();
    this.#preparingStaff = true;
    const signal = AbortSignal.any([query.signal, this.#workflowLifetime.signal, this.#patientLifetime.signal, this.#lifetime.signal, AbortSignal.timeout(20_000)]);
    let building: ReturnType<typeof ClinikoStaffSession.create> | undefined;
    try {
      if (!this.#staff) {
        const buildLifetime = new AbortController();
        building = ClinikoStaffSession.create({ ...c, ...c.staff, cliniko: { ...c.cliniko, recallTypeId: c.staff.recallTypeId },
          signal: AbortSignal.any([this.#workflowLifetime.signal, this.#patientLifetime.signal, this.#lifetime.signal, buildLifetime.signal]) });
        const built = await awaitUntilAbort(building, signal);
        if (!built?.ok || signal.aborted) { buildLifetime.abort(); void building.then(result => { if (result.ok) result.value.dispose(); }); return denied(); }
        this.#staff = built.value;
      }
      const selected = await awaitUntilAbort(this.#staff.prepare(query), signal);
      if (!selected?.ok || signal.aborted) return denied();
      if (selected.value.kind === "codeRequired") { this.#staffActive = true; this.#verificationRequired = true; this.#spokenMenu.clear(); this.#searchMenu.clear(); this.#publicMenu = undefined; this.#staff.beginVerification(); }
      if (selected.value.kind === "ready") { this.#staffActive = true; this.#spokenMenu.clear(); this.#searchMenu.clear(); this.#publicMenu = undefined; }
      return selected;
    } catch { return denied(); }
    finally { this.#preparingStaff = false; }
  }
  async collectIntake(draft: ClinikoIntakeDraft) {
    const source = this.intake;
    if (!source || this.closed) return unavailable<Readonly<{ draftRef: string }>>();
    this.#verificationRequired = true; this.#intakeDraftRef = undefined;
    const result = await source.collect(draft, { privacyAccepted: true, intakeAccepted: true });
    if (!result.ok || this.closed || this.intake !== source) return unavailable<Readonly<{ draftRef: string }>>();
    this.#intakeDraftRef = result.value.draftRef; return result;
  }
  async startWorkflow(query: WorkflowQuery) {
    const config = this.#config;
    if (!sameScope(query.scope, config.receipt.scope) || query.callId !== config.receipt.callId || query.sessionId !== config.sessionId ||
        query.policyVersion !== config.policyVersion || query.signal.aborted) return unavailable<Readonly<{ kind: "codeRequired" | "intakeRequired" }>>();
    const selected = await this.choose(query.operation, query.signal, query.replaceCanceledChange === true, query.expectedConversationRevision);
    if (selected.ok && !query.signal.aborted && selected.value.kind === "codeRequired") this.beginVerification();
    return selected;
  }
  get intake(): ClinikoIntakeBookingSession["intake"] | undefined {
    return !this.#staffActive && this.#owner instanceof ClinikoIntakeBookingSession ? this.#owner.intake : undefined;
  }
  async #active(operation: ClinikoWorkflow, external?: AbortSignal): Promise<boolean> {
    const config = this.#config, scope = config.receipt.scope;
    const signal = AbortSignal.any([this.#workflowLifetime.signal, this.#patientLifetime.signal, this.#lifetime.signal, AbortSignal.timeout(5_000), ...(external ? [external] : [])]);
    const checked = await awaitUntilAbort(Promise.all([config.ledger.read(config.receipt.callId, scope), config.policies.read(scope),
      operation === "appointments.read" ? Promise.resolve(ok({ stopped: false })) : config.ledger.readWriteStop(scope)]), signal);
    if (!checked || signal.aborted) return false;
    const [found, current, stop] = checked;
    const now = Date.parse((config.clock ?? (() => new Date().toISOString()))());
    return !this.#patientLifetime.signal.aborted && !this.#lifetime.signal.aborted && found.ok && current.ok && stop.ok && !stop.value.stopped && Number.isFinite(now) &&
      !found.value.callerIdentityDenied && found.value.lifecycle === "active" && sameScope(found.value.policy.scope, scope) && sameScope(current.value.scope, scope) &&
      found.value.policy.policyVersion === config.policyVersion && current.value.policyVersion === config.policyVersion &&
      found.value.policy.automationEnabled && current.value.automationEnabled &&
      (operation === "appointments.read" ? config.enquiry !== undefined : found.value.policy.capabilities[operation] === "execute" && current.value.capabilities[operation] === "execute") &&
      found.value.sessionLease?.sessionId === config.sessionId && Date.parse(found.value.sessionLease.expiresAt) > now &&
      found.value.admission?.key.accountRef === config.inbound.key.accountRef && found.value.admission.key.providerCallRef === config.inbound.key.providerCallRef &&
      found.value.admission.dialedNumber === config.inbound.dialedNumber;
  }
  async choose(operation: ClinikoWorkflow, external?: AbortSignal, replaceCanceledChange = false, expectedRevision?: number): Promise<Result<Readonly<{ kind: "codeRequired" | "intakeRequired" }>, Failure>> {
    if (!["book", "cancel", "reschedule", "intake", "appointments.read"].includes(operation) || this.#staffActive || this.#selecting || this.#patientLifetime.signal.aborted || this.#lifetime.signal.aborted || external?.aborted) return unavailable();
    if (this.#owner && this.#workflow === operation) return await this.#active(operation, external)
      ? ok({ kind: operation === "intake" ? "intakeRequired" : "codeRequired" }) : unavailable();
    this.#selecting = true;
    const signal = AbortSignal.any([this.#workflowLifetime.signal, this.#patientLifetime.signal, this.#lifetime.signal, this.#config.signal, AbortSignal.timeout(20_000), ...(external ? [external] : [])]);
    const buildLifetime = new AbortController();
    let published = false;
    let building: Promise<Result<Owner, Readonly<{ kind: string }>>> | undefined;
    let created: Owner | undefined;
    try {
      const previousOwner = this.#owner;
      const before = await awaitUntilAbort(this.#config.ledger.read(this.#config.receipt.callId, this.#config.receipt.scope), signal);
      if (!before?.ok || expectedRevision !== undefined && before.value.conversationRevision !== expectedRevision) return unavailable();
      // Only an explicitly requested unsent cancellation/move may be replaced.
      // New owners issue new operation-bound verification; no prior grant or target transfers.
      const fromEnquiry = previousOwner instanceof ClinikoAppointmentEnquirySession;
      if (previousOwner && !fromEnquiry && (!replaceCanceledChange || !["cancel", "reschedule"].includes(operation) ||
          !["cancel", "reschedule"].includes(this.#workflow!) ||
          Object.values(before.value.actions).some(action => action.status !== "canceled"))) return unavailable();
      if (fromEnquiry && Object.values(before.value.actions).some(action => action.status !== "canceled")) return unavailable();
      if (!await this.#active(operation, signal) || signal.aborted) return unavailable();
      const config = { ...this.#config, signal: AbortSignal.any([this.#workflowLifetime.signal, this.#patientLifetime.signal, this.#lifetime.signal, this.#config.signal, buildLifetime.signal]) }, paths = config.approvals;
      building = operation === "appointments.read" ? config.enquiry ? ClinikoAppointmentEnquirySession.create({ ...config, ...config.enquiry }) : undefined :
        operation === "book" ? ClinikoBookingSession.create({ ...config, callerApprovalPath: paths.bookCaller, bookingApprovalPath: paths.booking }) :
        operation === "cancel" ? ClinikoCancellationSession.create({ ...config, callerApprovalPath: paths.cancelCaller, cancellationApprovalPath: paths.cancellation }) :
        operation === "reschedule" ? ClinikoReschedulingSession.create({ ...config, callerApprovalPath: paths.rescheduleCaller, bookingApprovalPath: paths.booking, reschedulingApprovalPath: paths.rescheduling }) :
        config.intake ? ClinikoIntakeBookingSession.create({ ...config, ...config.intake, bookingPermission: config.permission, bookingApprovalPath: paths.booking }) : undefined;
      const result = building ? await awaitUntilAbort(building, signal) : undefined;
      if (!result?.ok) return unavailable();
      created = result.value;
      if (signal.aborted || !await this.#active(operation, signal)) return unavailable();
      const after = await awaitUntilAbort(this.#config.ledger.read(this.#config.receipt.callId, this.#config.receipt.scope), signal);
      if (!after?.ok || after.value.conversationRevision !== before.value.conversationRevision || this.#owner !== previousOwner ||
          signal.aborted || previousOwner && Object.values(after.value.actions).some(action => action.status !== "canceled")) return unavailable();
      previousOwner?.dispose(); this.#publicMenu = undefined; this.#spokenMenu.clear(); this.#searchMenu.clear(); this.#reschedulingTargetSelected = false;
      this.#owner = created; this.#workflow = operation; this.#verificationRequired = operation !== "intake"; created = undefined; published = true;
      return ok({ kind: operation === "intake" ? "intakeRequired" : "codeRequired" });
    } catch { return unavailable(); }
    finally {
      if (!published) { buildLifetime.abort(); void building?.then(result => { if (result.ok) result.value.dispose(); }, () => undefined); }
      created?.dispose(); this.#selecting = false;
    }
  }
  beginVerification(): boolean {
    if (this.#staffActive && this.#staff && !this.closed) { this.#staff.beginVerification(); return true; }
    const owner = this.#owner;
    if (this.#patientLifetime.signal.aborted || this.#lifetime.signal.aborted || !owner || owner instanceof ClinikoIntakeBookingSession) return false;
    owner.beginVerification(); return true;
  }
  async submitCode(code: string): Promise<Readonly<{ verified: boolean }>> {
    if (this.#staffActive && this.#staff && !this.closed) {
      const staff = this.#staff, result = await staff.submitCode(code);
      if (this.#patientLifetime.signal.aborted || this.closed || this.#staff !== staff) return { verified: false };
      if (result.verified) this.#verificationRequired = false;
      return result;
    }
    const owner = this.#owner;
    if (this.#patientLifetime.signal.aborted || this.#lifetime.signal.aborted || !owner) return { verified: false };
    const result = await (owner instanceof ClinikoIntakeBookingSession ? owner.intake.submitCode(code) : owner.submitCode(code));
    if (this.#lifetime.signal.aborted || owner !== this.#owner) return { verified: false };
    if (result.verified) this.#verificationRequired = false;
    return result;
  }
  async cancellationProof(): Promise<Readonly<{ verificationRef: string; expiresAt: string }> | undefined> {
    return !this.#staffActive && this.#owner instanceof ClinikoCancellationSession && !this.#lifetime.signal.aborted ? this.#owner.verified() : undefined;
  }
  async enquiryRange(now: string) {
    return !this.closed && !this.#staffActive && !this.#verificationRequired && this.#owner instanceof ClinikoAppointmentEnquirySession
      ? this.#owner.searchRange(now) : undefined;
  }
  async enquiryChoiceIntent(text: string): Promise<VoiceIntent | undefined> {
    if (this.#workflow !== "appointments.read" || this.#verificationRequired || this.closed || this.#staffActive) return undefined;
    const value = text.toLowerCase().replace(/[,.!?]/g, " ").replace(/\s+/g, " ").trim();
    const match = value.match(/^(?:the |my |option )?(first|second|third|one|two|three|1|2|3)(?: (?:appointment|visit|one))?(?: please)?$/);
    if (!match) return undefined;
    const choice = ["first", "one", "1"].includes(match[1]!) ? 1 : ["second", "two", "2"].includes(match[1]!) ? 2 : 3;
    // The shared enquiry turn owner checks actual latest playback and count;
    // the source then re-reads the exact private appointment selection.
    return { kind: "appointmentEnquiryChoice", choice };
  }
  async #enquiryOwner(query: AppointmentEnquiryQuery) {
    const c = this.#config, owner = this.#owner;
    if (!(owner instanceof ClinikoAppointmentEnquirySession) || this.#verificationRequired || this.#staffActive || this.closed || query.signal.aborted ||
        !sameScope(query.scope, c.receipt.scope) || query.callId !== c.receipt.callId || query.sessionId !== c.sessionId || query.policyVersion !== c.policyVersion) return undefined;
    const state = await awaitUntilAbort(c.ledger.read(c.receipt.callId, c.receipt.scope), query.signal);
    return state?.ok && (query.expectedConversationRevision === undefined || query.expectedConversationRevision === state.value.conversationRevision) &&
      this.#owner === owner && await this.#active("appointments.read", query.signal) ? owner : undefined;
  }
  async readAppointmentEnquiry(query: AppointmentEnquiryQuery & Readonly<{ from: string; to: string }>) {
    const owner = await this.#enquiryOwner(query);
    const result = owner ? await owner.read(query.from, query.to, query.now, query.signal) : undefined;
    if (!result || owner !== await this.#enquiryOwner(query)) return err({ kind: "invalidProof" as const });
    return result.ok ? ok({ snapshot: result.value, checkedAt: (this.#config.clock ?? (() => new Date().toISOString()))() }) : result;
  }
  async selectAppointmentEnquiry(query: AppointmentEnquiryQuery & Readonly<{ choice: 1 | 2 | 3 }>) {
    const owner = await this.#enquiryOwner(query);
    const result = owner ? await owner.select(query.choice, query.now, query.signal) : undefined;
    if (!result || owner !== await this.#enquiryOwner(query)) return err({ kind: "invalidProof" as const });
    return result.ok ? ok({ ...result.value, checkedAt: (this.#config.clock ?? (() => new Date().toISOString()))() }) : result;
  }
  /** Exact bounded cancellation selection over the latest actually played list.
   * Only private host state is selected; the ordinary SAM proposal still owns
   * action preparation, exact playback and separate affirmation. */
  async selectCancellationIntent(turn: FinalCallerTurn, choice: 1 | 2 | 3, external?: AbortSignal): Promise<VoiceIntent> {
    const denied = { kind: "clarify", reason: "menuUnavailable" } as const, owner = this.#owner;
    if (!(owner instanceof ClinikoCancellationSession) || this.closed || this.#staffActive || this.#verificationRequired ||
        turn.callId !== this.#config.receipt.callId || turn.sessionId !== this.#config.sessionId) return denied;
    const signal = AbortSignal.any([this.#workflowLifetime.signal, this.#patientLifetime.signal, this.#lifetime.signal, AbortSignal.timeout(15_000), ...(external ? [external] : [])]);
    const config = this.#config, before = await awaitUntilAbort(config.ledger.read(turn.callId, config.receipt.scope), signal);
    if (!before?.ok) return denied;
    const last = before.value.appointmentReads.at(-1), notice = last && before.value.presentations[noticePresentationId(turn.callId, last.turnId)];
    if (!last || last.status !== "shown" || (last.shownCount ?? 0) < 2 || before.value.pendingPresentationId ||
        before.value.processedTurnIds.at(-1) !== last.turnId || notice?.status !== "played") return denied;
    const proof = await owner.verified(signal);
    if (!proof) return denied;
    const now = (config.clock ?? (() => new Date().toISOString()))();
    const selected = await awaitUntilAbort(owner.appointments.select(config.receipt.scope, proof.verificationRef, choice, now, signal), signal);
    const after = await awaitUntilAbort(config.ledger.read(turn.callId, config.receipt.scope), signal);
    if (!selected?.ok || !after?.ok || signal.aborted || this.closed || this.#owner !== owner ||
        after.value.conversationRevision !== before.value.conversationRevision || after.value.lifecycle !== "active" ||
        after.value.sessionLease?.sessionId !== config.sessionId || selected.value.snapshot.verificationRef !== proof.verificationRef ||
        selected.value.snapshot.appointments.length !== 1) return denied;
    return { kind: "cancel", verificationRef: proof.verificationRef, targetRef: "selected" };
  }
  get appointments() { return !this.#staffActive && this.#owner instanceof ClinikoCancellationSession ? this.#owner.appointments : undefined; }
  #booking() { return this.#staffActive ? undefined : this.#owner instanceof ClinikoBookingSession ? this.#owner.effects : this.#owner instanceof ClinikoIntakeBookingSession ? this.#owner : undefined; }
  bookingMenuAvailable(): boolean { return this.#booking()?.bookingMenuAvailable() === true; }
  async readBookingMenu(query: BookingMenuReadQuery) {
    this.#spokenMenu.clear();
    if (this.#booking()) { const failure = await this.#horizonFailure(query); if (failure) return err(failure); }
    const result = await (this.#booking()?.readBookingMenu(query) ?? readDenied());
    if (result.ok && !query.signal.aborted && !this.closed && !this.#patientLifetime.signal.aborted) {
      this.#publicMenu = { kind: "booking", stage: null };
      this.#searchMenu.remember({ turnId: query.turnId, from: query.from, to: query.to, kind: "booking", snapshot: result.value });
      this.#spokenMenu.remember({ kind: "booking", stage: null, turnId: query.turnId, snapshot: result.value });
    }
    return result;
  }
  async selectBookingMenu(query: BookingMenuQuery & Readonly<{ menuTurnId: string; choice: 1 | 2 | 3 }>) {
    const result = await (this.#booking()?.selectBookingMenu(query) ?? readDenied());
    if (result.ok && !query.signal.aborted && !this.closed && !this.#patientLifetime.signal.aborted) { this.#publicMenu = undefined; this.#spokenMenu.consumed(query.turnId, query.choice); }
    else if (!query.signal.aborted) this.#spokenMenu.clear();
    return result;
  }
  async resolveBooking(scope: LocationScope, verificationRef: string, offerRef: string, now: string, signal?: AbortSignal) { return this.#booking()?.resolveBooking(scope, verificationRef, offerRef, now, signal) ?? readDenied(); }
  reschedulingMenuAvailable(): boolean { return !this.#staffActive && this.#owner instanceof ClinikoReschedulingSession && this.#owner.effects.reschedulingMenuAvailable(); }
  async readReschedulingMenu(query: ReschedulingMenuReadQuery) {
    this.#spokenMenu.clear();
    if (query.stage === "offers" && this.reschedulingMenuAvailable()) { const failure = await this.#horizonFailure(query); if (failure) return err(failure); }
    const result = await (!this.#staffActive && this.#owner instanceof ClinikoReschedulingSession ? this.#owner.effects.readReschedulingMenu(query) : readDenied());
    if (result.ok && !query.signal.aborted && !this.closed && !this.#patientLifetime.signal.aborted) {
      this.#publicMenu = { kind: "rescheduling", stage: query.stage };
      if (query.stage === "offers") this.#searchMenu.remember({ turnId: query.turnId, from: query.from, to: query.to, kind: "rescheduling", snapshot: result.value });
      else this.#searchMenu.clear();
      this.#spokenMenu.remember({ kind: "rescheduling", stage: query.stage, turnId: query.turnId, snapshot: result.value });
    }
    return result;
  }
  async selectReschedulingMenu(query: ReschedulingMenuQuery & Readonly<{ menuTurnId: string; choice: 1 | 2 | 3 }>) {
    const result = await (!this.#staffActive && this.#owner instanceof ClinikoReschedulingSession ? this.#owner.effects.selectReschedulingMenu(query) : readDenied());
    if (result.ok && !query.signal.aborted && !this.closed && !this.#patientLifetime.signal.aborted) {
      this.#publicMenu = undefined;
      if (result.value.kind === "targetSelected") { this.#reschedulingTargetSelected = true; this.#spokenMenu.clear(); }
      else this.#spokenMenu.consumed(query.turnId, query.choice);
    }
    else if (!query.signal.aborted) this.#spokenMenu.clear();
    return result;
  }
  async resolveAppointmentChange(query: AppointmentChangeEvidenceQuery, signal?: AbortSignal) { return !this.#staffActive && (this.#owner instanceof ClinikoCancellationSession || this.#owner instanceof ClinikoReschedulingSession) ? this.#owner.effects.resolveAppointmentChange(query, signal) : readDenied(); }
  async resolveIntake(query: IntakeEvidenceQuery) { return !this.#staffActive && this.#owner instanceof ClinikoIntakeBookingSession ? this.#owner.resolveIntake(query) : readDenied(); }
  async write(mutation: HostMutation, now: string, signal?: AbortSignal): Promise<HostWriteReceipt> {
    const owner = this.#owner;
    if (!owner || owner instanceof ClinikoAppointmentEnquirySession || this.#staffActive || this.#lifetime.signal.aborted) return { kind: "rejected", actionKey: mutation.actionKey, reason: "forbidden" };
    return (owner instanceof ClinikoIntakeBookingSession ? owner : owner.effects).write(mutation, now, signal);
  }
  async reconcile(mutation: HostMutation) { return { kind: "stillUnknown" as const, actionKey: mutation.actionKey }; }
  async readStaffReviewProcess(query: import("../core/host.ts").StaffReviewProcessQuery) {
    if (this.closed || this.#patientLifetime.signal.aborted || query.signal.aborted || !this.#staffActive || !this.#staff) return err({ kind: "staffReviewUnavailable" as const });
    return this.#staff.readReviewProcess(query);
  }
  async openTask(item: StaffItem, signal?: AbortSignal) { return this.#staff?.openTask(item, signal) ?? { kind: "rejected" as const, taskKey: item.key }; }
  async reconcileTask(item: StaffItem, signal?: AbortSignal) { return this.#staff?.reconcileTask(item, signal) ?? { kind: "stillUnknown" as const, taskKey: item.key }; }
  dispose(): void { this.#searchMenu.clear(); this.#spokenMenu.clear(); this.#workflowLifetime.abort(); this.#patientLifetime.abort(); this.#lifetime.abort(); this.#config.signal.removeEventListener("abort", this.#onClose); this.#owner?.dispose(); this.#staff?.dispose(); this.#staff = undefined; this.#owner = undefined; this.#workflow = undefined; this.#verificationRequired = false; this.#intakeDraftRef = undefined; this.#publicMenu = undefined; this.#reschedulingTargetSelected = false; }
}
