import { html } from "lit-html";
import type { CallPolicy } from "../../core/model.ts";
import type { CallSummary } from "../../reference/call-review.ts";
import type { CapabilityDescriptor } from "../../reference/command-gateway.ts";
import type { StaffQueuePage } from "../../reference/staff-queue.ts";

export type DashboardState = {
  loading: boolean;
  busy: boolean;
  capabilities: readonly CapabilityDescriptor[];
  policy: CallPolicy | undefined;
  callIdInput: string;
  call: CallSummary | undefined;
  staffPage: StaffQueuePage | undefined;
  notice: string | undefined;
  error: string | undefined;
};

export type DashboardActions = Readonly<{
  toggleBooking(): void;
  setCallId(value: string): void;
  loadCall(): void;
  loadStaff(): void;
  loadMoreStaff(): void;
}>;

export function dashboardView(state: DashboardState, actions: DashboardActions) {
  const canChange = state.capabilities.some(item => item.id === "settings.appointments.booking.enabled.change.v1");
  const enabled = state.policy?.bookingEnabled ?? false;
  return html`
    <header><h1>Abby</h1><p class="muted">Clinic reception settings and call review</p></header>
    ${state.loading ? html`<p role="status">Loading clinic settings…</p>` : html`
      <section class="card" aria-labelledby="booking-title">
        <div class="row"><div><h2 id="booking-title">Booking automation</h2>
          <p class="status">${state.policy ? enabled ? "Enabled" : "Disabled" : "Unavailable"}</p>
          <p class="muted">Changes apply to new calls. Current calls keep their captured setting.</p></div>
          ${canChange && state.policy ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.toggleBooking()}>${enabled ? "Disable booking" : "Enable booking"}</button>` : html`<span class="pill">View only</span>`}
        </div>
        ${state.policy ? html`<p class="muted">Policy version ${state.policy.policyVersion} · Booking capability: ${state.policy.capabilities.book}</p>` : ""}
      </section>
      <section class="card" aria-labelledby="review-title">
        <h2 id="review-title">Call review</h2>
        <div class="lookup"><input aria-label="Call ID" .value=${state.callIdInput} @input=${(event: Event) => actions.setCallId((event.target as HTMLInputElement).value)} placeholder="Enter a call ID">
          <button type="button" ?disabled=${state.busy} @click=${() => actions.loadCall()}>Load call</button></div>
        ${state.call ? html`<div aria-label="Call summary"><p><strong>${state.call.callId}</strong> · ${state.call.lifecycle}</p>
          <p>${state.call.actions.length} appointment action(s); ${state.call.staffItems.length} staff follow-up item(s); ${state.call.knowledgeAnswers.length} sourced answer(s); ${state.call.availabilityReads.length} availability read(s).</p>
          ${state.call.actions.length ? html`<ul>${state.call.actions.map(action => html`<li>${action.kind}: ${action.status}</li>`)}</ul>` : ""}
          ${state.call.staffItems.length ? html`<ul>${state.call.staffItems.map(item => html`<li>Staff follow-up: ${item.reason} (${item.status})</li>`)}</ul>` : ""}
          ${state.call.knowledgeAnswers.length ? html`<h3>Answer sources</h3><ul>${state.call.knowledgeAnswers.map(item => html`<li>${item.sourceRef} · version ${item.version}</li>`)}</ul>` : ""}
          ${state.call.availabilityReads.length ? html`<h3>Availability reads</h3><ul>${state.call.availabilityReads.map(item => html`<li>${item.status}${item.sourceRef ? ` · ${item.sourceRef}` : ""}${item.timeZone ? ` · ${item.timeZone}` : ""} · ${item.shownCount} time(s)${item.reason ? ` · ${item.reason}` : ""}</li>`)}</ul>` : ""}
        </div>` : ""}
      </section>
      ${state.capabilities.some(item => item.id === "staff.list.v1") ? html`<section class="card" aria-labelledby="staff-title">
        <div class="row"><h2 id="staff-title">Staff follow-up</h2><button type="button" ?disabled=${state.busy} @click=${() => actions.loadStaff()}>Refresh follow-up</button></div>
        ${state.staffPage ? html`<div aria-label="Staff follow-up queue">
          ${state.staffPage.items.length ? html`<ul>${state.staffPage.items.map(item => html`<li>${item.callId} · ${item.reason} · ${item.status}${item.overdue ? " · overdue" : ""} · due ${item.dueAt}</li>`)}</ul>` : html`<p>No follow-up items in this clinic.</p>`}
          ${state.staffPage.nextAfterTaskKey ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.loadMoreStaff()}>Load more follow-up</button>` : ""}
        </div>` : html`<p class="muted">Follow-up queue unavailable.</p>`}
      </section>` : ""}
      ${state.notice ? html`<p role="status">${state.notice}</p>` : ""}
      ${state.error ? html`<p role="alert" class="error">${state.error}</p>` : ""}
    `}
  `;
}
