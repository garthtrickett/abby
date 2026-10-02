import type { ClinicIntakeAuditPage } from "../../core/clinic-intake-setting.ts";
import { validStaffedDestinationCatalogue, validStaffedDestinationRef } from "../../core/staffed-destination.ts";
import type { StaffedDestinationAuditPage, StaffedDestinationCatalogue } from "../../core/staffed-destination.ts";
import { CALL_TERMINAL_REASONS, err, ok } from "../../core/model.ts";
import type { AfterHoursMode, CallPolicy, LocalStaffWindow, Result, StaffChangeRequest, StaffQueueEntry } from "../../core/model.ts";
import { validAfterHoursSetting } from "../../core/after-hours-policy.ts";
import { validGreetingShape } from "../../core/greeting.ts";
import { validApprovedStaffSchedule } from "../../core/staff-schedule.ts";
import { validUrgentResponseShape } from "../../core/urgent-response.ts";
import type { AfterHoursSettingAuditPage, AutomationSettingAuditPage, BookingSettingAuditPage, GreetingSettingAuditPage, StaffScheduleSettingAuditPage, UrgentSettingAuditPage } from "../../core/host.ts";
import type { CallSummary } from "../../reference/call-review.ts";
import type { CapabilityDescriptor, GatewayCommand, GatewayFailure, GatewayReply } from "../../reference/command-gateway.ts";
import { capabilityDescriptor } from "../../reference/capability-catalogue.ts";
import { matchesSchema } from "../../reference/schema-shapes.ts";
import type { CancellationSettingAuditPage, ReschedulingSettingAuditPage } from "../../core/host.ts";
import type { ClinicAvailabilityApprovalState, ClinicAvailabilityBusinessCatalogue,
  ClinicAvailabilityRoute, ClinicAvailabilitySelection, ClinicAvailabilitySelectionSnapshot,
  ClinicAvailabilityPractitionerCatalogue, ClinicAvailabilityTypeCatalogue } from "../../reference/clinic-availability-setup.ts";
import type { StaffQueuePage } from "../../reference/staff-queue.ts";
import type { CallOutcomePage } from "../../reference/call-outcome-report.ts";
import type { WriteStopAuditPage, WriteStopStatus } from "../../core/write-stop.ts";
import type { KnowledgeEntry } from "../../reference/knowledge-catalogue.ts";

