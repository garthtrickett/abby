import type { ClinicIntakeAuditPage } from "../core/clinic-intake-setting.ts";
import type { NotificationAuditPage, NotificationCatalogue, NotificationKind, NotificationOwner } from "../core/notification-policy.ts";
import type { VoiceCatalogue } from "../core/voice-profile.ts";
import type { VoiceSettingAuditPage } from "../core/clinic-voice-setting.ts";
import type { StaffedDestinationAuditPage, StaffedDestinationCatalogue } from "../core/staffed-destination.ts";
import type { AppointmentChangeSelection, AfterHoursSettingAuditPage, AutomationSettingAuditPage, BookingSettingAuditPage, GreetingSettingAuditPage, StaffScheduleSettingAuditPage, UrgentSettingAuditPage, PolicyFailure, PolicyStore } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { AfterHoursMode, ApprovedAfterHoursInfo, ApprovedGreeting, ApprovedStaffSchedule, ApprovedUrgentResponse, CallPolicy, FinalCallerTurn, LocalStaffWindow, LocationScope, Result, StaffChangeRequest, StaffItem, TransitionFailure } from "../core/model.ts";
import { TextReception } from "./text-reception.ts";
import type { TextReceptionFailure } from "./text-reception.ts";
import type { CallSummary } from "./call-review.ts";
import { CallReview } from "./call-review.ts";
import type { StaffQueue } from "./staff-queue.ts";
import type { StaffQueueHealth, StaffQueuePage } from "./staff-queue.ts";
import type { CallOutcomeReport, CallOutcomePage } from "./call-outcome-report.ts";
import { commandProgress } from "./command-progress.ts";
import type { CallCommandProgress } from "./command-progress.ts";
import { capabilityDescriptor } from "./capability-catalogue.ts";
import type { CapabilityId, CapabilityDescriptor } from "./capability-catalogue.ts";
import { matchesSchema } from "./schema-shapes.ts";
import type { LedgerStore } from "../core/ledger.ts";
import type { WriteStopAuditPage, WriteStopStatus } from "../core/write-stop.ts";
import type { KnowledgeCatalogue, KnowledgeEntry, KnowledgeFailure } from "./knowledge-catalogue.ts";
import type { ClinicAvailabilitySetup, ClinicAvailabilityApprovalState, ClinicAvailabilitySetupFailure,
  ClinicAvailabilityRoute, ClinicAvailabilityBusinessCatalogue, ClinicAvailabilitySelection,
  ClinicAvailabilitySelectionSnapshot, ClinicAvailabilityPractitionerCatalogue,
  ClinicAvailabilityTypeCatalogue } from "./clinic-availability-setup.ts";
import { validOperationalDailyCounts } from "../voice/operational-counts.ts";
import type { OperationalDailyCounts, OperationalDailyReader } from "../voice/operational-counts.ts";
import type { CancellationSettingAuditPage, ReschedulingSettingAuditPage } from "../core/host.ts";

export type { CapabilityDescriptor } from "./capability-catalogue.ts";

export type HostActor = Readonly<{
  actorRef: string;
  role: "clinicAdmin" | "staff" | "agent";
  scope: LocationScope;
}>;

