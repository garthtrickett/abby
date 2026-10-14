import { ClassServiceDialogue } from "./class-service-dialogue.ts";
import { readClassServices, classServiceName } from "./class-service-catalogue.ts";
import type { ClassServiceConfig, PublicClassService } from "./class-service-catalogue.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { ClinikoCallTasks } from "./cliniko-call-tasks.ts";
import { ClinikoRepresentativeCallOwner } from "./cliniko-representative-call-owner.ts";
import { ClinikoRepresentativeSelection } from "./cliniko-representative-selection.ts";
import type { RepresentativeWorkflowSelection } from "./workflow-caller-verification.ts";
import { ClinikoConfirmationResendWorkflow } from "./cliniko-confirmation-resend-workflow.ts";
import type { ConfirmationResendWorkflowConfig, ConfirmationResendMenuProgress } from "./cliniko-confirmation-resend-workflow.ts";
import { ClinikoPractitionerHistorySession } from "./cliniko-practitioner-history-session.ts";
import type { VerifiedPatient } from "../core/model.ts";
import { copyBookingServiceChoice } from "../core/booking-service-choice.ts";
import { servicePractitionerPreferenceLanguage } from "./service-practitioner-preference.ts";
import { hasSentPatientWork } from "../core/request-boundary.ts";
import { readClinikoBookingHorizon, requestedDatesOutsideHorizon } from "./cliniko-booking-horizon.ts";
import { validCallerIdentityDenial } from "../core/caller-identity.ts";
import { bookingPreferenceLanguage } from "./booking-preference-language.ts";
import { ClinikoCatalogueBookingHost } from "./cliniko-catalogue-booking-host.ts";
import { normalizedSpokenName } from "../core/pending-location.ts";
import { bookingDateRangeLanguage } from "./booking-date-range-language.ts";
import { PlayedMenuSearch } from "./played-menu-search.ts";
import { clinicDateAt } from "./clinic-clock.ts";
import type { AppointmentEnquiryQuery, AppointmentChangeEvidenceQuery, BookingMenuQuery, BookingMenuReadQuery, IntakeEvidenceQuery, ReschedulingMenuQuery, ReschedulingMenuReadQuery, StaffRequestQuery, WorkflowQuery } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { HostMutation, HostWriteReceipt, LocationScope, Result, StaffItem } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { callIdFor } from "../voice/admission.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { ClinikoClassSession } from "./cliniko-class-session.ts";
import { OwnerFileClassPolicy } from "./owner-file-class-policy.ts";
import { ClinikoBookingSession } from "./cliniko-booking-session.ts";
import type { ClinikoBookingSessionConfig } from "./cliniko-booking-session.ts";
import { ClinikoCancellationSession } from "./cliniko-cancellation-session.ts";
import { ClinikoIntakeBookingSession } from "./cliniko-intake-booking-session.ts";
import type { ClinikoIntakeBookingSessionConfig } from "./cliniko-intake-booking-session.ts";
import { ClinikoReschedulingSession } from "./cliniko-rescheduling-session.ts";
import { PlayedPractitionerSelection } from "./played-practitioner-selection.ts";
import { validCallKnowledgeSource } from "../core/knowledge-evidence.ts";
import { OwnerFileClinicFAQs } from "./owner-file-clinic-faqs.ts";
import { NoStoredKnowledge } from "./no-stored-knowledge.ts";
import type { ClinikoIntakeDraft } from "../cliniko/patient-intake.ts";
import type { CallState, FinalCallerTurn } from "../core/model.ts";
import type { VoiceIntent } from "../voice/voice-session.ts";
import { PlayedMenuSelection } from "./played-menu-selection.ts";
import { noticePresentationId } from "../core/transition.ts";
import { ClinikoStaffSession } from "./cliniko-staff-session.ts";
import { ClinikoAppointmentEnquirySession } from "./cliniko-appointment-enquiry-session.ts";
import type { PatientVerificationPermission } from "./email-patient-authority.ts";
import type { BookingServiceChoice } from "../core/booking-service-choice.ts";
import { bookingServiceLanguage, bookingEligibilityChanged, bookingDurationLanguage } from "./booking-service-language.ts";
import { BookingServiceDialogue, startsServiceDialogue, startsIntakeServiceDialogue } from "./booking-service-dialogue.ts";
import { currentServiceCatalogue, serviceBookingConfig } from "./service-booking-config.ts";
import type { ServiceCatalogueConfig } from "./service-booking-config.ts";
import { ClinikoPatientCorrectionWorkflow } from "./cliniko-patient-correction-workflow.ts";
import type { PatientCorrectionWorkflowConfig } from "./cliniko-patient-correction-workflow.ts";
import type { PatientDetailChanges } from "../cliniko/patient-details.ts";

export type ClinikoWorkflow = import("../core/model.ts").WorkflowOperation;
export type ClinikoCallFlowConfig = Omit<ClinikoBookingSessionConfig, "callerApprovalPath" | "bookingApprovalPath" | "representative"> & Readonly<{
  approvals: Readonly<{ bookCaller: string; cancelCaller: string; rescheduleCaller: string; booking: string; cancellation: string; rescheduling: string }>;
  classAttendance?: ClassServiceConfig;
  classServices?: readonly ClassServiceConfig[];
  intake?: Pick<ClinikoIntakeBookingSessionConfig, "policy" | "permission" | "presentation">;
  staff?: Readonly<{ callerApprovalPath: string; staffApprovalPath: string; recallTypeId: string; permission: PatientVerificationPermission }>;
  publicKnowledge?: OwnerFileClinicFAQs;
  history?: Readonly<{ callerApprovalPath: string; historyApprovalPath: string; permission: PatientVerificationPermission }>;
  enquiry?: Readonly<{ callerApprovalPath: string; readApprovalPath: string; permission: PatientVerificationPermission }>;
  serviceCatalogue?: ServiceCatalogueConfig;
  correction?: PatientCorrectionWorkflowConfig;
  resend?: ConfirmationResendWorkflowConfig;
  taskSequence?: Readonly<{ approvalPath: string }>;
  representativeInput?: Omit<Parameters<typeof ClinikoRepresentativeCallOwner.create>[0], "context" | "flow" | "operation" | "serviceChoice">;
  reschedulingDestination?: Readonly<{ practitionerId: string; bookingApprovalPath: string }>;
  reschedulingPractitioners?: readonly Readonly<{ practitionerId: string; bookingApprovalPath: string }>[];
}>;
type Owner = ClinikoClassSession | ClinikoBookingSession | ClinikoCancellationSession | ClinikoReschedulingSession | ClinikoIntakeBookingSession | ClinikoAppointmentEnquirySession | ClinikoPractitionerHistorySession | ClinikoPatientCorrectionWorkflow | ClinikoConfirmationResendWorkflow;
type Failure = Readonly<{ kind: "workflowUnavailable" }>;
const unavailable = <T>(): Result<T, Failure> => err({ kind: "workflowUnavailable" });
const readDenied = () => err({ kind: "unavailable" as const, target: "appointment" as const });
const offerDenied = () => err({ kind: "unavailable" as const, target: "offer" as const });
export const clinikoStaffPreparationDeadlineMs = 20_000;

/** An admitted call owns its current workflow. No eager verifier, model credential, cross-operation grant or implicit intake booking.
 * Concrete workflow owners retain all permission, public approval, SAM, inspection and single-send checks. */
