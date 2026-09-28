import { render } from "lit-html";
import type { DashboardFailure, DashboardPort } from "./api.ts";
import { dashboardView } from "./view.ts";
import type { DashboardState } from "./view.ts";
import type { StaffChangeRequest, StaffQueueEntry } from "../../core/model.ts";
import type { CallOutcomePage } from "../../reference/call-outcome-report.ts";
import type { BookingSettingAuditPage } from "../../core/host.ts";
import type { AutomationSettingAuditPage } from "../../core/host.ts";
import { READINESS_REQUIREMENTS } from "../../core/readiness.ts";
import type { ReadinessRequirement } from "../../core/readiness.ts";
import type { WriteStopAuditPage, WriteStopStatus } from "../../core/write-stop.ts";
import type { KnowledgeEntry } from "../../reference/knowledge-catalogue.ts";

function appendAudit(previous: BookingSettingAuditPage, next: BookingSettingAuditPage): BookingSettingAuditPage {
  return { entries: [...previous.entries, ...next.entries],
    ...(next.nextAfterVersion === undefined ? {} : { nextAfterVersion: next.nextAfterVersion }) };
}

function appendAutomationAudit(previous: AutomationSettingAuditPage, next: AutomationSettingAuditPage): AutomationSettingAuditPage {
  return { entries: [...previous.entries, ...next.entries],
    ...(next.nextAfterVersion === undefined ? {} : { nextAfterVersion: next.nextAfterVersion }) };
}

function appendOutcomes(previous: CallOutcomePage, next: CallOutcomePage): CallOutcomePage {
  return { rows: [...previous.rows, ...next.rows], totals: {
    calls: previous.totals.calls + next.totals.calls,
    committedActions: previous.totals.committedActions + next.totals.committedActions,
    callsWithUnresolvedActions: previous.totals.callsWithUnresolvedActions + next.totals.callsWithUnresolvedActions,
    callsWithStaffRequests: previous.totals.callsWithStaffRequests + next.totals.callsWithStaffRequests,
    callsWithHostConfirmedTasks: previous.totals.callsWithHostConfirmedTasks + next.totals.callsWithHostConfirmedTasks,
    callsWithStaffNeedsReview: previous.totals.callsWithStaffNeedsReview + next.totals.callsWithStaffNeedsReview,
    callsWithSystemFailure: previous.totals.callsWithSystemFailure + next.totals.callsWithSystemFailure,
    callsWithCallerDisconnect: previous.totals.callsWithCallerDisconnect + next.totals.callsWithCallerDisconnect,
    callsWithMediaFailure: previous.totals.callsWithMediaFailure + next.totals.callsWithMediaFailure,
    callsWithLeaseExpiry: previous.totals.callsWithLeaseExpiry + next.totals.callsWithLeaseExpiry,
    callsWithTransferConnected: previous.totals.callsWithTransferConnected + next.totals.callsWithTransferConnected,
  }, ...(next.nextAfterCallId === undefined ? {} : { nextAfterCallId: next.nextAfterCallId }) };
}

function message(failure: DashboardFailure): string {
  switch (failure.kind) {
    case "forbidden": return "You do not have permission to make this change.";
    case "versionConflict": return "Settings changed elsewhere. The current value has been reloaded.";
    case "callUnknown": return "Call not found for this clinic.";
    case "scopeMismatch": return "This call belongs to another clinic.";
    case "readinessFailed": {
      const labels: Record<typeof READINESS_REQUIREMENTS[number], string> = {
        hostPermissions: "host permissions", selectedLocation: "a selected location", approvedKnowledge: "approved clinic information",
        bookableOffers: "booking setup", staffDestination: "staff destination", afterHoursDestination: "after-hours destination",
        notificationOwner: "notification owner", fallbackRoute: "tested fallback route", mediaTestCall: "passed media test call",
      };
      const missing = Array.isArray(failure.missing) ? failure.missing.filter((item): item is ReadinessRequirement =>
        READINESS_REQUIREMENTS.includes(item as ReadinessRequirement)) : [];
      return `Clinic setup incomplete: ${missing.map(item => labels[item]).join(", ") || "readiness evidence"}.`;
    }
    default: return "The request could not be completed. Please try again.";
  }
}