export type GatewayCommand =
  | Readonly<{ kind: "settings.voice.locale.change.v1"; expectedVersion: string; locale: string | null }>
  | Readonly<{ kind: "settings.voice.voiceId.change.v1"; expectedVersion: string; voiceId: string | null }>
  | Readonly<{ kind: "settings.voice.options.v1" }>
  | Readonly<{ kind: "settings.voice.audit.v1"; afterVersion?: number }>
  | Readonly<{ kind: "settings.read.v1" }>
  | Readonly<{ kind: "settings.notifications.owner.change.v1"; expectedVersion: string; notificationKind: NotificationKind; owner: NotificationOwner | null }>
  | Readonly<{ kind: "settings.notifications.audit.v1"; afterVersion?: number }>
  | Readonly<{ kind: "settings.notifications.options.v1" }>
  | Readonly<{ kind: "settings.routing.staffedDestination.options.v1" }>
  | Readonly<{ kind: "settings.routing.staffedDestination.change.v1"; expectedVersion: string; destinationRef: string | null }>
  | Readonly<{ kind: "settings.routing.staffedDestination.audit.v1"; afterVersion?: number }>
  | Readonly<{ kind: "settings.automation.enabled.change.v1"; expectedVersion: string; enabled: boolean }>
  | Readonly<{ kind: "settings.automation.audit.v1"; afterVersion?: number }>
  | Readonly<{ kind: "calls.writes.stop.v1"; reason: string }>
  | Readonly<{ kind: "calls.writes.stop.read.v1"; afterEffectId?: string }>
  | Readonly<{ kind: "calls.writes.resume.v1"; expectedVersion: string; reason: string }>
  | Readonly<{ kind: "calls.writes.stop.audit.v1"; afterVersion?: number }>
  | Readonly<{ kind: "settings.appointments.booking.enabled.change.v1"; expectedVersion: string; enabled: boolean }>
  | Readonly<{ kind: "settings.appointments.booking.audit.v1"; afterVersion?: number }>
  | Readonly<{ kind: "settings.appointments.cancellation.enabled.change.v1"; expectedVersion: string; enabled: boolean }>
  | Readonly<{ kind: "settings.appointments.rescheduling.enabled.change.v1"; expectedVersion: string; enabled: boolean }>
  | Readonly<{ kind: "settings.patients.firstTimeIntake.enabled.change.v1"; expectedVersion: string; enabled: boolean }>
  | Readonly<{ kind: "settings.appointments.cancellation.audit.v1"; afterVersion?: number }>
  | Readonly<{ kind: "settings.appointments.rescheduling.audit.v1"; afterVersion?: number }>
  | Readonly<{ kind: "settings.patients.firstTimeIntake.audit.v1"; afterVersion?: number }>
  | Readonly<{ kind: "settings.routing.afterHours.change.v1"; expectedVersion: string;
    mode: AfterHoursMode; infoVersion?: string; approvedText?: string }>
  | Readonly<{ kind: "settings.routing.afterHours.audit.v1"; afterVersion?: number }>
  | Readonly<{ kind: "settings.routing.urgent.change.v1"; expectedVersion: string; enabled: false }>
  | Readonly<{ kind: "settings.routing.urgent.change.v1"; expectedVersion: string; enabled: true;
    scriptVersion: string; approvedText: string; effectiveFrom: string; effectiveUntil: string }>
  | Readonly<{ kind: "settings.routing.urgent.audit.v1"; afterVersion?: number }>
  | Readonly<{ kind: "settings.routing.staffSchedule.change.v1"; expectedVersion: string; enabled: false }>
  | Readonly<{ kind: "settings.routing.staffSchedule.change.v1"; expectedVersion: string; enabled: true;
    scheduleVersion: string; effectiveFrom: string; effectiveUntil: string; timeZone: string;
    weekly: readonly LocalStaffWindow[]; closedDates: readonly string[] }>
  | Readonly<{ kind: "settings.routing.staffSchedule.audit.v1"; afterVersion?: number }>
  | Readonly<{ kind: "settings.routing.greeting.change.v1"; expectedVersion: string; enabled: false }>
  | Readonly<{ kind: "settings.routing.greeting.change.v1"; expectedVersion: string; enabled: true;
    greetingVersion: string; approvedText: string; effectiveFrom: string; effectiveUntil: string }>
  | Readonly<{ kind: "settings.routing.greeting.audit.v1"; afterVersion?: number }>
  | Readonly<{ kind: "booking.propose.v2"; turn: FinalCallerTurn; verificationRef: string; offerRef: string; now: string }>
  | Readonly<{ kind: "appointments.change.propose.v1"; turn: FinalCallerTurn & Readonly<{ sessionId: string }>; selection: AppointmentChangeSelection; now: string }>
  | Readonly<{ kind: "patients.intake.propose.v1"; turn: FinalCallerTurn & Readonly<{ sessionId: string }>; draftRef: string; now: string }>
  | Readonly<{ kind: "calls.turn.model.v1"; turn: FinalCallerTurn; now: string }>
  | Readonly<{ kind: "knowledge.answer.v2"; turn: FinalCallerTurn; sourceRefs: readonly string[]; proposedText: string; now: string }>
  | Readonly<{ kind: "knowledge.list.v1" }>
  | Readonly<{ kind: "knowledge.draft.save.v1"; sourceRef: string; expectedVersion: string; ownerRef: string; text: string; effectiveFrom: string; effectiveUntil: string }>
  | Readonly<{ kind: "knowledge.approve.v1"; sourceRef: string; expectedVersion: string }>
  | Readonly<{ kind: "knowledge.revoke.v1"; sourceRef: string; expectedVersion: string }>
  | Readonly<{ kind: "clinic.availability.businesses.list.v1" }>
  | Readonly<{ kind: "clinic.availability.practitioners.list.v1"; businessId: string }>
  | Readonly<{ kind: "clinic.availability.types.list.v1"; businessId: string; practitionerId: string }>
  | Readonly<{ kind: "clinic.availability.selection.inspect.v1"; selection: ClinicAvailabilitySelection }>
  | Readonly<{ kind: "clinic.availability.approval.read.v1" }>
  | Readonly<{ kind: "clinic.availability.route.check.v1" }>
  | Readonly<{ kind: "clinic.availability.approval.change.v1"; route: ClinicAvailabilityRoute; selection: ClinicAvailabilitySelection; expectedVersion: number }>
  | Readonly<{ kind: "clinic.availability.approval.change.v2"; route: ClinicAvailabilityRoute; selection: ClinicAvailabilitySelection;
    alternatives: readonly ClinicAvailabilitySelection[]; expectedVersion: number }>
  | Readonly<{ kind: "clinic.availability.approval.revoke.v1"; expectedVersion: number }>
  | Readonly<{ kind: "rescheduling.menu.read.v1"; turn: FinalCallerTurn; stage: "targets" | "offers"; from: string; to: string; now: string; window?: import("../core/booking-search-window.ts").BookingSearchWindow | null }>
  | Readonly<{ kind: "rescheduling.menu.select.v1"; turn: FinalCallerTurn; stage: "targets" | "offers"; choice: 1 | 2 | 3; now: string }>
  | Readonly<{ kind: "booking.offers.read.v1"; turn: FinalCallerTurn; from: string; to: string; now: string; preference?: import("../core/booking-search-preference.ts").BookingSearchPreference; window?: import("../core/booking-search-window.ts").BookingSearchWindow | null }>
  | Readonly<{ kind: "booking.offers.select.v1"; turn: FinalCallerTurn; choice: 1 | 2 | 3; now: string }>
  | Readonly<{ kind: "availability.read.v2"; turn: FinalCallerTurn; from: string; to: string; now: string }>
  | Readonly<{ kind: "appointments.read.v1"; turn: FinalCallerTurn; verificationRef: string; from: string; to: string; now: string }>
  | Readonly<{ kind: "calls.read.v1"; callId: string }>
  | Readonly<{ kind: "calls.outcomes.v1"; afterCallId?: string }>
  | Readonly<{ kind: "staff.list.v1"; afterTaskKey?: string }>
  | Readonly<{ kind: "staff.health.v1" }>
  | Readonly<{ kind: "staff.requests.prepare.v1"; turn: FinalCallerTurn & Readonly<{ sessionId: string }>; requestedPerson?: string; now: string }>
  | Readonly<{ kind: "staff.requests.outcome.v1"; turn: FinalCallerTurn & Readonly<{ sessionId: string }>; now: string }>
  | Readonly<{ kind: "operations.daily.v1" }>
  | Readonly<{ kind: "staff.change.v1"; callId: string; taskKey: string; expectedVersion: number; change: StaffChangeRequest; now: string }>;

