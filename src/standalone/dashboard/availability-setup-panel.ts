import { html, render } from "lit-html";
import type { DashboardFailure, DashboardPort } from "./api.ts";
import type { ClinicAvailabilityApprovalState, ClinicAvailabilityBusinessCatalogue,
  ClinicAvailabilityRoute, ClinicAvailabilitySelection, ClinicAvailabilitySelectionSnapshot } from "../../reference/clinic-availability-setup.ts";

type SetupPort = Pick<DashboardPort, "capabilities" | "settings" | "availabilityBusinesses" |
  "availabilityInspect" | "availabilityApproval" | "approveAvailability" | "revokeAvailability">;
type Field = keyof ClinicAvailabilityRoute | keyof ClinicAvailabilitySelection;

function failureMessage(failure: DashboardFailure): string {
  switch (failure.kind) {
    case "credentialForbidden": return "Cliniko rejected this connection. Ask an administrator to check its API access.";
    case "catalogueRateLimited": return "Cliniko is rate limiting catalogue reads. Try again later.";
    case "versionConflict": return "This approval changed elsewhere. Check the current version before trying again.";
    case "commandOutcomeUnknown":
    case "responseContractViolation":
    case "transportUnavailable":
    case "storageFailure": return "The approval outcome is uncertain. Check the current state before trying again.";
    case "routeChanged": return "The number route changed. Check the account, number and route version.";
    case "policyChanged": return "The clinic policy changed. Reload before inspecting this selection again.";
    case "selectionUnavailable": return "This selection is no longer eligible for online availability.";
    case "scopeMismatch": return "The connection belongs to another clinic location.";
    case "forbidden": return "Clinic administrator access is required.";
    default: return "Clinic availability setup could not be completed. Check the selection and try again.";
  }
}

/** Browser-only reference setup. The host must authenticate the actor before constructing its gateway. */
export class AvailabilitySetupPanel {
  private readonly root: HTMLElement;
  private readonly port: SetupPort;
  private permitted = false;
  private busy = false;
  private catalogue: ClinicAvailabilityBusinessCatalogue | undefined;
  private approval: ClinicAvailabilityApprovalState | undefined;
  private snapshot: ClinicAvailabilitySelectionSnapshot | undefined;
  private route: ClinicAvailabilityRoute = { accountRef: "", dialedNumber: "", routeVersion: "" };
  private selection: ClinicAvailabilitySelection = { businessId: "", practitionerId: "", appointmentTypeId: "", policyVersion: "" };
  private confirmed = false;
  private notice: string | undefined;
  private error: string | undefined;

  constructor(root: HTMLElement, port: SetupPort) {
    this.root = root;
    this.port = port;
  }

  async load(): Promise<void> {
    const capabilities = await this.port.capabilities();
    this.permitted = capabilities.ok && capabilities.value.some(item => item.id === "clinic.availability.approval.change.v1");
    if (!this.permitted) return;
    const [settings, catalogue, approval] = await Promise.all([
      this.port.settings(), this.port.availabilityBusinesses(), this.port.availabilityApproval(),
    ]);
    if (settings.ok) this.selection = { ...this.selection, policyVersion: settings.value.policyVersion };
    else this.error = failureMessage(settings.error);
    if (catalogue.ok) this.catalogue = catalogue.value;
    else this.error = failureMessage(catalogue.error);
    if (approval.ok) {
      this.approval = approval.value;
      if (approval.value.approval) {
        this.route = { ...approval.value.approval.route };
        this.selection = { ...approval.value.approval.selection };
      }
    } else this.error = failureMessage(approval.error);
    if (!this.selection.businessId && this.catalogue?.businesses[0]) {
      this.selection = { ...this.selection, businessId: this.catalogue.businesses[0].businessId };
    }
    this.draw();
  }

  private setField(field: Field, value: string): void {
    if (field === "accountRef" || field === "dialedNumber" || field === "routeVersion") {
      this.route = { ...this.route, [field]: value };
    } else {
      this.selection = { ...this.selection, [field]: value };
      this.snapshot = undefined;
    }
    this.confirmed = false;
    this.draw();
  }

  private async inspect(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.error = undefined; this.notice = undefined; this.snapshot = undefined; this.draw();
    const result = await this.port.availabilityInspect(this.selection);
    if (result.ok) this.snapshot = result.value;
    else this.error = failureMessage(result.error);
    this.busy = false; this.draw();
  }

