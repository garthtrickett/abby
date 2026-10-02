import { html } from "lit-html";
import type { CallPolicy, LocationScope } from "../../core/model.ts";
import { validStaffedDestinationCatalogue } from "../../core/staffed-destination.ts";
import type { StaffedDestinationAuditPage, StaffedDestinationCatalogue } from "../../core/staffed-destination.ts";
import type { CapabilityDescriptor } from "../../reference/command-gateway.ts";
import type { DashboardFailure, DashboardPort } from "./api.ts";

export type StaffedDestinationState = {
  catalogue: StaffedDestinationCatalogue | undefined;
  selected: string;
  audit: StaffedDestinationAuditPage | undefined;
  problem: string | undefined;
};
export function initialStaffedDestinationState(): StaffedDestinationState {
  return { catalogue: undefined, selected: "", audit: undefined, problem: undefined };
}
type Context = {
  staffedDestination: StaffedDestinationState;
  policy: CallPolicy | undefined;
  busy: boolean;
  capabilities: readonly CapabilityDescriptor[];
  notice: string | undefined;
  error: string | undefined;
};
type Port = Pick<DashboardPort, "settings" | "staffedDestinations" | "staffedDestinationAudit" | "changeStaffedDestination">;
const changeId = "settings.routing.staffedDestination.change.v1";
const optionsId = "settings.routing.staffedDestination.options.v1";
const auditId = "settings.routing.staffedDestination.audit.v1";
function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}
function validCurrentPolicy(policy: CallPolicy, scope: LocationScope): boolean {
  return sameScope(policy.scope, scope) && /^(0|[1-9][0-9]*)$/.test(policy.policyVersion) &&
    Number.isSafeInteger(Number(policy.policyVersion)) && ["execute", "requestOnly", "unavailable"].includes(policy.capabilities.transfer);
}

/** Owns only the staffed-route form and recovery; all setting edits share the parent policy and busy state. */
export class StaffedDestinationControl {
  private readonly context: Context;
  private readonly port: Port;
  private readonly draw: () => void;
  private readonly failureText: (failure: DashboardFailure) => string;

  constructor(context: Context, port: Port, draw: () => void, failureText: (failure: DashboardFailure) => string) {
    this.context = context; this.port = port; this.draw = draw; this.failureText = failureText;
  }

  readonly actions = {
    select: (ref: string) => { this.context.staffedDestination.selected = ref; this.draw(); },
    save: () => { void this.save(false); },
    clear: () => { void this.save(true); },
    refresh: () => { void this.refresh(); },
    loadMore: () => { void this.loadMore(); },
  };

  private permitted(id: string): boolean { return this.context.capabilities.some(item => item.id === id); }

  async initialize(): Promise<void> {
    const state = this.context.staffedDestination;
    state.catalogue = undefined;
    state.audit = undefined;
    state.problem = undefined;
    state.selected = this.context.policy?.transferDestinationRef ?? "";
    if (!this.permitted(optionsId)) return;
    const [catalogue, audit] = await Promise.all([this.port.staffedDestinations(), this.port.staffedDestinationAudit()]);
    if (catalogue.ok && this.context.policy && validStaffedDestinationCatalogue(catalogue.value, this.context.policy.scope)) {
      state.catalogue = catalogue.value;
    }
    if (audit.ok && this.permitted(auditId)) state.audit = audit.value;
    // An unconfigured host is an unavailable picker, not an error in unrelated settings.
  }

  private async readAudit(): Promise<void> {
    if (!this.permitted(auditId)) return;
    const audit = await this.port.staffedDestinationAudit();
    if (audit.ok) this.context.staffedDestination.audit = audit.value;
    else this.context.staffedDestination.problem = this.failureText(audit.error);
  }

  private async save(clear: boolean): Promise<void> {
    const current = this.context.policy;
    const state = this.context.staffedDestination;
    if (this.context.busy || !current || !validCurrentPolicy(current, current.scope) || !this.permitted(changeId)) return;
    if (!clear && (!state.catalogue || !validStaffedDestinationCatalogue(state.catalogue, current.scope) ||
        !state.catalogue.options.some(option => option.destinationRef === state.selected))) return;
    this.context.busy = true;
    this.context.error = undefined;
    this.context.notice = undefined;
    state.problem = undefined;
    this.draw();
    const result = await this.port.changeStaffedDestination(current.policyVersion, clear ? null : state.selected);
    if (result.ok && validCurrentPolicy(result.value, current.scope) && Number(result.value.policyVersion) > Number(current.policyVersion)) {
      this.context.policy = result.value;
      state.selected = result.value.transferDestinationRef ?? "";
      this.context.notice = clear ? "Transfer destination cleared for new calls." : "Transfer destination saved for new calls.";
      await this.readAudit();
    } else {
      state.problem = result.ok ? "The save reply could not be verified." : this.failureText(result.error);
      this.context.policy = undefined;
      const inspected = await this.port.settings();
      if (inspected.ok && validCurrentPolicy(inspected.value, current.scope)) {
        this.context.policy = inspected.value;
        state.selected = inspected.value.transferDestinationRef ?? "";
        await this.readAudit();
      } else state.problem = "The transfer destination could not be confirmed. Reload before editing settings.";
    }
    this.context.busy = false;
    this.draw();
  }