type AssertNever<T extends never> = T;
type CatalogueMissingCommand = AssertNever<Exclude<GatewayCommand["kind"], CapabilityId>>;
type CommandMissingCatalogue = AssertNever<Exclude<CapabilityId, GatewayCommand["kind"]>>;

export type GatewayReply =
  | Readonly<{ kind: "voiceOptions"; catalogue: VoiceCatalogue }>
  | Readonly<{ kind: "voiceSettingAudit"; page: VoiceSettingAuditPage }>
  | Readonly<{ kind: "settings"; policy: CallPolicy }>
  | Readonly<{ kind: "staffedDestinationOptions"; catalogue: StaffedDestinationCatalogue }>
  | Readonly<{ kind: "notificationOptions"; catalogue: NotificationCatalogue }>
  | Readonly<{ kind: "notificationSettingAudit"; page: NotificationAuditPage }>
  | Readonly<{ kind: "staffedDestinationSettingAudit"; page: StaffedDestinationAuditPage }>
  | Readonly<{ kind: "automationSettingAudit"; page: AutomationSettingAuditPage }>
  | Readonly<{ kind: "writeStop"; status: WriteStopStatus }>
  | Readonly<{ kind: "writeStopAudit"; page: WriteStopAuditPage }>
  | Readonly<{ kind: "bookingSettingAudit"; page: BookingSettingAuditPage }>
  | Readonly<{ kind: "cancellationSettingAudit"; page: CancellationSettingAuditPage }>
  | Readonly<{ kind: "reschedulingSettingAudit"; page: ReschedulingSettingAuditPage }>
  | Readonly<{ kind: "firstTimeIntakeSettingAudit"; page: ClinicIntakeAuditPage }>
  | Readonly<{ kind: "afterHoursSettingAudit"; page: AfterHoursSettingAuditPage }>
  | Readonly<{ kind: "urgentSettingAudit"; page: UrgentSettingAuditPage }>
  | Readonly<{ kind: "staffScheduleSettingAudit"; page: StaffScheduleSettingAuditPage }>
  | Readonly<{ kind: "greetingSettingAudit"; page: GreetingSettingAuditPage }>
  | Readonly<{ kind: "bookingProposal"; progress: CallCommandProgress }>
  | Readonly<{ kind: "appointmentChangeProposal"; progress: CallCommandProgress }>
  | Readonly<{ kind: "intakeProposal"; progress: CallCommandProgress }>
  | Readonly<{ kind: "staffRequestProgress"; progress: CallCommandProgress }>
  | Readonly<{ kind: "modelTurn"; progress: CallCommandProgress }>
  | Readonly<{ kind: "knowledgeAnswer"; progress: CallCommandProgress }>
  | Readonly<{ kind: "knowledgeList"; entries: readonly KnowledgeEntry[] }>
  | Readonly<{ kind: "knowledgeEntry"; entry: KnowledgeEntry }>
  | Readonly<{ kind: "clinicAvailabilityBusinesses"; catalogue: ClinicAvailabilityBusinessCatalogue }>
  | Readonly<{ kind: "clinicAvailabilityPractitioners"; catalogue: ClinicAvailabilityPractitionerCatalogue }>
  | Readonly<{ kind: "clinicAvailabilityTypes"; catalogue: ClinicAvailabilityTypeCatalogue }>
  | Readonly<{ kind: "clinicAvailabilitySelection"; snapshot: ClinicAvailabilitySelectionSnapshot }>
  | Readonly<{ kind: "clinicAvailabilityApprovalState"; state: ClinicAvailabilityApprovalState }>
  | Readonly<{ kind: "clinicAvailabilityRouteCheck"; eligible: true }>
  | Readonly<{ kind: "availabilityAnswer"; progress: CallCommandProgress }>
  | Readonly<{ kind: "appointmentAnswer"; progress: CallCommandProgress }>
  | Readonly<{ kind: "callSummary"; call: CallSummary }>
  | Readonly<{ kind: "callOutcomes"; page: CallOutcomePage }>
  | Readonly<{ kind: "staffQueue"; page: StaffQueuePage }>
  | Readonly<{ kind: "staffQueueHealth"; health: StaffQueueHealth }>
  | Readonly<{ kind: "operationalDaily"; daily: OperationalDailyCounts }>
  | Readonly<{ kind: "staffChange"; taskKey: string; callVersion: number; status: StaffItem["status"]; pending: boolean; reviewRequired: boolean }>;

export type GatewayFailure = PolicyFailure | TextReceptionFailure | TransitionFailure | KnowledgeFailure | ClinicAvailabilitySetupFailure |
  Readonly<{ kind: "forbidden" | "invalid" | "commandOutcomeUnknown" | "responseContractViolation" }>;

export class CommandGateway {
  private readonly actor: HostActor;
  private readonly policy: PolicyStore;
  private readonly reception: TextReception;
  private readonly review: CallReview | undefined;
  private readonly staffQueue: StaffQueue | undefined;
  private readonly outcomeReport: CallOutcomeReport | undefined;
  private readonly writeStopLedger: LedgerStore | undefined;
  private readonly knowledgeCatalogue: KnowledgeCatalogue | undefined;
  private readonly availabilitySetup: ClinicAvailabilitySetup | undefined;
  private readonly operationalDaily: OperationalDailyReader | undefined;

