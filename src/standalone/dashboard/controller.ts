import { render } from "lit-html";
import type { DashboardFailure, DashboardPort } from "./api.ts";
import { dashboardView } from "./view.ts";
import type { DashboardState } from "./view.ts";
import type { StaffChangeRequest, StaffQueueEntry } from "../../core/model.ts";
import type { CallOutcomePage } from "../../reference/call-outcome-report.ts";

function appendOutcomes(previous: CallOutcomePage, next: CallOutcomePage): CallOutcomePage {
  return { rows: [...previous.rows, ...next.rows], totals: {
    calls: previous.totals.calls + next.totals.calls,
    committedActions: previous.totals.committedActions + next.totals.committedActions,
    callsWithUnresolvedActions: previous.totals.callsWithUnresolvedActions + next.totals.callsWithUnresolvedActions,
    callsWithStaffRequests: previous.totals.callsWithStaffRequests + next.totals.callsWithStaffRequests,
    callsWithHostConfirmedTasks: previous.totals.callsWithHostConfirmedTasks + next.totals.callsWithHostConfirmedTasks,
    callsWithStaffNeedsReview: previous.totals.callsWithStaffNeedsReview + next.totals.callsWithStaffNeedsReview,
    callsWithSystemFailure: previous.totals.callsWithSystemFailure + next.totals.callsWithSystemFailure,
  }, ...(next.nextAfterCallId === undefined ? {} : { nextAfterCallId: next.nextAfterCallId }) };
}

function message(failure: DashboardFailure): string {
  switch (failure.kind) {
    case "forbidden": return "You do not have permission to make this change.";
    case "versionConflict": return "Settings changed elsewhere. The current value has been reloaded.";
    case "callUnknown": return "Call not found for this clinic.";
    case "scopeMismatch": return "This call belongs to another clinic.";
    default: return "The request could not be completed. Please try again.";
  }
}

export class DashboardController {
  private readonly root: HTMLElement;
  private readonly port: DashboardPort;
  private readonly state: DashboardState = { loading: true, busy: false, capabilities: [], policy: undefined, callIdInput: "", call: undefined, staffPage: undefined, outcomePage: undefined, notice: undefined, error: undefined };

  constructor(root: HTMLElement, port: DashboardPort) {
    this.root = root;
    this.port = port;
    this.draw();
  }

  private draw(): void {
    render(dashboardView(this.state, {
      toggleBooking: () => { void this.toggleBooking(); },
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
