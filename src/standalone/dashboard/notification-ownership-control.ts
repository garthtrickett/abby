import { html } from "lit-html";
import { NOTIFICATION_KINDS, NOTIFICATION_LABELS, validNotificationCatalogue, validNotificationSettings } from "../../core/notification-policy.ts";
import type { NotificationAuditPage, NotificationCatalogue, NotificationKind, NotificationOwner } from "../../core/notification-policy.ts";
import type { CallPolicy, LocationScope } from "../../core/model.ts";
import type { CapabilityDescriptor } from "../../reference/command-gateway.ts";
import type { DashboardFailure, DashboardPort } from "./api.ts";

export type NotificationOwnershipState = {
  catalogue: NotificationCatalogue | undefined;
  selected: Record<NotificationKind, NotificationOwner | "">;
  audit: NotificationAuditPage | undefined;
  problem: string | undefined;
};
export function initialNotificationOwnershipState(): NotificationOwnershipState {
  return { catalogue: undefined, selected: { bookingConfirmation: "", cancellationConfirmation: "", reschedulingConfirmation: "" },
    audit: undefined, problem: undefined };
}
type Context = {
  notifications: NotificationOwnershipState;
  policy: CallPolicy | undefined;
  busy: boolean;
  capabilities: readonly CapabilityDescriptor[];
  notice: string | undefined;
  error: string | undefined;
};
type Port = Pick<DashboardPort, "settings" | "notificationOptions" | "notificationAudit" | "changeNotificationOwner">;
const changeId = "settings.notifications.owner.change.v1";
const optionsId = "settings.notifications.options.v1";
const auditId = "settings.notifications.audit.v1";
function validCurrentPolicy(policy: CallPolicy, scope: LocationScope): boolean {
  return policy.scope.tenantId === scope.tenantId && policy.scope.clinicId === scope.clinicId &&
    policy.scope.locationId === scope.locationId && validNotificationSettings(policy.notificationSettings);
}
const ownerName = (owner: NotificationOwner | null | undefined) => owner === "abby" ? "Abby" : owner === "host" ? "Host" : "Not set";

/** Clinic ownership, recovery and history share the dashboard's policy and mutation lock. */
export class NotificationOwnershipControl {
  private readonly context: Context;
  private readonly port: Port;
  private readonly draw: () => void;
  private readonly failureText: (failure: DashboardFailure) => string;
  constructor(context: Context, port: Port, draw: () => void, failureText: (failure: DashboardFailure) => string) {
    this.context = context; this.port = port; this.draw = draw; this.failureText = failureText;
  }
  readonly actions = {
    select: (kind: NotificationKind, value: string) => {
      if (value === "host" || value === "abby" || value === "") this.context.notifications.selected[kind] = value;
      this.draw();
    },
    save: (kind: NotificationKind) => { void this.save(kind, false); },
    clear: (kind: NotificationKind) => { void this.save(kind, true); },
    refresh: () => { void this.refresh(); },
    loadMore: () => { void this.loadMore(); },
  };
  private permitted(id: string): boolean { return this.context.capabilities.some(item => item.id === id); }
  private syncSelections(): void {
    for (const kind of NOTIFICATION_KINDS) this.context.notifications.selected[kind] = this.context.policy?.notificationSettings?.owners[kind] ?? "";
  }
  async initialize(): Promise<void> {
    const state = this.context.notifications;
    state.catalogue = undefined; state.audit = undefined; state.problem = undefined;
    this.syncSelections();
    if (!this.permitted(optionsId)) return;
    try {
      const [catalogue, audit] = await Promise.all([this.port.notificationOptions(), this.port.notificationAudit()]);
      if (catalogue.ok && this.context.policy && validNotificationCatalogue(catalogue.value, this.context.policy.scope)) state.catalogue = catalogue.value;
      if (audit.ok && this.permitted(auditId)) state.audit = audit.value;
    } catch { state.problem = "Notification setup could not be loaded."; }
  }
  private async readAudit(): Promise<void> {
    if (!this.permitted(auditId)) return;
    try {
      const audit = await this.port.notificationAudit();
      if (audit.ok) this.context.notifications.audit = audit.value;
      else this.context.notifications.problem = this.failureText(audit.error);
    } catch { this.context.notifications.problem = "Notification history could not be loaded."; }
  }
  private async recover(scope: LocationScope): Promise<void> {
    this.context.policy = undefined;
    try {
      const inspected = await this.port.settings();
      if (inspected.ok && validCurrentPolicy(inspected.value, scope)) this.context.policy = inspected.value;
    } catch { /* Keep editing locked until a current scoped policy can be read. */ }
    this.syncSelections();
    if (this.context.policy) await this.readAudit();
    else this.context.notifications.problem = "Notification ownership could not be confirmed. Reload before editing settings.";
  }
  private async save(kind: NotificationKind, clear: boolean): Promise<void> {
    const current = this.context.policy;
    const state = this.context.notifications;
    if (this.context.busy || !current || !validCurrentPolicy(current, current.scope) || !this.permitted(changeId)) return;
    const owner = clear ? null : state.selected[kind];
    if (owner === "" || owner !== null && (!state.catalogue || !validNotificationCatalogue(state.catalogue, current.scope) ||
      !state.catalogue.options.find(option => option.kind === kind)?.owners.includes(owner))) return;
    this.context.busy = true; this.context.error = undefined; this.context.notice = undefined; state.problem = undefined;
    this.draw();
    try {
      const previous = current.notificationSettings!;
      const result = await this.port.changeNotificationOwner(previous.version, kind, owner);
      if (result.ok && validCurrentPolicy(result.value, current.scope) &&
          Number(result.value.notificationSettings!.version) === Number(previous.version) + 1 &&
          result.value.notificationSettings!.owners[kind] === owner) {
        this.context.policy = result.value; this.syncSelections();
        this.context.notice = `${NOTIFICATION_LABELS[kind]} owner ${clear ? "cleared" : "saved"} for new calls.`;
        await this.readAudit();
      } else {
        state.problem = result.ok ? "The notification save reply could not be verified." : this.failureText(result.error);
        await this.recover(current.scope);
      }
    } catch {
      state.problem = "The notification save reply was unavailable. Current ownership has been reloaded.";
      await this.recover(current.scope);
    } finally { this.context.busy = false; this.draw(); }
  }
  private async refresh(): Promise<void> {
    if (this.context.busy || !this.permitted(optionsId)) return;
    const scope = this.context.policy?.scope ?? this.context.notifications.catalogue?.scope;
    if (!scope) return;
    this.context.busy = true; this.draw();
    try {
      await this.recover(scope);
      if (this.context.policy) await this.initialize();
    } finally { this.context.busy = false; this.draw(); }
  }
  private async loadMore(): Promise<void> {
    const previous = this.context.notifications.audit;
    if (this.context.busy || !previous || previous.nextAfterVersion === undefined || !this.permitted(auditId)) return;
    this.context.busy = true; this.draw();
    try {
      const result = await this.port.notificationAudit(previous.nextAfterVersion);
      if (result.ok) this.context.notifications.audit = { ...result.value, entries: [...previous.entries, ...result.value.entries] };
      else this.context.notifications.problem = this.failureText(result.error);
    } catch { this.context.notifications.problem = "Notification history could not be loaded."; }
    finally { this.context.busy = false; this.draw(); }
  }
}

