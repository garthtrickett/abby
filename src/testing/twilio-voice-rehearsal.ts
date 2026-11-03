import { createHash } from "node:crypto";
import { validateRequest } from "twilio/lib/webhooks/webhooks.js";
import VoiceResponse from "twilio/lib/twiml/VoiceResponse.js";

export type RehearsalScenario = "dialogue" | "interruption" | "fallback";
export type RehearsalConfig = Readonly<{
  accountSid: string; authToken: string; from: string; to: string;
  callbackBase: string; runId: string; expiresAt: number; now?: () => number;
  scenario?: RehearsalScenario;
}>;
export type RehearsalRequest = Readonly<{
  method: string; target: string; contentType?: string; signature?: string; body: string;
}>;
const phone = /^\+[1-9]\d{7,14}$/;
type Step = Readonly<{ id: string; sayNext: string | undefined; words: readonly string[]; prefix?: string }>;
const dialogueSteps: readonly Step[] = [
  { id: "greeting", sayNext: "Hello.", words: ["abby", "test"] },
  { id: "hello", sayNext: "Blue.", words: ["heard", "greeting"], prefix: "hello i heard your test greeting" },
  { id: "blue", sayNext: "Green.", words: ["blue"], prefix: "i heard the test word blue" },
  { id: "green", sayNext: undefined, words: ["green"], prefix: "i heard the test word green" },
] as const;
const interruptionSteps: readonly Step[] = [{ id: "replacement", sayNext: undefined,
  words: ["heard", "greeting"], prefix: "hello i heard your test greeting" }];
const terminal = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);
const hangup = () => { const r = new VoiceResponse(); r.hangup(); return r.toString(); };

/** Single scripted test call. Signed callbacks are bound to its exact API-created
 * leg, account, numbers, run and step. Speech exists only during matching; neither
 * transcripts nor provider confidence are retained or treated as clinic authority. */
