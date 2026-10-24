import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { MediaFrame, TranscriptionFailure, TranscriptionPort } from "./media-turn-controller.ts";
import type { TranscriptEvent } from "./turn-assembler.ts";

type Socket = Pick<WebSocket, "on" | "send" | "terminate" | "bufferedAmount" | "readyState">;
type Final = Result<readonly TranscriptEvent[], TranscriptionFailure>;
export type DeepgramStreamingTranscriptionConfig = Readonly<{
  apiKey: string;
  sessionId: string;
  /** Optional fixed, patient-free evaluation vocabulary. No dynamic updates or weights. */
  keyterms?: readonly string[];
  socketFactory?: (url: string, headers: Readonly<Record<string, string>>) => Socket;
}>;

const failure: TranscriptionFailure = { kind: "transcriptionUnavailable" };
const maxAudioBytes = 1_000_000;
const maxEventBytes = 64_000;
const maxTranscriptChars = 4_096;
const deadlineMs = 2_000;
const endpoint = "wss://api.deepgram.com/v1/listen?" + new URLSearchParams({
  model: "nova-3", language: "en", encoding: "linear16", sample_rate: "16000", channels: "1",
  interim_results: "false", endpointing: "false", punctuate: "true", smart_format: "false",
  numerals: "false", mip_opt_out: "true",
}).toString();

