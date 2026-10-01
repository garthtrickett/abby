import { html, render } from "lit-html";
import { validOperationalDailyCounts } from "../../voice/operational-counts.ts";
import type { OperationalCounterKind, OperationalDailyCounts } from "../../voice/operational-counts.ts";

const columns: readonly Readonly<{ kind: OperationalCounterKind; label: string }>[] = [
  { kind: "admissionDenied", label: "Admission denied" },
  { kind: "callOwnerStarted", label: "Call owners started" },
  { kind: "callEnded", label: "Calls ended" },
  { kind: "voiceFailure", label: "Voice failures" },
  { kind: "clinikoBudgetDenied", label: "Cliniko budget denied" },
  { kind: "clinikoBudgetUnavailable", label: "Cliniko budget unavailable" },
  { kind: "clinikoProvider429", label: "Cliniko 429" },
  { kind: "clinikoProviderUnavailable", label: "Cliniko unavailable" },
];

/** Read-only, location-scoped operational counters; these are not per-call outcomes. */
export class OperationalDailyPanel {
  private readonly root: HTMLElement;

  constructor(root: HTMLElement) { this.root = root; }

  async load(): Promise<void> {
    let daily: OperationalDailyCounts | undefined;
    try {
      const response = await fetch("/api/operations/daily");
      if (response.ok) {
        const envelope: unknown = await response.json();
        if (envelope && typeof envelope === "object" && "ok" in envelope && envelope.ok === true &&
            "value" in envelope && envelope.value && typeof envelope.value === "object" &&
            "kind" in envelope.value && envelope.value.kind === "operationalDaily" &&
            "daily" in envelope.value && validOperationalDailyCounts(envelope.value.daily)) {
          daily = envelope.value.daily;
        }
      }
    } catch { /* Missing operational evidence stays unavailable. */ }
    render(html`<section class="card" aria-label="Operational counts">
      <h2>Operational counts</h2>
      <p class="muted">Seven UTC days for this clinic location. Counts are best effort; zero does not prove service health or staff delivery.</p>
      ${daily ? html`<div class="table-scroll"><table>
        <thead><tr><th scope="col">UTC date</th>${columns.map(column => html`<th scope="col">${column.label}</th>`)}</tr></thead>
        <tbody>${daily.days.map(day => html`<tr><th scope="row">${day.date}</th>
          ${columns.map(column => html`<td>${day.counts[column.kind]}</td>`)}</tr>`)}</tbody>
      </table></div>` : html`<p>Operational counts are unavailable.</p>`}
    </section>`, this.root);
  }
}
