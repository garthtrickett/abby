import WebSocket from "ws";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { MediaFrame, TranscriptionFailure, TranscriptionPort } from "./media-turn-controller.ts";
import type { TranscriptEvent } from "./turn-assembler.ts";

const endpoint = "wss://api.openai.com/v1/realtime?intent=transcription";
const failure: TranscriptionFailure = { kind: "transcriptionUnavailable" };
const maxBufferedBytes = 1_000_000;
const maxEventBytes = 64_000;
const maxTranscriptChars = 4_096;
const maxEarlyCompletions = 8;

type Socket = Pick<WebSocket, "on" | "send" | "close" | "terminate" | "bufferedAmount" | "readyState">;
export type OpenAIRealtimeTranscriptionModel = "gpt-live-transcribe" | "gpt-transcribe";
export type TranscriptionDelay = "minimal" | "low" | "medium" | "high" | "xhigh";
export type TranscriptionContext = Readonly<{
  /** Static, patient-free clinic setting. Never put caller or patient data here. */
  prompt: string;
  languages: readonly string[];
  keywords?: readonly string[];
}>;
export type OpenAIRealtimeTranscriptionConfig = Readonly<{
  apiKey: string;
  sessionId: string;
  model?: OpenAIRealtimeTranscriptionModel;
  context?: TranscriptionContext;
  /** Opt-in Realtime accuracy/latency tradeoff; a candidate still needs the fixed speech gate. */
  delay?: TranscriptionDelay;
  socketFactory?: (url: string, headers: Readonly<Record<string, string>>) => Socket;
}>;

function validContext(value: unknown): value is TranscriptionContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  if (!["languages,prompt", "keywords,languages,prompt"].includes(Object.keys(context).sort().join(",")) ||
      typeof context.prompt !== "string" || !context.prompt.trim() || context.prompt.length > 500 ||
      /[\r\n\u0000-\u001f\u007f]/.test(context.prompt) ||
      !Array.isArray(context.languages) || context.languages.length < 1 || context.languages.length > 4 ||
      context.languages.some(code => typeof code !== "string" || !/^[a-z]{2,3}(?:-[a-z]{2})?$/.test(code)) ||
      new Set(context.languages).size !== context.languages.length ||
      (context.keywords !== undefined && (!Array.isArray(context.keywords) ||
        context.keywords.length < 1 || context.keywords.length > 8 ||
        context.keywords.some(keyword => typeof keyword !== "string" || !keyword.trim() ||
          keyword.length > 80 || /[<>\r\n\u0000-\u001f\u007f]/.test(keyword)) ||
        new Set(context.keywords).size !== context.keywords.length))) return false;
  return true;
}