  constructor(actor: HostActor, policy: PolicyStore, reception: TextReception, review?: CallReview, staffQueue?: StaffQueue, outcomeReport?: CallOutcomeReport, writeStopLedger?: LedgerStore,
              knowledgeCatalogue?: KnowledgeCatalogue, availabilitySetup?: ClinicAvailabilitySetup,
              operationalDaily?: OperationalDailyReader) {
    if (!actor || typeof actor.actorRef !== "string" || !actor.actorRef.trim() || actor.actorRef.length > 256 ||
        !["clinicAdmin", "staff", "agent"].includes(actor.role) || !actor.scope ||
        [actor.scope.tenantId, actor.scope.clinicId, actor.scope.locationId]
          .some(part => typeof part !== "string" || !part.trim())) throw new Error("host actor identity is required");
    this.actor = structuredClone(actor);
    this.policy = policy;
    this.reception = reception;
    this.review = review;
    this.staffQueue = staffQueue;
    this.outcomeReport = outcomeReport;
    this.writeStopLedger = writeStopLedger;
    this.knowledgeCatalogue = knowledgeCatalogue;
    this.availabilitySetup = availabilitySetup;
    this.operationalDaily = operationalDaily;
  }

  /** A host transport can reject a gateway accidentally bound to another session. */
  matchesActor(actor: HostActor): boolean {
    return !!actor && this.actor.actorRef === actor.actorRef && this.actor.role === actor.role &&
      this.actor.scope.tenantId === actor.scope?.tenantId &&
      this.actor.scope.clinicId === actor.scope?.clinicId &&
      this.actor.scope.locationId === actor.scope?.locationId;
  }

  listPermitted(): readonly CapabilityDescriptor[] {
    const permitted: CapabilityId[] = ["settings.read.v1", "booking.propose.v2", "appointments.change.propose.v1",
      "patients.intake.propose.v1", "knowledge.answer.v2"];
    if (this.reception.reschedulingMenuEnabled()) permitted.push("rescheduling.menu.read.v1", "rescheduling.menu.select.v1");
    if (this.reception.bookingMenuEnabled()) permitted.push("booking.offers.read.v1", "booking.offers.select.v1");
    if (this.reception.modelEnabled()) permitted.push("calls.turn.model.v1");
    if (this.reception.availabilityEnabled()) permitted.push("availability.read.v2");
    if (this.reception.appointmentReadEnabled()) permitted.push("appointments.read.v1");
    if (this.reception.staffRequestEnabled()) permitted.push("staff.requests.prepare.v1", "staff.requests.outcome.v1");
    if (this.review) permitted.push("calls.read.v1");
    if (this.outcomeReport) permitted.push("calls.outcomes.v1");
    if (this.staffQueue) permitted.push("staff.list.v1", "staff.health.v1");
    if (this.actor.role !== "agent" && this.reception.staffLifecycleEnabled()) permitted.push("staff.change.v1");
    if (this.actor.role === "clinicAdmin") {
      if (this.operationalDaily) permitted.push("operations.daily.v1");
      if (this.knowledgeCatalogue) permitted.push("knowledge.list.v1", "knowledge.draft.save.v1", "knowledge.approve.v1", "knowledge.revoke.v1");
      if (this.availabilitySetup) permitted.push("clinic.availability.businesses.list.v1",
        "clinic.availability.practitioners.list.v1", "clinic.availability.types.list.v1", "clinic.availability.selection.inspect.v1",
        "clinic.availability.approval.read.v1", "clinic.availability.route.check.v1", "clinic.availability.approval.change.v1",
        "clinic.availability.approval.change.v2", "clinic.availability.approval.revoke.v1");
      permitted.push("settings.automation.enabled.change.v1", "settings.automation.audit.v1",
        "settings.voice.locale.change.v1", "settings.voice.voiceId.change.v1", "settings.voice.options.v1", "settings.voice.audit.v1",
        "settings.routing.staffedDestination.change.v1", "settings.routing.staffedDestination.audit.v1",
        "settings.routing.staffedDestination.options.v1",
        "settings.notifications.owner.change.v1", "settings.notifications.audit.v1", "settings.notifications.options.v1",
        "settings.appointments.booking.enabled.change.v1", "settings.appointments.booking.audit.v1",
        "settings.appointments.cancellation.enabled.change.v1", "settings.appointments.cancellation.audit.v1",
        "settings.appointments.rescheduling.enabled.change.v1", "settings.appointments.rescheduling.audit.v1",
        "settings.patients.firstTimeIntake.enabled.change.v1", "settings.patients.firstTimeIntake.audit.v1",
        "settings.routing.afterHours.change.v1", "settings.routing.afterHours.audit.v1",
        "settings.routing.urgent.change.v1", "settings.routing.urgent.audit.v1");
      permitted.push("settings.routing.staffSchedule.change.v1", "settings.routing.staffSchedule.audit.v1");
      permitted.push("settings.routing.greeting.change.v1", "settings.routing.greeting.audit.v1");
      if (this.writeStopLedger) permitted.push("calls.writes.stop.v1", "calls.writes.stop.read.v1",
        "calls.writes.resume.v1", "calls.writes.stop.audit.v1");
    }
    return permitted.map(capabilityDescriptor);
  }

  async submit(command: GatewayCommand): Promise<Result<GatewayReply, GatewayFailure>> {
    let kind: unknown;
    try { kind = command?.kind; }
    catch { return err({ kind: "invalid" }); }
    const capability = this.listPermitted().find(item => item.id === kind);
    if (!capability) return err({ kind: "forbidden" });
    try { if (!matchesSchema(capability.inputSchema, command)) return err({ kind: "invalid" }); }
    catch { return err({ kind: "invalid" }); }
    let result: Result<GatewayReply, GatewayFailure>;
    try { result = await this.dispatch(command); }
    catch { return err({ kind: "commandOutcomeUnknown" }); }
    try { return matchesSchema(capability.resultSchema, result) ? result : err({ kind: "responseContractViolation" }); }
    catch { return err({ kind: "responseContractViolation" }); }
  }

