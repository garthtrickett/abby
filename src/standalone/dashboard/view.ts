import { html } from "lit-html";
import type { CallPolicy, StaffChangeRequest, StaffQueueEntry } from "../../core/model.ts";
import type { CallSummary } from "../../reference/call-review.ts";
import type { CapabilityDescriptor } from "../../reference/command-gateway.ts";
import type { StaffQueuePage } from "../../reference/staff-queue.ts";
import type { CallOutcomePage } from "../../reference/call-outcome-report.ts";
import type { AutomationSettingAuditPage, BookingSettingAuditPage } from "../../core/host.ts";

export type DashboardState = {
  loading: boolean;
  busy: boolean;
  capabilities: readonly CapabilityDescriptor[];
  policy: CallPolicy | undefined;
  automationAuditPage: AutomationSettingAuditPage | undefined;
  auditPage: BookingSettingAuditPage | undefined;
  callIdInput: string;
  call: CallSummary | undefined;
  staffPage: StaffQueuePage | undefined;
  outcomePage: CallOutcomePage | undefined;
  notice: string | undefined;
  error: string | undefined;
};

export type DashboardActions = Readonly<{
  toggleAutomation(): void;
  loadAutomationAudit(): void;
  loadMoreAutomationAudit(): void;
  toggleBooking(): void;
  loadAudit(): void;
  loadMoreAudit(): void;
  setCallId(value: string): void;
  loadCall(): void;
  loadStaff(): void;
  loadMoreStaff(): void;
  loadOutcomes(): void;
  loadMoreOutcomes(): void;
  changeStaff(item: StaffQueueEntry, change: StaffChangeRequest): void;
}>;

