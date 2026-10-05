import type { ClinikoIntakeDraft } from "../cliniko/patient-intake.ts";
import { err, ok } from "../core/model.ts";
import { MediaTurnController } from "../voice/media-turn-controller.ts";
import type { MediaFrame, MediaTurnOptions, TranscriptionPort } from "../voice/media-turn-controller.ts";
import type { PrivateKeypadInput } from "../voice/private-keypad-input.ts";
import { TurnAssembler } from "../voice/turn-assembler.ts";
import type { TranscriptFailure } from "../voice/turn-assembler.ts";
import type { ClinikoCallFlow } from "./cliniko-call-flow.ts";
import { PrivateWorkflowKeypad } from "./private-workflow-keypad.ts";

const fields = ["firstName", "lastName", "dateOfBirth", "email"] as const;
type Field = typeof fields[number];
type Stage = "routing" | "start" | "terms" | "acknowledge" | "prompt" | "field" | "readback" | "code" | "ready" | "closed";
const prompts: Record<Field, string> = {
  firstName: "Please say your first name.", lastName: "Please say your last name.",
  dateOfBirth: "Please say your date of birth, using the day, month name and year.", email: "Please say your email address. You may say at and dot.",
};
function fieldValue(field: Field, text: string): string | undefined {
  const value = text.trim();
  if (field === "firstName" || field === "lastName") return /^[\p{L}][\p{L}\p{M} '-]{0,99}$/u.test(value) ? value : undefined;
  if (field === "email") {
    const email = value.toLowerCase().replace(/\s+at\s+/g, "@").replace(/\s+dot\s+/g, ".").replace(/\s+/g, "");
    return email.length <= 254 && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email) ? email : undefined;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const named = /^(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/i.exec(value);
  if (!named) return undefined;
  const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(named[2]!.toLowerCase()) + 1;
  return `${named[3]}-${String(month).padStart(2, "0")}-${named[1]!.padStart(2, "0")}`;
}
export type PrivateIntakeVoiceConfig = Readonly<{
  callId: string; sessionId: string; phone: string; owner: () => ClinikoCallFlow | undefined;
  present(text: string, signal: AbortSignal): Promise<boolean>;
  transcriptionFactory(sessionId: string): TranscriptionPort; signal: AbortSignal; mediaOptions?: MediaTurnOptions;
}>;

/** Owns private registration fields, separately played recovery consent and keypad OTP.
 * Field finals never become ordinary caller turns. During OTP even private transcription is disabled. */
export class PrivateIntakeVoiceInput implements PrivateKeypadInput {
  readonly #config: PrivateIntakeVoiceConfig;
  readonly #keypad: PrivateWorkflowKeypad;
  readonly #lifetime = new AbortController();
  readonly #media: MediaTurnController<void, TranscriptFailure>;
  readonly #onClose = () => this.stop();
  #stage: Stage = "routing";
  #draft: Partial<Record<Field, string>> = {};
  #field = 0;
  #attempts = 0;
  #sequence = 0;
  #working = false;
  #recoveryRef: string | undefined;
  constructor(config: PrivateIntakeVoiceConfig) {
    if (!/^\+[1-9][0-9]{7,14}$/.test(config.phone) || !(config.signal instanceof AbortSignal)) throw new TypeError("invalid private intake voice input");
    this.#config = Object.freeze({ ...config }); this.#keypad = new PrivateWorkflowKeypad(config);
    const privateSession = `${config.sessionId}:private-intake`, assembler = new TurnAssembler(config.callId, privateSession, "private-intake");
    let transcription: TranscriptionPort | undefined;
    const privateTranscription = () => transcription ??= config.transcriptionFactory(privateSession);
    this.#media = new MediaTurnController(privateSession, {
      speechStarted: async () => this.#stage === "field" ? ok(assembler.beginSpeech()) : err({ kind: "invalidTranscript" }),
      acceptTranscript: event => assembler.accept(event),
      finishTurn: async now => {
        const final = assembler.finish(now); if (!final.ok) return final;
        if (this.#stage !== "field" || this.#working) return err({ kind: "invalidTranscript" });
        const value = final.value.quality === "clear" ? fieldValue(fields[this.#field]!, final.value.text) : undefined;
        this.#stage = "prompt";
        this.#launch(async () => {
          if (!value) { if (++this.#attempts >= 3) { this.stop(); return; } await this.#prompt(); return; }
          this.#draft[fields[this.#field]!] = value; this.#field++; this.#attempts = 0;
          if (this.#field < fields.length) { await this.#prompt(); return; }
          this.#stage = "readback";
          const result = await this.#config.owner()!.collectIntake({ ...this.#draft, patientPhone: config.phone, phoneType: "Mobile" } as ClinikoIntakeDraft);
          this.#draft = {};
          if (!result.ok || this.#lifetime.signal.aborted) { this.stop(); return; }
          this.#stage = "code"; await this.#media.stop();
          if (!await this.#config.present("If you receive an email code, enter its six digits on the keypad, then press pound. Star clears the code. Please do not say the code aloud.", this.#lifetime.signal)) this.stop();
        });
        return ok(undefined);
      },
    }, { accept: (...args) => privateTranscription().accept(...args), flush: (...args) => privateTranscription().flush(...args),
      cancel: generation => transcription?.cancel?.(generation) ?? Promise.resolve(), close: () => transcription?.close?.() ?? Promise.resolve() }, config.mediaOptions);
    config.signal.addEventListener("abort", this.#onClose, { once: true }); if (config.signal.aborted) this.stop();
  }
  #launch(run: () => Promise<void>): void {
    if (this.#working || this.#lifetime.signal.aborted) return;
    this.#working = true;
    void run().catch(() => this.stop()).finally(() => { this.#working = false; });
  }
  async #prompt(): Promise<void> {
    this.#stage = "prompt";
    if (!await this.#config.present(prompts[fields[this.#field]!], this.#lifetime.signal) || this.#lifetime.signal.aborted) { this.stop(); return; }
    this.#stage = "field";
  }
  claim(callId: string, sessionId: string): boolean { return this.#keypad.claim(callId, sessionId); }
  start(): boolean { return !this.#lifetime.signal.aborted && this.#keypad.start(); }
  blocked(): boolean {
    if (this.#stage === "closed") return true;
    const codeBlocked = this.#keypad.blocked();
    if (this.#config.owner()?.workflow !== "intake") return codeBlocked;
    if (this.#stage === "routing") this.#stage = "start";
    return this.#stage !== "ready" || codeBlocked;
  }
  async accept(digit: string): Promise<"pending" | "verified" | "failed"> {
    if (this.#stage === "closed" || this.#config.owner()?.closed) return "failed";
    if (this.#config.owner()?.workflow !== "intake") return this.#keypad.accept(digit);
    this.blocked();
    if (this.#stage === "code") {
      if (this.#working) return "pending";
      const result = await this.#keypad.accept(digit); if (result === "verified") this.#stage = "ready";
      if (result === "failed") this.stop(); return result;
    }
    if (digit === "*") { this.stop(); return "failed"; }
    if (this.#working || digit !== "1") return "pending";
    if (this.#stage === "start") {
      this.#stage = "terms";
      this.#launch(async () => { const result = await this.#config.owner()!.intake!.begin();
        if (!result.ok || this.#lifetime.signal.aborted) { this.stop(); return; }
        this.#recoveryRef = result.value.recoveryRef;
        if (!await this.#config.present("Press one to acknowledge these privacy, registration and call-failure terms. Press star to stop.", this.#lifetime.signal)) { this.stop(); return; }
        this.#stage = "acknowledge";
      });
    } else if (this.#stage === "acknowledge") {
      this.#launch(async () => {
        if (!await this.#config.owner()!.intake!.acknowledgeRecovery(this.#recoveryRef!, true)) { this.stop(); return; }
        this.#recoveryRef = undefined; await this.#prompt();
      });
    }
    return "pending";
  }
  async acceptMedia(frame: MediaFrame): Promise<"pending" | "failed"> {
    if (this.#stage === "closed") return "failed";
    if (this.#stage !== "field") return "pending";
    const result = await this.#media.acceptMedia({ ...frame, sessionId: `${this.#config.sessionId}:private-intake`, sequence: this.#sequence++ });
    if (!result.ok) { this.stop(); return "failed"; }
    return "pending";
  }
  stop(): void {
    if (this.#stage === "closed") return;
    this.#stage = "closed"; this.#lifetime.abort(); this.#config.signal.removeEventListener("abort", this.#onClose);
    this.#draft = {}; this.#recoveryRef = undefined; this.#keypad.stop(); void this.#media.stop().catch(() => undefined);
  }
}