export type DashboardFailure = GatewayFailure | Readonly<{ kind: "transportUnavailable" | "malformed" }>;
export type DashboardPort = Readonly<{
  capabilities(): Promise<Result<readonly CapabilityDescriptor[], DashboardFailure>>;
  settings(): Promise<Result<CallPolicy, DashboardFailure>>;
  staffedDestinations(): Promise<Result<StaffedDestinationCatalogue, DashboardFailure>>;
  staffedDestinationAudit(afterVersion?: number): Promise<Result<StaffedDestinationAuditPage, DashboardFailure>>;
  changeStaffedDestination(expectedVersion: string, destinationRef: string | null): Promise<Result<CallPolicy, DashboardFailure>>;
  knowledge(): Promise<Result<readonly KnowledgeEntry[], DashboardFailure>>;
  saveKnowledgeDraft(input: Pick<KnowledgeEntry, "sourceRef" | "ownerRef" | "text" | "effectiveFrom" | "effectiveUntil"> & { expectedVersion: string }): Promise<Result<KnowledgeEntry, DashboardFailure>>;
  approveKnowledge(sourceRef: string, expectedVersion: string): Promise<Result<KnowledgeEntry, DashboardFailure>>;
  revokeKnowledge(sourceRef: string, expectedVersion: string): Promise<Result<KnowledgeEntry, DashboardFailure>>;
  automationAudit(afterVersion?: number): Promise<Result<AutomationSettingAuditPage, DashboardFailure>>;
  changeAutomationEnabled(expectedVersion: string, enabled: boolean): Promise<Result<CallPolicy, DashboardFailure>>;
  readWriteStop(afterEffectId?: string): Promise<Result<WriteStopStatus, DashboardFailure>>;
  stopWrites(reason: string): Promise<Result<WriteStopStatus, DashboardFailure>>;
  resumeWrites(expectedVersion: string, reason: string): Promise<Result<WriteStopStatus, DashboardFailure>>;
  writeStopAudit(afterVersion?: number): Promise<Result<WriteStopAuditPage, DashboardFailure>>;
  bookingAudit(afterVersion?: number): Promise<Result<BookingSettingAuditPage, DashboardFailure>>;
  changeBookingEnabled(expectedVersion: string, enabled: boolean): Promise<Result<CallPolicy, DashboardFailure>>;
  cancellationAudit(afterVersion?: number): Promise<Result<CancellationSettingAuditPage, DashboardFailure>>;
  reschedulingAudit(afterVersion?: number): Promise<Result<ReschedulingSettingAuditPage, DashboardFailure>>;
  firstTimeIntakeAudit(afterVersion?: number): Promise<Result<ClinicIntakeAuditPage, DashboardFailure>>;
  changeCancellationEnabled(expectedVersion: string, enabled: boolean): Promise<Result<CallPolicy, DashboardFailure>>;
  changeReschedulingEnabled(expectedVersion: string, enabled: boolean): Promise<Result<CallPolicy, DashboardFailure>>;
  changeFirstTimeIntakeEnabled(expectedVersion: string, enabled: boolean): Promise<Result<CallPolicy, DashboardFailure>>;
  afterHoursAudit(afterVersion?: number): Promise<Result<AfterHoursSettingAuditPage, DashboardFailure>>;
  changeAfterHours(expectedVersion: string, mode: AfterHoursMode, infoVersion?: string, approvedText?: string): Promise<Result<CallPolicy, DashboardFailure>>;
  urgentAudit(afterVersion?: number): Promise<Result<UrgentSettingAuditPage, DashboardFailure>>;
  changeUrgentResponse(expectedVersion: string, script?: Readonly<{ version: string; approvedText: string;
    effectiveFrom: string; effectiveUntil: string }>): Promise<Result<CallPolicy, DashboardFailure>>;
  staffScheduleAudit(afterVersion?: number): Promise<Result<StaffScheduleSettingAuditPage, DashboardFailure>>;
  changeStaffSchedule(expectedVersion: string, schedule?: Readonly<{ version: string; effectiveFrom: string;
    effectiveUntil: string; timeZone: string; weekly: readonly LocalStaffWindow[]; closedDates: readonly string[] }>):
    Promise<Result<CallPolicy, DashboardFailure>>;
  greetingAudit(afterVersion?: number): Promise<Result<GreetingSettingAuditPage, DashboardFailure>>;
  changeGreeting(expectedVersion: string, greeting?: Readonly<{ version: string; approvedText: string;
    effectiveFrom: string; effectiveUntil: string }>): Promise<Result<CallPolicy, DashboardFailure>>;
  callSummary(callId: string): Promise<Result<CallSummary, DashboardFailure>>;
  callOutcomes(afterCallId?: string): Promise<Result<CallOutcomePage, DashboardFailure>>;
  staffQueue(afterTaskKey?: string): Promise<Result<StaffQueuePage, DashboardFailure>>;
  changeStaff(item: StaffQueueEntry, change: StaffChangeRequest): Promise<Result<void, DashboardFailure>>;
  availabilityBusinesses(): Promise<Result<ClinicAvailabilityBusinessCatalogue, DashboardFailure>>;
  availabilityPractitioners(businessId: string): Promise<Result<ClinicAvailabilityPractitionerCatalogue, DashboardFailure>>;
  availabilityTypes(businessId: string, practitionerId: string): Promise<Result<ClinicAvailabilityTypeCatalogue, DashboardFailure>>;
  availabilityInspect(selection: ClinicAvailabilitySelection): Promise<Result<ClinicAvailabilitySelectionSnapshot, DashboardFailure>>;
  availabilityApproval(): Promise<Result<ClinicAvailabilityApprovalState, DashboardFailure>>;
  checkAvailabilityRoute(): Promise<Result<true, DashboardFailure>>;
  approveAvailability(route: ClinicAvailabilityRoute, selection: ClinicAvailabilitySelection, expectedVersion: number):
    Promise<Result<ClinicAvailabilityApprovalState, DashboardFailure>>;
  approveAvailabilityAlternatives(route: ClinicAvailabilityRoute, selection: ClinicAvailabilitySelection,
    alternatives: readonly ClinicAvailabilitySelection[], expectedVersion: number):
    Promise<Result<ClinicAvailabilityApprovalState, DashboardFailure>>;
  revokeAvailability(expectedVersion: number): Promise<Result<ClinicAvailabilityApprovalState, DashboardFailure>>;
}>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validKnowledgeEntry(value: unknown): boolean {
  const entry = record(value);
  const scope = record(entry?.scope);
  return !!entry && !!scope && [scope.tenantId, scope.clinicId, scope.locationId, entry.sourceRef, entry.version,
    entry.ownerRef, entry.text, entry.actorRef, entry.changedAt].every(item => typeof item === "string" && !!item) &&
    ["draft", "approved", "revoked"].includes(String(entry.status)) &&
    typeof entry.effectiveFrom === "string" && typeof entry.effectiveUntil === "string" &&
    Number.isFinite(Date.parse(entry.effectiveFrom)) && Number.isFinite(Date.parse(entry.effectiveUntil));
}

async function knowledgeChange(path: string, input: object): Promise<Result<KnowledgeEntry, DashboardFailure>> {
  const result = await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  if (!result.ok) return result;
  const reply = record(result.value);
  return reply?.kind === "knowledgeEntry" && validKnowledgeEntry(reply.entry)
    ? ok(reply.entry as KnowledgeEntry) : err({ kind: "malformed" });
}

