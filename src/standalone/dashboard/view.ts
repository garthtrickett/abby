import { html } from "lit-html";
import type { CancellationSettingAuditPage, ReschedulingSettingAuditPage } from "../../core/host.ts";
import type { CallPolicy, StaffChangeRequest, StaffQueueEntry } from "../../core/model.ts";
import type { CallSummary } from "../../reference/call-review.ts";
import type { CapabilityDescriptor } from "../../reference/command-gateway.ts";
import type { StaffQueuePage } from "../../reference/staff-queue.ts";
import type { CallOutcomePage } from "../../reference/call-outcome-report.ts";
import type { AfterHoursSettingAuditPage, AutomationSettingAuditPage, BookingSettingAuditPage, GreetingSettingAuditPage, StaffScheduleSettingAuditPage, UrgentSettingAuditPage } from "../../core/host.ts";
import type { WriteStopAuditPage, WriteStopStatus } from "../../core/write-stop.ts";
import type { KnowledgeEntry } from "../../reference/knowledge-catalogue.ts";

export type DashboardState = {
  loading: boolean;
  busy: boolean;
  capabilities: readonly CapabilityDescriptor[];
  policy: CallPolicy | undefined;
  knowledge: readonly KnowledgeEntry[] | undefined;
  knowledgeSourceRef: string;
  knowledgeOwnerRef: string;
  knowledgeText: string;
  knowledgeFrom: string;
  knowledgeUntil: string;
  writeStop: WriteStopStatus | undefined;
  writeStopAuditPage: WriteStopAuditPage | undefined;
  stopReasonInput: string;
  automationAuditPage: AutomationSettingAuditPage | undefined;
  auditPage: BookingSettingAuditPage | undefined;
  cancellationAuditPage: CancellationSettingAuditPage | undefined;
  reschedulingAuditPage: ReschedulingSettingAuditPage | undefined;
  afterHoursAuditPage: AfterHoursSettingAuditPage | undefined;
  afterHoursInfoVersion: string;
  afterHoursApprovedText: string;
  urgentAuditPage: UrgentSettingAuditPage | undefined;
  urgentVersion: string;
  urgentText: string;
  urgentFrom: string;
  urgentUntil: string;
  hoursAuditPage: StaffScheduleSettingAuditPage | undefined;
  hoursVersion: string;
  hoursTimeZone: string;
  hoursWeekly: string;
  hoursClosedDates: string;
  hoursFrom: string;
  hoursUntil: string;
  greetingAuditPage: GreetingSettingAuditPage | undefined;
  greetingVersion: string;
  greetingText: string;
  greetingFrom: string;
  greetingUntil: string;
  callIdInput: string;
  call: CallSummary | undefined;
  staffPage: StaffQueuePage | undefined;
  outcomePage: CallOutcomePage | undefined;
  notice: string | undefined;
  error: string | undefined;
};