function sameStrings(left: unknown, right: readonly string[]): boolean {
  return Array.isArray(left) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

/** Keeps the 16 kHz to 24 kHz sample phase across Abby media frames. */
class Pcm16To24 {
  private inputIndex = 0;
  private previous = 0;
  private nextOutput = 0;

  push(bytes: Uint8Array): Uint8Array {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const output: number[] = [];
    for (let offset = 0; offset < bytes.length; offset += 2) {
      const sample = view.getInt16(offset, true);
      const index = this.inputIndex;
      if (index === 0) {
        output.push(sample);
        this.nextOutput = 1;
      } else {
        while (this.nextOutput * 2 <= index * 3) {
          const fraction = this.nextOutput * 2 - (index - 1) * 3;
          output.push(Math.round((this.previous * (3 - fraction) + sample * fraction) / 3));
          this.nextOutput += 1;
        }
      }
      this.previous = sample;
      this.inputIndex += 1;
    }
    const converted = new Uint8Array(output.length * 2);
    const target = new DataView(converted.buffer);
    output.forEach((sample, index) => target.setInt16(index * 2, sample, true));
    return converted;
  }

  finish(): Uint8Array {
    if (this.inputIndex === 0 || this.nextOutput * 2 >= this.inputIndex * 3) return new Uint8Array();
    const last = new Uint8Array(2);
    new DataView(last.buffer).setInt16(0, this.previous, true);
    this.nextOutput += 1;
    return last;
  }

  reset(): void {
    this.inputIndex = 0;
    this.previous = 0;
    this.nextOutput = 0;
  }
}

type PendingTurn = {
  generation: number;
  itemId?: string;
  transcript?: string;
  earlyCompletions: Map<string, string>;
  resolve: (result: Result<readonly TranscriptEvent[], TranscriptionFailure>) => void;
};

/** Transient Realtime transcription; Abby owns endpointing and the final caller turn. */
export class OpenAIRealtimeTranscription implements TranscriptionPort {
  private readonly sessionId: string;
  private readonly model: OpenAIRealtimeTranscriptionModel;
  private readonly context: TranscriptionContext | undefined;
  private readonly delay: OpenAIRealtimeTranscriptionConfig["delay"];
  private readonly socket: Socket;
  private readonly converter = new Pcm16To24();
  private readonly ready: Promise<boolean>;
  private resolveReady!: (ready: boolean) => void;
  private configured = false;
  private closed = false;
  private generation: number | undefined;
  private pending: PendingTurn | undefined;

  constructor(config: OpenAIRealtimeTranscriptionConfig) {
    if (!config || typeof config.apiKey !== "string" || !config.apiKey.trim() || /[\r\n]/.test(config.apiKey) ||
        typeof config.sessionId !== "string" || !config.sessionId.trim() || config.sessionId.length > 256 ||
        (config.model !== undefined && config.model !== "gpt-live-transcribe" && config.model !== "gpt-transcribe") ||
        (config.context !== undefined && !validContext(config.context)) ||
        (config.delay !== undefined && !["minimal", "low", "medium", "high", "xhigh"].includes(config.delay)) ||
        (config.socketFactory !== undefined && typeof config.socketFactory !== "function")) {
      throw new RangeError("invalid transcription configuration");
    }
    this.sessionId = config.sessionId;
    this.model = config.model ?? "gpt-live-transcribe";
    this.context = config.context ? { prompt: config.context.prompt,
      languages: [...config.context.languages],
      ...(config.context.keywords ? { keywords: [...config.context.keywords] } : {}) } : undefined;
    this.delay = config.delay;
    this.ready = new Promise(resolve => { this.resolveReady = resolve; });
    const headers = { Authorization: `Bearer ${config.apiKey}` };
    this.socket = config.socketFactory?.(endpoint, headers) ?? new WebSocket(endpoint, { headers });
    this.socket.on("open", () => {
      this.send({ type: "session.update", session: { type: "transcription", audio: { input: {
        format: { type: "audio/pcm", rate: 24000 },
        transcription: { model: this.model, ...(this.context ? this.context : {}),
          ...(this.delay ? { delay: this.delay } : {}) }, turn_detection: null,
      } } } });
    });
    this.socket.on("message", data => this.message(data));
    this.socket.on("error", () => this.fail());
    this.socket.on("close", () => this.fail());
  }

  private send(event: object): boolean {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > maxBufferedBytes) {
      this.fail();
      return false;
    }
    try {
      this.socket.send(JSON.stringify(event));
      if (this.socket.bufferedAmount > maxBufferedBytes) { this.fail(); return false; }
      return true;
    } catch { this.fail(); return false; }
  }

  private fail(): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveReady(false);
    this.pending?.resolve(err(failure));
    this.pending = undefined;
    try { this.socket.terminate(); } catch { /* already closed */ }
  }

  private message(data: unknown): void {
    if (this.closed || !(typeof data === "string" || data instanceof Uint8Array) ||
        (typeof data === "string" ? Buffer.byteLength(data) : data.byteLength) > maxEventBytes) {
      this.fail(); return;
    }
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data.toString());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid event");
      event = parsed as Record<string, unknown>;
    } catch { this.fail(); return; }
    if (event.type === "error" || event.type === "conversation.item.input_audio_transcription.failed") {
      this.fail(); return;
    }
    if (event.type === "session.updated") {
      const session = event.session as { type?: unknown; audio?: { input?: {
        format?: { type?: unknown; rate?: unknown }; transcription?: {
          model?: unknown; prompt?: unknown; languages?: unknown; keywords?: unknown;
        }; turn_detection?: unknown;
      } } } | undefined;
      if (session?.type !== "transcription" || session.audio?.input?.format?.type !== "audio/pcm" ||
          session.audio.input.format.rate !== 24000 ||
          session.audio.input.transcription?.model !== this.model ||
          (this.context !== undefined &&
            (session.audio.input.transcription?.prompt !== this.context.prompt ||
             !sameStrings(session.audio.input.transcription?.languages, this.context.languages) ||
             (this.context.keywords !== undefined && session.audio.input.transcription?.keywords !== undefined &&
              !sameStrings(session.audio.input.transcription.keywords, this.context.keywords)))) ||
          session.audio.input.turn_detection !== null) { this.fail(); return; }
      this.configured = true;
      this.resolveReady(true);
    }
    const pending = this.pending;
    if (!pending) return;
    if (event.type === "input_audio_buffer.committed") {
      if (typeof event.item_id !== "string" || !event.item_id || pending.itemId) { this.fail(); return; }
      pending.itemId = event.item_id;
      const early = pending.earlyCompletions.get(event.item_id);
      pending.earlyCompletions.clear();
      if (early !== undefined) pending.transcript = early;
      if (pending.transcript !== undefined) this.complete(pending);
    } else if (event.type === "conversation.item.input_audio_transcription.completed") {
      if (typeof event.item_id !== "string" || !event.item_id || typeof event.transcript !== "string" ||
          event.transcript.length > maxTranscriptChars) { this.fail(); return; }
      if (event.item_id === pending.itemId) {
        pending.transcript = event.transcript;
        this.complete(pending);
      } else if (!pending.itemId) {
        // If a completion precedes its commit acknowledgment, keep only a bounded
        // set of candidates and accept only the committed item ID.
        if (pending.earlyCompletions.has(event.item_id) ||
            pending.earlyCompletions.size >= maxEarlyCompletions) { this.fail(); return; }
        pending.earlyCompletions.set(event.item_id, event.transcript);
      }
    }
  }

  private complete(pending: PendingTurn): void {
    if (!pending.itemId || pending.transcript === undefined || this.pending !== pending) return;
    this.pending = undefined;
    this.generation = undefined;
    this.converter.reset();
    const text = pending.transcript.trim();
    pending.resolve(ok(text ? [{ kind: "segmentFinal", sessionId: this.sessionId,
      generation: pending.generation, utteranceId: pending.itemId, text, quality: "needsClarification" }] : []));
  }

  private async waitReady(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) { this.fail(); return false; }
    const abort = () => this.fail();
    signal.addEventListener("abort", abort, { once: true });
    try { return await this.ready && !signal.aborted && !this.closed && this.configured; }
    finally { signal.removeEventListener("abort", abort); }
  }

  async accept(frame: MediaFrame, generation: number, signal: AbortSignal):
    Promise<Result<readonly TranscriptEvent[], TranscriptionFailure>> {
    if (!frame || frame.sessionId !== this.sessionId || !Number.isSafeInteger(generation) || generation < 1 ||
        !(frame.bytes instanceof Uint8Array) || frame.bytes.length < 320 || frame.bytes.length > 3_200 ||
        frame.bytes.length % 32 !== 0 || this.pending || (this.generation !== undefined && this.generation !== generation) ||
        !await this.waitReady(signal)) return err(failure);
    this.generation = generation;
    const audio = this.converter.push(frame.bytes);
    return this.send({ type: "input_audio_buffer.append", audio: Buffer.from(audio).toString("base64") })
      ? ok([]) : err(failure);
  }

  async flush(generation: number, signal: AbortSignal):
    Promise<Result<readonly TranscriptEvent[], TranscriptionFailure>> {
    if (this.generation !== generation || this.pending || !await this.waitReady(signal)) return err(failure);
    const tail = this.converter.finish();
    if (tail.length && !this.send({ type: "input_audio_buffer.append", audio: Buffer.from(tail).toString("base64") })) return err(failure);
    return new Promise(resolve => {
      const abort = () => this.fail();
      signal.addEventListener("abort", abort, { once: true });
      const settle = (result: Result<readonly TranscriptEvent[], TranscriptionFailure>) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      };
      this.pending = { generation, earlyCompletions: new Map(), resolve: settle };
      if (signal.aborted || !this.send({ type: "input_audio_buffer.commit" })) this.fail();
    });
  }

  async cancel(generation: number): Promise<void> {
    if (this.generation === generation) this.fail();
  }

  async close(): Promise<void> { this.fail(); }
}