async function request(path: string, init?: RequestInit): Promise<Result<unknown, DashboardFailure>> {
  try {
    const response = await fetch(path, init);
    const data = record(await response.json() as unknown);
    if (!data) return err({ kind: "malformed" });
    if (data.ok === false) {
      const failure = record(data.error);
      return typeof failure?.kind === "string" ? err(failure as DashboardFailure) : err({ kind: "malformed" });
    }
    return data.ok === true ? ok(data.value) : err({ kind: "malformed" });
  } catch {
    return err({ kind: "transportUnavailable" });
  }
}

type AvailabilityCommand = Extract<GatewayCommand, { kind: `clinic.availability.${string}` }>;
async function availabilityCommand<K extends GatewayReply["kind"]>(command: AvailabilityCommand, replyKind: K):
  Promise<Result<Extract<GatewayReply, { kind: K }>, DashboardFailure>> {
  const result = await request("/api/clinic-availability/command", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
  if (!result.ok) return result;
  if (!matchesSchema(capabilityDescriptor(command.kind).resultSchema, { ok: true, value: result.value }) ||
      record(result.value)?.kind !== replyKind) return err({ kind: "malformed" });
  return ok(result.value as Extract<GatewayReply, { kind: K }>);
}

function policy(value: unknown): Result<CallPolicy, DashboardFailure> {
  const reply = record(value);
  const current = record(reply?.policy);
  return reply?.kind === "settings" && current && typeof current.policyVersion === "string" && typeof current.automationVersion === "string" && typeof current.automationEnabled === "boolean" && typeof current.bookingEnabled === "boolean" && record(current.capabilities)
    && (current.cancellationEnabled === undefined || typeof current.cancellationEnabled === "boolean")
    && (current.reschedulingEnabled === undefined || typeof current.reschedulingEnabled === "boolean")
    && (current.transferDestinationRef === undefined || validStaffedDestinationRef(current.transferDestinationRef))
    && (current.transferDestinationVersion === undefined || validStaffedDestinationRef(current.transferDestinationVersion))
    && (current.firstTimeIntakeEnabled === undefined || typeof current.firstTimeIntakeEnabled === "boolean")
    && (current.firstTimeIntakeVersion === undefined || (typeof current.firstTimeIntakeVersion === "string" && /^(0|[1-9][0-9]*)$/.test(current.firstTimeIntakeVersion)))
    && record(current.scope) && validAfterHoursSetting(current.afterHoursMode ?? "staffRequest", current.afterHoursInfo,
      current.scope as CallPolicy["scope"]) &&
      (current.urgentResponse === undefined || validUrgentResponseShape(current.urgentResponse, current.scope as CallPolicy["scope"])) &&
      (current.staffSchedule === undefined || validApprovedStaffSchedule(current.staffSchedule, current.scope as CallPolicy["scope"])) &&
      (current.greeting === undefined || validGreetingShape(current.greeting, current.scope as CallPolicy["scope"]))
    ? ok(current as CallPolicy) : err({ kind: "malformed" });
}

function writeStop(value: unknown): Result<WriteStopStatus, DashboardFailure> {
  const reply = record(value);
  const status = record(reply?.status);
  if (reply?.kind !== "writeStop" || !status || typeof status.stopped !== "boolean" ||
      typeof status.version !== "string" || !/^(0|[1-9][0-9]*)$/.test(status.version) || !Array.isArray(status.inFlight) ||
      (status.nextAfterEffectId !== undefined && (typeof status.nextAfterEffectId !== "string" || !status.nextAfterEffectId)) ||
      !status.inFlight.every(item => {
        const row = record(item);
        return row && typeof row.effectId === "string" && !!row.effectId && typeof row.callId === "string" && !!row.callId &&
          typeof row.actionKey === "string" && !!row.actionKey && ["possiblySent", "uncertain"].includes(String(row.status));
      })) return err({ kind: "malformed" });
  if (status.version === "0" ? status.stopped || status.inFlight.length > 0 || status.actorRef !== undefined || status.reason !== undefined || status.changedAt !== undefined
    : typeof status.actorRef !== "string" || !status.actorRef || typeof status.reason !== "string" || !status.reason ||
      typeof status.changedAt !== "string" || !Number.isFinite(Date.parse(status.changedAt)) || (!status.stopped && status.inFlight.length > 0)) return err({ kind: "malformed" });
  return ok(status as WriteStopStatus);
}

export class FetchDashboardPort implements DashboardPort {
  async staffedDestinations(): Promise<Result<StaffedDestinationCatalogue, DashboardFailure>> {
    const result = await request("/api/settings/staffed-destination-options");
    if (!result.ok) return result;
    if (!matchesSchema(capabilityDescriptor("settings.routing.staffedDestination.options.v1").resultSchema,
      { ok: true, value: result.value })) return err({ kind: "malformed" });
    const reply = result.value as Extract<GatewayReply, { kind: "staffedDestinationOptions" }>;
    return validStaffedDestinationCatalogue(reply.catalogue, reply.catalogue.scope) ? ok(reply.catalogue) : err({ kind: "malformed" });
  }

  async staffedDestinationAudit(afterVersion?: number): Promise<Result<StaffedDestinationAuditPage, DashboardFailure>> {
    const result = await request(`/api/settings/staffed-destination-audit${afterVersion === undefined ? "" : `?after=${afterVersion}`}`);
    if (!result.ok) return result;
    if (!matchesSchema(capabilityDescriptor("settings.routing.staffedDestination.audit.v1").resultSchema,
      { ok: true, value: result.value })) return err({ kind: "malformed" });
    const reply = result.value as Extract<GatewayReply, { kind: "staffedDestinationSettingAudit" }>;
    if (reply.page.entries.some(entry => !/^(0|[1-9][0-9]*)$/.test(entry.version) || !Number.isFinite(Date.parse(entry.changedAt)) ||
        !validStaffedDestinationRef(entry.actorRef) ||
        (entry.destinationRef !== null && !validStaffedDestinationRef(entry.destinationRef)) ||
        (entry.previousDestinationRef !== null && !validStaffedDestinationRef(entry.previousDestinationRef)))) return err({ kind: "malformed" });
    return ok(reply.page);
  }

  async changeStaffedDestination(expectedVersion: string, destinationRef: string | null): Promise<Result<CallPolicy, DashboardFailure>> {
    const result = await request("/api/settings/staffed-destination", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion, destinationRef }) });
    return result.ok ? policy(result.value) : result;
  }

  async availabilityBusinesses(): Promise<Result<ClinicAvailabilityBusinessCatalogue, DashboardFailure>> {
    const result = await availabilityCommand({ kind: "clinic.availability.businesses.list.v1" }, "clinicAvailabilityBusinesses");
    return result.ok ? ok(result.value.catalogue) : result;
  }

  async availabilityPractitioners(businessId: string): Promise<Result<ClinicAvailabilityPractitionerCatalogue, DashboardFailure>> {
    const result = await availabilityCommand({ kind: "clinic.availability.practitioners.list.v1", businessId }, "clinicAvailabilityPractitioners");
    return result.ok ? ok(result.value.catalogue) : result;
  }

  async availabilityTypes(businessId: string, practitionerId: string): Promise<Result<ClinicAvailabilityTypeCatalogue, DashboardFailure>> {
    const result = await availabilityCommand({ kind: "clinic.availability.types.list.v1", businessId, practitionerId }, "clinicAvailabilityTypes");
    return result.ok ? ok(result.value.catalogue) : result;
  }

  async availabilityInspect(selection: ClinicAvailabilitySelection): Promise<Result<ClinicAvailabilitySelectionSnapshot, DashboardFailure>> {
    const result = await availabilityCommand({ kind: "clinic.availability.selection.inspect.v1", selection }, "clinicAvailabilitySelection");
    return result.ok ? ok(result.value.snapshot) : result;
  }

  async availabilityApproval(): Promise<Result<ClinicAvailabilityApprovalState, DashboardFailure>> {
    const result = await availabilityCommand({ kind: "clinic.availability.approval.read.v1" }, "clinicAvailabilityApprovalState");
    return result.ok ? ok(result.value.state) : result;
  }

  async checkAvailabilityRoute(): Promise<Result<true, DashboardFailure>> {
    const result = await availabilityCommand({ kind: "clinic.availability.route.check.v1" }, "clinicAvailabilityRouteCheck");
    return result.ok ? ok(result.value.eligible) : result;
  }

  async approveAvailability(route: ClinicAvailabilityRoute, selection: ClinicAvailabilitySelection, expectedVersion: number):
    Promise<Result<ClinicAvailabilityApprovalState, DashboardFailure>> {
    const result = await availabilityCommand({ kind: "clinic.availability.approval.change.v1", route, selection, expectedVersion },
      "clinicAvailabilityApprovalState");
    return result.ok ? ok(result.value.state) : result;
  }

  async approveAvailabilityAlternatives(route: ClinicAvailabilityRoute, selection: ClinicAvailabilitySelection,
    alternatives: readonly ClinicAvailabilitySelection[], expectedVersion: number):
    Promise<Result<ClinicAvailabilityApprovalState, DashboardFailure>> {
    const result = await availabilityCommand({ kind: "clinic.availability.approval.change.v2",
      route, selection, alternatives, expectedVersion }, "clinicAvailabilityApprovalState");
    return result.ok ? ok(result.value.state) : result;
  }

  async revokeAvailability(expectedVersion: number): Promise<Result<ClinicAvailabilityApprovalState, DashboardFailure>> {
    const result = await availabilityCommand({ kind: "clinic.availability.approval.revoke.v1", expectedVersion },
      "clinicAvailabilityApprovalState");
    return result.ok ? ok(result.value.state) : result;
  }

  async knowledge(): Promise<Result<readonly KnowledgeEntry[], DashboardFailure>> {
    const result = await request("/api/knowledge");
    if (!result.ok) return result;
    const reply = record(result.value);
    if (reply?.kind !== "knowledgeList" || !Array.isArray(reply.entries) ||
        !reply.entries.every(entry => validKnowledgeEntry(entry))) return err({ kind: "malformed" });
    return ok(reply.entries as readonly KnowledgeEntry[]);
  }

  async saveKnowledgeDraft(input: Pick<KnowledgeEntry, "sourceRef" | "ownerRef" | "text" | "effectiveFrom" | "effectiveUntil"> & { expectedVersion: string }): Promise<Result<KnowledgeEntry, DashboardFailure>> {
    return knowledgeChange("/api/knowledge/draft", input);
  }

  async approveKnowledge(sourceRef: string, expectedVersion: string): Promise<Result<KnowledgeEntry, DashboardFailure>> {
    return knowledgeChange("/api/knowledge/approve", { sourceRef, expectedVersion });
  }

  async revokeKnowledge(sourceRef: string, expectedVersion: string): Promise<Result<KnowledgeEntry, DashboardFailure>> {
    return knowledgeChange("/api/knowledge/revoke", { sourceRef, expectedVersion });
  }

  async capabilities(): Promise<Result<readonly CapabilityDescriptor[], DashboardFailure>> {
    const result = await request("/api/capabilities");
    if (!result.ok) return result;
    if (!Array.isArray(result.value) || !result.value.every(item => typeof record(item)?.id === "string")) return err({ kind: "malformed" });
    return ok(result.value as readonly CapabilityDescriptor[]);
  }

  async settings(): Promise<Result<CallPolicy, DashboardFailure>> {
    const result = await request("/api/settings");
    return result.ok ? policy(result.value) : result;
  }

  async automationAudit(afterVersion?: number): Promise<Result<AutomationSettingAuditPage, DashboardFailure>> {
    const result = await request(`/api/settings/automation-audit${afterVersion === undefined ? "" : `?after=${afterVersion}`}`);
    if (!result.ok) return result;
    const reply = record(result.value);
    const page = record(reply?.page);
    if (reply?.kind !== "automationSettingAudit" || !page || !Array.isArray(page.entries) ||
        (page.nextAfterVersion !== undefined && (!Number.isSafeInteger(page.nextAfterVersion) || Number(page.nextAfterVersion) < 0)) ||
        !page.entries.every(value => {
          const entry = record(value);
          return entry && typeof entry.version === "string" && /^(0|[1-9][0-9]*)$/.test(entry.version) &&
            typeof entry.enabled === "boolean" && typeof entry.previousEnabled === "boolean" &&
            typeof entry.actorRef === "string" && !!entry.actorRef &&
            typeof entry.changedAt === "string" && Number.isFinite(Date.parse(entry.changedAt));
        })) return err({ kind: "malformed" });
    return ok(page as AutomationSettingAuditPage);
  }

  async changeAutomationEnabled(expectedVersion: string, enabled: boolean): Promise<Result<CallPolicy, DashboardFailure>> {
    const result = await request("/api/settings/automation-enabled", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion, enabled }),
    });
    return result.ok ? policy(result.value) : result;
  }

  async readWriteStop(afterEffectId?: string): Promise<Result<WriteStopStatus, DashboardFailure>> {
    const result = await request(`/api/writes/stop${afterEffectId === undefined ? "" : `?after=${encodeURIComponent(afterEffectId)}`}`);
    return result.ok ? writeStop(result.value) : result;
  }

  async stopWrites(reason: string): Promise<Result<WriteStopStatus, DashboardFailure>> {
    const result = await request("/api/writes/stop", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }) });
    return result.ok ? writeStop(result.value) : result;
  }

  async resumeWrites(expectedVersion: string, reason: string): Promise<Result<WriteStopStatus, DashboardFailure>> {
    const result = await request("/api/writes/resume", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion, reason }) });
    return result.ok ? writeStop(result.value) : result;
  }

  async writeStopAudit(afterVersion?: number): Promise<Result<WriteStopAuditPage, DashboardFailure>> {
    const result = await request(`/api/writes/stop-audit${afterVersion === undefined ? "" : `?after=${afterVersion}`}`);
    if (!result.ok) return result;
    const reply = record(result.value);
    const page = record(reply?.page);
    if (reply?.kind !== "writeStopAudit" || !page || !Array.isArray(page.entries) ||
        (page.nextAfterVersion !== undefined && (!Number.isSafeInteger(page.nextAfterVersion) || Number(page.nextAfterVersion) < 0)) ||
        !page.entries.every(value => {
          const entry = record(value);
          return entry && typeof entry.version === "string" && /^[1-9][0-9]*$/.test(entry.version) &&
            typeof entry.stopped === "boolean" && typeof entry.actorRef === "string" && !!entry.actorRef &&
            typeof entry.reason === "string" && !!entry.reason && typeof entry.changedAt === "string" && Number.isFinite(Date.parse(entry.changedAt));
        })) return err({ kind: "malformed" });
    return ok(page as WriteStopAuditPage);
  }

  async bookingAudit(afterVersion?: number): Promise<Result<BookingSettingAuditPage, DashboardFailure>> {
    const result = await request(`/api/settings/booking-audit${afterVersion === undefined ? "" : `?after=${afterVersion}`}`);
    if (!result.ok) return result;
    const reply = record(result.value);
    const page = record(reply?.page);
    if (reply?.kind !== "bookingSettingAudit" || !page || !Array.isArray(page.entries) ||
        (page.nextAfterVersion !== undefined && (!Number.isSafeInteger(page.nextAfterVersion) || Number(page.nextAfterVersion) < 0)) ||
        !page.entries.every(value => {
          const entry = record(value);
          return entry && typeof entry.version === "string" && /^(0|[1-9][0-9]*)$/.test(entry.version) &&
            typeof entry.enabled === "boolean" && (entry.provenance === "recorded"
              ? typeof entry.actorRef === "string" && !!entry.actorRef && typeof entry.previousEnabled === "boolean" &&
                typeof entry.changedAt === "string" && Number.isFinite(Date.parse(entry.changedAt))
              : entry.provenance === "legacyUnattributed" && entry.actorRef === undefined &&
                entry.previousEnabled === undefined && entry.changedAt === undefined);
        })) return err({ kind: "malformed" });
    return ok(page as BookingSettingAuditPage);
  }

  async changeBookingEnabled(expectedVersion: string, enabled: boolean): Promise<Result<CallPolicy, DashboardFailure>> {
    const result = await request("/api/settings/booking-enabled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion, enabled }),
    });
    return result.ok ? policy(result.value) : result;
  }

  async cancellationAudit(afterVersion?: number): Promise<Result<CancellationSettingAuditPage, DashboardFailure>> {
    const result = await request(`/api/settings/cancellation-audit${afterVersion === undefined ? "" : `?after=${afterVersion}`}`);
    if (!result.ok) return result;
    if (!matchesSchema(capabilityDescriptor("settings.appointments.cancellation.audit.v1").resultSchema,
      { ok: true, value: result.value })) return err({ kind: "malformed" });
    const reply = result.value as Extract<GatewayReply, { kind: "cancellationSettingAudit" }>;
    if (reply.page.entries.some(entry => !/^(0|[1-9][0-9]*)$/.test(entry.version) ||
        !Number.isFinite(Date.parse(entry.changedAt)))) return err({ kind: "malformed" });
    return ok(reply.page);
  }

  async changeCancellationEnabled(expectedVersion: string, enabled: boolean): Promise<Result<CallPolicy, DashboardFailure>> {
    const result = await request("/api/settings/cancellation-enabled", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion, enabled }) });
    return result.ok ? policy(result.value) : result;
  }

  async reschedulingAudit(afterVersion?: number): Promise<Result<ReschedulingSettingAuditPage, DashboardFailure>> {
    const result = await request(`/api/settings/rescheduling-audit${afterVersion === undefined ? "" : `?after=${afterVersion}`}`);
    if (!result.ok) return result;
    if (!matchesSchema(capabilityDescriptor("settings.appointments.rescheduling.audit.v1").resultSchema,
      { ok: true, value: result.value })) return err({ kind: "malformed" });
    const reply = result.value as Extract<GatewayReply, { kind: "reschedulingSettingAudit" }>;
    if (reply.page.entries.some(entry => !/^(0|[1-9][0-9]*)$/.test(entry.version) ||
        !Number.isFinite(Date.parse(entry.changedAt)))) return err({ kind: "malformed" });
    return ok(reply.page);
  }

  async changeReschedulingEnabled(expectedVersion: string, enabled: boolean): Promise<Result<CallPolicy, DashboardFailure>> {
    const result = await request("/api/settings/rescheduling-enabled", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion, enabled }) });
    return result.ok ? policy(result.value) : result;
  }

  async firstTimeIntakeAudit(afterVersion?: number): Promise<Result<ClinicIntakeAuditPage, DashboardFailure>> {
    const result = await request(`/api/settings/first-time-intake-audit${afterVersion === undefined ? "" : `?after=${afterVersion}`}`);
    if (!result.ok) return result;
    if (!matchesSchema(capabilityDescriptor("settings.patients.firstTimeIntake.audit.v1").resultSchema,
      { ok: true, value: result.value })) return err({ kind: "malformed" });
    const reply = result.value as Extract<GatewayReply, { kind: "firstTimeIntakeSettingAudit" }>;
    if (reply.page.entries.some(entry => !/^(0|[1-9][0-9]*)$/.test(entry.version) ||
        !Number.isFinite(Date.parse(entry.changedAt)))) return err({ kind: "malformed" });
    return ok(reply.page);
  }

  async changeFirstTimeIntakeEnabled(expectedVersion: string, enabled: boolean): Promise<Result<CallPolicy, DashboardFailure>> {
    const result = await request("/api/settings/first-time-intake-enabled", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion, enabled }) });
    return result.ok ? policy(result.value) : result;
  }

  async afterHoursAudit(afterVersion?: number): Promise<Result<AfterHoursSettingAuditPage, DashboardFailure>> {
    const result = await request(`/api/settings/after-hours-audit${afterVersion === undefined ? "" : `?after=${afterVersion}`}`);
    if (!result.ok) return result;
    const reply = record(result.value);
    const page = record(reply?.page);
    if (reply?.kind !== "afterHoursSettingAudit" || !page || !Array.isArray(page.entries) ||
        (page.nextAfterVersion !== undefined && (!Number.isSafeInteger(page.nextAfterVersion) || Number(page.nextAfterVersion) < 0)) ||
        !page.entries.every(value => {
          const entry = record(value);
          return entry && typeof entry.version === "string" && /^(0|[1-9][0-9]*)$/.test(entry.version) &&
            ["staffRequest", "approvedInfoAndRequest"].includes(String(entry.mode)) &&
            ["staffRequest", "approvedInfoAndRequest"].includes(String(entry.previousMode)) &&
            (entry.infoVersion === undefined || (typeof entry.infoVersion === "string" && !!entry.infoVersion)) &&
            typeof entry.actorRef === "string" && !!entry.actorRef &&
            typeof entry.changedAt === "string" && Number.isFinite(Date.parse(entry.changedAt));
        })) return err({ kind: "malformed" });
    return ok(page as AfterHoursSettingAuditPage);
  }

  async changeAfterHours(expectedVersion: string, mode: AfterHoursMode, infoVersion?: string,
                         approvedText?: string): Promise<Result<CallPolicy, DashboardFailure>> {
    const result = await request("/api/settings/after-hours", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion, mode, ...(infoVersion === undefined ? {} : { infoVersion }),
        ...(approvedText === undefined ? {} : { approvedText }) }) });
    return result.ok ? policy(result.value) : result;
  }

  async urgentAudit(afterVersion?: number): Promise<Result<UrgentSettingAuditPage, DashboardFailure>> {
    const result = await request(`/api/settings/urgent-audit${afterVersion === undefined ? "" : `?after=${afterVersion}`}`);
    if (!result.ok) return result;
    const valid = matchesSchema(capabilityDescriptor("settings.routing.urgent.audit.v1").resultSchema,
      { ok: true, value: result.value });
    const reply = record(result.value);
    return valid && reply?.kind === "urgentSettingAudit" ? ok(reply.page as UrgentSettingAuditPage) : err({ kind: "malformed" });
  }

  async changeUrgentResponse(expectedVersion: string, script?: Readonly<{ version: string; approvedText: string;
    effectiveFrom: string; effectiveUntil: string }>): Promise<Result<CallPolicy, DashboardFailure>> {
    const result = await request("/api/settings/urgent", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion, enabled: script !== undefined,
        ...(script === undefined ? {} : { scriptVersion: script.version, approvedText: script.approvedText,
          effectiveFrom: script.effectiveFrom, effectiveUntil: script.effectiveUntil }) }),
    });
    return result.ok ? policy(result.value) : result;
  }

  async staffScheduleAudit(afterVersion?: number): Promise<Result<StaffScheduleSettingAuditPage, DashboardFailure>> {
    const result = await request(`/api/settings/staff-schedule-audit${afterVersion === undefined ? "" : `?after=${afterVersion}`}`);
    if (!result.ok) return result;
    const valid = matchesSchema(capabilityDescriptor("settings.routing.staffSchedule.audit.v1").resultSchema,
      { ok: true, value: result.value });
    const reply = record(result.value);
    return valid && reply?.kind === "staffScheduleSettingAudit"
      ? ok(reply.page as StaffScheduleSettingAuditPage) : err({ kind: "malformed" });
  }

  async changeStaffSchedule(expectedVersion: string, schedule?: Readonly<{ version: string; effectiveFrom: string;
    effectiveUntil: string; timeZone: string; weekly: readonly LocalStaffWindow[]; closedDates: readonly string[] }>):
    Promise<Result<CallPolicy, DashboardFailure>> {
    const result = await request("/api/settings/staff-schedule", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "settings.routing.staffSchedule.change.v1", expectedVersion,
        enabled: schedule !== undefined,
        ...(schedule === undefined ? {} : { scheduleVersion: schedule.version,
          effectiveFrom: schedule.effectiveFrom, effectiveUntil: schedule.effectiveUntil,
          timeZone: schedule.timeZone, weekly: schedule.weekly, closedDates: schedule.closedDates }) }),
    });
    return result.ok ? policy(result.value) : result;
  }

  async greetingAudit(afterVersion?: number): Promise<Result<GreetingSettingAuditPage, DashboardFailure>> {
    const result = await request(`/api/settings/greeting-audit${afterVersion === undefined ? "" : `?after=${afterVersion}`}`);
    if (!result.ok) return result;
    const valid = matchesSchema(capabilityDescriptor("settings.routing.greeting.audit.v1").resultSchema,
      { ok: true, value: result.value });
    const reply = record(result.value);
    return valid && reply?.kind === "greetingSettingAudit"
      ? ok(reply.page as GreetingSettingAuditPage) : err({ kind: "malformed" });
  }

  async changeGreeting(expectedVersion: string, greeting?: Readonly<{ version: string; approvedText: string;
    effectiveFrom: string; effectiveUntil: string }>): Promise<Result<CallPolicy, DashboardFailure>> {
    const result = await request("/api/settings/greeting", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "settings.routing.greeting.change.v1", expectedVersion,
        enabled: greeting !== undefined,
        ...(greeting === undefined ? {} : { greetingVersion: greeting.version, approvedText: greeting.approvedText,
          effectiveFrom: greeting.effectiveFrom, effectiveUntil: greeting.effectiveUntil }) }),
    });
    return result.ok ? policy(result.value) : result;
  }

  async callSummary(callId: string): Promise<Result<CallSummary, DashboardFailure>> {
    const result = await request(`/api/calls/${encodeURIComponent(callId)}`);
    if (!result.ok) return result;
    const reply = record(result.value);
    const call = record(reply?.call);
    const terminal = record(call?.terminal);
    return reply?.kind === "callSummary" && call && call.callId === callId &&
      (call.lifecycle === "starting" || call.lifecycle === "active" || call.lifecycle === "ended") &&
      (call.terminal === undefined || (terminal && call.lifecycle === "ended" &&
        CALL_TERMINAL_REASONS.includes(terminal.reason as typeof CALL_TERMINAL_REASONS[number]) &&
        typeof terminal.at === "string" && Number.isFinite(Date.parse(terminal.at)))) &&
      Array.isArray(call.actions) && Array.isArray(call.staffItems)
      ? ok(call as CallSummary) : err({ kind: "malformed" });
  }

  async callOutcomes(afterCallId?: string): Promise<Result<CallOutcomePage, DashboardFailure>> {
    const result = await request(`/api/call-outcomes${afterCallId === undefined ? "" : `?after=${encodeURIComponent(afterCallId)}`}`);
    if (!result.ok) return result;
    const reply = record(result.value);
    const page = record(reply?.page);
    const totals = record(page?.totals);
    const keys = ["calls", "committedActions", "callsWithUnresolvedActions", "callsWithStaffRequests",
      "callsWithHostConfirmedTasks", "callsWithStaffNeedsReview", "callsWithSystemFailure", "callsWithCallerDisconnect",
      "callsWithMediaFailure", "callsWithLeaseExpiry", "callsWithTransferConnected"];
    if (reply?.kind !== "callOutcomes" || !page || !totals || !Array.isArray(page.rows) ||
        !keys.every(key => Number.isSafeInteger(totals[key]) && Number(totals[key]) >= 0) ||
        (page.nextAfterCallId !== undefined && typeof page.nextAfterCallId !== "string") ||
        !page.rows.every(value => {
          const row = record(value);
          return row && typeof row.callId === "string" && ["starting", "active", "ended"].includes(String(row.lifecycle)) &&
            (row.terminalReason === undefined || CALL_TERMINAL_REASONS.includes(row.terminalReason as typeof CALL_TERMINAL_REASONS[number])) &&
            ["committedActions", "unresolvedActions", "staffRequests", "hostConfirmedTasks", "staffNeedsReview"]
              .every(key => Number.isSafeInteger(row[key]) && Number(row[key]) >= 0) && typeof row.systemFailure === "boolean";
        })) return err({ kind: "malformed" });
    return ok(page as CallOutcomePage);
  }

  async staffQueue(afterTaskKey?: string): Promise<Result<StaffQueuePage, DashboardFailure>> {
    const result = await request(`/api/staff${afterTaskKey === undefined ? "" : `?after=${encodeURIComponent(afterTaskKey)}`}`);
    if (!result.ok) return result;
    const reply = record(result.value);
    const page = record(reply?.page);
    return reply?.kind === "staffQueue" && page && Array.isArray(page.items) && page.items.every(item => {
      const entry = record(item);
      return entry && typeof entry.callId === "string" && Number.isSafeInteger(entry.callVersion) && typeof entry.taskKey === "string" &&
        typeof entry.reason === "string" && typeof entry.status === "string" && typeof entry.dueAt === "string" &&
        typeof entry.overdue === "boolean" && (entry.alerts === undefined || (() => {
          const alerts = record(entry.alerts);
          return alerts && Object.keys(alerts).every(key => key === "overdue" || key === "needsReview") &&
            Object.values(alerts).every(status => ["pending", "delivered", "uncertain", "failed", "canceled"].includes(String(status)));
        })());
    }) && (page.nextAfterTaskKey === undefined || typeof page.nextAfterTaskKey === "string")
      ? ok(page as StaffQueuePage) : err({ kind: "malformed" });
  }

  async changeStaff(item: StaffQueueEntry, change: StaffChangeRequest): Promise<Result<void, DashboardFailure>> {
    const result = await request("/api/staff/change", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callId: item.callId, taskKey: item.taskKey, expectedVersion: item.callVersion, change }) });
    if (!result.ok) return result;
    const reply = record(result.value);
    return reply?.kind === "staffChange" && reply.taskKey === item.taskKey && Number.isSafeInteger(reply.callVersion) &&
      typeof reply.status === "string" && typeof reply.pending === "boolean" && typeof reply.reviewRequired === "boolean"
      ? ok(undefined) : err({ kind: "malformed" });
  }
}