  private async change(action: "approve" | "revoke"): Promise<void> {
    if (this.busy || !this.approval || (action === "approve" && (!this.confirmed || this.snapshot?.status !== "candidate"))) return;
    this.busy = true; this.error = undefined; this.notice = undefined; this.draw();
    const result = action === "approve"
      ? await this.port.approveAvailability(this.route, this.selection, this.approval.version)
      : await this.port.revokeAvailability(this.approval.version);
    if (result.ok) {
      this.approval = result.value;
      this.notice = action === "approve" ? "Read-only route approval recorded. Calls recheck Cliniko before offering times." : "Availability approval revoked for new calls.";
    } else {
      this.error = failureMessage(result.error);
      const latest = await this.port.availabilityApproval();
      if (latest.ok) this.approval = latest.value;
      else {
        this.approval = undefined;
        this.error += " The approval state could not be refreshed; reload the page before continuing.";
      }
    }
    this.confirmed = false; this.snapshot = undefined; this.busy = false; this.draw();
  }

  private draw(): void {
    if (!this.permitted) return;
    const approved = this.approval?.approval;
    render(html`<section class="card" aria-labelledby="availability-setup-title">
      <h2 id="availability-setup-title">Read-only availability setup</h2>
      <p class="muted">Approve one clinic route for provisional times. Booking, patient details and staff requests stay unavailable.</p>
      <p class="status" aria-label="Availability approval status">${approved
        ? `Stored approval: ${approved.selection.businessId} / ${approved.selection.practitionerId} / ${approved.selection.appointmentTypeId} · version ${this.approval?.version}`
        : `No approved availability route · version ${this.approval?.version ?? "unknown"}`}</p>
      ${approved ? html`<p class="muted">Number ${approved.route.dialedNumber} · route ${approved.route.routeVersion} · approved by ${approved.approvedBy}</p>` : ""}
      <label>Cliniko business <select aria-label="Cliniko business"
        @change=${(event: Event) => this.setField("businessId", (event.target as HTMLSelectElement).value)}>
        ${this.catalogue?.businesses.map(business => html`<option value=${business.businessId} ?selected=${business.businessId === this.selection.businessId}>${business.name} (${business.businessId})${business.archived ? " · archived" : ""}${business.onlineBooking ? "" : " · online booking off"}</option>`) ?? ""}
      </select></label>
      <label>Practitioner ID <input aria-label="Practitioner ID" .value=${this.selection.practitionerId}
        @input=${(event: Event) => this.setField("practitionerId", (event.target as HTMLInputElement).value)}></label>
      <label>Appointment type ID <input aria-label="Appointment type ID" .value=${this.selection.appointmentTypeId}
        @input=${(event: Event) => this.setField("appointmentTypeId", (event.target as HTMLInputElement).value)}></label>
      <p class="muted">Clinic policy version ${this.selection.policyVersion || "unavailable"}</p>
      <button type="button" ?disabled=${this.busy || !this.catalogue || !this.selection.policyVersion} @click=${() => { void this.inspect(); }}>Inspect selection</button>
      ${this.snapshot ? html`<div aria-label="Availability selection inspection">
        <p>${this.snapshot.businessName} · ${this.snapshot.practitionerName} · ${this.snapshot.appointmentTypeName}</p>
        <p>${this.snapshot.status === "candidate" ? "Eligible candidate for read-only availability" : `Unavailable: ${this.snapshot.reasons.join(", ")}`}</p>
        <p>Clinic time zone: ${this.snapshot.timeZone ?? "unknown"} · checked ${this.snapshot.observedAt}</p>
      </div>` : ""}
      <label>Route account reference <input aria-label="Route account reference" .value=${this.route.accountRef}
        @input=${(event: Event) => this.setField("accountRef", (event.target as HTMLInputElement).value)}></label>
      <label>Dialed number <input aria-label="Dialed number" .value=${this.route.dialedNumber}
        @input=${(event: Event) => this.setField("dialedNumber", (event.target as HTMLInputElement).value)}></label>
      <label>Route version <input aria-label="Route version" .value=${this.route.routeVersion}
        @input=${(event: Event) => this.setField("routeVersion", (event.target as HTMLInputElement).value)}></label>
      <label class="confirmation"><input type="checkbox" .checked=${this.confirmed}
        @change=${(event: Event) => { this.confirmed = (event.target as HTMLInputElement).checked; this.draw(); }}>
        I approve this route for provisional availability only.</label>
      <div class="lookup"><button type="button" ?disabled=${this.busy || !this.confirmed || this.snapshot?.status !== "candidate" || !this.approval}
        @click=${() => { void this.change("approve"); }}>Approve read-only route</button>
        <button type="button" ?disabled=${this.busy || !approved} @click=${() => { void this.change("revoke"); }}>Revoke availability route</button></div>
      ${this.notice ? html`<p role="status">${this.notice}</p>` : ""}
      ${this.error ? html`<p role="alert" class="error">${this.error}</p>` : ""}
    </section>`, this.root);
  }
}
