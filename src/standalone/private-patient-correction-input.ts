import type { PatientDetailChanges, PatientDetailField } from "../cliniko/patient-details.ts";
import { err, ok } from "../core/model.ts";
import type { PrivateKeypadInput } from "../voice/private-keypad-input.ts";
import { MediaTurnController } from "../voice/media-turn-controller.ts";
import type { MediaFrame, MediaTurnOptions, TranscriptionPort } from "../voice/media-turn-controller.ts";
import { TurnAssembler } from "../voice/turn-assembler.ts";
import type { TranscriptFailure } from "../voice/turn-assembler.ts";
import type { ClinikoCallFlow } from "./cliniko-call-flow.ts";
import { PrivateWorkflowKeypad } from "./private-workflow-keypad.ts";
import { privatePatientCorrectionField } from "./private-patient-correction-field.ts";
import { privateIntakeField } from "./private-intake-field.ts";

type Config = Readonly<{ callId: string; sessionId: string; owner: () => ClinikoCallFlow | undefined;
  present(text: string, signal: AbortSignal): Promise<boolean>; transcriptionFactory(sessionId: string): TranscriptionPort;
  signal: AbortSignal; mediaOptions?: MediaTurnOptions }>;
type Stage = "verification" | "terms" | "acknowledge" | "menu" | "prompt" | "field" | "more" | "readback" | "prospectiveCode" | "readyGate" | "ready" | "closed";
const label = (field: PatientDetailField) => field === "patient_phone_numbers" ? "phone numbers" : field.replaceAll("_", " ");

/** Private value finals/readback and prospective OTP never become model or SAM turns.
 * Ordinary media resumes only after the correction is ready for a separate SAM proposal. */