export type DashboardActions = Readonly<{
  setKnowledgeField(field: "knowledgeSourceRef" | "knowledgeOwnerRef" | "knowledgeText" | "knowledgeFrom" | "knowledgeUntil", value: string): void;
  saveKnowledgeDraft(): void;
  approveKnowledge(entry: KnowledgeEntry): void;
  revokeKnowledge(entry: KnowledgeEntry): void;
  setStopReason(value: string): void;
  stopWrites(): void;
  resumeWrites(): void;
  loadMoreStoppedWrites(): void;
  loadMoreWriteStopAudit(): void;
  toggleAutomation(): void;
  loadAutomationAudit(): void;
  loadMoreAutomationAudit(): void;
  toggleBooking(): void;
  toggleCancellation(): void;
  toggleRescheduling(): void;
  loadCancellationAudit(): void;
  loadReschedulingAudit(): void;
  loadMoreCancellationAudit(): void;
  loadMoreReschedulingAudit(): void;
  loadAudit(): void;
  loadMoreAudit(): void;
  setAfterHoursField(field: "afterHoursInfoVersion" | "afterHoursApprovedText", value: string): void;
  changeAfterHours(mode: "staffRequest" | "approvedInfoAndRequest"): void;
  loadAfterHoursAudit(): void;
  loadMoreAfterHoursAudit(): void;
  setUrgentField(field: "urgentVersion" | "urgentText" | "urgentFrom" | "urgentUntil", value: string): void;
  changeUrgentResponse(enabled: boolean): void;
  loadUrgentAudit(): void;
  loadMoreUrgentAudit(): void;
  setHoursField(field: "hoursVersion" | "hoursTimeZone" | "hoursWeekly" | "hoursClosedDates" | "hoursFrom" | "hoursUntil", value: string): void;
  changeStaffSchedule(enabled: boolean): void;
  loadHoursAudit(): void;
  loadMoreHoursAudit(): void;
  setGreetingField(field: "greetingVersion" | "greetingText" | "greetingFrom" | "greetingUntil", value: string): void;
  changeGreeting(enabled: boolean): void;
  loadGreetingAudit(): void;
  loadMoreGreetingAudit(): void;
  setCallId(value: string): void;
  loadCall(): void;
  loadStaff(): void;
  loadMoreStaff(): void;
  loadOutcomes(): void;
  loadMoreOutcomes(): void;
  changeStaff(item: StaffQueueEntry, change: StaffChangeRequest): void;
}>;