export class DashboardController {
  private readonly root: HTMLElement;
  private readonly port: DashboardPort;
  private readonly state: DashboardState = { loading: true, busy: false, capabilities: [], policy: undefined,
    knowledge: undefined, knowledgeSourceRef: "", knowledgeOwnerRef: "", knowledgeText: "",
    knowledgeFrom: new Date().toISOString(), knowledgeUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    writeStop: undefined, stopReasonInput: "", auditPage: undefined,
    writeStopAuditPage: undefined, automationAuditPage: undefined, callIdInput: "", call: undefined, staffPage: undefined, outcomePage: undefined, notice: undefined, error: undefined };

  constructor(root: HTMLElement, port: DashboardPort) {
    this.root = root;
    this.port = port;
    this.draw();
  }

  private draw(): void {
    render(dashboardView(this.state, {
      setKnowledgeField: (field, value) => { this.state[field] = value; },
      saveKnowledgeDraft: () => { void this.saveKnowledgeDraft(); },
      approveKnowledge: entry => { void this.changeKnowledgeApproval(entry, "approve"); },
      revokeKnowledge: entry => { void this.changeKnowledgeApproval(entry, "revoke"); },
      setStopReason: value => { this.state.stopReasonInput = value; this.draw(); },
      stopWrites: () => { void this.stopWrites(); },
      resumeWrites: () => { void this.resumeWrites(); },
      loadMoreStoppedWrites: () => { void this.loadMoreStoppedWrites(); },
      loadMoreWriteStopAudit: () => { void this.loadMoreWriteStopAudit(); },
      toggleAutomation: () => { void this.toggleAutomation(); },
      loadAutomationAudit: () => { void this.loadAutomationAudit(); },
      loadMoreAutomationAudit: () => { void this.loadMoreAutomationAudit(); },
      toggleBooking: () => { void this.toggleBooking(); },
      loadAudit: () => { void this.loadAudit(); },
      loadMoreAudit: () => { void this.loadMoreAudit(); },
      setCallId: value => { this.state.callIdInput = value; },
      loadCall: () => { void this.loadCall(); },
      loadStaff: () => { void this.loadStaff(); },
      loadMoreStaff: () => { void this.loadMoreStaff(); },
      loadOutcomes: () => { void this.loadOutcomes(); },
      loadMoreOutcomes: () => { void this.loadMoreOutcomes(); },
      changeStaff: (item, change) => { void this.changeStaff(item, change); },
    }), this.root);
  }

  async load(): Promise<void> {
    const [capabilities, settings] = await Promise.all([this.port.capabilities(), this.port.settings()]);
    if (capabilities.ok) this.state.capabilities = capabilities.value;
    if (settings.ok) this.state.policy = settings.value;
    this.state.error = !settings.ok ? message(settings.error) : !capabilities.ok ? message(capabilities.error) : undefined;
    if (capabilities.ok && capabilities.value.some(item => item.id === "knowledge.list.v1")) {
      const knowledge = await this.port.knowledge();
      if (knowledge.ok) this.state.knowledge = knowledge.value;
      else this.state.error = message(knowledge.error);
    }
    if (capabilities.ok && capabilities.value.some(item => item.id === "calls.writes.stop.read.v1")) {
      const stop = await this.port.readWriteStop();
      if (stop.ok) this.state.writeStop = stop.value;
      else this.state.error = message(stop.error);
    }
    if (capabilities.ok && capabilities.value.some(item => item.id === "calls.writes.stop.audit.v1")) {
      const audit = await this.port.writeStopAudit();
      if (audit.ok) this.state.writeStopAuditPage = audit.value;
      else this.state.error = message(audit.error);
    }
    if (capabilities.ok && capabilities.value.some(item => item.id === "settings.automation.audit.v1")) {
      const audit = await this.port.automationAudit();
      if (audit.ok) this.state.automationAuditPage = audit.value;
      else this.state.error = message(audit.error);
    }
    if (capabilities.ok && capabilities.value.some(item => item.id === "settings.appointments.booking.audit.v1")) {
      const audit = await this.port.bookingAudit();
      if (audit.ok) this.state.auditPage = audit.value;
      else this.state.error = message(audit.error);
    }
    if (capabilities.ok && capabilities.value.some(item => item.id === "staff.list.v1")) {
      const queue = await this.port.staffQueue();
      if (queue.ok) this.state.staffPage = queue.value;
      else this.state.error = message(queue.error);
    }
    if (capabilities.ok && capabilities.value.some(item => item.id === "calls.outcomes.v1")) {
      const outcomes = await this.port.callOutcomes();
      if (outcomes.ok) this.state.outcomePage = outcomes.value;
      else this.state.error = message(outcomes.error);
    }
    this.state.loading = false;
    this.draw();
  }