export class PrivatePatientCorrectionInput implements PrivateKeypadInput {
  readonly #config: Config;
  readonly #keypad: PrivateWorkflowKeypad;
  readonly #lifetime = new AbortController();
  readonly #onClose = () => this.stop();
  #media: MediaTurnController<void, TranscriptFailure>;
  readonly #privateSession: string;
  #mediaGeneration = 0;
  #stage: Stage = "verification";
  #working = false;
  #consentRef: string | undefined;
  #fields: readonly PatientDetailField[] = [];
  #field: PatientDetailField | undefined;
  #draft: PatientDetailChanges = {};
  #digits = "";
  #attempts = 0;
  #sequence = 0;
  #codeOverflow = false;
  #fragment: string | undefined;
  constructor(config: Config) {
    this.#config = Object.freeze({ ...config }); this.#keypad = new PrivateWorkflowKeypad(config);
    this.#privateSession = `${config.sessionId}:private-correction`;
    this.#media = this.#createMedia();
    config.signal.addEventListener("abort", this.#onClose, { once: true }); if (config.signal.aborted) this.stop();
  }
  #createMedia(): MediaTurnController<void, TranscriptFailure> {
    const config = this.#config, sessionId = `${this.#privateSession}:${this.#mediaGeneration++}`;
    this.#sequence = 0;
    const assembler = new TurnAssembler(config.callId, sessionId, "private-correction");
    let transcription: TranscriptionPort | undefined;
    const port = () => transcription ??= config.transcriptionFactory(sessionId);
    return new MediaTurnController(sessionId, {
      speechStarted: async () => this.#stage === "field" ? ok(assembler.beginSpeech()) : err({ kind: "invalidTranscript" }),
      acceptTranscript: event => assembler.accept(event),
      finishTurn: async now => {
        const final = assembler.finish(now);
        if (!final.ok) return final;
        if (this.#stage !== "field" || this.#working || !this.#field) return err({ kind: "invalidTranscript" });
        const email = final.value.quality === "clear" && this.#field === "email" ? privateIntakeField("email", final.value.text, this.#fragment) : undefined;
        const value = final.value.quality === "clear" ? privatePatientCorrectionField(this.#field,
          email?.kind === "value" ? email.value : final.value.text, this.#config.owner()!.privatePhoneCountry) : undefined;
        this.#stage = "prompt";
        this.#launch(async () => {
          if (!value) {
            if (email?.kind === "fragment") this.#fragment = email.value;
            if (email?.kind === "reset") this.#fragment = undefined;
            if (++this.#attempts >= 3) { this.stop(); return; } await this.#prompt(); return;
          }
          this.#draft = { ...this.#draft, ...value }; this.#attempts = 0; this.#field = undefined; this.#fragment = undefined;
          await this.#present("Press one to correct another field, two to review these corrections, or three to start the fields again. Press star to stop.", "more");
        });
        return ok(undefined);
      },
    }, { accept: (...args) => port().accept(...args), flush: (...args) => port().flush(...args),
      cancel: generation => transcription?.cancel?.(generation) ?? Promise.resolve(), close: () => transcription?.close?.() ?? Promise.resolve() }, config.mediaOptions);
  }
  #launch(run: () => Promise<void>): void {
    if (this.#working || this.#lifetime.signal.aborted) return;
    this.#working = true; void run().catch(() => this.stop()).finally(() => { this.#working = false; });
  }
  async #present(text: string, next: Stage): Promise<void> {
    this.#stage = "prompt";
    if (!await this.#config.present(text, this.#lifetime.signal) || this.#lifetime.signal.aborted) { this.stop(); return; }
    this.#stage = next;
  }
  async #menu(): Promise<void> {
    this.#digits = "";
    await this.#present(this.#fields.map((field, i) => `For ${label(field)}, enter ${i + 1}, then pound.`).join(" ") + " Press star to stop.", "menu");
  }
  async #prompt(): Promise<void> {
    const field = this.#field!;
    await this.#present(this.#fragment ? "Please continue your email address, starting with continue, or say actually followed by the full address to replace it." : field === "patient_phone_numbers"
      ? "This replaces the complete recorded phone list. Say each type, mobile, home, work, other or fax, followed by its number. Separate entries by saying semicolon. To remove all numbers, say clear all phone numbers."
      : `Please say the corrected ${label(field)}.${field === "country_code" ? " Use the two-letter country code." : field === "date_of_birth" ? " Use the day, month name and year." : field === "email" ? " You may say at and dot." : ""}`, "field");
  }
  #readyText(): string {
    return "Your correction is ready for review. Press pound to return to speech, then say prepare the correction. You will be asked to confirm it separately. Press one to edit these fields, or three to start the fields again. You may also press one or three after returning to speech, before confirming.";
  }
  #edit(reset: boolean): boolean {
    const owner = this.#config.owner();
    if (!owner?.discardPatientCorrection()) { this.stop(); return false; }
    this.#stage = "prompt"; this.#digits = ""; this.#codeOverflow = false; this.#attempts = 0; this.#fragment = undefined; this.#field = undefined;
    if (reset) this.#draft = {};
    this.#launch(async () => { await this.#media.stop(); if (this.#lifetime.signal.aborted) return; this.#media = this.#createMedia(); await this.#menu(); });
    return true;
  }
  handlesDigit(digit: string): boolean {
    return this.#stage === "ready" && !!this.#config.owner()?.patientCorrection && (digit === "1" || digit === "3");
  }
  claim(callId: string, sessionId: string) { return this.#keypad.claim(callId, sessionId); }
  start() { return !this.#lifetime.signal.aborted && this.#keypad.start(); }
  blocked(): boolean {
    if (this.#stage === "closed" || this.#config.owner()?.closed) return true;
    return this.#stage !== "ready" || this.#keypad.blocked();
  }
  async accept(digit: string): Promise<"pending" | "verified" | "failed"> {
    const owner = this.#config.owner();
    if (this.#stage === "closed" || !owner?.patientCorrection || owner.closed) return "failed";
    if (digit === "*" && !["verification", "prospectiveCode"].includes(this.#stage)) { this.stop(); return "failed"; }
    if (this.#working) return "pending";
    if (this.#stage === "verification") {
      const result = await this.#keypad.accept(digit);
      if (result === "failed") { this.stop(); return "failed"; }
      if (result === "verified") {
        this.#stage = "terms";
        this.#launch(async () => {
          const terms = await owner.patientCorrection!.begin();
          if (!terms.ok || this.#lifetime.signal.aborted) { this.stop(); return; }
          this.#consentRef = terms.value.consentRef; this.#fields = [...terms.value.allowedFields];
          await this.#present("Press one to accept these privacy and account correction terms, or star to stop.", "acknowledge");
        });
      }
      return "pending";
    }
    if (this.#stage === "acknowledge" && digit === "1") {
      this.#launch(async () => { if (!await owner.patientCorrection!.acknowledge(this.#consentRef!, true)) { this.stop(); return; } this.#consentRef = undefined; await this.#menu(); });
    } else if (this.#stage === "menu") {
      if (/^[0-9]$/.test(digit) && this.#digits.length < 2) this.#digits += digit;
      else if (digit === "#") {
        const choice = /^(?:[1-9]|1[0-2])$/.test(this.#digits) ? Number(this.#digits) : 0; this.#digits = "";
        this.#field = this.#fields[choice - 1];
        this.#launch(async () => this.#field ? this.#prompt() : this.#menu());
      } else { this.#digits = ""; }
    } else if (this.#stage === "more") {
      if (digit === "1" || digit === "3") { if (digit === "3") this.#draft = {}; this.#launch(() => this.#menu()); }
      if (digit === "2") {
        this.#stage = "readback";
        this.#launch(async () => {
          const collected = await owner.collectPatientCorrection(this.#draft);
          if (!collected.ok || this.#lifetime.signal.aborted) { this.stop(); return; }
          await this.#media.stop(); this.#digits = ""; this.#codeOverflow = false; this.#attempts = 0;
          await this.#present(collected.value.codeRequired ? "If you receive a code at the corrected email address, enter six digits then pound. To edit fields, press pound before entering any digits. Star clears the code. Do not say the code aloud."
            : this.#readyText(), collected.value.codeRequired ? "prospectiveCode" : "readyGate");
        });
      }
    } else if (this.#stage === "prospectiveCode") {
      if (digit === "*") { this.#digits = ""; this.#codeOverflow = false; }
      else if (/^[0-9]$/.test(digit)) { if (this.#digits.length < 6) this.#digits += digit; else this.#codeOverflow = true; }
      else if (digit === "#" && !this.#digits && !this.#codeOverflow) {
        if (!this.#edit(false)) return "failed";
      }
      else if (digit === "#") {
        const code = this.#digits.length === 6 && !this.#codeOverflow ? this.#digits : ""; this.#digits = ""; this.#codeOverflow = false;
        // Playback marks arrive on the same serialized transport as keypad input.
        // Return before awaiting private playback so its mark can be processed.
        this.#launch(async () => {
          const checked = await owner.patientCorrection!.answer(code);
          if (checked.verified) await this.#present(this.#readyText(), "readyGate");
          else if (++this.#attempts >= 3) this.stop();
        });
      } else this.#codeOverflow = true;
    } else if ((this.#stage === "readyGate" || this.#stage === "ready") && (digit === "1" || digit === "3")) {
      if (!this.#edit(digit === "3")) return "failed";
    } else if (this.#stage === "readyGate" && digit === "#") this.#stage = "ready";
    // A ready transition follows private playback. Its final queued digit remains private.
    return this.#stage === "ready" ? "verified" : "pending";
  }
  async acceptMedia(frame: MediaFrame): Promise<"pending" | "failed"> {
    if (this.#stage === "closed") return "failed";
    if (this.#stage !== "field") return "pending";
    const result = await this.#media.acceptMedia({ ...frame, sessionId: `${this.#privateSession}:${this.#mediaGeneration - 1}`, sequence: this.#sequence++ });
    if (!result.ok) { this.stop(); return "failed"; } return "pending";
  }
  stop(): void {
    if (this.#stage === "closed") return;
    this.#stage = "closed"; this.#lifetime.abort(); this.#config.signal.removeEventListener("abort", this.#onClose);
    this.#draft = {}; this.#digits = ""; this.#fields = []; this.#field = undefined; this.#consentRef = undefined; this.#fragment = undefined;
    this.#keypad.stop(); void this.#media.stop().catch(() => undefined);
  }
}