export function notificationOwnershipView(context: Context, actions: NotificationOwnershipControl["actions"]) {
  const state = context.notifications;
  const permitted = (id: string) => context.capabilities.some(item => item.id === id);
  const editable = permitted(changeId) && !!context.policy && validCurrentPolicy(context.policy, context.policy.scope);
  const knownCatalogue = !!context.policy && !!state.catalogue && validNotificationCatalogue(state.catalogue, context.policy.scope);
  return html`<section class="card" aria-labelledby="notification-ownership-title">
    <h2 id="notification-ownership-title">Notification ownership</h2>
    <p class="muted">Changes apply to new calls. Active calls retain their notification owner.</p>
    ${context.policy?.notificationSettings ? html`<p>Clinic notification version ${context.policy.notificationSettings.version}</p>` : html`<p>Notification ownership state unavailable.</p>`}
    ${NOTIFICATION_KINDS.map(kind => {
      const owners = knownCatalogue ? state.catalogue!.options.find(option => option.kind === kind)?.owners ?? [] : [];
      const saved = context.policy?.notificationSettings?.owners[kind];
      const effective = context.policy?.notificationBindings?.[kind];
      return html`<fieldset><legend>${NOTIFICATION_LABELS[kind]}</legend>
        <p>Saved owner: ${ownerName(saved)}</p><p>Managed delivery: ${effective ? ownerName(effective.owner) : "Unavailable"}</p>
        ${permitted(changeId) ? html`<label>${NOTIFICATION_LABELS[kind]} owner
          <select aria-label=${`${NOTIFICATION_LABELS[kind]} owner`} ?disabled=${context.busy || !editable || !owners.length}
            @change=${(event: Event) => actions.select(kind, (event.target as HTMLSelectElement).value)}>
            <option value="" ?selected=${!owners.includes(state.selected[kind] as NotificationOwner)}>Choose an owner</option>
            ${owners.map(owner => html`<option value=${owner} ?selected=${state.selected[kind] === owner}>${ownerName(owner)}</option>`)}
          </select></label>
          ${owners.length ? "" : html`<p class="muted">No approved notification sender available.</p>`}
          <div class="row"><button type="button" ?disabled=${context.busy || !editable || !owners.includes(state.selected[kind] as NotificationOwner)} @click=${() => actions.save(kind)}>Save owner</button>
          <button type="button" ?disabled=${context.busy || !editable || saved == null} @click=${() => actions.clear(kind)}>Clear owner</button></div>` : html`<span class="pill">View only</span>`}
      </fieldset>`;
    })}
    ${permitted(optionsId) ? html`<button type="button" ?disabled=${context.busy} @click=${actions.refresh}>Refresh notification setup and history</button>` : ""}
    ${state.problem ? html`<p role="alert">${state.problem}</p>` : ""}
    ${permitted(auditId) ? html`<h3>Notification ownership history</h3><div aria-label="Notification ownership audit">
      ${state.audit ? state.audit.entries.length ? html`<ul>${state.audit.entries.map(entry => html`<li>Version ${entry.version} · ${NOTIFICATION_LABELS[entry.kind]} · ${ownerName(entry.previousOwner)} → ${ownerName(entry.owner)} · ${entry.actorRef} · ${entry.changedAt}</li>`)}</ul>`
        : html`<p>No notification ownership changes recorded.</p>` : html`<p class="muted">Notification ownership history unavailable.</p>`}
      ${state.audit?.nextAfterVersion !== undefined ? html`<button type="button" ?disabled=${context.busy} @click=${actions.loadMore}>Load more notification history</button>` : ""}
    </div>` : ""}
  </section>`;
}
