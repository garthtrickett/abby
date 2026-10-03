import { html, render } from "lit-html";
import type { DashboardFailure, DashboardPort } from "./api.ts";
import { initialVoiceProfileState, VoiceProfileControl, voiceProfileView } from "./voice-profile-control.ts";
import type { VoiceProfileContext } from "./voice-profile-control.ts";

type Port = Pick<DashboardPort, "capabilities" | "settings" | "voiceOptions" | "voiceAudit" | "changeVoiceSetting">;
function failureText(failure: DashboardFailure): string {
  if (failure.kind === "versionConflict") return "Clinic voice settings changed elsewhere. Review the current version and try again.";
  if (failure.kind === "forbidden") return "Clinic administrator access is required.";
  if (failure.kind === "readinessFailed") return "That locale and voice pair has no approved speech profile.";
  return "Voice settings could not be verified. Review current settings before editing.";
}

/** The supervised standalone admin uses the same control and mutation recovery as an embedded dashboard. */
export class VoiceSetupPanel {
  private readonly root: HTMLElement;
  private readonly port: Port;
  private readonly control: VoiceProfileControl;
  private readonly context: VoiceProfileContext = { voice: initialVoiceProfileState(), policy: undefined,
    capabilities: [], busy: false, notice: undefined, error: undefined };
  constructor(root: HTMLElement, port: Port) {
    this.root = root; this.port = port;
    this.control = new VoiceProfileControl(this.context, port, () => this.draw(), failureText);
  }
  async load(): Promise<void> {
    try {
      const [menu, policy] = await Promise.all([this.port.capabilities(), this.port.settings()]);
      this.context.capabilities = menu.ok ? menu.value : [];
      this.context.policy = policy.ok ? policy.value : undefined;
      if (!menu.ok) this.context.error = failureText(menu.error);
      else if (!policy.ok) this.context.error = failureText(policy.error);
      await this.control.initialize();
    } catch { this.context.error = "Voice setup could not be loaded."; }
    this.draw();
  }
  private draw(): void {
    render(html`${this.context.error ? html`<p role="alert">${this.context.error}</p>` : ""}
      ${this.context.notice ? html`<p role="status">${this.context.notice}</p>` : ""}
      ${voiceProfileView(this.context, this.control.actions)}`, this.root);
  }
}