  private async refreshKnowledge(): Promise<void> {
    const result = await this.port.knowledge();
    if (result.ok) this.state.knowledge = result.value;
    else this.state.error = message(result.error);
  }

  private async saveKnowledgeDraft(): Promise<void> {
    if (this.state.busy || !this.state.capabilities.some(item => item.id === "knowledge.draft.save.v1")) return;
    const sourceRef = this.state.knowledgeSourceRef.trim();
    const latest = this.state.knowledge?.filter(entry => entry.sourceRef === sourceRef).at(-1);
    this.state.busy = true;
    this.state.error = undefined;
    this.state.notice = undefined;
    this.draw();
    const result = await this.port.saveKnowledgeDraft({ sourceRef, expectedVersion: latest?.version ?? "0",
      ownerRef: this.state.knowledgeOwnerRef.trim(), text: this.state.knowledgeText.trim(),
      effectiveFrom: this.state.knowledgeFrom.trim(), effectiveUntil: this.state.knowledgeUntil.trim() });
    if (result.ok) this.state.notice = `Draft ${result.value.sourceRef} saved as version ${result.value.version}. Approval is required.`;
    else this.state.error = result.error.kind === "versionConflict" ? "Knowledge changed elsewhere. The list was refreshed." : message(result.error);
    await this.refreshKnowledge();
    this.state.busy = false;
    this.draw();
  }

  private async changeKnowledgeApproval(entry: KnowledgeEntry, action: "approve" | "revoke"): Promise<void> {
    if (this.state.busy || !this.state.capabilities.some(item => item.id === `knowledge.${action}.v1`)) return;
    this.state.busy = true;
    this.state.error = undefined;
    this.state.notice = undefined;
    this.draw();
    const result = action === "approve"
      ? await this.port.approveKnowledge(entry.sourceRef, entry.version)
      : await this.port.revokeKnowledge(entry.sourceRef, entry.version);
    if (result.ok) this.state.notice = `${entry.sourceRef} ${action === "approve" ? "approved" : "revoked"}.`;
    else this.state.error = result.error.kind === "versionConflict" ? "Knowledge changed elsewhere. The list was refreshed." : message(result.error);
    await this.refreshKnowledge();
    this.state.busy = false;
    this.draw();
  }

  private async loadAudit(): Promise<void> {
    if (this.state.busy) return;
    this.state.busy = true;
    this.state.error = undefined;
    this.draw();
    const result = await this.port.bookingAudit();
    if (result.ok) this.state.auditPage = result.value;
    else this.state.error = message(result.error);
    this.state.busy = false;
    this.draw();
  }

  private async loadAutomationAudit(): Promise<void> {
    if (this.state.busy) return;
    this.state.busy = true;
    this.state.error = undefined;
    this.draw();
    const result = await this.port.automationAudit();
    if (result.ok) this.state.automationAuditPage = result.value;
    else this.state.error = message(result.error);
    this.state.busy = false;
    this.draw();
  }

  private async stopWrites(): Promise<void> {
    if (this.state.busy || this.state.writeStop?.stopped || !this.state.capabilities.some(item => item.id === "calls.writes.stop.v1")) return;
    const reason = this.state.stopReasonInput.trim();
    if (!reason) { this.state.error = "Enter a reason for the emergency stop."; this.draw(); return; }
    this.state.busy = true;
    this.state.error = undefined;
    this.draw();
    const result = await this.port.stopWrites(reason);
    if (result.ok) {
      this.state.writeStop = result.value;
      this.state.stopReasonInput = "";
      this.state.notice = "Appointment writes stopped for this clinic. Review any writes already in flight.";
      const audit = await this.port.writeStopAudit();
      if (audit.ok) this.state.writeStopAuditPage = audit.value;
      else this.state.error = message(audit.error);
    } else this.state.error = message(result.error);
    this.state.busy = false;
    this.draw();
  }

