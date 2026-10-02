import { html, render } from "lit-html";
import type { CallPolicy } from "../../core/model.ts";
import type { GreetingSettingAuditEntry, GreetingSettingAuditPage } from "../../core/host.ts";
import type { DashboardFailure, DashboardPort } from "./api.ts";

type GreetingPort = Pick<DashboardPort, "capabilities" | "settings" | "greetingAudit" | "changeGreeting">;
type InputField = "version" | "text" | "from" | "until";

function failureMessage(failure: DashboardFailure): string {
  if (failure.kind === "versionConflict") return "The greeting changed elsewhere. Review the current version and try again.";
  if (failure.kind === "forbidden") return "Clinic administrator access is required.";
  if (failure.kind === "invalidValue" || failure.kind === "invalid") return "Check the greeting text, version and UTC effective dates.";
  return "The greeting outcome is uncertain. Review the current setting before trying again.";
}

/** Supervised Cliniko setup exposes only the public greeting setting, never caller data. */
export class GreetingSetupPanel {
  private readonly root: HTMLElement;
  private readonly port: GreetingPort;
  private permitted = false;
  private busy = false;
  private policy: CallPolicy | undefined;
  private history: GreetingSettingAuditEntry[] = [];
  private nextAfterVersion: number | undefined;
  private version = "";
  private text = "";
  private from = "";
  private until = "";
  private notice: string | undefined;
  private error: string | undefined;

  constructor(root: HTMLElement, port: GreetingPort) {
    this.root = root;
    this.port = port;
  }

  async load(): Promise<void> {
    const capabilities = await this.port.capabilities();
    this.permitted = capabilities.ok && capabilities.value.some(item => item.id === "settings.routing.greeting.change.v1") &&
      capabilities.value.some(item => item.id === "settings.routing.greeting.audit.v1");
    if (!this.permitted) return;
    const [settings, audit] = await Promise.all([this.port.settings(), this.port.greetingAudit()]);
    if (settings.ok) {
      this.policy = settings.value;
      this.fillFromPolicy();
    } else this.error = failureMessage(settings.error);
    if (audit.ok) this.replaceHistory(audit.value);
    else this.error = failureMessage(audit.error);
    this.draw();
  }

  private fillFromPolicy(): void {
    const greeting = this.policy?.greeting;
    this.version = greeting?.version ?? "";
    this.text = greeting?.approvedText ?? "";
    this.from = greeting?.effectiveFrom ?? "";
    this.until = greeting?.effectiveUntil ?? "";
  }

  private replaceHistory(page: GreetingSettingAuditPage): void {
    this.history = [...page.entries];
    this.nextAfterVersion = page.nextAfterVersion;
  }

  private setField(field: InputField, value: string): void {
    if (field === "version") this.version = value;
    if (field === "text") this.text = value;
    if (field === "from") this.from = value;
    if (field === "until") this.until = value;
    this.draw();
  }

  private async change(enabled: boolean): Promise<void> {
    if (this.busy || !this.policy) return;
    if (enabled && (!this.version.trim() || !this.text.trim() || !this.from.trim() || !this.until.trim())) {
      this.error = "Enter greeting text, a version and UTC effective dates.";
      this.draw();
      return;
    }
    this.busy = true;
    this.error = undefined;
    this.notice = undefined;
    this.draw();
    const result = await this.port.changeGreeting(this.policy.policyVersion, enabled ? {
      version: this.version.trim(), approvedText: this.text.trim(),
      effectiveFrom: this.from.trim(), effectiveUntil: this.until.trim(),
    } : undefined);
    if (result.ok) {
      this.policy = result.value;
      this.fillFromPolicy();
      this.notice = enabled ? "Greeting approved for new calls." : "Greeting disabled for new calls.";
    } else {
      this.error = failureMessage(result.error);
      const current = await this.port.settings();
      if (current.ok) {
        this.policy = current.value;
        this.fillFromPolicy();
      } else this.error += " Current setting unavailable; reload before another change.";
    }
    const audit = await this.port.greetingAudit();
    if (audit.ok) this.replaceHistory(audit.value);
    else this.error = failureMessage(audit.error);
    this.busy = false;
    this.draw();
  }

  private async loadMore(): Promise<void> {
    if (this.busy || this.nextAfterVersion === undefined) return;
    this.busy = true;
    this.draw();
    const result = await this.port.greetingAudit(this.nextAfterVersion);
    if (result.ok) {
      this.history.push(...result.value.entries);
      this.nextAfterVersion = result.value.nextAfterVersion;
    } else this.error = failureMessage(result.error);
    this.busy = false;
    this.draw();
  }

  private draw(): void {
    if (!this.permitted) return;
    render(html`<section class="card" aria-labelledby="local-greeting-title">
      <h2 id="local-greeting-title">Approved greeting</h2>
      <p aria-label="Greeting approval status" class="status">${this.policy?.greeting
        ? `Greeting saved · policy version ${this.policy.policyVersion}`
        : `No approved greeting · policy version ${this.policy?.policyVersion ?? "unknown"}`}</p>
      <p class="muted">New voice calls require an approved greeting within its UTC effective period. The exact words below are spoken to callers.</p>
      <p class="muted">For availability calls, include exactly: “Press 1 for possible times today. Press 2 for possible times tomorrow.” If seven-day availability is enabled, also include: “Press 3 for possible times over the next week.” Calls refuse a greeting that omits or contradicts the enabled choices.</p>
      ${this.error ? html`<p role="alert">${this.error}</p>` : ""}
      ${this.notice ? html`<p role="status">${this.notice}</p>` : ""}
      <label>Greeting version <input aria-label="Local greeting version" .value=${this.version}
        @input=${(event: Event) => this.setField("version", (event.target as HTMLInputElement).value)}></label>
      <label>Greeting text <textarea aria-label="Local greeting text" .value=${this.text}
        @input=${(event: Event) => this.setField("text", (event.target as HTMLTextAreaElement).value)}></textarea></label>
      <label>Effective from (UTC ISO time) <input aria-label="Local greeting effective from" .value=${this.from}
        @input=${(event: Event) => this.setField("from", (event.target as HTMLInputElement).value)}></label>
      <label>Effective until (UTC ISO time) <input aria-label="Local greeting effective until" .value=${this.until}
        @input=${(event: Event) => this.setField("until", (event.target as HTMLInputElement).value)}></label>
      <button type="button" ?disabled=${this.busy || !this.policy} @click=${() => void this.change(true)}>Approve greeting for new calls</button>
      <button type="button" ?disabled=${this.busy || !this.policy?.greeting} @click=${() => void this.change(false)}>Disable greeting for new calls</button>
      <section aria-label="Greeting change history">
        <h3>Greeting change history</h3>
        ${this.history.length ? html`<ul>${this.history.map(entry => html`<li>Version ${entry.version} · ${entry.enabled ? "approved" : "disabled"}${entry.greetingVersion ? ` · greeting ${entry.greetingVersion}` : ""} · ${entry.actorRef} · ${entry.changedAt}</li>`)}</ul>`
          : html`<p>No greeting changes recorded.</p>`}
        ${this.nextAfterVersion === undefined ? "" : html`<button type="button" ?disabled=${this.busy}
          @click=${() => void this.loadMore()}>Load more greeting history</button>`}
      </section>
    </section>`, this.root);
  }
}