export function dashboardView(state: DashboardState, actions: DashboardActions) {
  const knowledgeCurrent = state.knowledge?.filter((entry, index, rows) => !rows.slice(index + 1).some(row => row.sourceRef === entry.sourceRef)) ?? [];
  const canChange = state.capabilities.some(item => item.id === "settings.appointments.booking.enabled.change.v1");
  const canChangeAutomation = state.capabilities.some(item => item.id === "settings.automation.enabled.change.v1");
  const canChangeAfterHours = state.capabilities.some(item => item.id === "settings.routing.afterHours.change.v1");
  const canChangeUrgent = state.capabilities.some(item => item.id === "settings.routing.urgent.change.v1");
  const canChangeGreeting = state.capabilities.some(item => item.id === "settings.routing.greeting.change.v1");
  const canChangeHours = state.capabilities.some(item => item.id === "settings.routing.staffSchedule.change.v1");
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
      ${state.capabilities.some(item => item.id === "calls.writes.stop.read.v1") ? html`<section class="card" aria-labelledby="write-stop-title">
        <h2 id="write-stop-title">Emergency write stop</h2>
        <p class="muted">Blocks queued appointment writes on active calls. Writes already in flight still need their receipt or review.</p>
        ${state.writeStop?.stopped ? html`<div aria-label="Emergency stop status">
          <p class="status">Stopped by ${state.writeStop.actorRef} · ${state.writeStop.changedAt} · version ${state.writeStop.version}</p>
          <p>Reason: ${state.writeStop.reason}</p>
          <p>Writes already in flight at stop: ${state.writeStop.inFlight.length}${state.writeStop.nextAfterEffectId ? "+" : ""}</p>
          ${state.writeStop.inFlight.length ? html`<ul>${state.writeStop.inFlight.map(item => html`<li>${item.callId} · ${item.actionKey} · ${item.status}</li>`)}</ul>` : ""}
          ${state.writeStop.nextAfterEffectId ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.loadMoreStoppedWrites()}>Load more in-flight writes</button>` : ""}
          <label>Reason for resuming appointment writes <input aria-label="Reason for resuming appointment writes" .value=${state.stopReasonInput} @input=${(event: Event) => actions.setStopReason((event.target as HTMLInputElement).value)}></label>
          <button type="button" ?disabled=${state.busy || !state.stopReasonInput.trim()} @click=${() => actions.resumeWrites()}>Resume appointment writes</button>
        </div>` : html`<div>
          ${state.writeStop && state.writeStop.version !== "0" ? html`<p class="status">Writes resumed by ${state.writeStop.actorRef} · ${state.writeStop.changedAt} · version ${state.writeStop.version}</p>` : ""}
          <label>Reason for emergency stop <input aria-label="Reason for emergency stop" .value=${state.stopReasonInput} @input=${(event: Event) => actions.setStopReason((event.target as HTMLInputElement).value)}></label>
          <button type="button" ?disabled=${state.busy || !state.stopReasonInput.trim()} @click=${() => actions.stopWrites()}>Stop appointment writes</button></div>`}
        ${state.writeStopAuditPage ? html`<div aria-label="Write stop audit"><h3>Write stop history</h3>
          ${state.writeStopAuditPage.entries.length ? html`<ul>${state.writeStopAuditPage.entries.map(entry => html`<li>Version ${entry.version} · ${entry.stopped ? "stopped" : "resumed"} · ${entry.actorRef} · ${entry.reason} · ${entry.changedAt}</li>`)}</ul>` : html`<p>No write-stop changes recorded.</p>`}
          ${state.writeStopAuditPage.nextAfterVersion !== undefined ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.loadMoreWriteStopAudit()}>Load more write-stop history</button>` : ""}
        </div>` : ""}
      </section>` : ""}
      <section class="card" aria-labelledby="booking-title">
        <div class="row"><div><h2 id="booking-title">Booking automation</h2>
          <p class="status">${state.policy ? enabled ? "Enabled" : "Disabled" : "Unavailable"}</p>
          <p class="muted">Changes apply to new calls. Current calls keep their captured setting.</p></div>
          ${canChange && state.policy ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.toggleBooking()}>${enabled ? "Disable booking" : "Enable booking"}</button>` : html`<span class="pill">View only</span>`}
        </div>
        ${state.policy ? html`<p class="muted">Policy version ${state.policy.policyVersion} · Booking capability: ${state.policy.capabilities.book}</p>` : ""}
      </section>
      <section class="card" aria-labelledby="cancellation-title">
        <div class="row"><div><h2 id="cancellation-title">Cancellation automation</h2>
          <p class="status">${state.policy ? state.policy.cancellationEnabled === true ? "Cancellation enabled" : "Cancellation disabled" : "Cancellation unavailable"}</p>
          <p class="muted">Changes apply to new calls. Current calls keep their captured setting.</p></div>
          ${state.capabilities.some(item => item.id === "settings.appointments.cancellation.enabled.change.v1")
            ? html`<button type="button" ?disabled=${state.busy || !state.policy} @click=${() => actions.toggleCancellation()}>${!state.policy ? "Cancellation state unavailable" : state.policy.cancellationEnabled ? "Disable cancellation" : "Enable cancellation"}</button>`
            : html`<span class="pill">View only</span>`}
        </div>
        ${state.policy ? html`<p class="muted">Cancellation capability: ${state.policy.capabilities.cancel}</p>
          ${state.policy.capabilities.cancel !== "execute" ? html`<p class="muted">This setting cannot grant cancellation permission the clinic's host does not support.</p>` : ""}` : ""}
      </section>
      <section class="card" aria-labelledby="rescheduling-title">
        <div class="row"><div><h2 id="rescheduling-title">Rescheduling automation</h2>
          <p class="status">${state.policy ? state.policy.reschedulingEnabled === true ? "Rescheduling enabled" : "Rescheduling disabled" : "Rescheduling unavailable"}</p>
          <p class="muted">Changes apply to new calls. Current calls keep their captured setting.</p></div>
          ${state.capabilities.some(item => item.id === "settings.appointments.rescheduling.enabled.change.v1")
            ? html`<button type="button" ?disabled=${state.busy || !state.policy} @click=${() => actions.toggleRescheduling()}>${!state.policy ? "Rescheduling state unavailable" : state.policy.reschedulingEnabled ? "Disable rescheduling" : "Enable rescheduling"}</button>`
            : html`<span class="pill">View only</span>`}
        </div>
        ${state.policy ? html`<p class="muted">Rescheduling capability: ${state.policy.capabilities.reschedule}</p>
          ${state.policy.capabilities.reschedule !== "execute" ? html`<p class="muted">This setting cannot grant rescheduling permission the clinic's host does not support.</p>` : ""}` : ""}
      </section>
      <section class="card" aria-labelledby="after-hours-title">
        <h2 id="after-hours-title">After-hours information</h2>
        <p class="status">${state.policy?.afterHoursMode === "approvedInfoAndRequest" ? "Approved information enabled" : "Staff request only"}</p>
        <p class="muted">Applies to new calls when a live transfer is attempted outside staffed hours and staff follow-up is available. The approved text is spoken after the follow-up notice.</p>
        ${state.policy?.capabilities.transfer !== "execute" || state.policy.staffWorkEnabled === false ?
          html`<p class="muted">This clinic cannot currently attempt live transfers with follow-up; saved information will be inactive until that capability is available.</p>` : ""}
        ${canChangeAfterHours && state.policy ? html`<div>
          <label>Approved information version <input aria-label="Approved after-hours information version"
            .value=${state.afterHoursInfoVersion}
            @input=${(event: Event) => actions.setAfterHoursField("afterHoursInfoVersion", (event.target as HTMLInputElement).value)}></label>
          <label>Approved after-hours information <textarea aria-label="Approved after-hours information"
            .value=${state.afterHoursApprovedText}
            @input=${(event: Event) => actions.setAfterHoursField("afterHoursApprovedText", (event.target as HTMLTextAreaElement).value)}></textarea></label>
          <button type="button" ?disabled=${state.busy || !state.afterHoursInfoVersion.trim() || !state.afterHoursApprovedText.trim()}
            @click=${() => actions.changeAfterHours("approvedInfoAndRequest")}>Save approved after-hours information</button>
          <button type="button" ?disabled=${state.busy || state.policy.afterHoursMode !== "approvedInfoAndRequest"}
            @click=${() => actions.changeAfterHours("staffRequest")}>Use staff request only</button>
        </div>` : html`<span class="pill">Admin only</span>`}
        ${state.policy ? html`<p class="muted">After-hours version ${state.policy.policyVersion}</p>` : ""}
      </section>
      ${state.capabilities.some(item => item.id === "settings.routing.afterHours.audit.v1") ? html`<section class="card" aria-labelledby="after-hours-audit-title">
        <div class="row"><h2 id="after-hours-audit-title">After-hours setting history</h2>
          <button type="button" ?disabled=${state.busy} @click=${() => actions.loadAfterHoursAudit()}>Refresh after-hours history</button></div>
        ${state.afterHoursAuditPage ? html`<div aria-label="After-hours setting audit">
          ${state.afterHoursAuditPage.entries.length ? html`<ul>${state.afterHoursAuditPage.entries.map(entry => html`<li>Version ${entry.version} · ${entry.mode === "staffRequest" ? "staff request only" : "approved information"}${entry.infoVersion ? ` · information ${entry.infoVersion}` : ""} · ${entry.actorRef} · ${entry.changedAt}</li>`)}</ul>` : html`<p>No after-hours setting changes recorded.</p>`}
          ${state.afterHoursAuditPage.nextAfterVersion !== undefined ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.loadMoreAfterHoursAudit()}>Load more after-hours history</button>` : ""}
        </div>` : html`<p class="muted">Setting history unavailable.</p>`}
      </section>` : ""}
      <section class="card" aria-labelledby="urgent-title">
        <h2 id="urgent-title">Urgent request wording</h2>
        <p class="status">${state.policy?.urgentResponse ? "Approved script saved" : "No approved script"}</p>
        <p class="muted">A clinic admin approves this exact public wording for potentially urgent requests. Use only general clinic wording, with no patient details. It applies only to new calls while effective. Saving it does not enable natural-language calls or a staff route.</p>
        ${canChangeUrgent && state.policy ? html`<div>
          <label>Urgent script version <input aria-label="Urgent script version" .value=${state.urgentVersion}
            @input=${(event: Event) => actions.setUrgentField("urgentVersion", (event.target as HTMLInputElement).value)}></label>
          <label>Approved urgent request wording <textarea aria-label="Approved urgent request wording" .value=${state.urgentText}
            @input=${(event: Event) => actions.setUrgentField("urgentText", (event.target as HTMLTextAreaElement).value)}></textarea></label>
          <label>Effective from (UTC) <input aria-label="Urgent effective from" .value=${state.urgentFrom}
            @input=${(event: Event) => actions.setUrgentField("urgentFrom", (event.target as HTMLInputElement).value)}></label>
          <label>Effective until (UTC) <input aria-label="Urgent effective until" .value=${state.urgentUntil}
            @input=${(event: Event) => actions.setUrgentField("urgentUntil", (event.target as HTMLInputElement).value)}></label>
          <button type="button" ?disabled=${state.busy || !state.urgentVersion.trim() || !state.urgentText.trim() ||
            !state.urgentFrom.trim() || !state.urgentUntil.trim()}
            @click=${() => actions.changeUrgentResponse(true)}>Approve urgent request wording</button>
          <button type="button" ?disabled=${state.busy || !state.policy.urgentResponse}
            @click=${() => actions.changeUrgentResponse(false)}>Disable urgent request wording</button>
        </div>` : html`<span class="pill">Admin only</span>`}
        ${state.policy ? html`<p class="muted">Urgent setting revision ${state.policy.policyVersion}</p>` : ""}
      </section>
      ${state.capabilities.some(item => item.id === "settings.routing.urgent.audit.v1") ? html`<section class="card" aria-labelledby="urgent-audit-title">
        <div class="row"><h2 id="urgent-audit-title">Urgent wording history</h2>
          <button type="button" ?disabled=${state.busy} @click=${() => actions.loadUrgentAudit()}>Refresh urgent wording history</button></div>
        ${state.urgentAuditPage ? html`<div aria-label="Urgent wording audit">
          ${state.urgentAuditPage.entries.length ? html`<ul>${state.urgentAuditPage.entries.map(entry => html`<li>Version ${entry.version} · ${entry.enabled ? "approved" : "disabled"}${entry.scriptVersion ? ` · script ${entry.scriptVersion}` : ""} · ${entry.actorRef} · ${entry.changedAt}</li>`)}</ul>` : html`<p>No urgent wording changes recorded.</p>`}
          ${state.urgentAuditPage.nextAfterVersion !== undefined ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.loadMoreUrgentAudit()}>Load more urgent wording history</button>` : ""}
        </div>` : html`<p class="muted">Setting history unavailable.</p>`}
      </section>` : ""}
      <section class="card" aria-labelledby="greeting-title">
        <h2 id="greeting-title">Approved greeting</h2>
        <p class="status">${state.policy?.greeting ? "Greeting saved" : "No approved greeting"}</p>
        <p class="muted">A clinic admin approves the exact opening words and an effective period. A disabled or expired greeting blocks new voice calls.</p>
        ${canChangeGreeting && state.policy ? html`<div>
          <label>Greeting version <input aria-label="Greeting version" .value=${state.greetingVersion}
            @input=${(event: Event) => actions.setGreetingField("greetingVersion", (event.target as HTMLInputElement).value)}></label>
          <label>Greeting text <textarea aria-label="Greeting text" .value=${state.greetingText}
            @input=${(event: Event) => actions.setGreetingField("greetingText", (event.target as HTMLTextAreaElement).value)}></textarea></label>
          <label>Greeting effective from (UTC) <input aria-label="Greeting effective from" .value=${state.greetingFrom}
            @input=${(event: Event) => actions.setGreetingField("greetingFrom", (event.target as HTMLInputElement).value)}></label>
          <label>Greeting effective until (UTC) <input aria-label="Greeting effective until" .value=${state.greetingUntil}
            @input=${(event: Event) => actions.setGreetingField("greetingUntil", (event.target as HTMLInputElement).value)}></label>
          <button type="button" ?disabled=${state.busy || !state.greetingVersion.trim() || !state.greetingText.trim() ||
            !state.greetingFrom.trim() || !state.greetingUntil.trim()}
            @click=${() => actions.changeGreeting(true)}>Approve greeting</button>
          <button type="button" ?disabled=${state.busy || !state.policy.greeting}
            @click=${() => actions.changeGreeting(false)}>Disable greeting</button>
        </div>` : html`<span class="pill">Admin only</span>`}
      </section>
      ${state.capabilities.some(item => item.id === "settings.routing.greeting.audit.v1") ? html`<section class="card" aria-labelledby="greeting-audit-title">
        <div class="row"><h2 id="greeting-audit-title">Greeting history</h2>
          <button type="button" ?disabled=${state.busy} @click=${() => actions.loadGreetingAudit()}>Refresh greeting history</button></div>
        ${state.greetingAuditPage ? html`<div aria-label="Greeting audit">
          ${state.greetingAuditPage.entries.length ? html`<ul>${state.greetingAuditPage.entries.map(entry => html`<li>Version ${entry.version} · ${entry.enabled ? "approved" : "disabled"}${entry.greetingVersion ? ` · greeting ${entry.greetingVersion}` : ""} · ${entry.actorRef} · ${entry.changedAt}</li>`)}</ul>` : html`<p>No greeting changes recorded.</p>`}
          ${state.greetingAuditPage.nextAfterVersion !== undefined ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.loadMoreGreetingAudit()}>Load more greeting history</button>` : ""}
        </div>` : html`<p class="muted">Setting history unavailable.</p>`}
      </section>` : ""}
      <section class="card" aria-labelledby="clinic-hours-title">
        <h2 id="clinic-hours-title">Staffed transfer hours</h2>
        <p class="status">${state.policy?.staffSchedule ? "Approved hours saved" : "No approved hours"}</p>
        <p class="muted">A clinic admin approves local weekly hours and closed dates. A window can cross midnight, such as Mon 19:00-02:00. Changes apply to new calls and cannot enable a transfer route by themselves.</p>
        ${canChangeHours && state.policy ? html`<div>
          <label>Hours version <input aria-label="Hours version" .value=${state.hoursVersion}
            @input=${(event: Event) => actions.setHoursField("hoursVersion", (event.target as HTMLInputElement).value)}></label>
          <label>Clinic time zone <input aria-label="Clinic time zone" placeholder="Australia/Sydney" .value=${state.hoursTimeZone}
            @input=${(event: Event) => actions.setHoursField("hoursTimeZone", (event.target as HTMLInputElement).value)}></label>
          <label>Weekly staffed hours <textarea aria-label="Weekly staffed hours" placeholder="Mon 09:00-17:00&#10;Tue 09:00-17:00" .value=${state.hoursWeekly}
            @input=${(event: Event) => actions.setHoursField("hoursWeekly", (event.target as HTMLTextAreaElement).value)}></textarea></label>
          <label>Closed dates, one per line <textarea aria-label="Closed dates" placeholder="2026-12-25" .value=${state.hoursClosedDates}
            @input=${(event: Event) => actions.setHoursField("hoursClosedDates", (event.target as HTMLTextAreaElement).value)}></textarea></label>
          <label>Approval effective from (UTC) <input aria-label="Hours effective from" .value=${state.hoursFrom}
            @input=${(event: Event) => actions.setHoursField("hoursFrom", (event.target as HTMLInputElement).value)}></label>
          <label>Approval effective until (UTC) <input aria-label="Hours effective until" .value=${state.hoursUntil}
            @input=${(event: Event) => actions.setHoursField("hoursUntil", (event.target as HTMLInputElement).value)}></label>
          <button type="button" ?disabled=${state.busy || !state.hoursVersion.trim() || !state.hoursTimeZone.trim() ||
            !state.hoursWeekly.trim() || !state.hoursFrom.trim() || !state.hoursUntil.trim()}
            @click=${() => actions.changeStaffSchedule(true)}>Approve staffed hours</button>
          <button type="button" ?disabled=${state.busy || !state.policy.staffSchedule}
            @click=${() => actions.changeStaffSchedule(false)}>Disable staffed hours</button>
        </div>` : html`<span class="pill">Admin only</span>`}
      </section>
      ${state.capabilities.some(item => item.id === "settings.routing.staffSchedule.audit.v1") ? html`<section class="card" aria-labelledby="hours-audit-title">
        <div class="row"><h2 id="hours-audit-title">Staffed hours history</h2>
          <button type="button" ?disabled=${state.busy} @click=${() => actions.loadHoursAudit()}>Refresh staffed hours history</button></div>
        ${state.hoursAuditPage ? html`<div aria-label="Staffed hours audit">
          ${state.hoursAuditPage.entries.length ? html`<ul>${state.hoursAuditPage.entries.map(entry => html`<li>Version ${entry.version} · ${entry.enabled ? "approved" : "disabled"}${entry.scheduleVersion ? ` · hours ${entry.scheduleVersion}` : ""} · ${entry.actorRef} · ${entry.changedAt}</li>`)}</ul>` : html`<p>No staffed hours changes recorded.</p>`}
          ${state.hoursAuditPage.nextAfterVersion !== undefined ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.loadMoreHoursAudit()}>Load more staffed hours history</button>` : ""}
        </div>` : html`<p class="muted">Setting history unavailable.</p>`}
      </section>` : ""}
      ${state.capabilities.some(item => item.id === "knowledge.list.v1") ? html`<section class="card" aria-labelledby="knowledge-title">
        <h2 id="knowledge-title">Approved clinic information</h2>
        <p class="muted">Save a draft, then approve it before Abby can use the text. Revocation blocks future answers immediately.</p>
        <label>Source reference <input aria-label="Knowledge source reference" .value=${state.knowledgeSourceRef}
          @input=${(event: Event) => actions.setKnowledgeField("knowledgeSourceRef", (event.target as HTMLInputElement).value)}></label>
        <label>Owner reference <input aria-label="Knowledge owner reference" .value=${state.knowledgeOwnerRef}
          @input=${(event: Event) => actions.setKnowledgeField("knowledgeOwnerRef", (event.target as HTMLInputElement).value)}></label>
        <label>Approved answer text <textarea aria-label="Knowledge answer text" .value=${state.knowledgeText}
          @input=${(event: Event) => actions.setKnowledgeField("knowledgeText", (event.target as HTMLTextAreaElement).value)}></textarea></label>
        <label>Effective from (UTC) <input aria-label="Knowledge effective from" .value=${state.knowledgeFrom}
          @input=${(event: Event) => actions.setKnowledgeField("knowledgeFrom", (event.target as HTMLInputElement).value)}></label>
        <label>Effective until (UTC) <input aria-label="Knowledge effective until" .value=${state.knowledgeUntil}
          @input=${(event: Event) => actions.setKnowledgeField("knowledgeUntil", (event.target as HTMLInputElement).value)}></label>
        <button type="button" ?disabled=${state.busy} @click=${() => actions.saveKnowledgeDraft()}>Save knowledge draft</button>
        <div aria-label="Knowledge sources">${knowledgeCurrent.length ? html`<ul>${knowledgeCurrent.map(entry => html`<li>
          <strong>${entry.sourceRef}</strong> · version ${entry.version} · ${entry.status} · ${entry.ownerRef}
          ${entry.status === "draft" ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.approveKnowledge(entry)}>Approve ${entry.sourceRef}</button>` : ""}
          ${entry.status !== "revoked" && state.knowledge?.some(row => row.sourceRef === entry.sourceRef && row.status === "approved") ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.revokeKnowledge(entry)}>Revoke ${entry.sourceRef}</button>` : ""}
        </li>`)}</ul>` : html`<p>No clinic information recorded.</p>`}</div>
        <details><summary>Knowledge history</summary><ul>${state.knowledge?.map(entry => html`<li>${entry.sourceRef} · version ${entry.version} · ${entry.status} · ${entry.actorRef} · ${entry.changedAt}</li>`)}</ul></details>
      </section>` : ""}
      ${state.capabilities.some(item => item.id === "settings.appointments.booking.audit.v1") ? html`<section class="card" aria-labelledby="booking-audit-title">
        <div class="row"><h2 id="booking-audit-title">Booking setting history</h2>
          <button type="button" ?disabled=${state.busy} @click=${() => actions.loadAudit()}>Refresh history</button></div>
        ${state.auditPage ? html`<div aria-label="Booking setting audit">
          ${state.auditPage.entries.length ? html`<ul>${state.auditPage.entries.map(entry => html`<li>Version ${entry.version} · ${entry.enabled ? "enabled" : "disabled"} · ${entry.provenance === "recorded" ? html`${entry.actorRef} · ${entry.changedAt}` : "Earlier change; actor unavailable"}</li>`)}</ul>` : html`<p>No booking setting changes recorded.</p>`}
          ${state.auditPage.nextAfterVersion !== undefined ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.loadMoreAudit()}>Load more history</button>` : ""}
        </div>` : html`<p class="muted">Setting history unavailable.</p>`}
      </section>` : ""}
      ${state.capabilities.some(item => item.id === "settings.appointments.cancellation.audit.v1") ? html`<section class="card" aria-labelledby="cancellation-audit-title">
        <div class="row"><h2 id="cancellation-audit-title">Cancellation setting history</h2>
          <button type="button" ?disabled=${state.busy} @click=${() => actions.loadCancellationAudit()}>Refresh cancellation history</button></div>
        ${state.cancellationAuditPage ? html`<div aria-label="Cancellation setting audit">
          ${state.cancellationAuditPage.entries.length ? html`<ul>${state.cancellationAuditPage.entries.map(entry => html`<li>Version ${entry.version} · ${entry.enabled ? "enabled" : "disabled"} · ${entry.actorRef} · ${entry.changedAt}</li>`)}</ul>`
            : html`<p>No cancellation setting changes recorded.</p>`}
          ${state.cancellationAuditPage.nextAfterVersion !== undefined ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.loadMoreCancellationAudit()}>Load more cancellation history</button>` : ""}
        </div>` : html`<p class="muted">Setting history unavailable.</p>`}
      </section>` : ""}
      ${state.capabilities.some(item => item.id === "settings.appointments.rescheduling.audit.v1") ? html`<section class="card" aria-labelledby="rescheduling-audit-title">
        <div class="row"><h2 id="rescheduling-audit-title">Rescheduling setting history</h2>
          <button type="button" ?disabled=${state.busy} @click=${() => actions.loadReschedulingAudit()}>Refresh rescheduling history</button></div>
        ${state.reschedulingAuditPage ? html`<div aria-label="Rescheduling setting audit">
          ${state.reschedulingAuditPage.entries.length ? html`<ul>${state.reschedulingAuditPage.entries.map(entry => html`<li>Version ${entry.version} · ${entry.enabled ? "enabled" : "disabled"} · ${entry.actorRef} · ${entry.changedAt}</li>`)}</ul>`
            : html`<p>No rescheduling setting changes recorded.</p>`}
          ${state.reschedulingAuditPage.nextAfterVersion !== undefined ? html`<button type="button" ?disabled=${state.busy} @click=${() => actions.loadMoreReschedulingAudit()}>Load more rescheduling history</button>` : ""}
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