export function dashboardView(state: DashboardState, actions: DashboardActions) {
  const canChange = state.capabilities.some(item => item.id === "settings.appointments.booking.enabled.change.v1");
  const canChangeAutomation = state.capabilities.some(item => item.id === "settings.automation.enabled.change.v1");
  const enabled = state.policy?.bookingEnabled ?? false;
  const automationEnabled = state.policy?.automationEnabled ?? false;
  const canChangeStaff = state.capabilities.some(item => item.id === "staff.change.v1");
  return html`
    <header><h1>Abby</h1><p class="muted">Clinic reception settings and call review</p></header>
    ${state.loading ? html`<p role="status">Loading clinic settings…</p>` : html`
      <section class="card" aria-labelledby="automation-title">
        <div class="row"><div><h2 id="automation-title">Reception automation</h2>
          <p class="status">${state.policy ? automationEnabled ? "Enabled" : "Disabled" : "Unavailable"}</p>
          <p class="muted">Changes apply to new calls. Enabling requires a passed clinic readiness check.</p></div>
          ${canChangeAutomation && state.policy ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.toggleAutomation()}>${automationEnabled ? "Disable reception" : "Enable reception"}</button>` : html`<span class="pill">Admin only</span>`}
        </div>
        ${state.policy ? html`<p class="muted">Automation version ${state.policy.automationVersion}</p>` : ""}
      </section>
      ${state.capabilities.some(item => item.id === "settings.automation.audit.v1") ? html`<section class="card" aria-labelledby="automation-audit-title">
        <div class="row"><h2 id="automation-audit-title">Reception setting history</h2>
          <button type="button" ?disabled=${state.busy} @click=${() => actions.loadAutomationAudit()}>Refresh reception history</button></div>
        ${state.automationAuditPage ? html`<div aria-label="Automation setting audit">
          ${state.automationAuditPage.entries.length ? html`<ul>${state.automationAuditPage.entries.map(entry => html`<li>Version ${entry.version} · ${entry.enabled ? "enabled" : "disabled"} · ${entry.actorRef} · ${entry.changedAt}</li>`)}</ul>` : html`<p>No reception setting changes recorded.</p>`}
          ${state.automationAuditPage.nextAfterVersion !== undefined ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.loadMoreAutomationAudit()}>Load more reception history</button>` : ""}
        </div>` : html`<p class="muted">Setting history unavailable.</p>`}
      </section>` : ""}
      <section class="card" aria-labelledby="booking-title">
        <div class="row"><div><h2 id="booking-title">Booking automation</h2>
          <p class="status">${state.policy ? enabled ? "Enabled" : "Disabled" : "Unavailable"}</p>
          <p class="muted">Changes apply to new calls. Current calls keep their captured setting.</p></div>
          ${canChange && state.policy ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.toggleBooking()}>${enabled ? "Disable booking" : "Enable booking"}</button>` : html`<span class="pill">View only</span>`}
        </div>
        ${state.policy ? html`<p class="muted">Policy version ${state.policy.policyVersion} · Booking capability: ${state.policy.capabilities.book}</p>` : ""}
      </section>
      ${state.capabilities.some(item => item.id === "settings.appointments.booking.audit.v1") ? html`<section class="card" aria-labelledby="booking-audit-title">
        <div class="row"><h2 id="booking-audit-title">Booking setting history</h2>
          <button type="button" ?disabled=${state.busy} @click=${() => actions.loadAudit()}>Refresh history</button></div>
        ${state.auditPage ? html`<div aria-label="Booking setting audit">
          ${state.auditPage.entries.length ? html`<ul>${state.auditPage.entries.map(entry => html`<li>Version ${entry.version} · ${entry.enabled ? "enabled" : "disabled"} · ${entry.provenance === "recorded" ? html`${entry.actorRef} · ${entry.changedAt}` : "Earlier change; actor unavailable"}</li>`)}</ul>` : html`<p>No booking setting changes recorded.</p>`}
          ${state.auditPage.nextAfterVersion !== undefined ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.loadMoreAudit()}>Load more history</button>` : ""}
        </div>` : html`<p class="muted">Setting history unavailable.</p>`}
      </section>` : ""}
      <section class="card" aria-labelledby="review-title">
        <h2 id="review-title">Call review</h2>
        <div class="lookup"><input aria-label="Call ID" .value=${state.callIdInput} @input=${(event: Event) => actions.setCallId((event.target as HTMLInputElement).value)} placeholder="Enter a call ID">
          <button type="button" ?disabled=${state.busy} @click=${() => actions.loadCall()}>Load call</button></div>
        ${state.call ? html`<div aria-label="Call summary"><p><strong>${state.call.callId}</strong> · ${state.call.lifecycle}</p>
          ${state.call.terminal ? html`<p>End reason: ${state.call.terminal.reason}</p>` : ""}
          <p>${state.call.actions.length} appointment action(s); ${state.call.staffItems.length} staff follow-up item(s); ${state.call.knowledgeAnswers.length} sourced answer(s); ${state.call.availabilityReads.length} availability read(s).</p>
          ${state.call.actions.length ? html`<ul>${state.call.actions.map(action => html`<li>${action.kind}: ${action.status}</li>`)}</ul>` : ""}
          ${state.call.staffItems.length ? html`<ul>${state.call.staffItems.map(item => html`<li>Staff follow-up: ${item.reason} (${item.status})</li>`)}</ul>` : ""}
          ${state.call.knowledgeAnswers.length ? html`<h3>Answer sources</h3><ul>${state.call.knowledgeAnswers.map(item => html`<li>${item.sourceRef} · version ${item.version}</li>`)}</ul>` : ""}
          ${state.call.availabilityReads.length ? html`<h3>Availability reads</h3><ul>${state.call.availabilityReads.map(item => html`<li>${item.status}${item.sourceRef ? ` · ${item.sourceRef}` : ""}${item.timeZone ? ` · ${item.timeZone}` : ""} · ${item.shownCount} time(s)${item.reason ? ` · ${item.reason}` : ""}</li>`)}</ul>` : ""}
        </div>` : ""}
      </section>
      ${state.capabilities.some(item => item.id === "calls.outcomes.v1") ? html`<section class="card" aria-labelledby="outcomes-title">
        <div class="row"><div><h2 id="outcomes-title">Call outcomes</h2><p class="muted">Counts cover loaded calls in this clinic.</p></div>
          <button type="button" ?disabled=${state.busy} @click=${() => actions.loadOutcomes()}>Refresh outcomes</button></div>
        ${state.outcomePage ? html`<div aria-label="Call outcome report">
          <p>${state.outcomePage.totals.calls} call(s) loaded · ${state.outcomePage.totals.committedActions} completed action(s) · ${state.outcomePage.totals.callsWithUnresolvedActions} call(s) with unresolved actions.</p>
          <p>${state.outcomePage.totals.callsWithStaffRequests} call(s) requested staff follow-up · ${state.outcomePage.totals.callsWithHostConfirmedTasks} call(s) have a host-confirmed task · ${state.outcomePage.totals.callsWithStaffNeedsReview} call(s) need staff review · ${state.outcomePage.totals.callsWithSystemFailure} call(s) recorded a system-failure task.</p>
          <p>${state.outcomePage.totals.callsWithCallerDisconnect} caller disconnect(s) · ${state.outcomePage.totals.callsWithMediaFailure} media failure(s) · ${state.outcomePage.totals.callsWithLeaseExpiry} lease closure(s) · ${state.outcomePage.totals.callsWithTransferConnected} connected transfer(s).</p>
          ${state.outcomePage.rows.length ? html`<ul>${state.outcomePage.rows.map(row => html`<li>${row.callId} · ${row.lifecycle}${row.terminalReason ? ` (${row.terminalReason})` : ""} · ${row.committedActions} completed · ${row.unresolvedActions} unresolved · ${row.staffRequests} staff request(s)${row.staffNeedsReview ? " · needs review" : ""}</li>`)}</ul>` : html`<p>No calls in this clinic.</p>`}
          ${state.outcomePage.nextAfterCallId ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.loadMoreOutcomes()}>Load more outcomes</button>` : ""}
        </div>` : html`<p class="muted">Outcome report unavailable.</p>`}
      </section>` : ""}
      ${state.capabilities.some(item => item.id === "staff.list.v1") ? html`<section class="card" aria-labelledby="staff-title">
        <div class="row"><h2 id="staff-title">Staff follow-up</h2><button type="button" ?disabled=${state.busy} @click=${() => actions.loadStaff()}>Refresh follow-up</button></div>
        ${state.staffPage ? html`<div aria-label="Staff follow-up queue">
          ${state.staffPage.items.length ? html`<ul>${state.staffPage.items.map(item => html`<li>${item.callId} · ${item.reason} · ${item.status}${item.overdue ? " · overdue" : ""}${item.pendingChangeKey ? " · pending host change" : ""}${item.reviewRequired ? " · needs operator review" : ""}${item.alerts?.overdue ? ` · overdue alert ${item.alerts.overdue}` : ""}${item.alerts?.needsReview ? ` · review alert ${item.alerts.needsReview}` : ""} · due ${item.dueAt}
            ${canChangeStaff && !item.pendingChangeKey && !item.reviewRequired && (item.status === "open" || item.status === "acknowledged") ? html`
              ${item.status === "open" ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.changeStaff(item, { kind: "acknowledge" })}>Acknowledge</button>` : ""}
              <button type="button" ?disabled=${state.busy} @click=${() => actions.changeStaff(item, { kind: "resolve" })}>Resolve</button>
              ${state.policy && JSON.stringify(item.destination) !== JSON.stringify(state.policy.staffDestination) ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.changeStaff(item, { kind: "reassign", target: "staff" })}>Assign to staff</button>` : ""}
              ${state.policy && JSON.stringify(item.destination) !== JSON.stringify(state.policy.operatorQueue) ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.changeStaff(item, { kind: "reassign", target: "operator" })}>Assign to operator</button>` : ""}
            ` : ""}
          </li>`)}</ul>` : html`<p>No follow-up items in this clinic.</p>`}
          ${state.staffPage.nextAfterTaskKey ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.loadMoreStaff()}>Load more follow-up</button>` : ""}
        </div>` : html`<p class="muted">Follow-up queue unavailable.</p>`}
      </section>` : ""}
      ${state.notice ? html`<p role="status">${state.notice}</p>` : ""}
      ${state.error ? html`<p role="alert" class="error">${state.error}</p>` : ""}
    `}
  `;
}