  private async dispatch(command: GatewayCommand): Promise<Result<GatewayReply, GatewayFailure>> {
    switch (command.kind) {
      case "staff.requests.prepare.v1": {
        const result = await this.reception.requestStaff(this.actor.scope, command.turn, command.requestedPerson, command.now);
        return result.ok ? ok({ kind: "staffRequestProgress", progress: commandProgress(result.value, command.turn.turnId) }) : result;
      }
      case "staff.requests.outcome.v1": {
        const result = await this.reception.staffOutcome(this.actor.scope, command.turn, command.now);
        return result.ok ? ok({ kind: "staffRequestProgress", progress: commandProgress(result.value, command.turn.turnId) }) : result;
      }
      case "settings.read.v1": {
        const result = await this.policy.read(this.actor.scope);
        return result.ok ? ok({ kind: "settings", policy: result.value }) : result;
      }
      case "settings.automation.enabled.change.v1": {
        const result = await this.policy.changeAutomationEnabled(this.actor.scope, command.expectedVersion, command.enabled, this.actor.actorRef);
        return result.ok ? ok({ kind: "settings", policy: result.value }) : result;
      }
      case "settings.automation.audit.v1": {
        if (command.afterVersion !== undefined && (!Number.isSafeInteger(command.afterVersion) || command.afterVersion < 0)) return err({ kind: "invalid" });
        const result = await this.policy.listAutomationChanges(this.actor.scope, command.afterVersion);
        return result.ok ? ok({ kind: "automationSettingAudit", page: result.value }) : result;
      }
      case "calls.writes.stop.v1": {
        if (!this.writeStopLedger) return err({ kind: "forbidden" });
        const result = await this.writeStopLedger.stopWrites(this.actor.scope, this.actor.actorRef, command.reason);
        return result.ok ? ok({ kind: "writeStop", status: result.value }) : result;
      }
      case "calls.writes.stop.read.v1": {
        if (!this.writeStopLedger) return err({ kind: "forbidden" });
        const result = await this.writeStopLedger.readWriteStop(this.actor.scope, command.afterEffectId);
        return result.ok ? ok({ kind: "writeStop", status: result.value }) : result;
      }
      case "calls.writes.resume.v1": {
        if (!this.writeStopLedger) return err({ kind: "forbidden" });
        const result = await this.writeStopLedger.resumeWrites(this.actor.scope, command.expectedVersion, this.actor.actorRef, command.reason);
        return result.ok ? ok({ kind: "writeStop", status: result.value }) : result;
      }
      case "calls.writes.stop.audit.v1": {
        if (!this.writeStopLedger) return err({ kind: "forbidden" });
        const result = await this.writeStopLedger.listWriteStopChanges(this.actor.scope, command.afterVersion);
        return result.ok ? ok({ kind: "writeStopAudit", page: result.value }) : result;
      }
      case "settings.appointments.booking.enabled.change.v1": {
        const result = await this.policy.changeBookingEnabled(this.actor.scope, command.expectedVersion, command.enabled, this.actor.actorRef);
        return result.ok ? ok({ kind: "settings", policy: result.value }) : result;
      }
      case "settings.appointments.booking.audit.v1": {
        if (command.afterVersion !== undefined && (!Number.isSafeInteger(command.afterVersion) || command.afterVersion < 0)) return err({ kind: "invalid" });
        const result = await this.policy.listBookingChanges(this.actor.scope, command.afterVersion);
        return result.ok ? ok({ kind: "bookingSettingAudit", page: result.value }) : result;
      }
      case "settings.appointments.cancellation.enabled.change.v1": {
        const result = await this.policy.changeCancellationEnabled(this.actor.scope, command.expectedVersion,
          command.enabled, this.actor.actorRef);
        return result.ok ? ok({ kind: "settings", policy: result.value }) : result;
      }
      case "settings.appointments.cancellation.audit.v1": {
        const result = await this.policy.listCancellationChanges(this.actor.scope, command.afterVersion);
        return result.ok ? ok({ kind: "cancellationSettingAudit", page: result.value }) : result;
      }
      case "settings.appointments.rescheduling.enabled.change.v1": {
        const result = await this.policy.changeReschedulingEnabled(this.actor.scope, command.expectedVersion,
          command.enabled, this.actor.actorRef);
        return result.ok ? ok({ kind: "settings", policy: result.value }) : result;
      }
      case "settings.appointments.rescheduling.audit.v1": {
        const result = await this.policy.listReschedulingChanges(this.actor.scope, command.afterVersion);
        return result.ok ? ok({ kind: "reschedulingSettingAudit", page: result.value }) : result;
      }
      case "settings.patients.firstTimeIntake.enabled.change.v1": {
        const result = await this.policy.changeFirstTimeIntakeEnabled(this.actor.scope, command.expectedVersion,
          command.enabled, this.actor.actorRef);
        return result.ok ? ok({ kind: "settings", policy: result.value }) : result;
      }
      case "settings.patients.firstTimeIntake.audit.v1": {
        const result = await this.policy.listFirstTimeIntakeChanges(this.actor.scope, command.afterVersion);
        return result.ok ? ok({ kind: "firstTimeIntakeSettingAudit", page: result.value }) : result;
      }
      case "settings.voice.locale.change.v1": {
        const result = await this.policy.changeVoiceSetting(this.actor.scope, command.expectedVersion, "locale", command.locale, this.actor.actorRef);
        return result.ok ? ok({ kind: "settings", policy: result.value }) : result;
      }
      case "settings.voice.voiceId.change.v1": {
        const result = await this.policy.changeVoiceSetting(this.actor.scope, command.expectedVersion, "voiceId", command.voiceId, this.actor.actorRef);
        return result.ok ? ok({ kind: "settings", policy: result.value }) : result;
      }
      case "settings.voice.options.v1": {
        const result = await this.policy.listVoiceOptions(this.actor.scope);
        return result.ok ? ok({ kind: "voiceOptions", catalogue: result.value }) : result;
      }
      case "settings.voice.audit.v1": {
        const result = await this.policy.listVoiceChanges(this.actor.scope, command.afterVersion);
        return result.ok ? ok({ kind: "voiceSettingAudit", page: result.value }) : result;
      }
      case "settings.notifications.owner.change.v1": {
        const result = await this.policy.changeNotificationOwner(this.actor.scope, command.expectedVersion,
          command.notificationKind, command.owner, this.actor.actorRef);
        return result.ok ? ok({ kind: "settings", policy: result.value }) : result;
      }
      case "settings.notifications.options.v1": {
        const result = await this.policy.listNotificationOptions(this.actor.scope);
        return result.ok ? ok({ kind: "notificationOptions", catalogue: result.value }) : result;
      }
      case "settings.notifications.audit.v1": {
        const result = await this.policy.listNotificationChanges(this.actor.scope, command.afterVersion);
        return result.ok ? ok({ kind: "notificationSettingAudit", page: result.value }) : result;
      }
      case "settings.routing.staffedDestination.change.v1": {
        const result = await this.policy.changeStaffedDestination(this.actor.scope, command.expectedVersion,
          command.destinationRef, this.actor.actorRef);
        return result.ok ? ok({ kind: "settings", policy: result.value }) : result;
      }
      case "settings.routing.staffedDestination.options.v1": {
        const result = await this.policy.listStaffedDestinations(this.actor.scope);
        return result.ok ? ok({ kind: "staffedDestinationOptions", catalogue: result.value }) : result;
      }
      case "settings.routing.staffedDestination.audit.v1": {
        const result = await this.policy.listStaffedDestinationChanges(this.actor.scope, command.afterVersion);
        return result.ok ? ok({ kind: "staffedDestinationSettingAudit", page: result.value }) : result;
      }
      case "settings.routing.afterHours.change.v1": {
        if (command.mode === "staffRequest" &&
            (command.infoVersion !== undefined || command.approvedText !== undefined)) return err({ kind: "invalid" });
        const info: ApprovedAfterHoursInfo | undefined = command.mode === "approvedInfoAndRequest" ? {
          scope: this.actor.scope, version: command.infoVersion ?? "", ownerRef: this.actor.actorRef,
          approvedText: command.approvedText ?? "", approved: true,
        } : undefined;
        const result = await this.policy.changeAfterHours(this.actor.scope, command.expectedVersion,
          command.mode, info, this.actor.actorRef);
        return result.ok ? ok({ kind: "settings", policy: result.value }) : result;
      }
      case "settings.routing.afterHours.audit.v1": {
        if (command.afterVersion !== undefined && (!Number.isSafeInteger(command.afterVersion) || command.afterVersion < 0)) return err({ kind: "invalid" });
        const result = await this.policy.listAfterHoursChanges(this.actor.scope, command.afterVersion);
        return result.ok ? ok({ kind: "afterHoursSettingAudit", page: result.value }) : result;
      }
      case "settings.routing.urgent.change.v1": {
        const response: ApprovedUrgentResponse | undefined = command.enabled ? {
          scope: this.actor.scope, version: command.scriptVersion, ownerRef: this.actor.actorRef,
          approvedText: command.approvedText, approved: true,
          effectiveFrom: command.effectiveFrom, effectiveUntil: command.effectiveUntil,
        } : undefined;
        const result = await this.policy.changeUrgentResponse(this.actor.scope, command.expectedVersion,
          response, this.actor.actorRef);
        return result.ok ? ok({ kind: "settings", policy: result.value }) : result;
      }
      case "settings.routing.urgent.audit.v1": {
        const result = await this.policy.listUrgentResponseChanges(this.actor.scope, command.afterVersion);
        return result.ok ? ok({ kind: "urgentSettingAudit", page: result.value }) : result;
      }
      case "settings.routing.staffSchedule.change.v1": {
        const schedule: ApprovedStaffSchedule | undefined = command.enabled ? {
          scope: this.actor.scope, version: command.scheduleVersion, ownerRef: this.actor.actorRef, approved: true,
          effectiveFrom: command.effectiveFrom, effectiveUntil: command.effectiveUntil,
          timeZone: command.timeZone, weekly: command.weekly, closedDates: command.closedDates,
        } : undefined;
        const result = await this.policy.changeStaffSchedule(this.actor.scope, command.expectedVersion,
          schedule, this.actor.actorRef);
        return result.ok ? ok({ kind: "settings", policy: result.value }) : result;
      }
      case "settings.routing.staffSchedule.audit.v1": {
        const result = await this.policy.listStaffScheduleChanges(this.actor.scope, command.afterVersion);
        return result.ok ? ok({ kind: "staffScheduleSettingAudit", page: result.value }) : result;
      }
      case "settings.routing.greeting.change.v1": {
        const greeting: ApprovedGreeting | undefined = command.enabled ? {
          scope: this.actor.scope, version: command.greetingVersion, ownerRef: this.actor.actorRef, approved: true,
          approvedText: command.approvedText, effectiveFrom: command.effectiveFrom, effectiveUntil: command.effectiveUntil,
        } : undefined;
        const result = await this.policy.changeGreeting(this.actor.scope, command.expectedVersion,
          greeting, this.actor.actorRef);
        return result.ok ? ok({ kind: "settings", policy: result.value }) : result;
      }
      case "settings.routing.greeting.audit.v1": {
        const result = await this.policy.listGreetingChanges(this.actor.scope, command.afterVersion);
        return result.ok ? ok({ kind: "greetingSettingAudit", page: result.value }) : result;
      }
      case "booking.propose.v2": {
        if (!command.turn.turnId || !command.turn.callId || !command.turn.text || !command.verificationRef || !command.offerRef) return err({ kind: "invalid" });
        const result = await this.reception.proposeBooking(this.actor.scope, command.turn, command.verificationRef, command.offerRef, command.now);
        return result.ok ? ok({ kind: "bookingProposal", progress: commandProgress(result.value, command.turn.turnId) }) : result;
      }
      case "appointments.change.propose.v1": {
        if (!Number.isFinite(Date.parse(command.now))) return err({ kind: "invalid" });
        const result = await this.reception.proposeAppointmentChange(this.actor.scope, command.turn, command.selection, command.now);
        return result.ok ? ok({ kind: "appointmentChangeProposal", progress: commandProgress(result.value, command.turn.turnId) }) : result;
      }
      case "patients.intake.propose.v1": {
        if (!Number.isFinite(Date.parse(command.now))) return err({ kind: "invalid" });
        const result = await this.reception.proposeIntake(this.actor.scope, command.turn, command.draftRef, command.now);
        return result.ok ? ok({ kind: "intakeProposal", progress: commandProgress(result.value, command.turn.turnId) }) : result;
      }
      case "calls.turn.model.v1": {
        if (!command.turn || !command.turn.turnId || !command.turn.callId || !command.turn.text ||
            typeof command.now !== "string" || !Number.isFinite(Date.parse(command.now))) return err({ kind: "invalid" });
        const result = await this.reception.interpretModelTurn(this.actor.scope, command.turn, command.now);
        return result.ok ? ok({ kind: "modelTurn", progress: commandProgress(result.value, command.turn.turnId) }) : result;
      }
      case "knowledge.answer.v2": {
        if (!command.turn || !command.turn.turnId || !command.turn.callId || !command.turn.text ||
            typeof command.now !== "string" || !Number.isFinite(Date.parse(command.now)) ||
            !Array.isArray(command.sourceRefs) || command.sourceRefs.some(ref => typeof ref !== "string") ||
            typeof command.proposedText !== "string") return err({ kind: "invalid" });
        const result = await this.reception.answer(this.actor.scope, command.turn, command.sourceRefs, command.proposedText, command.now);
        return result.ok ? ok({ kind: "knowledgeAnswer", progress: commandProgress(result.value, command.turn.turnId) }) : result;
      }
      case "knowledge.list.v1": {
        if (!this.knowledgeCatalogue) return err({ kind: "forbidden" });
        const result = await this.knowledgeCatalogue.list(this.actor.scope);
        return result.ok ? ok({ kind: "knowledgeList", entries: result.value }) : result;
      }
      case "knowledge.draft.save.v1": {
        if (!this.knowledgeCatalogue) return err({ kind: "forbidden" });
        const result = await this.knowledgeCatalogue.saveDraft(this.actor.scope, command.sourceRef, command.expectedVersion,
          command.ownerRef, command.text, command.effectiveFrom, command.effectiveUntil, this.actor.actorRef);
        return result.ok ? ok({ kind: "knowledgeEntry", entry: result.value }) : result;
      }
      case "knowledge.approve.v1": {
        if (!this.knowledgeCatalogue) return err({ kind: "forbidden" });
        const result = await this.knowledgeCatalogue.approve(this.actor.scope, command.sourceRef, command.expectedVersion, this.actor.actorRef);
        return result.ok ? ok({ kind: "knowledgeEntry", entry: result.value }) : result;
      }
      case "knowledge.revoke.v1": {
        if (!this.knowledgeCatalogue) return err({ kind: "forbidden" });
        const result = await this.knowledgeCatalogue.revoke(this.actor.scope, command.sourceRef, command.expectedVersion, this.actor.actorRef);
        return result.ok ? ok({ kind: "knowledgeEntry", entry: result.value }) : result;
      }
      case "clinic.availability.businesses.list.v1": {
        if (!this.availabilitySetup) return err({ kind: "forbidden" });
        const result = await this.availabilitySetup.businesses(this.actor);
        return result.ok ? ok({ kind: "clinicAvailabilityBusinesses", catalogue: result.value }) : result;
      }
      case "clinic.availability.practitioners.list.v1": {
        if (!this.availabilitySetup) return err({ kind: "forbidden" });
        const result = await this.availabilitySetup.practitioners(this.actor, command.businessId);
        return result.ok ? ok({ kind: "clinicAvailabilityPractitioners", catalogue: result.value }) : result;
      }
      case "clinic.availability.types.list.v1": {
        if (!this.availabilitySetup) return err({ kind: "forbidden" });
        const result = await this.availabilitySetup.appointmentTypes(this.actor, command.businessId, command.practitionerId);
        return result.ok ? ok({ kind: "clinicAvailabilityTypes", catalogue: result.value }) : result;
      }
      case "clinic.availability.selection.inspect.v1": {
        if (!this.availabilitySetup) return err({ kind: "forbidden" });
        const result = await this.availabilitySetup.inspect(this.actor, command.selection);
        return result.ok ? ok({ kind: "clinicAvailabilitySelection", snapshot: result.value }) : result;
      }
      case "clinic.availability.approval.read.v1": {
        if (!this.availabilitySetup) return err({ kind: "forbidden" });
        const result = await this.availabilitySetup.current(this.actor);
        return result.ok ? ok({ kind: "clinicAvailabilityApprovalState", state: result.value }) : result;
      }
      case "clinic.availability.route.check.v1": {
        if (!this.availabilitySetup) return err({ kind: "forbidden" });
        const result = await this.availabilitySetup.checkApprovedRoute(this.actor);
        return result.ok ? ok({ kind: "clinicAvailabilityRouteCheck", eligible: true }) : result;
      }
      case "clinic.availability.approval.change.v1": {
        if (!this.availabilitySetup) return err({ kind: "forbidden" });
        const result = await this.availabilitySetup.approve(this.actor, command.route, command.selection, command.expectedVersion);
        return result.ok ? ok({ kind: "clinicAvailabilityApprovalState", state: result.value }) : result;
      }
      case "clinic.availability.approval.change.v2": {
        if (!this.availabilitySetup) return err({ kind: "forbidden" });
        const result = await this.availabilitySetup.approveAlternatives(this.actor, command.route, command.selection,
          command.alternatives, command.expectedVersion);
        return result.ok ? ok({ kind: "clinicAvailabilityApprovalState", state: result.value }) : result;
      }
      case "clinic.availability.approval.revoke.v1": {
        if (!this.availabilitySetup) return err({ kind: "forbidden" });
        const result = await this.availabilitySetup.revoke(this.actor, command.expectedVersion);
        return result.ok ? ok({ kind: "clinicAvailabilityApprovalState", state: result.value }) : result;
      }
      case "rescheduling.menu.read.v1": {
        const turn = structuredClone(command.turn);
        const result = await this.reception.readReschedulingMenu(this.actor.scope, turn, command.stage, command.from, command.to, command.now, false, command.window);
        return result.ok ? ok({ kind: "appointmentChangeProposal", progress: commandProgress(result.value, turn.turnId) }) : result;
      }
      case "rescheduling.menu.select.v1": {
        const turn = structuredClone(command.turn);
        const result = await this.reception.selectReschedulingMenu(this.actor.scope, turn, command.stage, command.choice, command.now);
        return result.ok ? ok({ kind: "appointmentChangeProposal", progress: commandProgress(result.value, turn.turnId) }) : result;
      }
      case "booking.offers.read.v1": {
        const result = await this.reception.readBookingMenu(this.actor.scope, command.turn, command.from, command.to, command.now, command.window, command.preference);
        return result.ok ? ok({ kind: "bookingProposal", progress: commandProgress(result.value, command.turn.turnId) }) : result;
      }
      case "booking.offers.select.v1": {
        const result = await this.reception.selectBookingMenu(this.actor.scope, command.turn, command.choice, command.now);
        return result.ok ? ok({ kind: "bookingProposal", progress: commandProgress(result.value, command.turn.turnId) }) : result;
      }
      case "availability.read.v2": {
        if (!command.turn || !command.turn.turnId || !command.turn.callId || !command.turn.text ||
            typeof command.from !== "string" || typeof command.to !== "string" ||
            typeof command.now !== "string" || !Number.isFinite(Date.parse(command.now))) return err({ kind: "invalid" });
        const result = await this.reception.checkAvailability(this.actor.scope, command.turn, command.from, command.to, command.now);
        return result.ok ? ok({ kind: "availabilityAnswer", progress: commandProgress(result.value, command.turn.turnId) }) : result;
      }
      case "appointments.read.v1": {
        if (!command.turn || !command.turn.turnId || !command.turn.callId || !command.turn.text ||
            !command.verificationRef || command.verificationRef.length > 256 ||
            typeof command.from !== "string" || typeof command.to !== "string" ||
            typeof command.now !== "string" || !Number.isFinite(Date.parse(command.now))) return err({ kind: "invalid" });
        const result = await this.reception.checkAppointments(this.actor.scope, command.turn, command.verificationRef,
          command.from, command.to, command.now);
        return result.ok ? ok({ kind: "appointmentAnswer", progress: commandProgress(result.value, command.turn.turnId) }) : result;
      }
      case "calls.read.v1": {
        if (!this.review || !command.callId || command.callId.length > 256) return err({ kind: "invalid" });
        const result = await this.review.read(command.callId, this.actor.scope);
        return result.ok ? ok({ kind: "callSummary", call: result.value }) : result;
      }
      case "calls.outcomes.v1": {
        if (!this.outcomeReport || (command.afterCallId !== undefined &&
            (typeof command.afterCallId !== "string" || !command.afterCallId || command.afterCallId.length > 256))) return err({ kind: "invalid" });
        const result = await this.outcomeReport.list(this.actor.scope, command.afterCallId);
        return result.ok ? ok({ kind: "callOutcomes", page: result.value }) : result;
      }
      case "staff.list.v1": {
        if (!this.staffQueue || (command.afterTaskKey !== undefined &&
            (typeof command.afterTaskKey !== "string" || !command.afterTaskKey || command.afterTaskKey.length > 256))) return err({ kind: "invalid" });
        const result = await this.staffQueue.list(this.actor.scope, command.afterTaskKey);
        return result.ok ? ok({ kind: "staffQueue", page: result.value }) : result;
      }
      case "staff.health.v1": {
        if (!this.staffQueue) return err({ kind: "forbidden" });
        const result = await this.staffQueue.health(this.actor.scope);
        return result.ok ? ok({ kind: "staffQueueHealth", health: result.value }) : result;
      }
      case "operations.daily.v1": {
        if (!this.operationalDaily || this.actor.role !== "clinicAdmin") return err({ kind: "forbidden" });
        const daily = await this.operationalDaily.daily(this.actor.scope);
        return validOperationalDailyCounts(daily)
          ? ok({ kind: "operationalDaily", daily }) : err({ kind: "responseContractViolation" });
      }
      case "staff.change.v1": {
        if (!command.callId || command.callId.length > 256 || !command.taskKey || command.taskKey.length > 256 ||
            !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0 ||
            !command.change || !["acknowledge", "resolve", "reassign"].includes(command.change.kind) ||
            (command.change.kind === "reassign" && !["staff", "operator"].includes(command.change.target)) ||
            typeof command.now !== "string" || !Number.isFinite(Date.parse(command.now))) return err({ kind: "invalid" });
        const result = await this.reception.changeStaff(this.actor.scope, command.callId, command.expectedVersion,
          command.taskKey, this.actor.actorRef, command.change, command.now);
        if (!result.ok) return result;
        const item = result.value.staffItems[command.taskKey];
        return item ? ok({ kind: "staffChange", taskKey: item.key, callVersion: result.value.version,
          status: item.status, pending: !!item.pendingChangeKey, reviewRequired: !!item.reviewRequired })
          : err({ kind: "storageCorrupt" });
      }
    }
  }
}