type Turn = {
  generation: number;
  utteranceId: string;
  socket: Socket;
  ready: Promise<boolean>;
  resolveReady: (ready: boolean) => void;
  openTimer?: ReturnType<typeof setTimeout>;
  finalTimer?: ReturnType<typeof setTimeout>;
  pending: ((result: Final) => void) | undefined;
  retired: boolean;
  flushing: boolean;
  summary: boolean;
  bytes: number;
  sequence: number;
  finalThrough: number;
  interimThrough: number;
  finalCount: number;
  text: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Optional Nova-3 adapter. Each Abby turn owns one stream, closed by Abby.
 * Only final segments followed by a matching-duration summary and normal close
 * settle a flush. Provider endpointing/confidence never supplies action authority.
 */
export class DeepgramStreamingTranscription implements TranscriptionPort {
  private readonly config: DeepgramStreamingTranscriptionConfig;
  private readonly endpoint: string;
  private turn: Turn | undefined;
  private lastGeneration = 0;
  private closed = false;

  constructor(config: DeepgramStreamingTranscriptionConfig) {
    if (!config || typeof config.apiKey !== "string" || !config.apiKey.trim() ||
        config.apiKey.length > 512 || /[\s\u0000-\u001f\u007f]/.test(config.apiKey) ||
        typeof config.sessionId !== "string" || !config.sessionId || config.sessionId.length > 200 ||
        (config.socketFactory !== undefined && typeof config.socketFactory !== "function")) {
      throw new Error("Deepgram transcription configuration unavailable");
    }
    const terms = config.keyterms === undefined ? undefined :
      Array.isArray(config.keyterms) ? Array.from(config.keyterms) : config.keyterms;
    if (terms !== undefined && (!Array.isArray(terms) || terms.length > 50 ||
        terms.some(term => typeof term !== "string" || !term.trim() || term !== term.trim() ||
          term.length > 80 || /[\u0000-\u001f\u007f,:;]/.test(term)) ||
        Buffer.byteLength(terms.join(" "), "utf8") > 1_000 ||
        new Set(terms.map(term => term.toLowerCase())).size !== terms.length)) {
      throw new Error("Deepgram transcription configuration unavailable");
    }
    const keyterms = terms === undefined ? undefined : Object.freeze([...terms]);
    this.config = Object.freeze({ ...config, ...(keyterms === undefined ? {} : { keyterms }) });
    const url = new URL(endpoint);
    for (const term of keyterms ?? []) url.searchParams.append("keyterm", term);
    this.endpoint = url.toString();
  }

  private retire(turn: Turn, result: Final, terminate: boolean): void {
    if (turn.retired) return;
    turn.retired = true;
    if (this.turn === turn) this.turn = undefined;
    clearTimeout(turn.openTimer); clearTimeout(turn.finalTimer);
    turn.resolveReady(false);
    const pending = turn.pending; turn.pending = undefined;
    pending?.(result);
    if (terminate) { try { turn.socket.terminate(); } catch { /* No provider detail escapes. */ } }
  }

  private fail(): void {
    this.closed = true;
    if (this.turn) this.retire(this.turn, err(failure), true);
  }

  private isCurrent(turn: Turn): boolean { return this.turn === turn && !turn.retired && !this.closed; }

  private start(generation: number): Turn | undefined {
    try {
      let resolveReady!: (ready: boolean) => void;
      const ready = new Promise<boolean>(resolve => { resolveReady = resolve; });
      const headers = { Authorization: `Token ${this.config.apiKey}` };
      const socket = this.config.socketFactory?.(this.endpoint, headers) ??
        new WebSocket(this.endpoint, { headers, maxPayload: maxEventBytes, handshakeTimeout: deadlineMs });
      const turn: Turn = { generation, utteranceId: randomUUID(), socket, ready, resolveReady,
        retired: false, flushing: false, summary: false, bytes: 0, sequence: -1,
        finalThrough: 0, interimThrough: 0, finalCount: 0, text: "", pending: undefined };
      this.turn = turn;
      const current = () => this.isCurrent(turn);
      const opened = () => {
        if (!current()) return;
        clearTimeout(turn.openTimer); turn.resolveReady(true);
      };
      socket.on("open", opened);
      socket.on("message", (raw: WebSocket.RawData, binary: boolean) => {
        if (current()) this.receive(turn, raw, binary);
      });
      socket.on("error", () => { if (current()) this.fail(); });
      socket.on("close", (code: number) => {
        if (!current()) return;
        if (code !== 1000 || !turn.flushing || !turn.summary || !turn.pending ||
            turn.interimThrough > turn.finalThrough + 0.001) { this.fail(); return; }
        this.lastGeneration = turn.generation;
        this.retire(turn, ok(turn.text ? [{ kind: "segmentFinal", sessionId: this.config.sessionId,
          generation, utteranceId: turn.utteranceId, text: turn.text, quality: "needsClarification" }] : []), false);
      });
      turn.openTimer = setTimeout(() => { if (current()) this.fail(); }, deadlineMs);
      if (socket.readyState === WebSocket.OPEN) opened();
      else if (socket.readyState !== WebSocket.CONNECTING) this.fail();
      return turn;
    } catch { this.fail(); return undefined; }
  }

  private receive(turn: Turn, raw: WebSocket.RawData, binary: boolean): void {
    try {
      if (binary) throw new Error();
      const length = Array.isArray(raw) ? raw.reduce((size, bytes) => size + bytes.length, 0) : raw.byteLength;
      if (length > maxEventBytes) throw new Error();
      const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const event = record(JSON.parse(bytes.toString("utf8")) as unknown);
      if (!event || turn.summary) throw new Error();
      if (event.type === "Metadata") {
        if (!turn.flushing || event.channels !== 1 || !nonnegative(event.duration) ||
            Math.abs(event.duration - turn.bytes / 32_000) > 0.001) throw new Error();
        turn.summary = true;
        return;
      }
      if (event.type !== "Results" || typeof event.is_final !== "boolean" ||
          !Array.isArray(event.channel_index) || event.channel_index.length !== 2 ||
          event.channel_index[0] !== 0 || event.channel_index[1] !== 1 ||
          !nonnegative(event.start) || !nonnegative(event.duration)) throw new Error();
      const alternatives = record(event.channel)?.alternatives;
      const alternative = Array.isArray(alternatives) && alternatives.length === 1 ? record(alternatives[0]) : undefined;
      if (typeof alternative?.transcript !== "string" || alternative.transcript.length > maxTranscriptChars ||
          /[\u0000-\u001f\u007f]/.test(alternative.transcript)) throw new Error();
      const text = alternative.transcript.trim(), end = event.start + event.duration;
      if (!event.is_final) {
        if (text) turn.interimThrough = Math.max(turn.interimThrough, end);
        return;
      }
      if (++turn.finalCount > 128 || event.start < turn.finalThrough - 0.001 ||
          end > turn.bytes / 32_000 + 0.05 || (text && event.duration === 0)) throw new Error();
      turn.finalThrough = end;
      turn.text = [turn.text, text].filter(Boolean).join(" ");
      if (turn.text.length > maxTranscriptChars) throw new Error();
    } catch { this.fail(); }
  }

  private async ready(turn: Turn, signal: AbortSignal): Promise<boolean> {
    const abort = () => { if (this.isCurrent(turn)) this.fail(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) { this.fail(); return false; }
      return await turn.ready && !signal.aborted && this.isCurrent(turn);
    } finally { signal.removeEventListener("abort", abort); }
  }

  private send(turn: Turn, payload: string | Buffer): boolean {
    try {
      if (turn.retired || turn.socket.readyState !== WebSocket.OPEN ||
          !nonnegative(turn.socket.bufferedAmount) || turn.socket.bufferedAmount > maxAudioBytes) throw new Error();
      turn.socket.send(payload);
      return !turn.retired;
    } catch { this.fail(); return false; }
  }

  async accept(frame: MediaFrame, generation: number, signal: AbortSignal): Promise<Final> {
    if (this.closed || !Number.isSafeInteger(generation) || generation < 1 ||
        !(signal instanceof AbortSignal) || !frame || frame.sessionId !== this.config.sessionId ||
        !Number.isSafeInteger(frame.sequence) || frame.sequence < 0 ||
        typeof frame.capturedAt !== "string" || !Number.isFinite(Date.parse(frame.capturedAt)) ||
        !(frame.bytes instanceof Uint8Array) || frame.bytes.length < 320 ||
        frame.bytes.length > 3_200 || frame.bytes.length % 32 !== 0) return err(failure);
    if (!this.turn && generation <= this.lastGeneration) return err(failure);
    const turn = this.turn ?? this.start(generation);
    if (!turn || turn.generation !== generation || turn.flushing || !await this.ready(turn, signal)) return err(failure);
    if (!this.isCurrent(turn) || turn.flushing) return err(failure);
    if (frame.sequence <= turn.sequence || turn.bytes + frame.bytes.length > maxAudioBytes) {
      this.fail(); return err(failure);
    }
    turn.sequence = frame.sequence; turn.bytes += frame.bytes.length;
    return this.send(turn, Buffer.from(frame.bytes)) ? ok([]) : err(failure);
  }

  async flush(generation: number, signal: AbortSignal): Promise<Final> {
    const turn = this.turn;
    if (this.closed || !(signal instanceof AbortSignal) || !turn || turn.generation !== generation ||
        turn.flushing || !await this.ready(turn, signal) || !turn.bytes) return err(failure);
    if (!this.isCurrent(turn) || turn.flushing) return err(failure);
    turn.flushing = true;
    return new Promise(resolve => {
      const abort = () => { if (this.isCurrent(turn)) this.fail(); };
      turn.pending = result => { signal.removeEventListener("abort", abort); resolve(result); };
      signal.addEventListener("abort", abort, { once: true });
      turn.finalTimer = setTimeout(abort, deadlineMs);
      if (signal.aborted || !this.send(turn, JSON.stringify({ type: "CloseStream" }))) this.fail();
    });
  }

  async cancel(generation: number): Promise<void> {
    if (this.turn?.generation === generation) this.fail();
  }
  async close(): Promise<void> { this.fail(); }
}
