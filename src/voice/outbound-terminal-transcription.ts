import { randomUUID } from "node:crypto";
import { err } from "../core/model.ts";
import type { FinalCallerTurn, Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import type { MediaFrame, TranscriptionFailure, TranscriptionPort } from "./media-turn-controller.ts";
import type { TranscriptEvent } from "./turn-assembler.ts";
import type { OutboundContactStopPolicy } from "./outbound-contact-stop.ts";

type TranscriptionResult = Result<readonly TranscriptEvent[], TranscriptionFailure>;
const unavailable = (): TranscriptionResult => err({ kind: "transcriptionUnavailable" });

/** Owns a bounded public-ASR tail independently of clinical cancellation. It
 * never finishes a clinical turn and never attests negative/all-call coverage.
 * Private keypad audio never crosses this existing transcription interface. */
export class OutboundTerminalTranscription {
  readonly #raw: TranscriptionPort;
  readonly #callId: string;
  readonly #sessionId: string;
  readonly #deadline: number;
  readonly #now: () => string;
  readonly #policy: () => OutboundContactStopPolicy | undefined;
  readonly #controllers = new Set<AbortController>();
  readonly #pending = new Set<Promise<TranscriptionResult>>();
  readonly #segments = new Map<string, Extract<TranscriptEvent, { kind: "segmentFinal" }>>();
  readonly #partials = new Set<string>();
  #generation: number | undefined;
  #lastFrameAt = "";
  #bad = false;
  #cancelled = false;
  #closing = false;
  #sealed = false;
  #flush: Promise<TranscriptionResult> | undefined;
  readonly #queued = new Map<number, MediaFrame>();
  #lostThrough = -1;
  #lastAccepted = -1;
  #drained: Promise<readonly FinalCallerTurn[]> | undefined;
  #finished: Promise<void> | undefined;
  #closed: Promise<void> | undefined;

  constructor(raw: TranscriptionPort, config: Readonly<{ callId: string; sessionId: string; deadlineMs: number;
    now: () => string; policy: () => OutboundContactStopPolicy | undefined }>) {
    if (!config.callId || !config.sessionId || !Number.isSafeInteger(config.deadlineMs) || config.deadlineMs < 50 || config.deadlineMs > 10000)
      throw Error("Invalid terminal transcription ownership");
    this.#raw = Object.freeze({ accept: raw.accept.bind(raw), flush: raw.flush.bind(raw),
      ...(raw.cancel ? { cancel: raw.cancel.bind(raw) } : {}), ...(raw.close ? { close: raw.close.bind(raw) } : {}) });
    this.#callId = config.callId; this.#sessionId = config.sessionId; this.#deadline = config.deadlineMs;
    this.#now = config.now; this.#policy = config.policy;
  }

  #observe(generation: number, result: TranscriptionResult): void {
    if (this.#sealed || generation !== this.#generation) return;
    if (!result.ok || !Array.isArray(result.value)) { this.#bad = true; return; }
    for (const event of result.value) {
      if (!event || event.sessionId !== this.#sessionId || event.generation !== generation ||
          !["partial", "segmentFinal"].includes(event.kind) || typeof event.utteranceId !== "string" || !event.utteranceId || event.utteranceId.length > 256 ||
          typeof event.text !== "string" || !event.text.trim() || event.text.length > 512) { this.#bad = true; return; }
      if (event.kind !== "segmentFinal") {
        if (this.#segments.has(event.utteranceId) || this.#partials.size >= 32) { this.#bad = true; return; }
        this.#partials.add(event.utteranceId); continue;
      }
      this.#partials.delete(event.utteranceId);
      const previous = this.#segments.get(event.utteranceId);
      if (!["clear", "needsClarification"].includes(event.quality) || previous &&
          (previous.text !== event.text || previous.quality !== event.quality)) { this.#bad = true; return; }
      this.#segments.set(event.utteranceId, Object.freeze({ ...event }));
      if (this.#segments.size > 32 || [...this.#segments.values()].reduce((n, e) => n + e.text.length + 1, 0) > 512) {
        this.#bad = true; this.#segments.clear(); return;
      }
    }
  }

  #run(generation: number, operation: (signal: AbortSignal) => Promise<TranscriptionResult>): Promise<TranscriptionResult> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.#deadline);
    this.#controllers.add(controller);
    const result = (async () => {
      try {
        const value = await awaitUntilAbort(Promise.resolve().then(() => controller.signal.aborted ? unavailable() : operation(controller.signal)), controller.signal);
        const result = value && !controller.signal.aborted ? value : unavailable();
        this.#observe(generation, result); return result;
      } catch { const result = unavailable(); this.#observe(generation, result); return result; }
      finally { clearTimeout(timer); controller.abort(); this.#controllers.delete(controller); }
    })();
    this.#pending.add(result); void result.then(() => this.#pending.delete(result)); return result;
  }

  async #forCaller(result: Promise<TranscriptionResult>, signal: AbortSignal): Promise<TranscriptionResult> {
    const abort = () => {
      if (!this.#closing) { this.#cancelled = true; for (const controller of this.#controllers) controller.abort(); }
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try { return await awaitUntilAbort(result, signal) ?? unavailable(); }
    finally { signal.removeEventListener("abort", abort); }
  }

  async #disposeRaw(operation: () => Promise<void> | undefined): Promise<void> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.#deadline);
    try { await awaitUntilAbort(Promise.resolve().then(operation), controller.signal); }
    catch { /* Disposal supplies no positive observation. */ }
    finally { clearTimeout(timer); controller.abort(); }
  }

  readonly transcription: TranscriptionPort = Object.freeze({
    accept: (frame: MediaFrame, generation: number, signal: AbortSignal) => {
      if (this.#closing || signal.aborted || frame.sessionId !== this.#sessionId || !Number.isSafeInteger(generation) || generation < 1 ||
          this.#generation !== undefined && generation < this.#generation) return Promise.resolve(unavailable());
      if (generation !== this.#generation) {
        this.#generation = generation; this.#segments.clear(); this.#partials.clear(); this.#bad = false; this.#cancelled = false; this.#flush = undefined;
      }
      this.#lastFrameAt = frame.capturedAt; this.#lastAccepted = frame.sequence;
      for (const sequence of this.#queued.keys()) if (sequence <= frame.sequence) this.#queued.delete(sequence);
      return this.#forCaller(this.#run(generation, stop => this.#raw.accept(frame, generation, stop)), signal);
    },
    flush: (generation: number, signal: AbortSignal) => {
      if (this.#closing || signal.aborted || generation !== this.#generation || this.#cancelled) return Promise.resolve(unavailable());
      this.#flush ??= this.#run(generation, stop => this.#raw.flush(generation, stop));
      return this.#forCaller(this.#flush, signal);
    },
    cancel: async (generation: number) => {
      if (this.#closing) await this.#drain();
      else if (generation === this.#generation) { this.#cancelled = true; for (const controller of this.#controllers) controller.abort(); }
      await this.#disposeRaw(() => this.#raw.cancel?.(generation));
    },
    close: () => {
      this.finish();
      this.#closed ??= (async () => { await this.#drain(); await this.#disposeRaw(() => this.#raw.close?.()); })();
      return this.#closed;
    },
  });

  /** Only the transport owner may supply validated, unconditionally public
   * frames. Calls with a private keypad adapter retain their private owner and
   * do not enter this queue. This is never an all-call/no-stop witness. */
  bufferPublicFrame(frame: MediaFrame): void {
    if (this.#closing || !this.#policy() || frame.sessionId !== this.#sessionId || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0 ||
        !Number.isFinite(Date.parse(frame.capturedAt)) || !(frame.bytes instanceof Uint8Array) || frame.bytes.length < 320 || frame.bytes.length > 3200) return;
    if (frame.sequence <= this.#lastAccepted || this.#queued.has(frame.sequence)) return;
    this.#queued.set(frame.sequence, Object.freeze({ ...frame, bytes: new Uint8Array(frame.bytes) }));
    if (this.#queued.size > 64) { this.#lostThrough = Math.max(this.#lostThrough, frame.sequence); this.#queued.clear(); }
  }

  #makeTurn(): FinalCallerTurn | undefined {
    if (this.#bad || this.#cancelled || this.#partials.size || !this.#segments.size) return;
    const at = this.#now(), frameAt = Date.parse(this.#lastFrameAt);
    if (!Number.isFinite(frameAt) || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at || Date.parse(at) < frameAt) return;
    const segments = [...this.#segments.values()];
    return Object.freeze({ callId: this.#callId, sessionId: this.#sessionId, turnId: "outbound-terminal:" + randomUUID(),
      text: segments.map(e => e.text.trim()).join(" "), quality: segments.every(e => e.quality === "clear") ? "clear" : "needsClarification", at });
  }

  #drain(): Promise<readonly FinalCallerTurn[]> {
    this.#drained ??= (async () => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.#deadline), completed: FinalCallerTurn[] = [];
      try {
        if (!this.#policy()) return completed;
        await awaitUntilAbort(Promise.all([...this.#pending]), controller.signal);
        if (controller.signal.aborted || this.#cancelled) return completed;
        // A previously completed ordinary utterance remains independently
        // eligible as positive evidence; an incomplete later tail cannot erase it.
        const alreadyFlushed = this.#flush;
        if (alreadyFlushed) {
          const flushed = await awaitUntilAbort(alreadyFlushed, controller.signal), turn = flushed?.ok ? this.#makeTurn() : undefined;
          if (turn) completed.push(turn);
          if (!flushed?.ok || controller.signal.aborted || this.#bad) return completed;
        }
        if (this.#lostThrough > this.#lastAccepted || this.#bad) return completed;
        const queued = [...this.#queued.values()].sort((a, b) => a.sequence - b.sequence);
        if (queued.length && (alreadyFlushed || this.#generation === undefined)) {
          this.#generation = (this.#generation ?? 0) + 1; this.#segments.clear(); this.#partials.clear(); this.#flush = undefined;
        }
        const generation = this.#generation;
        if (generation === undefined || alreadyFlushed && !queued.length) return completed;
        for (const frame of queued) {
          if (controller.signal.aborted || !this.#policy()) return completed;
          this.#lastFrameAt = frame.capturedAt;
          const accepted = await awaitUntilAbort(this.#run(generation, stop => this.#raw.accept(frame, generation, stop)), controller.signal);
          if (!accepted?.ok || controller.signal.aborted || this.#bad) return completed;
        }
        this.#flush ??= this.#run(generation, stop => this.#raw.flush(generation, stop));
        const flushed = await awaitUntilAbort(this.#flush, controller.signal);
        const turn = flushed?.ok && !controller.signal.aborted ? this.#makeTurn() : undefined;
        if (turn) completed.push(turn); return completed;
      } catch { return completed; }
      finally {
        this.#sealed = true; this.#queued.clear(); clearTimeout(timer); controller.abort();
        for (const pending of this.#controllers) pending.abort();
      }
    })();
    return this.#drained;
  }

  /** Called synchronously when clinical work is revoked; repeated callers join
   * the same ASR drain and separately bounded native positive-stop retention. */
  finish(): Promise<void> {
    this.#closing = true;
    this.#finished ??= (async () => {
      try {
        const turns = await this.#drain();
        for (const turn of turns) {
          const policy = this.#policy();
          if (!policy || !Number.isSafeInteger(policy.retentionDeadlineMs) || policy.retentionDeadlineMs < 1 || policy.retentionDeadlineMs > 120000) return;
          let stop = false;
          try { stop = policy.inspect(turn) === "stop"; } catch { continue; }
          if (!stop) continue;
          const controller = new AbortController(), timer = setTimeout(() => controller.abort(), policy.retentionDeadlineMs);
          try { await awaitUntilAbort(Promise.resolve().then(() => policy.retainStop(turn, controller.signal)), controller.signal); }
          finally { clearTimeout(timer); controller.abort(); }
          break;
        }
      } catch { /* An incomplete tail or native retention never proves contact completion. */ }
      finally { this.#segments.clear(); this.#partials.clear(); }
    })();
    return this.#finished;
  }
}
