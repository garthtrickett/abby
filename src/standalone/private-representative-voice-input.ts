import { err, ok } from "../core/model.ts";
import { MediaTurnController } from "../voice/media-turn-controller.ts";
import type { MediaFrame, MediaTurnOptions, TranscriptionPort } from "../voice/media-turn-controller.ts";
import type { PrivateKeypadInput } from "../voice/private-keypad-input.ts";
import { TurnAssembler } from "../voice/turn-assembler.ts";
import type { TranscriptFailure } from "../voice/turn-assembler.ts";
import { ClinikoRepresentativeCallOwner } from "./cliniko-representative-call-owner.ts";
import { privateIntakeField } from "./private-intake-field.ts";
import type { RepresentativeIdentity } from "./cliniko-representative-selection.ts";

const fields = ["firstName", "lastName", "dateOfBirth"] as const;
type Stage = "routing" | "start" | "prompt" | "actorCode" | "field" | "readback" | "subjectCode" | "ready" | "closed";
type Config = Readonly<{ callId: string; sessionId: string; input: PrivateKeypadInput;
  owner: () => ClinikoRepresentativeCallOwner | undefined;
  present(text: string, signal: AbortSignal): Promise<boolean>;
  transcriptionFactory(sessionId: string): TranscriptionPort; signal: AbortSignal; mediaOptions?: MediaTurnOptions; waitForStartKey?: true }>;

/** Private actor code, patient fields/readback and subject code. No field final
 * becomes an ordinary caller turn, and no transcription opens during OTP. */