export class TwilioVoiceRehearsal {
  private readonly config: RehearsalConfig;
  private readonly base: URL;
  private readonly now: () => number;
  private readonly scenario: RehearsalScenario;
  private readonly steps: readonly Step[];
  private callSid: string | undefined;
  private next = 0;
  private failed = false;
  private providerTerminal: string | undefined;
  private readonly replies = new Map<number, { digest: string; xml: string }>();
  constructor(config: RehearsalConfig) {
    const base = new URL(config.callbackBase);
    const now = config.now ?? Date.now;
    const scenario = config.scenario ?? "dialogue";
    if (!/^AC[0-9a-f]{32}$/.test(config.accountSid) || !config.authToken ||
        !phone.test(config.from) || !phone.test(config.to) || config.from === config.to ||
        !/^[a-f0-9]{32}$/.test(config.runId) || base.protocol !== "https:" ||
        base.username || base.password || base.search || base.hash || base.pathname !== "/" ||
        !Number.isSafeInteger(config.expiresAt) || config.expiresAt <= now() ||
        config.expiresAt > now() + 300_000 || !["dialogue", "interruption", "fallback"].includes(scenario))
      throw new Error("Invalid rehearsal configuration");
    this.config = Object.freeze({ ...config }); this.base = base; this.now = now;
    this.scenario = scenario;
    this.steps = scenario === "dialogue" ? dialogueSteps : scenario === "interruption" ? interruptionSteps : [];
  }
  private action(step: number): string {
    return new URL(`/voice-rehearsal/${this.config.runId}/${step}`, this.base).href;
  }
  private listen(response: VoiceResponse, step: number): void {
    response.gather({ input: ["speech"], action: this.action(step), method: "POST",
      speechModel: "deepgram_nova-3", language: "en-US", speechTimeout: "2",
      timeout: 15, actionOnEmptyResult: true });
  }
  private gather(step: number, say?: string): string {
    const response = new VoiceResponse();
    // Say is outside Gather: the tester finishes its short phrase before listening.
    if (say) response.say(say);
    this.listen(response, step);
    response.hangup(); // Missing callback/recognition cannot leave an open call loop.
    return response.toString();
  }
  initialTwiml(): string {
    if (this.scenario === "dialogue") return this.gather(0);
    const response = new VoiceResponse();
    // The greeting finishes before a fixed public probe; this is not adaptive
    // speech timing or a recognition-quality qualification.
    response.pause({ length: 25 });
    if (this.scenario === "interruption") {
      response.say("Count."); response.pause({ length: 3 }); response.say("Hello.");
      this.listen(response, 0);
    } else { response.play({ digits: "9" }); response.pause({ length: 20 }); }
    response.hangup(); return response.toString();
  }
  bindCall(callSid: string): void {
    if (this.callSid || !/^CA[0-9a-f]{32}$/.test(callSid)) throw new Error("Invalid rehearsal call binding");
    this.callSid = callSid;
  }
  accept(request: RehearsalRequest): Readonly<{ status: number; xml?: string }> {
    if (request.method !== "POST" || request.contentType?.split(";")[0]?.trim().toLowerCase() !==
        "application/x-www-form-urlencoded" || !request.signature || Buffer.byteLength(request.body) > 16_384)
      return { status: 403 };
    const path = new URL(request.target, this.base);
    const index = this.steps.findIndex((_s, i) => this.action(i) === path.href);
    if (index < 0 || request.target !== path.pathname || this.now() >= this.config.expiresAt) return { status: 403 };
    const fields: Record<string, string> = Object.create(null);
    for (const [key, value] of new URLSearchParams(request.body)) {
      if (Object.hasOwn(fields, key)) return { status: 403 };
      fields[key] = value;
    }
    if (!validateRequest(this.config.authToken, request.signature, path.href, fields) ||
        fields.AccountSid !== this.config.accountSid || !this.callSid || fields.CallSid !== this.callSid ||
        fields.From !== this.config.from || fields.To !== this.config.to || fields.Direction !== "outbound-api" ||
        fields.CallStatus !== "in-progress") return { status: 403 };
    const digest = createHash("sha256").update(request.body).digest("hex");
    const prior = this.replies.get(index);
    if (prior) return prior.digest === digest ? { status: 200, xml: prior.xml } : { status: 409 };
    if (this.failed || this.providerTerminal || index !== this.next) return { status: 409 };
    const text = fields.SpeechResult;
    const normalized = (text ?? "").toLowerCase().replace(/[^a-z ]/g, " ").split(/ +/).filter(Boolean).join(" ");
    const words = new Set(normalized.split(" "));
    const step = this.steps[index]!;
    const matched = typeof text === "string" && text.length <= 4_096 && step.words.every(w => words.has(w)) &&
      (!step.prefix || normalized === step.prefix || normalized.startsWith(step.prefix + " "));
    this.failed = !matched;
    if (matched) this.next++;
    const xml = matched && step.sayNext ? this.gather(index + 1, step.sayNext) : hangup();
    this.replies.set(index, { digest, xml });
    return { status: 200, xml };
  }
  invalidateRun(): void { this.failed = true; }
  observeTerminal(callSid: string, status: string): void {
    if (callSid !== this.callSid || !terminal.has(status) ||
        this.providerTerminal && this.providerTerminal !== status) throw new Error("Invalid rehearsal terminal");
    this.providerTerminal = status;
  }
  summary() {
    const matched = !this.failed && this.steps.length > 0 && this.next === this.steps.length;
    return { scenario: this.scenario === "dialogue" ? "restricted-audio-dialogue-v1" :
      this.scenario === "interruption" ? "restricted-interruption-v1" : "restricted-fallback-v1",
      matchedSteps: this.steps.slice(0, this.next).map(s => s.id), scriptMatched: matched,
      dialogueMatched: this.scenario === "dialogue" && matched,
      carrierDialoguePassed: this.scenario === "dialogue" && matched && this.providerTerminal === "completed",
      failed: this.failed, providerTerminal: this.providerTerminal ?? "unverified",
      interruption: this.scenario === "interruption" ? "unverified" : "notRun",
      fallbackRinging: this.scenario === "fallback" ? "unverified" : "notRun", normalHangupNoFallback: "unverified",
      clinicalAcceptance: false, audioOrTranscriptPersisted: false } as const;
  }
}
