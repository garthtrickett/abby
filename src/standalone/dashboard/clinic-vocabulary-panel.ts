import { html, render } from "lit-html";
import { validVocabularyTerms } from "../../core/public-vocabulary-terms.ts";
import { validVoiceLocationScope } from "../../core/voice-profile.ts";
import type { VocabularyProposal } from "../../core/clinic-vocabulary.ts";

type View = VocabularyProposal & Readonly<{ expectedBinding: string }>;
function view(value: unknown): View | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "catalogueHash,expectedBinding,expectedRevision,manualTerms,scope,selectedTerms,suggestions" ||
      !validVoiceLocationScope(row.scope) || ![row.catalogueHash, row.expectedBinding, row.expectedRevision].every(item =>
        typeof item === "string" && /^[a-f0-9]{64}$/.test(item)) || !validVocabularyTerms(row.manualTerms) ||
      !validVocabularyTerms(row.selectedTerms) || !validVocabularyTerms(row.suggestions)) return undefined;
  return structuredClone(row) as unknown as View;
}

/** Optional owner editor. Only a fresh server proposal supplies save versions;
 * an uncertain mutation disables another save until the owner reloads current terms. */
export class ClinicVocabularyPanel {
  readonly #root: HTMLElement;
  readonly #request: typeof fetch;
  #view: View | undefined;
  #enabled = false;
  #busy = false;
  #uncertain = false;
  #manual = "";
  #selected = new Set<string>();
  #confirmed = false;
  #error = "";
  #notice = "";
  constructor(root: HTMLElement, request: typeof fetch = fetch) { this.#root = root; this.#request = request; }
  async load(): Promise<void> {
    this.#busy = true; this.#error = ""; this.#draw();
    try {
      const request = this.#request;
      const response = await request("/api/clinic-vocabulary", { credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (response.status === 403 || response.status === 404) {
        this.#enabled = false; this.#view = undefined; this.#manual = ""; this.#selected.clear(); return;
      }
      const result: unknown = response.ok ? await response.json() : undefined;
      const found = result && typeof result === "object" && "ok" in result && result.ok === true && "value" in result ? view(result.value) : undefined;
      if (!found) throw new Error("unavailable");
      this.#enabled = true; this.#view = found; this.#manual = found.manualTerms.join("\n");
      this.#selected = new Set(found.selectedTerms); this.#confirmed = false; this.#uncertain = false;
    } catch {
      this.#enabled = true; this.#uncertain = true;
      this.#error = "Current clinic terms could not be verified. Reload them before editing.";
    } finally { this.#busy = false; this.#draw(); }
  }
  async #save(): Promise<void> {
    const manualPublicTerms = this.#manual.split("\n").map(term => term.trim()).filter(Boolean), selectedTerms = [...this.#selected];
    const selected = this.#view;
    if (!selected || this.#busy || this.#uncertain || manualPublicTerms.length > 0 && !this.#confirmed) return;
    if (!validVocabularyTerms([...manualPublicTerms, ...selectedTerms])) {
      this.#error = "Some terms are duplicated, too long or contain unsupported punctuation. Review the list."; this.#draw(); return;
    }
    this.#busy = true; this.#error = ""; this.#notice = ""; this.#draw();
    try {
      const request = this.#request;
      const response = await request("/api/clinic-vocabulary", { method: "POST", credentials: "same-origin", redirect: "error",
        signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          expectedBinding: selected.expectedBinding, expectedRevision: selected.expectedRevision, catalogueHash: selected.catalogueHash,
          manualPublicTerms, selectedTerms, manualPublicConfirmed: this.#confirmed }) });
      if (response.status === 409 || response.status === 423) {
        this.#uncertain = true; this.#error = "Clinic terms changed elsewhere. Reload current terms before saving again."; return;
      }
      const result: unknown = response.ok ? await response.json() : undefined;
      if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("value" in result) ||
          !result.value || typeof result.value !== "object" || Object.keys(result.value).join(",") !== "saved" ||
          !("saved" in result.value) || result.value.saved !== true) throw new Error("unverified save");
      this.#notice = "Clinic terms saved. New terms still need voice-quality checks before use.";
      await this.load();
    } catch {
      this.#uncertain = true;
      this.#error = "We could not verify whether your changes were saved. Reload current terms before trying again.";
    } finally { this.#busy = false; this.#draw(); }
  }
  #draw(): void {
    if (!this.#enabled) { render(html``, this.#root); return; }
    const choices = [...this.#view?.selectedTerms ?? [], ...this.#view?.suggestions ?? []];
    render(html`<section aria-label="Clinic terms">
      <h2>Clinic terms</h2><p>Help Abby recognise your published service, practitioner and location names.</p>
      ${this.#error ? html`<p role="alert">${this.#error}</p>` : ""}
      ${this.#notice ? html`<p role="status">${this.#notice}</p>` : ""}
      ${this.#view ? html`<fieldset ?disabled=${this.#busy || this.#uncertain}><legend>Approved public catalogue terms</legend>
        ${choices.map(term => html`<label><input type="checkbox" .checked=${this.#selected.has(term)} @change=${(event: Event) => {
          (event.target as HTMLInputElement).checked ? this.#selected.add(term) : this.#selected.delete(term); this.#draw();
        }}> ${term}</label>`)}
        <label>Additional published terms, one per line<textarea .value=${this.#manual} @input=${(event: Event) => {
          this.#manual = (event.target as HTMLTextAreaElement).value; this.#confirmed = false; this.#draw();
        }}></textarea></label>
        <p>Only use information your clinic has already made public. Never add patient details.</p>
        <label><input type="checkbox" .checked=${this.#confirmed} @change=${(event: Event) => {
          this.#confirmed = (event.target as HTMLInputElement).checked; this.#draw();
        }}> These additional terms are already publicly published by the clinic</label>
      </fieldset>` : ""}
      <button type="button" ?disabled=${this.#busy || this.#uncertain || !this.#view || !!this.#manual.trim() && !this.#confirmed}
        @click=${() => { void this.#save(); }}>Approve clinic terms</button>
      <button type="button" ?disabled=${this.#busy} @click=${() => { this.#notice = ""; void this.load(); }}>Discard edits and reload current terms</button>
    </section>`, this.#root);
  }
}