  private async refresh(): Promise<void> {
    if (this.context.busy || !this.permitted(optionsId)) return;
    const scope = this.context.policy?.scope ?? this.context.staffedDestination.catalogue?.scope;
    this.context.busy = true;
    this.draw();
    const inspected = await this.port.settings();
    this.context.policy = inspected.ok && validCurrentPolicy(inspected.value, scope ?? inspected.value.scope) ? inspected.value : undefined;
    await this.initialize();
    if (!this.context.policy) this.context.staffedDestination.problem = "The transfer destination could not be confirmed. Reload before editing settings.";
    this.context.busy = false;
    this.draw();
  }

  private async loadMore(): Promise<void> {
    const previous = this.context.staffedDestination.audit;
    if (this.context.busy || !previous || previous.nextAfterVersion === undefined || !this.permitted(auditId)) return;
    this.context.busy = true;
    this.draw();
    const result = await this.port.staffedDestinationAudit(previous.nextAfterVersion);
    if (result.ok) this.context.staffedDestination.audit = { ...result.value, entries: [...previous.entries, ...result.value.entries] };
    else this.context.staffedDestination.problem = this.failureText(result.error);
    this.context.busy = false;
    this.draw();
  }
}

export function staffedDestinationView(context: Context, actions: StaffedDestinationControl["actions"]) {
  const state = context.staffedDestination;
  const permitted = (id: string) => context.capabilities.some(item => item.id === id);
  const editable = permitted(changeId) && !!context.policy && validCurrentPolicy(context.policy, context.policy.scope);
  const knownCatalogue = state.catalogue && context.policy && validStaffedDestinationCatalogue(state.catalogue, context.policy.scope);
  const options = knownCatalogue ? state.catalogue!.options : [];
  const name = (ref: string | null | undefined) => ref ? options.find(option => option.destinationRef === ref)?.label ?? "Unavailable destination" : "Not set";
  const selectable = options.some(option => option.destinationRef === state.selected);
  return html`<section class="card" aria-labelledby="staffed-destination-title">
    <h2 id="staffed-destination-title">Staff transfer destination</h2>
    <p class="status">${context.policy ? context.policy.transferDestinationRef
      ? `Saved destination: ${name(context.policy.transferDestinationRef)}` : "No transfer destination saved." : "Transfer destination state unavailable."}</p>
    ${context.policy ? html`<p class="muted">${context.policy.capabilities.transfer === "execute"
      ? "Host permits live transfer. Approved staffed hours still apply." : context.policy.capabilities.transfer === "requestOnly"
        ? "Follow-up only; no live transfer." : "Live transfer unavailable."}</p>` : ""}
    <p class="muted">Changes affect new calls. Active calls keep their admitted destination.</p>
    ${permitted(changeId) ? html`<label>Approved staff destination
      <select aria-label="Approved staff destination" ?disabled=${context.busy || !editable || !options.length}
        @change=${(event: Event) => actions.select((event.target as HTMLSelectElement).value)}>
        <option value="" ?selected=${!selectable}>Choose a destination</option>
        ${options.map(option => html`<option value=${option.destinationRef} ?selected=${state.selected === option.destinationRef}>${option.label}</option>`)}
      </select></label>
      ${!knownCatalogue ? html`<p class="muted">Approved destinations unavailable.</p>` : options.length === 0 ? html`<p class="muted">No approved destinations available.</p>` : ""}
      <div class="row"><button type="button" ?disabled=${context.busy || !editable || !selectable} @click=${actions.save}>Save transfer destination</button>
      <button type="button" ?disabled=${context.busy || !editable || !context.policy?.transferDestinationRef} @click=${actions.clear}>Clear transfer destination</button>
      <button type="button" ?disabled=${context.busy} @click=${actions.refresh}>Refresh destinations and history</button></div>` : html`<span class="pill">View only</span>`}
    ${state.problem ? html`<p role="alert">${state.problem}</p>` : ""}
    ${permitted(auditId) ? html`<h3>Transfer destination history</h3><div aria-label="Transfer destination audit">
      ${state.audit ? state.audit.entries.length ? html`<ul>${state.audit.entries.map(entry => html`<li>Version ${entry.version} · ${name(entry.previousDestinationRef)} → ${name(entry.destinationRef)} · ${entry.actorRef} · ${entry.changedAt}</li>`)}</ul>`
        : html`<p>No transfer destination changes recorded.</p>` : html`<p class="muted">Transfer destination history unavailable.</p>`}
      ${state.audit?.nextAfterVersion !== undefined ? html`<button type="button" ?disabled=${context.busy} @click=${actions.loadMore}>Load more transfer history</button>` : ""}
    </div>` : ""}
  </section>`;
}
