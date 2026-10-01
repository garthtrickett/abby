import { html, render } from "lit-html";
import { publicSpeechGateStatus } from "../speech-gate-public-status.ts";
import type { SpeechGatePublicStatus } from "../speech-gate-public-status.ts";

const labels = { telephony: "Telephone audio", noise: "Noisy audio", safety: "Safety language",
  speech: "Spoken response latency" } as const;

/** The status describes an evaluation candidate, never permission to handle patient calls. */
export class SpeechGatePanel {
  private readonly root: HTMLElement;
  private readonly loadStatus: typeof fetch;

  constructor(root: HTMLElement, loadStatus: typeof fetch = fetch) {
    this.root = root;
    this.loadStatus = loadStatus;
  }

  async load(): Promise<void> {
    let status: SpeechGatePublicStatus | undefined;
    try {
      const loadStatus = this.loadStatus;
      const response = await loadStatus("/api/speech-gate");
      if (response.ok) {
        const envelope: unknown = await response.json();
        if (envelope && typeof envelope === "object" && "ok" in envelope && envelope.ok === true &&
            "value" in envelope) status = publicSpeechGateStatus({ ...envelope.value as object, kind: "speechGateStatus" });
      }
    } catch { /* The panel must not turn missing evidence into readiness. */ }
    render(html`<section aria-label="Voice quality status">
      <h2>Voice quality status</h2>
      ${status ? html`
        <p>${status.syntheticCandidateGate === "pass" ? "Synthetic speech checks passed." : "Voice quality is blocked by the synthetic speech checks."}</p>
        <ul>${status.checks.map(check => html`<li>${labels[check.name]}: ${check.status}</li>`)}</ul>
        <p>Representative call: not run. Release readiness: unverified.</p>
      ` : html`<p>Voice quality status is unavailable. Release readiness is unverified.</p>`}
    </section>`, this.root);
  }
}