export class ClinikoCallFlow extends NoStoredKnowledge {
  readonly effectDeadlineMs = 30_000;
  readonly #config: ClinikoCallFlowConfig;
  readonly #tasks: ClinikoCallTasks | undefined;
  readonly #lifetime = new AbortController();
  readonly #patientLifetime = new AbortController();
  #workflowLifetime = new AbortController();
  readonly #onClose = () => this.dispose();
  #owner: Owner | undefined;
  #representative: RepresentativeWorkflowSelection | undefined;
  #representativeCall: ClinikoRepresentativeCallOwner | undefined;
  #pendingRepresentative: Readonly<{ owner: ClinikoRepresentativeCallOwner; operation: "book" | "cancel" | "reschedule" | "appointments.read";
    revision: number; before: CallState; advancing: boolean }> | undefined;
  #pendingTask: Readonly<{ owner: Owner; previous: Owner; operation: ClinikoWorkflow; before: CallState;
    selectedConfig: ClinikoCallFlowConfig; serviceChoice: BookingServiceChoice | undefined; representative: RepresentativeWorkflowSelection | undefined }> | undefined;
  #historySubject: VerifiedPatient | undefined;
  #bookingConfig: ClinikoCallFlowConfig | undefined;
  #serviceChoice: BookingServiceChoice | undefined;
  #serviceOperation: "book" | "intake" | undefined;
  #staff: ClinikoStaffSession | undefined;
  #staffActive = false;
  #preparingStaff = false;
  #workflow: ClinikoWorkflow | undefined;
  #selecting = false;
  #verificationRequired = false;
  #intakeDraftRef: string | undefined;
  #patientCorrectionRef: string | undefined;
  #confirmationResendRef: string | undefined;
  #publicMenu: Readonly<{ kind: "booking" | "rescheduling"; stage: "targets" | "practitioners" | "offers" | null }> | undefined;
  #reschedulingTargetSelected = false;
  readonly #serviceDialogue = new BookingServiceDialogue();
  readonly #classDialogue = new ClassServiceDialogue();
  readonly #searchMenu = new PlayedMenuSearch();
  readonly #spokenMenu = new PlayedMenuSelection();
  readonly #spokenPractitioners = new PlayedPractitionerSelection();
  #switchPromptTurnId: string | undefined;
  private constructor(config: ClinikoCallFlowConfig) {
    const freezeClass = (service: ClassServiceConfig) => Object.freeze({ ...service,
      ...(service.move ? { move: Object.freeze({ ...service.move, destination: Object.freeze({ ...service.move.destination }) }) } : {}) });
    super(); this.#config = Object.freeze({ ...config, receipt: structuredClone(config.receipt), inbound: structuredClone(config.inbound),
      ...(config.reschedulingDestination ? { reschedulingDestination: Object.freeze({ ...config.reschedulingDestination }) } : {}),
      ...(config.reschedulingPractitioners ? { reschedulingPractitioners: Object.freeze(config.reschedulingPractitioners.map(member => Object.freeze({ ...member }))) } : {}),
      ...(config.classAttendance ? { classAttendance: freezeClass(config.classAttendance) } : {}),
      ...(config.classServices ? { classServices: Object.freeze(config.classServices.map(freezeClass)) } : {}),
      cliniko: Object.freeze({ ...config.cliniko }), approvals: Object.freeze({ ...config.approvals }), ...(config.intake ? { intake: Object.freeze({ ...config.intake }) } : {}),
      ...(config.catalogue ? { catalogue: Object.freeze({ ...config.catalogue, practitioners: Object.freeze(config.catalogue.practitioners.map(member => Object.freeze({ ...member }))) }) } : {}),
      ...(config.staff ? { staff: Object.freeze({ ...config.staff }) } : {}),
      ...(config.history ? { history: Object.freeze({ ...config.history }) } : {}),
      ...(config.enquiry ? { enquiry: Object.freeze({ ...config.enquiry }) } : {}),
      ...(config.correction ? { correction: Object.freeze({ ...config.correction }) } : {}),
      ...(config.resend ? { resend: Object.freeze({ ...config.resend }) } : {}),
      ...(config.representativeInput ? { representativeInput: Object.freeze({ ...config.representativeInput }) } : {}),
      ...(config.serviceCatalogue ? { serviceCatalogue: Object.freeze({ ...config.serviceCatalogue,
        services: Object.freeze(config.serviceCatalogue.services.map(service => Object.freeze({ ...service,
          practitioners: Object.freeze(service.practitioners.map(member => Object.freeze({ ...member }))) }))) }) } : {}) });
    this.#tasks = config.taskSequence ? new ClinikoCallTasks({ path: config.taskSequence.approvalPath, scope: config.receipt.scope,
      policyVersion: config.policyVersion, businessId: config.cliniko.businessId, credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey),
      timeZone: config.cliniko.timeZone, callId: config.receipt.callId, sessionId: config.sessionId, directory: config.directory,
      clock: config.clock ?? (() => new Date().toISOString()), signal: this.#lifetime.signal }) : undefined;
    config.signal.addEventListener("abort", this.#onClose, { once: true }); if (config.signal.aborted) this.dispose();
  }
  static create(config: ClinikoCallFlowConfig): Result<ClinikoCallFlow, Failure> {
    try {
      if (!config || config.classAttendance && config.classServices || config.classServices && (!Array.isArray(config.classServices) || config.classServices.length < 1 || config.classServices.length > 32) || Object.hasOwn(config, "representative") || !(config.signal instanceof AbortSignal) || config.signal.aborted || config.receipt.callId !== callIdFor(config.inbound.key) ||
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
    this.#publicMenu = undefined; this.#spokenMenu.clear(); this.#spokenPractitioners.clear(); this.#searchMenu.clear(); this.#reschedulingTargetSelected = false;
    if ((this.#tasks ? this.#tasks.hasSentCurrentWork(state.value) : hasSentPatientWork(state.value))) return true; // Do not dispose a sent owner's receipt/recovery state or saved intake proof.
    this.#workflowLifetime.abort(); this.#workflowLifetime = new AbortController();
    this.#pendingRepresentative?.owner.dispose(); this.#pendingRepresentative = undefined;
    this.#representativeCall?.dispose(); this.#representativeCall = undefined;
    this.#representative?.owner.dispose(); this.#representative = undefined;
    this.#owner?.dispose(); this.#staff?.dispose(); this.#owner = undefined; this.#staff = undefined;
    this.#serviceDialogue.clear(); this.#classDialogue.clear(); this.#workflow = undefined; this.#bookingConfig = undefined; this.#serviceChoice = undefined; this.#serviceOperation = undefined; this.#staffActive = false; this.#verificationRequired = false; this.#intakeDraftRef = undefined;
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
    this.#patientLifetime.abort(); this.#historySubject = undefined; this.#representative?.owner.dispose(); this.#representative = undefined;
    this.#owner?.dispose(); this.#staff?.dispose(); this.#owner = undefined; this.#staff = undefined;
    this.#serviceDialogue.clear(); this.#classDialogue.clear(); this.#workflow = undefined; this.#bookingConfig = undefined; this.#serviceChoice = undefined; this.#serviceOperation = undefined; this.#staffActive = false; this.#verificationRequired = false; this.#intakeDraftRef = undefined;
    this.#publicMenu = undefined; this.#reschedulingTargetSelected = false; this.#spokenMenu.clear(); this.#spokenPractitioners.clear(); this.#searchMenu.clear();
    return true;
  }
  binding() { return { callId: this.#config.receipt.callId, sessionId: this.#config.sessionId }; }
  get representativeInputOwner(): ClinikoRepresentativeCallOwner | undefined {
    return !this.closed && !this.patientAccessDenied ? this.#representativeCall : undefined;
  }
  /** Trusted private-input composition only; matching context grants no
   * patient permission and returns no caller or patient fields. */
  matchesPrivateVerificationContext(context: Pick<ClinikoCallFlowConfig, "receipt" | "inbound" | "sessionId" | "policyVersion" | "cliniko">): boolean {
    const c = this.#config;
    return !this.closed && !this.patientAccessDenied && sameScope(context.receipt.scope, c.receipt.scope) &&
      context.receipt.callId === c.receipt.callId && context.sessionId === c.sessionId && context.policyVersion === c.policyVersion &&
      context.inbound.key.accountRef === c.inbound.key.accountRef && context.inbound.key.providerCallRef === c.inbound.key.providerCallRef &&
      context.inbound.dialedNumber === c.inbound.dialedNumber && context.inbound.presentedCallerNumber === c.inbound.presentedCallerNumber &&
      context.cliniko.businessId === c.cliniko.businessId && context.cliniko.timeZone === c.cliniko.timeZone &&
      context.cliniko.countryCallingCode === c.cliniko.countryCallingCode &&
      context.cliniko.rateBudget === c.cliniko.rateBudget &&
      clinikoCredentialFingerprint(context.cliniko.apiKey) === clinikoCredentialFingerprint(c.cliniko.apiKey);
  }
  async readBookingHorizon(query: import("../core/host.ts").BookingHorizonQuery) {
    return this.#readHorizon(query);
  }
  async #readHorizon(query: import("../core/host.ts").BookingHorizonQuery, incoming?: import("../core/booking-search-preference.ts").BookingSearchPreference) {
    if (this.closed || this.#patientLifetime.signal.aborted || this.#staffActive || this.#workflow && !["book", "reschedule", "intake"].includes(this.#workflow))
      return err({ kind: "bookingHorizonUnavailable" as const });
    if (this.#config.serviceCatalogue && this.#workflow !== "reschedule" && (!this.#bookingConfig || !this.#serviceChoice)) return err({ kind: "bookingHorizonUnavailable" as const });
    const booking = this.#booking(), host = booking instanceof ClinikoIntakeBookingSession ? booking.effects : booking, prior = host instanceof ClinikoCatalogueBookingHost ? host.currentSearchPreference() : undefined;
    return readClinikoBookingHorizon(this.#bookingConfig ?? this.#config, { ...query, signal: AbortSignal.any([query.signal, this.#lifetime.signal]) }, this.#workflow === "reschedule" ? "reschedule" : "book",
      incoming?.practitioner ?? prior?.practitioner);
  }
  async #horizonFailure(query: BookingMenuReadQuery | ReschedulingMenuReadQuery) {
    if (this.#owner instanceof ClinikoClassSession) return undefined;
    const state = await this.#config.ledger.read(query.callId, query.scope);
    if (!state.ok) return undefined;
    const limits = await this.#readHorizon({ ...query, expectedConversationRevision: state.value.conversationRevision }, "preference" in query ? query.preference : undefined);
    return limits.ok && requestedDatesOutsideHorizon(limits.value, query.from, query.to, this.#config.cliniko.timeZone)
      ? { kind: "outsideHorizon" as const, target: "offer" as const, snapshot: limits.value } : undefined;
  }
  get previousPractitionerConfigured(): boolean { return this.#config.history !== undefined; }
  get workflow(): ClinikoWorkflow | undefined { return this.#workflow; }
  get patientAccessDenied(): boolean { return this.#patientLifetime.signal.aborted; }
  get closed(): boolean { return this.#lifetime.signal.aborted; }
  /** Non-secret transport state. The input owner closes ordinary media before mail starts. */
  get verificationRequired(): boolean { return this.#verificationRequired; }
  async #publicClassService() {
    const c = this.#config, selected = c.classAttendance;
    if (!selected || this.closed || this.patientAccessDenied || this.#staffActive) return undefined;
    if (selected.move) {
      const signal = AbortSignal.any([c.signal, this.#lifetime.signal, this.#patientLifetime.signal, AbortSignal.timeout(5000)]);
      const services = await readClassServices({ scope: c.receipt.scope, policyVersion: c.policyVersion, ...c.cliniko,
        directory: c.directory, clock: c.clock ?? (() => new Date().toISOString()), services: [selected] }, signal);
      const first = services.ok ? services.value.items[0]?.public : undefined;
      return first && !signal.aborted ? { className: first.className, practitionerName: first.practitionerName,
        locationName: first.locationName, serviceRef: first.serviceRef, ...(first.moveAvailable ? { moveAvailable: true as const } : {}) } : undefined;
    }
    const policy = await OwnerFileClassPolicy.capture({ path: selected.approvalPath, scope: c.receipt.scope,
      policyVersion: c.policyVersion, businessId: c.cliniko.businessId, practitionerId: selected.practitionerId,
      appointmentTypeId: selected.appointmentTypeId, credentialFingerprint: clinikoCredentialFingerprint(c.cliniko.apiKey),
      recallTypeId: c.cliniko.recallTypeId, timeZone: c.cliniko.timeZone, directory: c.directory,
      clock: c.clock ?? (() => new Date().toISOString()) });
    const current = policy.ok ? await policy.value.current(c.receipt.scope) : undefined;
    return current?.ok && !this.closed ? { className: current.value.className, practitionerName: current.value.practitionerName,
      locationName: current.value.locationName, serviceRef: current.value.serviceRef } : undefined;
  }
  async #classServices(external?: AbortSignal) {
    const c = this.#config;
    if (!c.classServices || this.closed || this.patientAccessDenied || this.#staffActive) return undefined;
    const signal = AbortSignal.any([c.signal, this.#lifetime.signal, this.#patientLifetime.signal, AbortSignal.timeout(5_000), ...(external ? [external] : [])]);
    const result = await readClassServices({ scope: c.receipt.scope, policyVersion: c.policyVersion, ...c.cliniko,
      directory: c.directory, clock: c.clock ?? (() => new Date().toISOString()), services: c.classServices }, signal);
    return result.ok && !signal.aborted ? result.value : undefined;
  }
  /** The public model may request a class operation, but only the actual caller
   * turn and a played question may select its private service binding. */
  async classServiceIntent(turn: FinalCallerTurn, external?: AbortSignal, requestedOperation?: "book" | "cancel" | "reschedule"): Promise<VoiceIntent | undefined> {
    if (!this.#config.classServices) return undefined;
    const normalized = classServiceName(turn.text);
    const match = /^(?:(?:please|can you|could you|i want to|i would like to) )?(book|cancel|move|reschedule) (?:(?:me (?:into|onto) )?(?:my|the|a) )?(.+?)(?: attendance)?(?: tonight|today|tomorrow)?(?: please)?$/.exec(normalized);
    const explicit = match && (/(?:^| )class$/.test(match[2]!) || /pilates|gym/.test(match[2]!));
    if (!explicit && !requestedOperation && !this.#classDialogue.active) return undefined;
    const denied = { kind: "clarify", reason: "serviceSelectionUnavailable" } as const;
    if (this.closed || this.patientAccessDenied || this.#staffActive || this.#verificationRequired || this.#owner && !(this.#owner instanceof ClinikoClassSession)) { this.#classDialogue.clear(); return denied; }
    const complete = await this.#classServices(external);
    if (!complete) { this.#classDialogue.clear(); return denied; }
    const operation = explicit ? (["move", "reschedule"].includes(match![1]!) ? "reschedule" : match![1] as "book" | "cancel") : requestedOperation;
    const selectedOperation = operation ?? this.#classDialogue.operation ?? "book";
    const catalogue = selectedOperation === "reschedule" ? { ...complete, items: complete.items.filter(item => item.public.moveAvailable) } : complete;
    if (!catalogue.items.length) { this.#classDialogue.clear(); return denied; }
    let name: string | undefined;
    if (explicit) {
      const subject = match![2]!.replace(/(?:^| )class$/, "").trim();
      if (subject && subject !== "group") {
        const matches = catalogue.items.filter(item => {
          const label = classServiceName(item.public.className);
          return label === subject || label.replace(/ class$/, "") === subject || ["pilates", "mat", "gym"].includes(subject) && label.split(" ").includes(subject);
        });
        if (!matches.length) { this.#classDialogue.clear(); return denied; }
        if (matches.length === 1) name = matches[0]!.label;
      }
    }
    const c = this.#config, signal = AbortSignal.any([c.signal, this.#lifetime.signal, this.#patientLifetime.signal, AbortSignal.timeout(5_000), ...(external ? [external] : [])]);
    const checked = await awaitUntilAbort(Promise.all([c.ledger.read(c.receipt.callId, c.receipt.scope), c.policies.read(c.receipt.scope)]), signal);
    const allowed = (policy: CallState["policy"]) => policy.staffWorkEnabled === true &&
      (selectedOperation === "book" ? policy.bookingEnabled === true : selectedOperation === "cancel" ? policy.cancellationEnabled === true : policy.reschedulingEnabled === true);
    if (!checked || !checked[0].ok || !checked[1].ok || !allowed(checked[0].value.policy) || !allowed(checked[1].value) ||
        !await this.#active(selectedOperation, signal) || signal.aborted) { this.#classDialogue.clear(); return denied; }
    return this.#classDialogue.resolve(turn, checked[0].value, catalogue, (c.clock ?? (() => new Date().toISOString()))(), operation ? { operation, ...(name ? { name } : {}) } : undefined);
  }
  /** Finite public routing only. The admitted class session separately checks
   * current approvals, exact patient permission and private channel proof. */
  async classWorkflowIntent(text: string): Promise<VoiceIntent | undefined> {
    const normalized = text.toLowerCase().replace(/[’]/g, "'").replace(/[,.!?]/g, " ").replace(/\s+/g, " ").trim();
    if (!/\bclass(?: attendance)?\b/.test(normalized) || !/\b(?:book|cancel|move|reschedule)\b/.test(normalized)) return undefined;
    if (!/^(?:(?:please|can you|could you) )?(?:book|cancel|move|reschedule) (?:(?:me (?:into|onto) )?(?:my|the|a) )?(?:pilates|mat|gym|group)? ?class(?: attendance)?(?: tonight|today|tomorrow)?(?: please)?$/.test(normalized)) return undefined;
    const service = await this.#publicClassService();
    if (!service || this.#owner && !(this.#owner instanceof ClinikoClassSession)) return undefined;
    const requested = /\b(pilates|mat|gym)\b/.exec(normalized)?.[1];
    if (requested && !(requested === "mat" ? /mat|pilates/i : new RegExp(requested, "i")).test(service.className)) return undefined;
    const operation = /\b(?:move|reschedule)\b/.test(normalized) ? "reschedule" : /\bcancel\b/.test(normalized) ? "cancel" : "book";
    return operation === "reschedule" && !("moveAvailable" in service) ? undefined : { kind: "workflow", operation, classAttendance: true };
  }
  serviceChoiceIntent(text: string): VoiceIntent | undefined {
    const initial = text.trim().match(/^(?:i am|i'm) a new patient[,.]?\s+(.+)$/i);
    const serviceChoice = bookingServiceLanguage(initial?.[1] ?? text); if (!serviceChoice) return undefined;
    return !this.#config.serviceCatalogue || this.closed || this.#staffActive || this.#verificationRequired || this.patientAccessDenied
      ? { kind: "clarify", reason: "changeUnsupported" }
      : (initial || this.#serviceOperation === "intake" || this.#workflow === "intake") && serviceChoice.visitKind !== "initial"
        ? { kind: "clarify", reason: "serviceSelectionUnavailable" }
        : { kind: "workflow", operation: initial || this.#serviceOperation === "intake" || this.#workflow === "intake" ? "intake" : "book", serviceChoice };
  }
  async serviceDialogueIntent(turn: FinalCallerTurn, external?: AbortSignal, routedBookingRequest = false, routedOperation: "book" | "intake" = "book"): Promise<VoiceIntent | undefined> {
    const c = this.#config, intakeStart = startsIntakeServiceDialogue(turn.text), starting = routedBookingRequest || startsServiceDialogue(turn.text) || intakeStart;
    const operation = starting ? intakeStart ? "intake" : routedOperation : this.#serviceOperation ?? "book";
    if (!c.serviceCatalogue || (!starting && !this.#serviceDialogue.active)) return undefined;
    const denied = { kind: "clarify", reason: starting ? "serviceSelectionUnavailable" : "serviceChoiceChanged" } as const;
    if (this.closed || this.#staffActive || this.#verificationRequired || this.patientAccessDenied || this.#selecting ||
        turn.quality !== "clear" || turn.callId !== c.receipt.callId || turn.sessionId !== c.sessionId || external?.aborted) return denied;
    const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(5000), ...(external ? [external] : [])]);
    if (operation === "intake" && !c.intake || !await this.#active(operation, signal)) { this.#serviceDialogue.clear(); return denied; }
    const state = await awaitUntilAbort(c.ledger.read(turn.callId, c.receipt.scope), signal);
    if (!state?.ok || signal.aborted) return denied;
    if ((this.#tasks ? this.#tasks.hasSentCurrentWork(state.value) : hasSentPatientWork(state.value))) { this.#serviceDialogue.clear(); return { kind: "clarify", reason: "changeAfterSend" }; }
    const source = await awaitUntilAbort(currentServiceCatalogue(c), signal);
    const current = await awaitUntilAbort(c.ledger.read(turn.callId, c.receipt.scope), signal);
    if (!source?.ok || !current?.ok || signal.aborted || current.value.conversationRevision !== state.value.conversationRevision ||
        current.value.sessionLease?.sessionId !== c.sessionId || current.value.lifecycle !== "active") { this.#serviceDialogue.clear(); return denied; }
    if (starting) {
      this.#owner?.dispose(); this.#owner = undefined; this.#serviceDialogue.clear(); this.#classDialogue.clear(); this.#workflow = undefined; this.#bookingConfig = undefined; this.#serviceChoice = undefined; this.#serviceOperation = undefined; this.#reschedulingTargetSelected = false;
      this.#serviceOperation = operation;
      this.#publicMenu = undefined; this.#spokenMenu.clear(); this.#spokenPractitioners.clear(); this.#searchMenu.clear();
    }
    return this.#serviceDialogue.resolve(turn, current.value, operation === "intake" ? source.value.services.filter(service => service.visitKind === "initial") : source.value.services, JSON.stringify([operation, source.value]),
      (c.clock ?? (() => new Date().toISOString()))(), routedBookingRequest || intakeStart, operation);
  }
  async serviceEligibilityChangeIntent(turn: FinalCallerTurn, signal?: AbortSignal): Promise<VoiceIntent | undefined> {
    const owner = this.#owner, c = this.#config;
    if (!c.serviceCatalogue || !this.#bookingConfig || this.#workflow !== "book" || !owner || this.closed || this.#staffActive ||
        this.#verificationRequired || this.patientAccessDenied || !bookingEligibilityChanged(turn.text) || turn.quality !== "clear" ||
        turn.callId !== c.receipt.callId || turn.sessionId !== c.sessionId || signal?.aborted) return undefined;
    const current = await awaitUntilAbort(c.ledger.read(turn.callId, c.receipt.scope), AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(5000), ...(signal ? [signal] : [])]));
    if (!current?.ok || this.#owner !== owner || this.closed || signal?.aborted || current.value.sessionLease?.sessionId !== c.sessionId ||
        current.value.lifecycle !== "active") return undefined;
    if ((this.#tasks ? this.#tasks.hasSentCurrentWork(current.value) : hasSentPatientWork(current.value))) return { kind: "clarify", reason: "changeAfterSend" };
    owner.dispose(); this.#owner = undefined; this.#serviceDialogue.clear(); this.#classDialogue.clear(); this.#workflow = undefined; this.#bookingConfig = undefined; this.#serviceChoice = undefined; this.#serviceOperation = undefined;
    this.#publicMenu = undefined; this.#spokenMenu.clear(); this.#spokenPractitioners.clear(); this.#searchMenu.clear(); this.#reschedulingTargetSelected = false;
    return { kind: "clarify", reason: "serviceChoiceChanged" };
  }
  async servicePractitionerIntent(turn: FinalCallerTurn, signal?: AbortSignal): Promise<VoiceIntent | undefined> {
    const choice = this.#serviceChoice, c = this.#config, preference = servicePractitionerPreferenceLanguage(turn.text);
    if (!choice || !preference || !c.serviceCatalogue || ! ["book", "intake"].includes(this.#workflow!) || this.closed || this.#staffActive ||
        this.#verificationRequired || this.patientAccessDenied || turn.quality !== "clear" || turn.callId !== c.receipt.callId ||
        turn.sessionId !== c.sessionId || signal?.aborted) return undefined;
    const current = await awaitUntilAbort(c.ledger.read(turn.callId, c.receipt.scope), AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(5000), ...(signal ? [signal] : [])]));
    const now = Date.parse((c.clock ?? (() => new Date().toISOString()))());
    if (!current?.ok || signal?.aborted || this.closed || this.#serviceChoice !== choice || current.value.lifecycle !== "active" ||
        current.value.sessionLease?.sessionId !== c.sessionId || !Number.isFinite(now) || Date.parse(current.value.sessionLease.expiresAt) <= now) return undefined;
    if ((this.#tasks ? this.#tasks.hasSentCurrentWork(current.value) : hasSentPatientWork(current.value))) return { kind: "clarify", reason: "changeAfterSend" };
    // A generic "I prefer" may describe dates or times. Only a current approved
    // canonical name can make it a practitioner change; explicit see/book-with
    // commands can still ask for an unavailable named practitioner.
    if (preference.kind === "name" && !/^(?:Can I see|Could I see|Please book me with) /i.test(turn.text.trim())) {
      const source = await awaitUntilAbort(currentServiceCatalogue(c), AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(5000), ...(signal ? [signal] : [])]));
      if (!source?.ok || signal?.aborted || this.closed || this.#serviceChoice !== choice) return undefined;
      const name = preference.name;
      const service = source.value.services.find(service => normalizedSpokenName(service.name) === normalizedSpokenName(choice.name) &&
        service.visitKind === choice.visitKind && service.durationMinutes === choice.durationMinutes);
      if (!service?.practitioners.some(member => normalizedSpokenName(member.name) === normalizedSpokenName(name))) return undefined;
    }
    return { kind: "workflow", operation: this.#workflow === "intake" ? "intake" : "book", serviceChoice: { ...choice, practitionerPreference: Object.freeze({ ...preference }) } };
  }
  async serviceDurationIntent(turn: FinalCallerTurn, signal?: AbortSignal): Promise<VoiceIntent | undefined> {
    const durationMinutes = bookingDurationLanguage(turn.text), choice = this.#serviceChoice, c = this.#config;
    if (!durationMinutes || !choice || this.closed || this.#staffActive || this.#verificationRequired || this.patientAccessDenied ||
        turn.callId !== c.receipt.callId || turn.sessionId !== c.sessionId || turn.quality !== "clear" || signal?.aborted) return undefined;
    const current = await awaitUntilAbort(c.ledger.read(turn.callId, c.receipt.scope), AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(5000), ...(signal ? [signal] : [])]));
    if (!current?.ok || this.#serviceChoice !== choice || this.closed || signal?.aborted || current.value.lifecycle !== "active" ||
        current.value.sessionLease?.sessionId !== c.sessionId) return undefined;
    return (this.#tasks ? this.#tasks.hasSentCurrentWork(current.value) : hasSentPatientWork(current.value)) ? { kind: "clarify", reason: "changeAfterSend" }
      : { kind: "workflow", operation: this.#workflow === "intake" ? "intake" : "book", serviceChoice: { ...choice, durationMinutes } };
  }
  async spokenMenuIntent(text: string) {
    if (this.closed || this.#verificationRequired) return undefined;
    const state = await this.#config.ledger.read(this.#config.receipt.callId, this.#config.receipt.scope);
    if (!state.ok || this.closed || state.value.sessionLease?.sessionId !== this.#config.sessionId) return undefined;
    const now = (this.#config.clock ?? (() => new Date().toISOString()))();
    return this.#spokenPractitioners.resolve(text, state.value, now) ?? this.#spokenMenu.resolve(text, state.value, now);
  }
  async practitionerMenuIntent(text: string): Promise<VoiceIntent | undefined> {
    if (this.closed || this.#verificationRequired || this.#staffActive || this.#workflow !== "reschedule" || !this.#reschedulingTargetSelected) return undefined;
    const value = text.trim().replace(/[.!?,]+$/g, "");
    const next = /^(?:(?:show|tell|list|check)(?: me)?\s+)?(?:more|other|next) practitioners(?: please)?$/i.test(value) && this.#publicMenu?.stage === "practitioners";
    const request = /\b(?:another|different|other)\s+(?:practitioners?|physiotherapists?|therapists?|podiatrists?|osteopaths?|chiropractors?|member of (?:the|your) team)\b/i.test(value) ||
      /^(?:who else (?:can i see|is available)|(?:show|list|check)(?: me)?(?: the)? (?:approved )?practitioners|can i switch practitioners)(?: please)?$/i.test(value);
    const yes = /^(?:yes(?: please)?|please do|okay)[.!?]*$/i.test(value);
    if (!next && !request && !(yes && this.#switchPromptTurnId)) return undefined;
    const c = this.#config, state = await c.ledger.read(c.receipt.callId, c.receipt.scope);
    if (!state.ok || this.closed || state.value.pendingPresentationId || state.value.lifecycle !== "active" ||
        state.value.sessionLease?.sessionId !== c.sessionId || Object.values(state.value.actions).some(action => action.status === "awaitingConfirmation") ||
        yes && (state.value.processedTurnIds.at(-1) !== this.#switchPromptTurnId ||
          state.value.presentations[noticePresentationId(c.receipt.callId, this.#switchPromptTurnId!)]?.status !== "played")) return undefined;
    const date = clinicDateAt(c.cliniko.timeZone, new Date((c.clock ?? (() => new Date().toISOString()))()));
    return { kind: "reschedulingMenu", stage: "practitioners", from: date, to: date, ...(next ? { nextPractitioners: true as const } : {}) };
  }
  async preferenceMenuIntent(text: string): Promise<VoiceIntent | undefined> {
    const preference = bookingPreferenceLanguage(text);
    if (!preference) return undefined;
    const denied = { kind: "clarify", reason: "searchPreferenceUnavailable" } as const;
    if (this.closed || this.#staffActive || this.#verificationRequired || !(this.#owner instanceof ClinikoBookingSession)) return denied;
    const state = await this.#config.ledger.read(this.#config.receipt.callId, this.#config.receipt.scope);
    if (!state.ok || this.closed || state.value.sessionLease?.sessionId !== this.#config.sessionId) return denied;
    if ((this.#tasks?.currentActions(state.value) ?? Object.values(state.value.actions)).some(action => ["committed", "uncertain", "needsReview", "dispatched"].includes(action.status)))
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
  async searchMenuIntent(turn: FinalCallerTurn): Promise<VoiceIntent | undefined> {
    if (turn.callId !== this.#config.receipt.callId || turn.sessionId !== this.#config.sessionId) return undefined;
    if (this.closed || this.#staffActive || this.#verificationRequired ||
        this.#workflow !== "book" && this.#workflow !== "intake" && !(this.#workflow === "reschedule" && this.#reschedulingTargetSelected)) return undefined;
    const found = await this.#config.ledger.read(this.#config.receipt.callId, this.#config.receipt.scope);
    if (!found.ok || this.closed || found.value.lifecycle !== "active" || found.value.sessionLease?.sessionId !== this.#config.sessionId) return undefined;
    const now = (this.#config.clock ?? (() => new Date().toISOString()))();
    const dates = bookingDateRangeLanguage(turn.text, clinicDateAt(this.#config.cliniko.timeZone, new Date(now)));
    if (dates && (this.#workflow === "book" || this.#workflow === "intake")) {
      if (dates.kind === "ambiguous") return { kind: "clarify", reason: "menuAmbiguous" };
      const maxDays = this.#owner instanceof ClinikoBookingSession || this.#owner instanceof ClinikoIntakeBookingSession || this.#owner instanceof ClinikoClassSession
        ? await this.#owner.maxBookingSearchDays() : undefined;
      if (!maxDays || this.closed || (Date.parse(dates.to) - Date.parse(dates.from)) / 86_400_000 + 1 > maxDays)
        return { kind: "clarify", reason: "searchPreferenceUnavailable" };
      return { kind: "bookingMenu", from: dates.from, to: dates.to };
    }
    return this.#searchMenu.resolve(turn.text, found.value, clinicDateAt(this.#config.cliniko.timeZone, new Date(now)), this.#config.cliniko.timeZone,
      this.#workflow === "reschedule" ? "rescheduling" : "booking", turn.turnId, now);
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
  async publicIntentContext(): Promise<Readonly<{ workflow: ClinikoWorkflow | null; verificationRequired: boolean; nextTaskAvailable?: true; callerIdentityDenied?: import("../core/caller-identity.ts").CallerIdentityDenial;
    lastAction: Readonly<{ kind: import("../core/model.ts").ActionKind; status: string; confirmationPlayed: boolean }> | null;
    now: string; timeZone: string; maxBookingSearchDays?: number;
    classServices?: readonly PublicClassService[];
    classService?: Readonly<{ className: string; practitionerName: string; locationName: string; serviceRef: string; moveAvailable?: true }>;
    lastMenu: Readonly<{ kind: "booking" | "rescheduling"; stage: "targets" | "practitioners" | "offers" | null }> | null;
    reschedulingTargetSelected: boolean; staffRequestActive: boolean }> | undefined> {
    if (this.closed) return undefined;
    const binding = this.binding(), found = await this.#config.ledger.read(binding.callId, this.#config.receipt.scope);
    if (!found.ok || this.closed || found.value.lifecycle !== "active" || found.value.sessionLease?.sessionId !== binding.sessionId) return undefined;
    const denied = found.value.callerIdentityDenied;
    if (denied) return { workflow: null, verificationRequired: false, callerIdentityDenied: denied, lastAction: null,
      now: (this.#config.clock ?? (() => new Date().toISOString()))(), timeZone: this.#config.cliniko.timeZone,
      lastMenu: null, reschedulingTargetSelected: false, staffRequestActive: false };
    const last = (this.#tasks?.currentActions(found.value) ?? Object.values(found.value.actions)).at(-1);
    const nextTaskAvailable = this.#tasks && this.#workflow && await this.#tasks.allows(found.value, this.#workflow, true);
    const classService = await this.#publicClassService();
    const classServices = await this.#classServices();
    const maxBookingSearchDays = !this.#verificationRequired && (this.#owner instanceof ClinikoBookingSession || this.#owner instanceof ClinikoIntakeBookingSession || this.#owner instanceof ClinikoClassSession)
      ? await this.#owner.maxBookingSearchDays() : undefined;
    if (this.closed) return undefined;
    return { workflow: this.#owner instanceof ClinikoPractitionerHistorySession || !(this.#owner instanceof ClinikoClassSession) && this.#config.serviceCatalogue && ["book", "intake"].includes(this.#workflow!) && !this.#serviceChoice ? null : this.#workflow ?? null, verificationRequired: this.#verificationRequired,
      ...(nextTaskAvailable ? { nextTaskAvailable: true as const } : {}),
      ...(classService ? { classService } : {}),
      ...(classServices ? { classServices: classServices.items.map(item => item.public) } : {}),
      lastAction: last ? { kind: last.kind, status: last.status,
        confirmationPlayed: found.value.presentations[last.presentationId]?.status === "played" } : null,
      now: (this.#config.clock ?? (() => new Date().toISOString()))(), timeZone: this.#config.cliniko.timeZone,
      ...(maxBookingSearchDays !== undefined && maxBookingSearchDays > 7 ? { maxBookingSearchDays } : {}),
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
    const signal = AbortSignal.any([query.signal, this.#workflowLifetime.signal, this.#patientLifetime.signal, this.#lifetime.signal, AbortSignal.timeout(clinikoStaffPreparationDeadlineMs)]);
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
      if (selected.value.kind === "codeRequired") { this.#staffActive = true; this.#verificationRequired = true; this.#spokenMenu.clear(); this.#spokenPractitioners.clear(); this.#searchMenu.clear(); this.#publicMenu = undefined; this.#staff.beginVerification(); }
      if (selected.value.kind === "ready") { this.#staffActive = true; this.#spokenMenu.clear(); this.#spokenPractitioners.clear(); this.#searchMenu.clear(); this.#publicMenu = undefined; }
      return selected;
    } catch { return denied(); }
    finally { this.#preparingStaff = false; }
  }
  conversationControlAccepted(turn: FinalCallerTurn, state: CallState): void {
    if (!this.closed && !this.#patientLifetime.signal.aborted && !state.callerIdentityDenied &&
        turn.callId === this.#config.receipt.callId && turn.sessionId === this.#config.sessionId)
      this.#staff?.conversationControlAccepted(turn, state);
  }
  async collectIntake(draft: ClinikoIntakeDraft) {
    const source = this.intake;
    if (!source || this.closed) return unavailable<Readonly<{ draftRef: string }>>();
    this.#verificationRequired = true; this.#intakeDraftRef = undefined;
    const result = await source.collect(draft, { privacyAccepted: true, intakeAccepted: true });
    if (!result.ok || this.closed || this.intake !== source) return unavailable<Readonly<{ draftRef: string }>>();
    this.#intakeDraftRef = result.value.draftRef; return result;
  }
  get patientCorrection() {
    return !this.#staffActive && this.#owner instanceof ClinikoPatientCorrectionWorkflow ? this.#owner.correction : undefined;
  }
  get privatePhoneCountry(): string { return this.#config.cliniko.countryCallingCode; }
  get patientCorrectionRef(): string | undefined { return this.#workflow === "patientUpdate" && !this.#verificationRequired ? this.#patientCorrectionRef : undefined; }
  discardPatientCorrection(): boolean {
    const owner = this.patientCorrection;
    if (!owner || this.closed || this.#verificationRequired || !owner.discardCollection()) return false;
    this.#patientCorrectionRef = undefined;
    return true;
  }
  async collectPatientCorrection(changes: PatientDetailChanges) {
    const owner = this.patientCorrection;
    this.#patientCorrectionRef = undefined;
    if (!owner || this.closed || this.#verificationRequired) return unavailable<Readonly<{ correctionRef: string; codeRequired: boolean }>>();
    const result = await owner.collect(changes);
    if (!result.ok || this.closed || owner !== this.patientCorrection) return unavailable<Readonly<{ correctionRef: string; codeRequired: boolean }>>();
    this.#patientCorrectionRef = result.value.correctionRef;
    return result;
  }
  async startWorkflow(query: WorkflowQuery): Promise<Result<Readonly<{ kind: "codeRequired" | "intakeRequired" | "representativeRequired"; advanceTask?: true }>, Failure>> {
    const config = this.#config;
    if (!sameScope(query.scope, config.receipt.scope) || query.callId !== config.receipt.callId || query.sessionId !== config.sessionId ||
        query.policyVersion !== config.policyVersion || query.signal.aborted) return unavailable<Readonly<{ kind: "codeRequired" | "intakeRequired" }>>();
    if (query.classSelectionRef && !query.classAttendance) return unavailable();
    if (query.classAttendance && (query.forAnotherPerson || query.serviceChoice || !["book", "cancel", "reschedule"].includes(query.operation))) return unavailable();
    if (query.forAnotherPerson) return this.#prepareRepresentative(query);
    const selected = await this.choose(query.operation, query.signal, query.replaceCanceledChange === true, query.expectedConversationRevision, query.serviceChoice, false, query.classAttendance === true, query.classSelectionRef, query.turnId);
    if (selected.ok && !selected.value.advanceTask && !query.signal.aborted && selected.value.kind === "codeRequired") this.beginVerification();
    return selected;
  }
  /** Routing readiness only; approval, identity and permission are checked by
   * preparation and private verification, never granted by this flag. */
  async representativeStartupAvailable(operation: "book" | "cancel" | "reschedule" | "appointments.read", external?: AbortSignal): Promise<boolean> {
    if (!this.#config.representativeInput || this.closed || this.patientAccessDenied || this.#staffActive || this.#selecting || this.#pendingRepresentative || this.#pendingTask) return false;
    if (!this.#tasks) return !this.#owner && !this.#representativeCall;
    const signal = AbortSignal.any([this.#lifetime.signal, this.#patientLifetime.signal, this.#workflowLifetime.signal, AbortSignal.timeout(5000), ...(external ? [external] : [])]);
    const state = await awaitUntilAbort(this.#config.ledger.read(this.#config.receipt.callId, this.#config.receipt.scope), signal);
    return !!state?.ok && !signal.aborted && (await awaitUntilAbort(this.#tasks.allowsRepresentative(state.value, operation, !!this.#owner), signal)) === true;
  }
  async completeWorkflowStart(query: WorkflowQuery & Readonly<{ turnId: string; advanceTask?: true }>): Promise<boolean> {
    if (query.forAnotherPerson) {
      const pending = this.#pendingRepresentative, c = this.#config;
      if (!pending || pending.operation !== query.operation || (query.advanceTask === true) !== pending.advancing || query.signal.aborted || this.closed ||
          !sameScope(query.scope, c.receipt.scope) || query.callId !== c.receipt.callId || query.sessionId !== c.sessionId || query.policyVersion !== c.policyVersion) return false;
      const state = await c.ledger.read(c.receipt.callId, c.receipt.scope);
      if (!state.ok || state.value.conversationRevision !== pending.revision + 1 || !state.value.processedTurnIds.includes(query.turnId) ||
          state.value.lastWorkflowStart?.turnId !== query.turnId || state.value.lastWorkflowStart.operation !== pending.operation ||
          state.value.lastWorkflowStart.next !== "representativeRequired" || !await this.#active(pending.operation, query.signal)) return false;
      if (pending.advancing && JSON.stringify(state.value.previousTaskActionKeys) !== JSON.stringify(Object.keys(pending.before.actions)) ||
          this.#tasks && !await this.#tasks.allowsRepresentative(pending.before, pending.operation, pending.advancing)) return false;
      this.#tasks?.publishRepresentative(pending.before, pending.advancing);
      this.#owner?.dispose(); this.#owner = undefined; this.#representative?.owner.dispose(); this.#representative = undefined;
      this.#representativeCall?.dispose(); this.#spokenMenu.clear(); this.#spokenPractitioners.clear(); this.#searchMenu.clear(); this.#publicMenu = undefined;
      this.#reschedulingTargetSelected = false; this.#bookingConfig = undefined; this.#serviceChoice = undefined; this.#serviceOperation = undefined;
      this.#representativeCall = pending.owner; this.#pendingRepresentative = undefined; this.#workflow = pending.operation; this.#verificationRequired = true;
      return true;
    }
    if (!query.advanceTask) return true;
    const pending = this.#pendingTask, c = this.#config;
    if (!pending || query.operation !== pending.operation || query.callId !== c.receipt.callId || query.sessionId !== c.sessionId ||
        !sameScope(query.scope, c.receipt.scope) || query.policyVersion !== c.policyVersion || query.signal.aborted || this.closed) return false;
    const state = await c.ledger.read(query.callId, query.scope);
    if (!state.ok || !state.value.processedTurnIds.includes(query.turnId) || state.value.conversationRevision !== pending.before.conversationRevision + 1 ||
        JSON.stringify(state.value.previousTaskActionKeys) !== JSON.stringify(Object.keys(pending.before.actions)) ||
        !await this.#active(pending.operation, query.signal) || !await this.#tasks!.allows(pending.before, pending.operation, true)) return false;
    this.#tasks!.publish(pending.before, true);
    this.#installOwner(pending.owner, pending.previous, pending.operation, pending.selectedConfig, pending.serviceChoice, pending.representative);
    this.#pendingTask = undefined; this.beginVerification(); return true;
  }
  async abandonWorkflowStart(query: WorkflowQuery & Readonly<{ turnId: string }>): Promise<void> {
    if (query.forAnotherPerson && query.callId === this.#config.receipt.callId && query.sessionId === this.#config.sessionId && sameScope(query.scope, this.#config.receipt.scope)) {
      const pending = this.#pendingRepresentative; this.#pendingRepresentative = undefined; pending?.owner.dispose();
      if (pending) {
        const state = await this.#config.ledger.read(query.callId, query.scope);
        if (state.ok && state.value.lastWorkflowStart?.turnId === query.turnId && state.value.lastWorkflowStart.next === "representativeRequired" &&
            state.value.conversationRevision === pending.revision + 1) {
          this.#tasks?.publishRepresentative(pending.before, pending.advancing);
          this.#owner?.dispose(); this.#owner = undefined; this.#representative?.owner.dispose(); this.#representative = undefined;
          this.#representativeCall?.dispose(); this.#representativeCall = undefined; this.#workflow = undefined; this.#verificationRequired = false;
          this.#publicMenu = undefined; this.#spokenMenu.clear(); this.#spokenPractitioners.clear(); this.#searchMenu.clear();
        }
      }
      return;
    }
    const pending = this.#pendingTask, c = this.#config;
    if (!pending || query.callId !== c.receipt.callId || query.sessionId !== c.sessionId || !sameScope(query.scope, c.receipt.scope)) return;
    this.#pendingTask = undefined; pending.owner.dispose();
    const state = await c.ledger.read(query.callId, query.scope);
    if (state.ok && state.value.processedTurnIds.includes(query.turnId) &&
        JSON.stringify(state.value.previousTaskActionKeys) === JSON.stringify(Object.keys(pending.before.actions))) {
      // The task event committed, but activation did not. Reserve its slot and
      // retain its predecessor receipt; a later explicit request needs a fresh owner.
      this.#tasks!.publish(pending.before, true); pending.previous.dispose(); this.#owner = undefined;
      this.#workflow = undefined; this.#verificationRequired = false; this.#serviceChoice = undefined; this.#bookingConfig = undefined;
    }
  }
  #installOwner(owner: Owner, previous: Owner | undefined, operation: ClinikoWorkflow, selectedConfig: ClinikoCallFlowConfig, serviceChoice: BookingServiceChoice | undefined, representative?: RepresentativeWorkflowSelection): void {
    if (this.#representative?.owner !== representative?.owner) this.#representative?.owner.dispose();
    this.#representative = representative;
    previous?.dispose(); this.#intakeDraftRef = undefined; this.#patientCorrectionRef = undefined; this.#confirmationResendRef = undefined; this.#publicMenu = undefined;
    this.#spokenMenu.clear(); this.#spokenPractitioners.clear(); this.#searchMenu.clear(); this.#reschedulingTargetSelected = false;
    this.#owner = owner; this.#workflow = operation; this.#bookingConfig = ["book", "intake"].includes(operation) ? selectedConfig : undefined;
    this.#serviceChoice = ["book", "intake"].includes(operation) && serviceChoice ? copyBookingServiceChoice(serviceChoice) : undefined;
    this.#serviceOperation = operation === "intake" ? "intake" : operation === "book" ? "book" : undefined; this.#verificationRequired = operation !== "intake";
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
      (operation === "appointments.read" ? config.enquiry !== undefined || config.history !== undefined : found.value.policy.capabilities[operation] === "execute" && current.value.capabilities[operation] === "execute") &&
      found.value.sessionLease?.sessionId === config.sessionId && Date.parse(found.value.sessionLease.expiresAt) > now &&
      found.value.admission?.key.accountRef === config.inbound.key.accountRef && found.value.admission.key.providerCallRef === config.inbound.key.providerCallRef &&
      found.value.admission.dialedNumber === config.inbound.dialedNumber;
  }
  async choose(operation: ClinikoWorkflow, external?: AbortSignal, replaceCanceledChange = false, expectedRevision?: number, incomingServiceChoice?: BookingServiceChoice, historyRequest = false, classAttendance = false, classSelectionRef?: string, selectionTurnId?: string): Promise<Result<Readonly<{ kind: "codeRequired" | "intakeRequired"; advanceTask?: true }>, Failure>> {
    if (this.#pendingRepresentative || this.#representativeCall && !this.#representative) return unavailable();
    return this.#choose(operation, external, replaceCanceledChange, expectedRevision, incomingServiceChoice, historyRequest, this.#representative, classAttendance, classSelectionRef, selectionTurnId);
  }
  async #prepareRepresentative(query: WorkflowQuery): Promise<Result<Readonly<{ kind: "representativeRequired"; advanceTask?: true }>, Failure>> {
    const c = this.#config;
    if (!c.representativeInput || !this.#tasks && (this.#owner || this.#representativeCall) || this.#staffActive || this.#selecting || this.#pendingTask || this.#pendingRepresentative ||
        !["book", "cancel", "reschedule", "appointments.read"].includes(query.operation) || query.replaceCanceledChange ||
        query.operation === "book" && c.serviceCatalogue && !query.serviceChoice || this.closed || this.patientAccessDenied) return unavailable();
    this.#selecting = true;
    const signal = AbortSignal.any([query.signal, this.#workflowLifetime.signal, this.#patientLifetime.signal, this.#lifetime.signal]);
    const buildLifetime = new AbortController();
    let published = false;
    let building: ReturnType<typeof ClinikoRepresentativeCallOwner.create> | undefined;
    let created: ClinikoRepresentativeCallOwner | undefined;
    try {
      const state = await awaitUntilAbort(c.ledger.read(c.receipt.callId, c.receipt.scope), signal);
      if (!state?.ok || signal.aborted || state.value.conversationRevision !== query.expectedConversationRevision) return unavailable();
      const previousOwner = this.#owner, previousRoot = this.#representativeCall;
      const advancing = !!previousOwner && !!this.#tasks;
      if (this.#tasks && !await this.#tasks.allowsRepresentative(state.value, query.operation, advancing) ||
          !advancing && (this.#tasks?.currentActions(state.value) ?? Object.values(state.value.actions)).some(action => action.status !== "canceled") ||
          !await this.#active(query.operation, signal)) return unavailable();
      const operation = query.operation as "book" | "cancel" | "reschedule" | "appointments.read";
      building = ClinikoRepresentativeCallOwner.create({ ...c.representativeInput, context: { ...c,
        lookup: this.#tasks ? this.#tasks.lookup(c.lookup) : c.lookup,
        signal: AbortSignal.any([c.signal, this.#workflowLifetime.signal, this.#patientLifetime.signal, this.#lifetime.signal, buildLifetime.signal]) }, flow: this, operation,
        ...(query.serviceChoice ? { serviceChoice: query.serviceChoice } : {}) });
      const made = await awaitUntilAbort(building, signal);
      if (!made?.ok) return unavailable(); created = made.value;
      const after = await awaitUntilAbort(c.ledger.read(c.receipt.callId, c.receipt.scope), signal);
      if (signal.aborted || !after?.ok || after.value.conversationRevision !== state.value.conversationRevision || this.#owner !== previousOwner || this.#representativeCall !== previousRoot ||
          this.#tasks && !await this.#tasks.allowsRepresentative(after.value, operation, advancing) || !await this.#active(operation, signal)) return unavailable();
      this.#pendingRepresentative = { owner: created, operation, revision: state.value.conversationRevision, before: structuredClone(state.value), advancing }; created = undefined; published = true;
      return ok({ kind: "representativeRequired", ...(advancing ? { advanceTask: true as const } : {}) });
    } catch { return unavailable(); }
    finally {
      if (!published) { buildLifetime.abort(); void building?.then(late => { if (late.ok) late.value.dispose(); }, () => undefined); }
      created?.dispose(); this.#selecting = false;
    }
  }
  /** Trusted private-input routing only. Identity and authority remain in the
   * concrete selector; public commands carry neither person fields nor refs. */
  async chooseRepresentative(operation: "book" | "cancel" | "reschedule" | "appointments.read", incoming: RepresentativeWorkflowSelection,
    external?: AbortSignal, expectedRevision?: number, serviceChoice?: BookingServiceChoice): Promise<Result<Readonly<{ kind: "codeRequired" | "intakeRequired"; advanceTask?: true }>, Failure>> {
    const representative = incoming && Object.freeze({ ...incoming });
    if (!(representative?.owner instanceof ClinikoRepresentativeSelection)) return unavailable();
    return this.#choose(operation, external, false, expectedRevision, serviceChoice, false, representative);
  }
  async #choose(operation: ClinikoWorkflow, external: AbortSignal | undefined, replaceCanceledChange: boolean, expectedRevision: number | undefined,
    incomingServiceChoice: BookingServiceChoice | undefined, historyRequest: boolean, representative: RepresentativeWorkflowSelection | undefined, classAttendance = false, classSelectionRef?: string, selectionTurnId?: string): Promise<Result<Readonly<{ kind: "codeRequired" | "intakeRequired"; advanceTask?: true }>, Failure>> {
    if (classSelectionRef && !classAttendance) return unavailable();
    if (classAttendance && (!(this.#config.classAttendance || this.#config.classServices) || representative || incomingServiceChoice || historyRequest || !["book", "cancel", "reschedule"].includes(operation))) return unavailable();
    if (representative) {
      // A new representative task must be accepted before its child workflow.
      if (this.#tasks && (this.#owner || !this.#representativeCall)) return unavailable();
      const c = this.#config, patientOperation = operation === "book" ? "appointments.book" : operation === "cancel" ? "appointments.cancel" : operation === "reschedule" ? "appointments.reschedule" : operation === "appointments.read" && !historyRequest ? "appointments.read" : undefined;
      if (!patientOperation || !representative.owner.matchesWorkflow({ scope: c.receipt.scope, callId: c.receipt.callId, sessionId: c.sessionId,
        policyVersion: c.policyVersion, credentialFingerprint: clinikoCredentialFingerprint(c.cliniko.apiKey), businessId: c.cliniko.businessId,
        timeZone: c.cliniko.timeZone, inbound: c.inbound, operation: patientOperation, selectionRef: representative.selectionRef })) return unavailable();
    }
    this.#serviceDialogue.clear();
    const serviceChoice = incomingServiceChoice ? copyBookingServiceChoice(incomingServiceChoice) : undefined;
    if (incomingServiceChoice && !serviceChoice) return unavailable();
    if (!["book", "cancel", "reschedule", "intake", "patientUpdate", "confirmationResend", "appointments.read"].includes(operation) || operation === "patientUpdate" && !this.#config.correction || operation === "confirmationResend" && !this.#config.resend || this.#pendingTask || this.#staffActive || this.#selecting || this.#patientLifetime.signal.aborted || this.#lifetime.signal.aborted || external?.aborted) return unavailable();
    if (serviceChoice && !["book", "intake"].includes(operation) || operation === "intake" && serviceChoice?.visitKind !== undefined && serviceChoice.visitKind !== "initial" ||
        ["book", "intake"].includes(operation) && this.#config.serviceCatalogue && !serviceChoice && !classAttendance ||
        serviceChoice && this.#owner && this.#verificationRequired) return unavailable();
    if (historyRequest && (operation !== "appointments.read" || !this.#config.history)) return unavailable();
    this.#selecting = true;
    const signal = AbortSignal.any([this.#workflowLifetime.signal, this.#patientLifetime.signal, this.#lifetime.signal, this.#config.signal, AbortSignal.timeout(20_000), ...(external ? [external] : [])]);
    const buildLifetime = new AbortController();
    let published = false;
    let building: Promise<Result<Owner, Readonly<{ kind: string }>>> | undefined;
    let created: Owner | undefined;
    try {
      const previousOwner = this.#owner;
      if (previousOwner && (previousOwner instanceof ClinikoClassSession) !== classAttendance) return unavailable();
      const replacingService = !!previousOwner && (!!serviceChoice && ["book", "intake"].includes(operation) || !!classSelectionRef && classAttendance) && this.#workflow === operation;
      const before = await awaitUntilAbort(this.#config.ledger.read(this.#config.receipt.callId, this.#config.receipt.scope), signal);
      if (!before?.ok || expectedRevision !== undefined && before.value.conversationRevision !== expectedRevision) return unavailable();
      if (this.#tasks && representative && !await this.#tasks.allowsRepresentative(before.value, operation, false)) return unavailable();
      const advancing = !!previousOwner && !!this.#tasks && await this.#tasks.allows(before.value, operation, true);
      if (this.#tasks && !advancing && !await this.#tasks.allows(before.value, operation, false)) return unavailable();
      const currentActions = this.#tasks?.currentActions(before.value) ?? Object.values(before.value.actions);
      const replacingPerson = !!representative && (this.#representative?.owner !== representative.owner || this.#representative.selectionRef !== representative.selectionRef);
      if (!advancing && !replacingPerson && previousOwner && this.#workflow === operation && !serviceChoice && !classSelectionRef && (operation !== "appointments.read" || historyRequest === (previousOwner instanceof ClinikoPractitionerHistorySession))) {
        if (operation === "patientUpdate" || currentActions.some(action => action.status !== "canceled")) return unavailable();
        return await this.#active(operation, external) ? ok({ kind: operation === "intake" ? "intakeRequired" : "codeRequired" }) : unavailable();
      }
      // Only an explicitly requested unsent cancellation/move may be replaced.
      // New owners issue new operation-bound verification; no prior grant or target transfers.
      const fromEnquiry = previousOwner instanceof ClinikoAppointmentEnquirySession || previousOwner instanceof ClinikoPractitionerHistorySession;
      const toHistory = historyRequest && !(this.#tasks ? this.#tasks.hasSentCurrentWork(before.value) : hasSentPatientWork(before.value)) && currentActions.every(action => action.status === "canceled");
      if (replacingService && !advancing && ((this.#tasks ? this.#tasks.hasSentCurrentWork(before.value) : hasSentPatientWork(before.value)) || currentActions.some(action =>
        !["awaitingConfirmation", "ready", "canceled"].includes(action.status)))) return unavailable();
      if (previousOwner && !advancing && !fromEnquiry && !replacingService && !toHistory && !replacingPerson && (!replaceCanceledChange || !["cancel", "reschedule"].includes(operation) ||
          !["cancel", "reschedule"].includes(this.#workflow!) ||
          currentActions.some(action => action.status !== "canceled"))) return unavailable();
      if (fromEnquiry && !advancing && currentActions.some(action => action.status !== "canceled")) return unavailable();
      if (!await this.#active(operation, signal) || signal.aborted) return unavailable();
      if (serviceChoice) { this.#serviceChoice = undefined; this.#serviceOperation = undefined; } // A failed explicit change cannot reuse the old variant.
      const selection = serviceChoice ? await awaitUntilAbort(serviceBookingConfig(this.#config, serviceChoice), signal) : undefined;
      if (serviceChoice && !selection?.ok || signal.aborted) return unavailable();
      let selectedConfig = selection?.ok ? selection.value : this.#config;
      if (classAttendance && this.#config.classServices) {
        const catalogue = await this.#classServices(signal);
        const chosen = catalogue && classSelectionRef ? this.#classDialogue.take(classSelectionRef, operation as "book" | "cancel" | "reschedule", before.value, catalogue,
          (this.#config.clock ?? (() => new Date().toISOString()))(), selectionTurnId) : undefined;
        if (!chosen || signal.aborted) return unavailable();
        selectedConfig = { ...this.#config, classAttendance: chosen.config };
      } else if (classSelectionRef) return unavailable();
      this.#classDialogue.clear();
      const pin = this.#historySubject;
      const lookup = pin ? { candidates: async (scope: Parameters<typeof selectedConfig.lookup.candidates>[0], phone: string) => {
        const now = Date.parse((this.#config.clock ?? (() => new Date().toISOString()))());
        if (!sameScope(pin.scope, this.#config.receipt.scope) || !Number.isFinite(now) || Date.parse(pin.expiresAt) <= now || this.closed || this.#historySubject !== pin) return err({ kind: "denied" });
        const result = await selectedConfig.lookup.candidates(scope, phone);
        return result.ok && result.value.kind === "one" && result.value.candidateIds[0] === pin.patientRef && this.#historySubject === pin && !this.closed ? result : err({ kind: "denied" });
      } } : selectedConfig.lookup;
      const config = { ...selectedConfig, ...(representative ? { representative } : {}), lookup: this.#tasks && !representative ? this.#tasks.lookup(lookup) : lookup,
        ...(selectedConfig.resend && this.#tasks ? { resend: { ...selectedConfig.resend, taskSequence: this.#tasks } } : {}), signal: AbortSignal.any([this.#workflowLifetime.signal, this.#patientLifetime.signal, this.#lifetime.signal, this.#config.signal, buildLifetime.signal]) }, paths = config.approvals;
      const classes = config.classAttendance;
      building = classAttendance && classes ? operation === "book" ? ClinikoClassSession.create({ ...config, operation: "book", callerApprovalPath: paths.bookCaller,
        classApprovalPath: classes.approvalPath, classPermission: classes.bookPermission,
        cliniko: { ...config.cliniko, practitionerId: classes.practitionerId, appointmentTypeId: classes.appointmentTypeId } }) :
        operation === "cancel" ? ClinikoClassSession.create({ ...config, operation: "cancel", callerApprovalPath: paths.cancelCaller, cancellationApprovalPath: classes.cancellationApprovalPath ?? paths.cancellation,
          classApprovalPath: classes.approvalPath, classPermission: classes.cancelPermission,
          cliniko: { ...config.cliniko, practitionerId: classes.practitionerId, appointmentTypeId: classes.appointmentTypeId } }) :
        operation === "reschedule" && classes.move ? ClinikoClassSession.create({ ...config, operation: "reschedule", callerApprovalPath: paths.rescheduleCaller,
          classApprovalPath: classes.approvalPath, classPermission: classes.move.permission, moveApprovalPath: classes.move.approvalPath,
          destination: { classApprovalPath: classes.move.destination.approvalPath, practitionerId: classes.move.destination.practitionerId, appointmentTypeId: classes.move.destination.appointmentTypeId },
          cliniko: { ...config.cliniko, practitionerId: classes.practitionerId, appointmentTypeId: classes.appointmentTypeId } }) : undefined :
        operation === "appointments.read" ? historyRequest ? config.history ? ClinikoPractitionerHistorySession.create({ ...config, ...config.history }) : undefined : config.enquiry ? ClinikoAppointmentEnquirySession.create({ ...config, ...config.enquiry }) : undefined :
        operation === "book" ? ClinikoBookingSession.create({ ...config, callerApprovalPath: paths.bookCaller, bookingApprovalPath: paths.booking }) :
        operation === "cancel" ? ClinikoCancellationSession.create({ ...config, callerApprovalPath: paths.cancelCaller, cancellationApprovalPath: paths.cancellation }) :
        operation === "reschedule" ? ClinikoReschedulingSession.create({ ...config, ...(config.reschedulingDestination ? { destination: config.reschedulingDestination } : {}), ...(config.reschedulingPractitioners !== undefined ? { practitioners: config.reschedulingPractitioners } : {}), callerApprovalPath: paths.rescheduleCaller, bookingApprovalPath: paths.booking, reschedulingApprovalPath: paths.rescheduling }) :
        operation === "confirmationResend" ? config.resend ? ClinikoConfirmationResendWorkflow.create({ ...config, resend: config.resend }) : undefined :
        operation === "patientUpdate" ? config.correction ? ClinikoPatientCorrectionWorkflow.create({ ...config, correction: config.correction,
          callerApprovalPath: config.correction.callerApprovalPath, bookingApprovalPath: paths.booking }) : undefined :
        config.intake ? ClinikoIntakeBookingSession.create({ ...config, ...config.intake, bookingPermission: config.permission, bookingApprovalPath: paths.booking }) : undefined;
      const result = building ? await awaitUntilAbort(building, signal) : undefined;
      if (!result?.ok) return unavailable();
      created = result.value;
      if (signal.aborted || !await this.#active(operation, signal)) return unavailable();
      const after = await awaitUntilAbort(this.#config.ledger.read(this.#config.receipt.callId, this.#config.receipt.scope), signal);
      if (!after?.ok || after.value.conversationRevision !== before.value.conversationRevision || this.#owner !== previousOwner ||
          signal.aborted || advancing && !await this.#tasks!.allows(after.value, operation, true) || previousOwner && !advancing && (replacingService ? (this.#tasks ? this.#tasks.hasSentCurrentWork(after.value) : hasSentPatientWork(after.value)) : (this.#tasks?.currentActions(after.value) ?? Object.values(after.value.actions)).some(action => action.status !== "canceled"))) return unavailable();
      if (advancing) this.#pendingTask = { owner: created, previous: previousOwner!, operation, before: structuredClone(before.value), selectedConfig, serviceChoice, representative };
      else { if (this.#tasks && !previousOwner && !representative) this.#tasks.publish(after.value, false); this.#installOwner(created, previousOwner, operation, selectedConfig, serviceChoice, representative); }
      created = undefined; published = true;
      return ok({ kind: operation === "intake" ? "intakeRequired" : "codeRequired", ...(advancing ? { advanceTask: true as const } : {}) });
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
    return !this.#staffActive && (this.#owner instanceof ClinikoCancellationSession || this.#owner instanceof ClinikoClassSession && this.#owner.operation === "cancel") && !this.#lifetime.signal.aborted ? this.#owner.verified() : undefined;
  }
  async readPreviousPractitioner(query: AppointmentEnquiryQuery & Readonly<{ turnId: string }>) {
    const c = this.#config, denied = () => err({ kind: "historyUnavailable" as const });
    if (!c.history || this.closed || this.#staffActive || this.#verificationRequired || this.patientAccessDenied || query.signal.aborted ||
        !sameScope(query.scope, c.receipt.scope) || query.callId !== c.receipt.callId || query.sessionId !== c.sessionId || query.policyVersion !== c.policyVersion) return denied();
    const state = await awaitUntilAbort(c.ledger.read(query.callId, query.scope), query.signal);
    if (!state?.ok || state.value.processedTurnIds.includes(query.turnId) || state.value.lifecycle !== "active" || state.value.sessionLease?.sessionId !== c.sessionId ||
        query.expectedConversationRevision !== state.value.conversationRevision || (this.#tasks ? this.#tasks.hasSentCurrentWork(state.value) : hasSentPatientWork(state.value)) || !await this.#active("appointments.read", query.signal)) return denied();
    if (!(this.#owner instanceof ClinikoPractitionerHistorySession)) {
      const selected = await this.choose("appointments.read", query.signal, false, query.expectedConversationRevision, undefined, true);
      if (!selected.ok || query.signal.aborted) return denied();
      this.beginVerification(); return ok({ kind: "codeRequired" as const });
    }
    const owner = this.#owner, read = await owner.read(query.now, query.signal);
    const after = await awaitUntilAbort(c.ledger.read(query.callId, query.scope), query.signal);
    if (!read.ok || query.signal.aborted || this.#owner !== owner || !after?.ok || after.value.conversationRevision !== state.value.conversationRevision ||
        !await this.#active("appointments.read", query.signal)) return denied();
    if (this.#historySubject && this.#historySubject.patientRef !== read.value.patient.patientRef) return denied();
    this.#historySubject = read.value.patient;
    return ok({ kind: "history" as const, snapshot: { scope: c.receipt.scope, callId: query.callId, sessionId: query.sessionId, policyVersion: c.policyVersion,
      checkedAt: (c.clock ?? (() => new Date().toISOString()))(), lookBackDays: read.value.lookBackDays, result: read.value.result } });
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
    const appointments = owner instanceof ClinikoCancellationSession || owner instanceof ClinikoClassSession ? owner.appointments : undefined;
    if (!appointments || !(owner instanceof ClinikoCancellationSession || owner instanceof ClinikoClassSession) || this.closed || this.#staffActive || this.#verificationRequired ||
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
    const selected = await awaitUntilAbort(appointments.select(config.receipt.scope, proof.verificationRef, choice, now, signal), signal);
    const after = await awaitUntilAbort(config.ledger.read(turn.callId, config.receipt.scope), signal);
    if (!selected?.ok || !after?.ok || signal.aborted || this.closed || this.#owner !== owner ||
        after.value.conversationRevision !== before.value.conversationRevision || after.value.lifecycle !== "active" ||
        after.value.sessionLease?.sessionId !== config.sessionId || selected.value.snapshot.verificationRef !== proof.verificationRef ||
        selected.value.snapshot.appointments.length !== 1) return denied;
    return { kind: "cancel", verificationRef: proof.verificationRef, targetRef: "selected" };
  }
  get collectingStaffMessage() { return this.#staff?.collectingMessage === true; }
  get appointments() { return !this.#staffActive && (this.#owner instanceof ClinikoCancellationSession || this.#owner instanceof ClinikoClassSession) ? this.#owner.appointments : undefined; }
  #booking() { return this.#staffActive ? undefined : this.#owner instanceof ClinikoClassSession ? this.#owner.booking : this.#config.serviceCatalogue && !this.#serviceChoice ? undefined : this.#owner instanceof ClinikoBookingSession ? this.#owner.effects : this.#owner instanceof ClinikoIntakeBookingSession ? this.#owner : undefined; }
  bookingMenuAvailable(): boolean { return this.#booking()?.bookingMenuAvailable() === true; }
  async readBookingMenu(query: BookingMenuReadQuery) {
    this.#spokenMenu.clear(); this.#spokenPractitioners.clear();
    if (this.#booking()) { const failure = await this.#horizonFailure(query); if (failure) return err(failure); }
    const result = await (this.#booking()?.readBookingMenu(query) ?? offerDenied());
    if (result.ok && !query.signal.aborted && !this.closed && !this.#patientLifetime.signal.aborted) {
      this.#publicMenu = { kind: "booking", stage: null };
      this.#searchMenu.remember({ turnId: query.turnId, from: query.from, to: query.to, kind: "booking", snapshot: result.value });
      this.#spokenMenu.remember({ kind: "booking", stage: null, turnId: query.turnId, snapshot: result.value });
    }
    return result;
  }
  async selectBookingMenu(query: BookingMenuQuery & Readonly<{ menuTurnId: string; choice: 1 | 2 | 3 }>) {
    const result = await (this.#booking()?.selectBookingMenu(query) ?? offerDenied());
    if (result.ok && !query.signal.aborted && !this.closed && !this.#patientLifetime.signal.aborted) { this.#publicMenu = undefined; this.#spokenMenu.consumed(query.turnId, query.choice); }
    else if (!query.signal.aborted) this.#spokenMenu.clear(); this.#spokenPractitioners.clear();
    return result;
  }
  async resolveBooking(scope: LocationScope, verificationRef: string, offerRef: string, now: string, signal?: AbortSignal) { return this.#booking()?.resolveBooking(scope, verificationRef, offerRef, now, signal) ?? offerDenied(); }
  #rescheduling() { return this.#staffActive ? undefined : this.#owner instanceof ClinikoReschedulingSession ? this.#owner.effects : this.#owner instanceof ClinikoClassSession ? this.#owner.rescheduling : undefined; }
  reschedulingMenuAvailable(): boolean { return this.#rescheduling()?.reschedulingMenuAvailable() === true; }
  async readReschedulingMenu(query: ReschedulingMenuReadQuery) {
    this.#switchPromptTurnId = undefined;
    this.#spokenMenu.clear(); this.#spokenPractitioners.clear();
    if (query.stage === "offers" && this.reschedulingMenuAvailable()) { const failure = await this.#horizonFailure(query); if (failure) return err(failure); }
    const result = await (this.#rescheduling()?.readReschedulingMenu(query) ?? readDenied());
    if (result.ok && !query.signal.aborted && !this.closed && !this.#patientLifetime.signal.aborted) {
      this.#publicMenu = { kind: "rescheduling", stage: query.stage };
      const snapshot = result.value;
      if (snapshot.stage === "offers" && snapshot.choices.length === 0 && snapshot.practitionerSwitchAvailable) this.#switchPromptTurnId = query.turnId;
      if (snapshot.stage === "offers") this.#searchMenu.remember({ turnId: query.turnId, from: query.from, to: query.to, kind: "rescheduling", snapshot });
      else this.#searchMenu.clear();
      if (snapshot.stage === "practitioners" || snapshot.stage === "selectedPractitioner") this.#spokenPractitioners.remember(query.turnId, snapshot);
      else if (snapshot.stage === "offers" || snapshot.stage === "targets" || snapshot.stage === "selectedTarget") this.#spokenMenu.remember({ kind: "rescheduling", stage: snapshot.stage === "offers" ? "offers" : "targets", turnId: query.turnId, snapshot });
    }
    return result;
  }
  async selectReschedulingMenu(query: ReschedulingMenuQuery & Readonly<{ menuTurnId: string; choice: 1 | 2 | 3 }>) {
    const result = await (this.#rescheduling()?.selectReschedulingMenu(query) ?? readDenied());
    if (result.ok && !query.signal.aborted && !this.closed && !this.#patientLifetime.signal.aborted) {
      this.#publicMenu = undefined;
      if (result.value.kind === "targetSelected") {
        this.#reschedulingTargetSelected = true; this.#spokenMenu.clear(); this.#spokenPractitioners.clear();
        this.#searchMenu.rememberSource(query.turnId, result.value.snapshot);
      }
      else if (result.value.kind === "practitionerSelected") { this.#spokenPractitioners.clear(); this.#spokenMenu.clear(); this.#spokenPractitioners.clear(); this.#searchMenu.clear(); }
      else this.#spokenMenu.consumed(query.turnId, query.choice);
    }
    else if (!query.signal.aborted) this.#spokenMenu.clear(); this.#spokenPractitioners.clear();
    return result;
  }
  async resolveAppointmentChange(query: AppointmentChangeEvidenceQuery, signal?: AbortSignal) { return !this.#staffActive && (this.#owner instanceof ClinikoCancellationSession || this.#owner instanceof ClinikoReschedulingSession || this.#owner instanceof ClinikoClassSession && ["cancel", "reschedule"].includes(this.#owner.operation)) ? (this.#owner instanceof ClinikoClassSession ? this.#owner.rescheduling ?? this.#owner.appointments! : this.#owner.effects).resolveAppointmentChange(query, signal) : readDenied(); }
  async resolveIntake(query: IntakeEvidenceQuery) { return (!this.#config.serviceCatalogue || !!this.#serviceChoice) && !this.#staffActive && this.#owner instanceof ClinikoIntakeBookingSession ? this.#owner.resolveIntake(query) : readDenied(); }
  get confirmationResendRef() { return !this.closed && !this.#verificationRequired && this.#workflow === "confirmationResend" ? this.#confirmationResendRef : undefined; }
  async listResendAppointments(signal?: AbortSignal) {
    this.#confirmationResendRef = undefined;
    return !this.closed && !this.#staffActive && !this.#verificationRequired && this.#owner instanceof ClinikoConfirmationResendWorkflow
      ? this.#owner.listAppointments(signal) : unavailable<ConfirmationResendMenuProgress>();
  }
  async pageResendAppointments(direction: "next" | "previous", signal?: AbortSignal) {
    this.#confirmationResendRef = undefined;
    return !this.closed && !this.#staffActive && !this.#verificationRequired && this.#owner instanceof ClinikoConfirmationResendWorkflow
      ? this.#owner.pageAppointments(direction, signal) : unavailable<ConfirmationResendMenuProgress>();
  }
  async resendMenuPlaybackCompleted(): Promise<boolean> {
    return !this.closed && !this.#verificationRequired && this.#owner instanceof ClinikoConfirmationResendWorkflow &&
      await this.#owner.menuPlaybackCompleted();
  }
  async selectResendAppointment(choice: 1 | 2 | 3, signal?: AbortSignal) {
    this.#confirmationResendRef = undefined;
    const owner = this.#owner;
    const result = !this.closed && !this.#staffActive && !this.#verificationRequired && owner instanceof ClinikoConfirmationResendWorkflow
      ? await owner.selectAppointment(choice, signal) : unavailable<Readonly<{ requestRef: string }>>();
    if (result.ok && this.#owner === owner && !this.closed && !signal?.aborted) this.#confirmationResendRef = result.value.requestRef;
    return result;
  }
  async resolveConfirmationResend(query: import("../core/host.ts").ConfirmationResendEvidenceQuery) {
    return !this.closed && !this.#staffActive && !this.#verificationRequired && this.#owner instanceof ClinikoConfirmationResendWorkflow
      ? this.#owner.effects.resolveConfirmationResend(query) : readDenied();
  }
  async resolvePatientCorrection(query: import("../core/host.ts").PatientCorrectionEvidenceQuery) {
    return this.patientCorrection?.resolvePatientCorrection(query) ?? readDenied();
  }
  async write(mutation: HostMutation, now: string, signal?: AbortSignal): Promise<HostWriteReceipt> {
    const owner = this.#owner;
    if (this.#tasks?.isRetired(mutation.actionKey)) return { kind: "rejected", actionKey: mutation.actionKey, reason: "forbidden" };
    if (!owner || owner instanceof ClinikoAppointmentEnquirySession || owner instanceof ClinikoPractitionerHistorySession || this.#staffActive || this.#lifetime.signal.aborted ||
        ["book", "intake"].includes(mutation.kind) && !(owner instanceof ClinikoClassSession) && this.#config.serviceCatalogue && !this.#serviceChoice) return { kind: "rejected", actionKey: mutation.actionKey, reason: "forbidden" };
    return (owner instanceof ClinikoIntakeBookingSession ? owner : owner.effects).write(mutation, now, signal);
  }
  async reconcile(mutation: HostMutation) {
    const receipt = this.#tasks?.receipt(mutation); if (receipt) return receipt;
    return this.#owner instanceof ClinikoConfirmationResendWorkflow ? this.#owner.effects.reconcile(mutation)
      : { kind: "stillUnknown" as const, actionKey: mutation.actionKey };
  }
  async readStaffReviewProcess(query: import("../core/host.ts").StaffReviewProcessQuery) {
    if (this.closed || this.#patientLifetime.signal.aborted || query.signal.aborted || !this.#staffActive || !this.#staff) return err({ kind: "staffReviewUnavailable" as const });
    return this.#staff.readReviewProcess(query);
  }
  async openTask(item: StaffItem, signal?: AbortSignal) { return this.#staff?.openTask(item, signal) ?? { kind: "rejected" as const, taskKey: item.key }; }
  async reconcileTask(item: StaffItem, signal?: AbortSignal) { return this.#staff?.reconcileTask(item, signal) ?? { kind: "stillUnknown" as const, taskKey: item.key }; }
  dispose(): void { this.#pendingRepresentative?.owner.dispose(); this.#pendingRepresentative = undefined; this.#representativeCall?.dispose(); this.#representativeCall = undefined; this.#pendingTask?.representative?.owner.dispose(); this.#representative?.owner.dispose(); this.#representative = undefined; this.#pendingTask?.owner.dispose(); this.#pendingTask = undefined; this.#historySubject = undefined; this.#searchMenu.clear(); this.#spokenMenu.clear(); this.#spokenPractitioners.clear(); this.#workflowLifetime.abort(); this.#patientLifetime.abort(); this.#lifetime.abort(); this.#config.signal.removeEventListener("abort", this.#onClose); this.#owner?.dispose(); this.#staff?.dispose(); this.#staff = undefined; this.#owner = undefined; this.#serviceDialogue.clear(); this.#classDialogue.clear(); this.#workflow = undefined; this.#bookingConfig = undefined; this.#serviceChoice = undefined; this.#serviceOperation = undefined; this.#verificationRequired = false; this.#intakeDraftRef = undefined; this.#publicMenu = undefined; this.#reschedulingTargetSelected = false; }
}
