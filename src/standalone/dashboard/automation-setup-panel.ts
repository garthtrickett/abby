import { html, render } from "lit-html";
import type { CallPolicy } from "../../core/model.ts";
import type { AutomationSettingAuditEntry, AutomationSettingAuditPage } from "../../core/host.ts";
import type { DashboardFailure, DashboardPort } from "./api.ts";

type AutomationPort = Pick<DashboardPort, "capabilities" | "settings" | "automationAudit" | "changeAutomationEnabled">;

function failureMessage(failure: DashboardFailure): string {
  if (failure.kind === "readinessFailed") return "Automation cannot be enabled until the clinic's readiness checks pass.";
  if (failure.kind === "versionConflict") return "Automation changed elsewhere. Review the current setting before trying again.";
  if (failure.kind === "forbidden") return "Clinic administrator access is required.";
  if (failure.kind === "invalid" || failure.kind === "invalidValue") return "The automation change was rejected. Reload and try again.";
  return "The automation outcome is uncertain. Review the current setting before trying again.";
}

/** Clinic-wide admission switch; changing it never grants a patient-specific capability. */
export class AutomationSetupPanel {
  private readonly root: HTMLElement;
  private readonly port: AutomationPort;
  private permitted = false;
  private busy = false;
  private policy: CallPolicy | undefined;
  private history: AutomationSettingAuditEntry[] = [];
  private nextAfterVersion: number | undefined;
  private error: string | undefined;
  private historyError: string | undefined;
  private notice: string | undefined;

  constructor(root: HTMLElement, port: AutomationPort) {
    this.root = root;
    this.port = port;
  }

  async load(): Promise<void> {
    const capabilities = await this.port.capabilities();
    this.permitted = capabilities.ok && capabilities.value.some(item => item.id === "settings.automation.enabled.change.v1") &&
      capabilities.value.some(item => item.id === "settings.automation.audit.v1");
    if (!this.permitted) return;
    const [settings, audit] = await Promise.all([this.port.settings(), this.port.automationAudit()]);
    if (settings.ok) this.policy = settings.value;
    else this.error = "Current automation setting unavailable. Reload before making a change.";
    if (audit.ok) this.replaceHistory(audit.value);
    else this.historyError = "Automation history unavailable. Reload to check it.";
    this.draw();
  }

  private replaceHistory(page: AutomationSettingAuditPage): void {
    this.history = [...page.entries];
    this.nextAfterVersion = page.nextAfterVersion;
    this.historyError = undefined;
  }

  private async change(enabled: boolean): Promise<void> {
    if (this.busy || !this.policy || this.policy.automationEnabled === enabled) return;
    this.busy = true;
    this.error = undefined;
    this.notice = undefined;
    this.draw();
    const result = await this.port.changeAutomationEnabled(this.policy.automationVersion, enabled);
    if (result.ok) {
      this.policy = result.value;
      this.notice = enabled ? "Automation enabled for new calls." : "Automation disabled for new calls.";
    } else {
      this.error = failureMessage(result.error);
      // Never retry a possibly committed write automatically or keep a stale version actionable.
      this.policy = undefined;
      const current = await this.port.settings();
      if (current.ok) this.policy = current.value;
      else this.error += " Current setting unavailable; reload before another change.";
    }
    const audit = await this.port.automationAudit();
    if (audit.ok) this.replaceHistory(audit.value);
    else {
      this.historyError = "Automation history unavailable. Reload to check it.";
      this.nextAfterVersion = undefined;
    }
    this.busy = false;
    this.draw();
  }

  private async loadMore(): Promise<void> {
    if (this.busy || this.nextAfterVersion === undefined) return;
    this.busy = true;
    this.draw();
    const result = await this.port.automationAudit(this.nextAfterVersion);
    if (result.ok) {
      this.history.push(...result.value.entries);
      this.nextAfterVersion = result.value.nextAfterVersion;
      this.historyError = undefined;
    } else this.historyError = "More automation history unavailable. Try again or reload.";
    this.busy = false;
    this.draw();
  }

  private draw(): void {
    if (!this.permitted) return;
    render(html`<section class="card" aria-labelledby="local-automation-title">
      <h2 id="local-automation-title">Clinic automation</h2>
      <p aria-label="Automation status" class="status">${this.policy
        ? `Automation ${this.policy.automationEnabled ? "enabled" : "disabled"} · version ${this.policy.automationVersion}`
        : "Current automation setting unavailable"}</p>
      <p class="muted">This switch applies to new calls across this clinic's locations. Active calls keep their current setting. Enabling requires clinic readiness checks and does not enable booking or staff follow-up.</p>
      ${this.error ? html`<p role="alert">${this.error}</p>` : ""}
      ${this.notice ? html`<p role="status">${this.notice}</p>` : ""}
      <button type="button" ?disabled=${this.busy || !this.policy || this.policy.automationEnabled}
        @click=${() => void this.change(true)}>Enable automation for new calls</button>
      <button type="button" ?disabled=${this.busy || !this.policy || !this.policy.automationEnabled}
        @click=${() => void this.change(false)}>Disable automation for new calls</button>
      <section aria-label="Automation change history">
        <h3>Automation change history</h3>
        ${this.historyError ? html`<p role="alert">${this.historyError}</p>` : ""}
        ${this.history.length ? html`<ul>${this.history.map(entry => html`<li>Version ${entry.version} · ${entry.enabled ? "enabled" : "disabled"} · ${entry.actorRef} · ${entry.changedAt}</li>`)}</ul>`
          : this.historyError ? "" : html`<p>No automation changes recorded.</p>`}
        ${this.nextAfterVersion === undefined ? "" : html`<button type="button" ?disabled=${this.busy}
          @click=${() => void this.loadMore()}>Load more automation history</button>`}
      </section>
    </section>`, this.root);
  }
}
