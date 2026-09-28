import { html } from "lit-html";
import type { CallPolicy } from "../../core/model.ts";
import type { CallSummary } from "../../reference/call-review.ts";
import type { CapabilityDescriptor } from "../../reference/command-gateway.ts";

export type DashboardState = {
  loading: boolean;
  busy: boolean;
  capabilities: readonly CapabilityDescriptor[];
  policy: CallPolicy | undefined;
  callIdInput: string;
  call: CallSummary | undefined;
  notice: string | undefined;
  error: string | undefined;
};

export type DashboardActions = Readonly<{
  toggleBooking(): void;
  setCallId(value: string): void;
  loadCall(): void;
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
          <p>${state.call.actions.length} appointment action(s); ${state.call.staffItems.length} staff follow-up item(s).</p>
          ${state.call.actions.length ? html`<ul>${state.call.actions.map(action => html`<li>${action.kind}: ${action.status}</li>`)}</ul>` : ""}
          ${state.call.staffItems.length ? html`<ul>${state.call.staffItems.map(item => html`<li>Staff follow-up: ${item.reason} (${item.status})</li>`)}</ul>` : ""}
        </div>` : ""}
      </section>
      ${state.notice ? html`<p role="status">${state.notice}</p>` : ""}
      ${state.error ? html`<p role="alert" class="error">${state.error}</p>` : ""}
    `}
  `;
}