export class PrivateRepresentativeVoiceInput implements PrivateKeypadInput {
  readonly #config: Config;
  readonly #lifetime = new AbortController();
  readonly #onClose = () => this.stop();
  #owner: ClinikoRepresentativeCallOwner | undefined;
  #stage: Stage = "routing";
  #claimed = false;
  #started = false;
  #working = false;
  #media: MediaTurnController<void, TranscriptFailure> | undefined;
  #mediaSession = "";
  #generation = 0;
  #sequence = 0;
  #field = 0;
  #draft: Partial<Record<typeof fields[number], string>> = {};
  #digits = "";
  #overflow = false;
  #attempts = 0;
  constructor(config: Config) {
    if (!(config.signal instanceof AbortSignal) || !config.callId || !config.sessionId || typeof config.owner !== "function" ||
        typeof config.present !== "function" || typeof config.transcriptionFactory !== "function") throw new TypeError("invalid private representative input");
    this.#config = Object.freeze({ ...config }); config.signal.addEventListener("abort", this.#onClose, { once: true });
    if (config.signal.aborted) this.stop();
  }
  claim(callId: string, sessionId: string): boolean {
    if (this.#claimed || this.#stage === "closed" || callId !== this.#config.callId || sessionId !== this.#config.sessionId || !this.#config.input.claim(callId, sessionId)) return false;
    this.#claimed = true; return true;
  }
  start(): boolean {
    if (!this.#claimed || this.#started || this.#stage === "closed" || !this.#config.input.start()) return false;
    this.#started = true; return true;
  }
  handlesDigit(digit: string): boolean { return !this.#owner && this.#config.input.handlesDigit?.(digit) === true; }
  #launch(run: () => Promise<void>): void {
    if (this.#working || this.#lifetime.signal.aborted) return;
    this.#working = true; void run().catch(() => this.stop()).finally(() => { this.#working = false; });
  }
  blocked(): boolean {
    if (this.#stage === "closed" || !this.#started) return true;
    const owner = this.#config.owner();
    if (!owner && !this.#owner) return this.#config.input.blocked();
    const binding = owner?.binding();
    if (!(owner instanceof ClinikoRepresentativeCallOwner) || owner.closed || this.#owner && this.#owner !== owner ||
        binding?.callId !== this.#config.callId || binding.sessionId !== this.#config.sessionId) { this.stop(); return true; }
    if (!this.#owner) {
      this.#owner = owner;
      if (this.#config.waitForStartKey) this.#stage = "start"; else this.#beginActor();
    }
    return this.#stage !== "ready" || this.#config.input.blocked();
  }
  #beginActor(): void {
    this.#stage = "prompt";
    this.#launch(async () => {
      if (!await this.#config.present("First verify yourself as the caller. If you receive a registered email code, enter its six digits and press pound. Star clears the code. Do not say the code aloud.", this.#lifetime.signal) ||
          this.#lifetime.signal.aborted || !this.#owner!.beginCallerVerification()) { this.stop(); return; }
      this.#stage = "actorCode";
    });
  }
  async #promptField(): Promise<void> {
    this.#stage = "prompt"; await this.#media?.stop();
    this.#mediaSession = `${this.#config.sessionId}:private-representative:${this.#generation++}`; this.#sequence = 0;
    const field = fields[this.#field]!, assembler = new TurnAssembler(this.#config.callId, this.#mediaSession, "private-representative");
    let transcription: TranscriptionPort | undefined;
    const port = () => transcription ??= this.#config.transcriptionFactory(this.#mediaSession);
    this.#media = new MediaTurnController(this.#mediaSession, {
      speechStarted: async () => this.#stage === "field" ? ok(assembler.beginSpeech()) : err({ kind: "invalidTranscript" }),
      acceptTranscript: event => assembler.accept(event),
      finishTurn: async now => {
        const final = assembler.finish(now); if (!final.ok) return final;
        if (this.#stage !== "field" || this.#working || this.#owner !== this.#config.owner()) return err({ kind: "invalidTranscript" });
        const parsed = final.value.quality === "clear" ? privateIntakeField(field, final.value.text) : undefined;
        this.#stage = "prompt";
        this.#launch(async () => {
          if (parsed?.kind !== "value") { if (++this.#attempts >= 3) { this.stop(); return; } await this.#promptField(); return; }
          this.#draft[field] = parsed.value; this.#field++; this.#attempts = 0;
          if (this.#field < fields.length) { await this.#promptField(); return; }
          if (!await this.#config.present(`The patient's name is ${this.#draft.firstName} ${this.#draft.lastName}, and date of birth is ${this.#draft.dateOfBirth}. Press one to use these details, two to enter the fields again, or star to stop.`, this.#lifetime.signal) || this.#lifetime.signal.aborted) { this.stop(); return; }
          this.#stage = "readback";
        });
        return ok(undefined);
      },
    }, { accept: (...args) => port().accept(...args), flush: (...args) => port().flush(...args),
      cancel: generation => transcription?.cancel?.(generation) ?? Promise.resolve(), close: () => transcription?.close?.() ?? Promise.resolve() }, this.#config.mediaOptions);
    const prompt = field === "dateOfBirth" ? "Please say the patient's date of birth, using the day, month name and year."
      : `Please say the patient's ${field === "firstName" ? "first" : "last"} name.`;
    if (!await this.#config.present(prompt, this.#lifetime.signal) || this.#lifetime.signal.aborted) { this.stop(); return; }
    this.#stage = "field";
  }
  async accept(digit: string): Promise<"pending" | "verified" | "failed"> {
    this.blocked(); if (this.#stage === "closed") return "failed";
    if (!this.#owner) return this.#config.input.accept(digit);
    if (this.#working) return "pending";
    if (this.#stage === "start") {
      if (digit === "*") { this.stop(); return "failed"; }
      if (digit !== "1") return "pending";
      this.#working = true; let ready = false;
      try { ready = await this.#owner.privateStartupReady(); } finally { this.#working = false; }
      if (this.#owner !== this.#config.owner() || this.#lifetime.signal.aborted) { this.stop(); return "failed"; }
      if (ready) this.#beginActor(); return "pending";
    }
    if (this.#stage === "actorCode") {
      if (digit === "*") { this.#digits = ""; this.#overflow = false; return "pending"; }
      if (/^[0-9]$/.test(digit)) { if (this.#digits.length < 6) this.#digits += digit; else this.#overflow = true; return "pending"; }
      if (digit !== "#") { this.#overflow = true; return "pending"; }
      const code = !this.#overflow && this.#digits.length === 6 ? this.#digits : ""; this.#digits = ""; this.#overflow = false;
      this.#working = true;
      try {
        const answer = await this.#owner.submitCallerCode(code);
        if (this.#lifetime.signal.aborted || this.#owner !== this.#config.owner()) return "failed";
        if (!answer.verified) { if (++this.#attempts >= 3) { this.stop(); return "failed"; } return "pending"; }
      } finally { this.#working = false; }
      this.#attempts = 0; this.#launch(() => this.#promptField()); return "pending";
    }
    if (this.#stage === "subjectCode" || this.#stage === "ready") return this.#config.input.accept(digit).then(result => {
      if (this.#lifetime.signal.aborted || this.#owner !== this.#config.owner()) { this.stop(); return "failed"; }
      if (result === "verified") this.#stage = "ready"; if (result === "failed") this.stop(); return result;
    });
    if (digit === "*") { this.stop(); return "failed"; }
    if (this.#stage === "readback" && digit === "2") { this.#draft = {}; this.#field = 0; this.#launch(() => this.#promptField()); }
    if (this.#stage === "readback" && digit === "1") {
      const identity = { ...this.#draft } as RepresentativeIdentity; this.#draft = {}; this.#stage = "prompt";
      this.#launch(async () => {
        await this.#media?.stop(); const selected = await this.#owner!.selectPatient(identity, undefined, this.#lifetime.signal);
        if (!selected.ok || !await this.#config.present("Now verify the selected patient. If their registered email receives a code, enter its six digits and press pound. Do not say the code aloud.", this.#lifetime.signal) || this.#lifetime.signal.aborted) { this.stop(); return; }
        if (!this.#owner!.beginPatientVerification()) { this.stop(); return; }
        this.#stage = "subjectCode";
      });
    }
    return "pending";
  }
  async acceptMedia(frame: MediaFrame): Promise<"pending" | "failed"> {
    this.blocked(); if (this.#stage === "closed") return "failed";
    if (!this.#owner) return this.#config.input.acceptMedia?.(frame) ?? "pending";
    if (this.#stage !== "field" || !this.#media) return "pending";
    const accepted = await this.#media.acceptMedia({ ...frame, sessionId: this.#mediaSession, sequence: this.#sequence++ });
    if (!accepted.ok) { this.stop(); return "failed"; } return "pending";
  }
  stop(): void {
    if (this.#stage === "closed") return;
    this.#stage = "closed"; this.#lifetime.abort(); this.#config.signal.removeEventListener("abort", this.#onClose);
    this.#draft = {}; this.#digits = ""; this.#owner?.dispose(); this.#owner = undefined; this.#config.input.stop(); void this.#media?.stop().catch(() => undefined);
  }
}
