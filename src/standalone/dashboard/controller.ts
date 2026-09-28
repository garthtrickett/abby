import { render } from "lit-html";
import type { DashboardFailure, DashboardPort } from "./api.ts";
import { dashboardView } from "./view.ts";
import type { DashboardState } from "./view.ts";

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
  private readonly state: DashboardState = { loading: true, busy: false, capabilities: [], policy: undefined, callIdInput: "", call: undefined, notice: undefined, error: undefined };

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
    }), this.root);
  }

  async load(): Promise<void> {
    const [capabilities, settings] = await Promise.all([this.port.capabilities(), this.port.settings()]);
    if (capabilities.ok) this.state.capabilities = capabilities.value;
    if (settings.ok) this.state.policy = settings.value;
    this.state.error = !settings.ok ? message(settings.error) : !capabilities.ok ? message(capabilities.error) : undefined;
    this.state.loading = false;
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
