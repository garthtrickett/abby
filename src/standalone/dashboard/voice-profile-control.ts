import { html } from "lit-html";
import { validVoiceCatalogue, validVoicePolicy, voiceClinicScope } from "../../core/voice-profile.ts";
import type { VoiceCatalogue, VoiceChoice, VoiceSettingKind } from "../../core/voice-profile.ts";
import type { VoiceSettingAuditPage } from "../../core/clinic-voice-setting.ts";
import type { CallPolicy, LocationScope } from "../../core/model.ts";
import type { CapabilityDescriptor } from "../../reference/command-gateway.ts";
import type { DashboardFailure, DashboardPort } from "./api.ts";

export type VoiceProfileState = {
  catalogue: VoiceCatalogue | undefined;
  selected: Record<VoiceSettingKind, string>;
  audit: VoiceSettingAuditPage | undefined;
  problem: string | undefined;
};
export function initialVoiceProfileState(): VoiceProfileState {
  return { catalogue: undefined, selected: { locale: "", voiceId: "" }, audit: undefined, problem: undefined };
}
export type VoiceProfileContext = {
  voice: VoiceProfileState;
  policy: CallPolicy | undefined;
  busy: boolean;
  capabilities: readonly CapabilityDescriptor[];
  notice: string | undefined;
  error: string | undefined;
};
type Port = Pick<DashboardPort, "settings" | "voiceOptions" | "voiceAudit" | "changeVoiceSetting">;
const optionsId = "settings.voice.options.v1", auditId = "settings.voice.audit.v1";
const changeId = (kind: VoiceSettingKind) => `settings.voice.${kind}.change.v1`;
const labels: Record<VoiceSettingKind, string> = { locale: "Clinic locale", voiceId: "Reception voice" };
const kinds: readonly VoiceSettingKind[] = ["locale", "voiceId"];
function choices(context: VoiceProfileContext, kind: VoiceSettingKind): readonly VoiceChoice[] {
  const catalogue = context.voice.catalogue, policy = context.policy;
  if (!catalogue || !policy || !validVoiceCatalogue(catalogue, voiceClinicScope(policy.scope))) return [];
  const other = kind === "locale" ? "voiceId" : "locale", saved = policy.voiceSettings?.[other];
  return (kind === "locale" ? catalogue.locales : catalogue.voices).filter(choice =>
    catalogue.pairs.some(pair => pair[kind] === choice.id && (!saved || pair[other] === saved && pair.ready)));
}

/** Owns only the public clinic speech preferences; the shared dashboard lock serializes all edits. */
export class VoiceProfileControl {
  private readonly context: VoiceProfileContext;
  private readonly port: Port;
  private readonly draw: () => void;
  private readonly failureText: (error: DashboardFailure) => string;
  constructor(context: VoiceProfileContext, port: Port, draw: () => void, failureText: (error: DashboardFailure) => string) {
    this.context = context; this.port = port; this.draw = draw; this.failureText = failureText;
  }
  readonly actions = {
    select: (kind: VoiceSettingKind, value: string) => {
      if (choices(this.context, kind).some(choice => choice.id === value)) this.context.voice.selected[kind] = value;
      this.draw();
    },
    save: (kind: VoiceSettingKind) => { void this.save(kind, false); },
    clear: (kind: VoiceSettingKind) => { void this.save(kind, true); },
    refresh: () => { void this.refresh(); },
    loadMore: () => { void this.loadMore(); },
  };
  private permitted(id: string): boolean { return this.context.capabilities.some(item => item.id === id); }
  private sync(): void {
    for (const kind of kinds) this.context.voice.selected[kind] = this.context.policy?.voiceSettings?.[kind] ?? "";
  }
  async initialize(): Promise<void> {
    const state = this.context.voice;
    state.catalogue = undefined; state.audit = undefined; state.problem = undefined; this.sync();
    if (!this.permitted(optionsId)) return;
    try {
      const [catalogue, audit] = await Promise.all([this.port.voiceOptions(),
        this.permitted(auditId) ? this.port.voiceAudit() : Promise.resolve(undefined)]);
      if (catalogue.ok && this.context.policy && validVoiceCatalogue(catalogue.value, voiceClinicScope(this.context.policy.scope))) state.catalogue = catalogue.value;
      else state.problem = catalogue.ok ? "Voice options could not be verified." : this.failureText(catalogue.error);
      if (audit?.ok) state.audit = audit.value;
      else if (audit) state.problem = this.failureText(audit.error);
    } catch { state.problem = "Voice setup could not be loaded."; }
  }
  private async readAudit(): Promise<void> {
    if (!this.permitted(auditId)) return;
    try {
      const audit = await this.port.voiceAudit();
      if (audit.ok) this.context.voice.audit = audit.value;
      else this.context.voice.problem = this.failureText(audit.error);
    } catch { this.context.voice.problem = "Voice history could not be loaded."; }
  }
  private async recover(scope: LocationScope): Promise<void> {
    this.context.policy = undefined;
    try {
      const inspected = await this.port.settings();
      if (inspected.ok && validVoicePolicy(inspected.value, scope)) this.context.policy = inspected.value;
    } catch { /* A missing scoped reread keeps every setting locked. */ }
    this.sync();
    if (this.context.policy) await this.readAudit();
    else this.context.voice.problem = "Voice settings could not be confirmed. Reload before editing settings.";
  }
  private async save(kind: VoiceSettingKind, clear: boolean): Promise<void> {
    const current = this.context.policy, state = this.context.voice;
    if (this.context.busy || !current || !validVoicePolicy(current, current.scope) || !this.permitted(changeId(kind))) return;
    const selected = clear ? null : state.selected[kind];
    if (!clear && (!selected || !choices(this.context, kind).some(choice => choice.id === selected))) return;
    this.context.busy = true; this.context.error = undefined; this.context.notice = undefined; state.problem = undefined; this.draw();
    const before = current.voiceSettings!, counterpart = kind === "locale" ? "voiceId" : "locale";
    try {
      const result = await this.port.changeVoiceSetting(before.version, kind, selected);
      if (result.ok && validVoicePolicy(result.value, current.scope) &&
          Number(result.value.voiceSettings!.version) === Number(before.version) + 1 &&
          result.value.voiceSettings![kind] === selected && result.value.voiceSettings![counterpart] === before[counterpart]) {
        this.context.policy = result.value; this.sync();
        this.context.notice = `${labels[kind]} ${clear ? "cleared" : "saved"} for new calls.`;
        await this.readAudit();
      } else {
        state.problem = result.ok ? "The voice save reply could not be verified." : this.failureText(result.error);
        await this.recover(current.scope);
      }
    } catch {
      state.problem = "The voice save reply was unavailable. Current settings have been reloaded.";
      await this.recover(current.scope);
    } finally { this.context.busy = false; this.draw(); }
  }
  private async refresh(): Promise<void> {
    const scope = this.context.policy?.scope;
    if (this.context.busy || !scope || !this.permitted(optionsId)) return;
    this.context.busy = true; this.draw();
    try { await this.recover(scope); if (this.context.policy) await this.initialize(); }
    finally { this.context.busy = false; this.draw(); }
  }
  private async loadMore(): Promise<void> {
    const previous = this.context.voice.audit;
    if (this.context.busy || !previous || previous.nextAfterVersion === undefined || !this.permitted(auditId)) return;
    this.context.busy = true; this.draw();
    try {
      const result = await this.port.voiceAudit(previous.nextAfterVersion);
      if (result.ok) this.context.voice.audit = { ...result.value, entries: [...previous.entries, ...result.value.entries] };
      else this.context.voice.problem = this.failureText(result.error);
    } catch { this.context.voice.problem = "Voice history could not be loaded."; }
    finally { this.context.busy = false; this.draw(); }
  }
}