  private async resumeWrites(): Promise<void> {
    const current = this.state.writeStop;
    if (this.state.busy || !current?.stopped || !this.state.capabilities.some(item => item.id === "calls.writes.resume.v1")) return;
    const reason = this.state.stopReasonInput.trim();
    if (!reason) { this.state.error = "Enter a reason for resuming appointment writes."; this.draw(); return; }
    this.state.busy = true;
    this.state.error = undefined;
    this.state.notice = undefined;
    this.draw();
    const result = await this.port.resumeWrites(current.version, reason);
    if (result.ok) {
      this.state.writeStop = result.value;
      this.state.stopReasonInput = "";
      this.state.notice = "Appointment writes resumed for this clinic after readiness passed.";
      const audit = await this.port.writeStopAudit();
      if (audit.ok) this.state.writeStopAuditPage = audit.value;
      else this.state.error = message(audit.error);
    } else {
      this.state.error = message(result.error);
      if (result.error.kind === "versionConflict") {
        const reloaded = await this.port.readWriteStop();
        if (reloaded.ok) this.state.writeStop = reloaded.value;
      }
    }
    this.state.busy = false;
    this.draw();
  }

  private async loadMoreWriteStopAudit(): Promise<void> {
    const previous = this.state.writeStopAuditPage;
    if (this.state.busy || previous?.nextAfterVersion === undefined) return;
    this.state.busy = true;
    this.state.error = undefined;
    this.draw();
    const result = await this.port.writeStopAudit(previous.nextAfterVersion);
    if (result.ok) this.state.writeStopAuditPage = { entries: [...previous.entries, ...result.value.entries],
      ...(result.value.nextAfterVersion === undefined ? {} : { nextAfterVersion: result.value.nextAfterVersion }) } satisfies WriteStopAuditPage;
    else this.state.error = message(result.error);
    this.state.busy = false;
    this.draw();
  }

  private async loadMoreStoppedWrites(): Promise<void> {
    const previous = this.state.writeStop;
    if (this.state.busy || !previous?.nextAfterEffectId) return;
    this.state.busy = true;
    this.state.error = undefined;
    this.draw();
    const result = await this.port.readWriteStop(previous.nextAfterEffectId);
    if (result.ok && result.value.version === previous.version && result.value.stopped) {
      this.state.writeStop = { ...result.value, inFlight: [...previous.inFlight, ...result.value.inFlight] } satisfies WriteStopStatus;
    } else if (result.ok) {
      this.state.writeStop = result.value;
      this.state.error = "Write-stop status changed while loading. The current status was reloaded.";
    } else this.state.error = message(result.error);
    this.state.busy = false;
    this.draw();
  }

  private async loadMoreAutomationAudit(): Promise<void> {
    const previous = this.state.automationAuditPage;
    if (this.state.busy || previous?.nextAfterVersion === undefined) return;
    this.state.busy = true;
    this.state.error = undefined;
    this.draw();
    const result = await this.port.automationAudit(previous.nextAfterVersion);
    if (result.ok) this.state.automationAuditPage = appendAutomationAudit(previous, result.value);
    else this.state.error = message(result.error);
    this.state.busy = false;
    this.draw();
  }

  private async loadMoreAudit(): Promise<void> {
    const previous = this.state.auditPage;
    if (this.state.busy || previous?.nextAfterVersion === undefined) return;
    this.state.busy = true;
    this.state.error = undefined;
    this.draw();
    const result = await this.port.bookingAudit(previous.nextAfterVersion);
    if (result.ok) this.state.auditPage = appendAudit(previous, result.value);
    else this.state.error = message(result.error);
    this.state.busy = false;
    this.draw();
  }

  private async loadOutcomes(): Promise<void> {
    if (this.state.busy) return;
    this.state.busy = true;
    this.state.error = undefined;
    this.draw();
    const result = await this.port.callOutcomes();
    if (result.ok) this.state.outcomePage = result.value;
    else this.state.error = message(result.error);
    this.state.busy = false;
    this.draw();
  }

  private async loadMoreOutcomes(): Promise<void> {
    const previous = this.state.outcomePage;
    if (this.state.busy || !previous?.nextAfterCallId) return;
    this.state.busy = true;
    this.state.error = undefined;
    this.draw();
    const result = await this.port.callOutcomes(previous.nextAfterCallId);
    if (result.ok) this.state.outcomePage = appendOutcomes(previous, result.value);
    else this.state.error = message(result.error);
    this.state.busy = false;
    this.draw();
  }

  private async loadStaff(): Promise<void> {
    if (this.state.busy) return;
    this.state.busy = true;
    this.state.error = undefined;
    this.draw();
    const result = await this.port.staffQueue();
    if (result.ok) this.state.staffPage = result.value;
    else this.state.error = message(result.error);
    this.state.busy = false;
    this.draw();
  }

  private async loadMoreStaff(): Promise<void> {
    const previous = this.state.staffPage;
    if (this.state.busy || !previous?.nextAfterTaskKey) return;
    this.state.busy = true;
    this.state.error = undefined;
    this.draw();
    const result = await this.port.staffQueue(previous.nextAfterTaskKey);
    if (result.ok) this.state.staffPage = { items: [...previous.items, ...result.value.items],
      ...(result.value.nextAfterTaskKey === undefined ? {} : { nextAfterTaskKey: result.value.nextAfterTaskKey }) };
    else this.state.error = message(result.error);
    this.state.busy = false;
    this.draw();
  }

  private async changeStaff(item: StaffQueueEntry, change: StaffChangeRequest): Promise<void> {
    if (this.state.busy || !this.state.capabilities.some(capability => capability.id === "staff.change.v1")) return;
    this.state.busy = true;
    this.state.error = undefined;
    this.state.notice = undefined;
    this.draw();
    const result = await this.port.changeStaff(item, change);
    if (!result.ok) this.state.error = result.error.kind === "versionConflict"
      ? "Follow-up changed elsewhere. The queue was refreshed." : message(result.error);
    else this.state.notice = "Follow-up command recorded. Check its queue status.";
    const refreshed = await this.port.staffQueue();
    if (refreshed.ok) this.state.staffPage = refreshed.value;
    else this.state.error = message(refreshed.error);
    this.state.busy = false;
    this.draw();
  }

  private async toggleBooking(): Promise<void> {
    const current = this.state.policy;
    if (this.state.busy || !current || !this.state.capabilities.some(item => item.id === "settings.appointments.booking.enabled.change.v1")) return;
    this.state.busy = true;
    this.state.error = undefined;
    this.state.notice = undefined;
    this.draw();
    const result = await this.port.changeBookingEnabled(current.policyVersion, !current.bookingEnabled);
    if (result.ok) {
      this.state.policy = result.value;
      this.state.notice = result.value.bookingEnabled ? "Booking enabled for new calls." : "Booking disabled for new calls.";
      const audit = await this.port.bookingAudit();
      if (audit.ok) this.state.auditPage = audit.value;
      else this.state.error = message(audit.error);
    } else {
      this.state.error = message(result.error);
      if (result.error.kind === "versionConflict") {
        const reloaded = await this.port.settings();
        if (reloaded.ok) this.state.policy = reloaded.value;
      }
    }
    this.state.busy = false;
    this.draw();
  }

  private async toggleAutomation(): Promise<void> {
    const current = this.state.policy;
    if (this.state.busy || !current || !this.state.capabilities.some(item => item.id === "settings.automation.enabled.change.v1")) return;
    this.state.busy = true;
    this.state.error = undefined;
    this.state.notice = undefined;
    this.draw();
    const result = await this.port.changeAutomationEnabled(current.automationVersion, !current.automationEnabled);
    if (result.ok) {
      this.state.policy = result.value;
      this.state.notice = result.value.automationEnabled ? "Reception automation enabled for new calls." : "Reception automation disabled for new calls.";
      const audit = await this.port.automationAudit();
      if (audit.ok) this.state.automationAuditPage = audit.value;
      else this.state.error = message(audit.error);
    } else {
      this.state.error = message(result.error);
      if (result.error.kind === "versionConflict") {
        const reloaded = await this.port.settings();
        if (reloaded.ok) this.state.policy = reloaded.value;
      }
    }
    this.state.busy = false;
    this.draw();
  }

  private async loadCall(): Promise<void> {
    if (this.state.busy) return;
    const callId = this.state.callIdInput.trim();
    if (!callId) { this.state.error = "Enter a call ID."; this.draw(); return; }
    this.state.busy = true;
    this.state.call = undefined;
    this.state.error = undefined;
    this.state.notice = undefined;
    this.draw();
    const result = await this.port.callSummary(callId);
    if (result.ok) this.state.call = result.value;
    else this.state.error = message(result.error);
    this.state.busy = false;
    this.draw();
  }
}