export function voiceProfileView(context: VoiceProfileContext, actions: VoiceProfileControl["actions"]) {
  const state = context.voice, policy = context.policy;
  const permitted = (id: string) => context.capabilities.some(item => item.id === id);
  const editable = !!policy && validVoicePolicy(policy, policy.scope);
  return html`<section class="card" aria-labelledby="voice-profile-title">
    <h2 id="voice-profile-title">Locale and voice</h2>
    <p class="muted">Shared by every clinic location. Changes apply to new calls; active calls retain their locale and voice.</p>
    <p>Clinic voice version ${policy?.voiceSettings?.version ?? "unavailable"}</p>
    <p>Approved speech profile: ${policy?.voiceProfile ? "Ready" : "Unavailable"}</p>
    <p class="muted">Speech settings do not enable automation or clinical actions. Clearing either setting blocks new voice calls.</p>
    ${kinds.map(kind => {
      const available = choices(context, kind), saved = policy?.voiceSettings?.[kind];
      return html`<fieldset><legend>${labels[kind]}</legend><p>Saved: ${saved ?? "Not set"}</p>
        ${permitted(changeId(kind)) ? html`<label>${labels[kind]}
          <select aria-label=${labels[kind]} ?disabled=${context.busy || !editable || !available.length}
            @change=${(event: Event) => actions.select(kind, (event.target as HTMLSelectElement).value)}>
            <option value="" ?selected=${!state.selected[kind]}>Choose…</option>
            ${available.map(choice => html`<option value=${choice.id} ?selected=${state.selected[kind] === choice.id}>${choice.label}</option>`)}
          </select></label>
          ${available.length ? "" : html`<p>No approved compatible ${kind === "locale" ? "locale" : "voice"} available.</p>`}
          <button type="button" ?disabled=${context.busy || !editable || !available.some(choice => choice.id === state.selected[kind])}
            @click=${() => actions.save(kind)}>Save ${kind === "locale" ? "locale" : "voice"}</button>
          <button type="button" ?disabled=${context.busy || !editable || saved == null}
            @click=${() => actions.clear(kind)}>Clear ${kind === "locale" ? "locale" : "voice"}</button>` : html`<p>View only</p>`}
      </fieldset>`;
    })}
    ${state.problem ? html`<p role="alert">${state.problem}</p>` : ""}
    ${permitted(optionsId) ? html`<button type="button" ?disabled=${context.busy || !policy} @click=${() => actions.refresh()}>Refresh voice settings</button>` : ""}
    ${permitted(auditId) && state.audit ? html`<h3>Voice setting history</h3>
      ${state.audit.entries.length ? html`<ul>${state.audit.entries.map(entry => html`<li>Version ${entry.version} · ${labels[entry.kind]} · ${entry.value ?? "cleared"} · ${entry.actorRef} · ${entry.changedAt}</li>`)}</ul>` : html`<p>No voice changes recorded.</p>`}
      ${state.audit.nextAfterVersion === undefined ? "" : html`<button type="button" ?disabled=${context.busy} @click=${() => actions.loadMore()}>Load more voice history</button>`}` : ""}
  </section>`;
}
