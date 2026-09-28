import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { PlaybackPort } from "./voice-session.ts";

/** Synthesis adapters yield normalized mono PCM16LE at 16 kHz in 10–100 ms chunks. */
export type SpeechSynthesisPort = Readonly<{
  stream(approvedText: string, signal: AbortSignal): AsyncIterable<Uint8Array>;
}>;

/** Queue acceptance is distinct from proof that the final chunk played. */
export type AudioOutputPort = Readonly<{
  queueChunk(playbackId: string, sequence: number, bytes: Uint8Array, signal: AbortSignal):
    Promise<"queued" | "notSent" | "uncertain">;
  finishQueue(playbackId: string, lastSequence: number, signal: AbortSignal):
    Promise<"queued" | "notSent" | "uncertain">;
  /** A true result proves queued and in-flight chunks for this ID cannot play later. */
  clear(playbackId: string): Promise<boolean>;
}>;

export type PlaybackCompletion = Readonly<{
  playbackId: string;
  lastSequence: number;
  status: "played" | "failed";
}>;
export type PlaybackEvidenceFailure = Readonly<{
  kind: "playbackUnknown" | "playbackNotQueued" | "invalidPlaybackEvidence" | "settlementUnavailable";
}>;
export type StreamedPlaybackOptions = Readonly<{ stepDeadlineMs?: number; maxChunks?: number }>;

type StreamState = {
  abort: AbortController;
  canceled: boolean;
  queued: boolean;
  attemptedSend: boolean;
  sentCount: number;
  lastSequence: number;
  settling: boolean;
  completion?: PlaybackCompletion;
};

function validChunk(bytes: unknown): bytes is Uint8Array {
  return bytes instanceof Uint8Array && bytes.length >= 320 && bytes.length <= 3_200 && bytes.length % 32 === 0;
}

/** One process-local output adapter per live call. The provider authenticates completion evidence. */
export class StreamedPlaybackPort implements PlaybackPort {
  private readonly synthesis: SpeechSynthesisPort;
  private readonly output: AudioOutputPort;
  private readonly stepDeadlineMs: number;
  private readonly maxChunks: number;
  private readonly streams = new Map<string, StreamState>();
  private readonly retired = new Set<string>();

  constructor(synthesis: SpeechSynthesisPort, output: AudioOutputPort, options: StreamedPlaybackOptions = {}) {
    const stepDeadlineMs = options.stepDeadlineMs ?? 2_000;
    const maxChunks = options.maxChunks ?? 3_000;
    if (!Number.isSafeInteger(stepDeadlineMs) || stepDeadlineMs < 50 || stepDeadlineMs > 10_000 ||
        !Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 6_000) {
      throw new RangeError("invalid streamed playback configuration");
    }
    this.synthesis = synthesis;
    this.output = output;
    this.stepDeadlineMs = stepDeadlineMs;
    this.maxChunks = maxChunks;
  }

  private async bounded<T>(operation: () => Promise<T>, abort?: AbortController): Promise<Result<T, undefined>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation).then(value => ok(value), () => err(undefined)),
        new Promise<Result<T, undefined>>(resolve => {
          timer = setTimeout(() => { abort?.abort(); resolve(err(undefined)); }, this.stepDeadlineMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async failed(playbackId: string, state: StreamState, definitelyNotSent = false):
    Promise<"notSent" | "uncertain"> {
    state.canceled = true;
    state.abort.abort();
    if (state.attemptedSend) await this.bounded(() => this.output.clear(playbackId));
    return state.attemptedSend && !definitelyNotSent ? "uncertain" : "notSent";
  }

  async enqueue(playbackId: string, approvedText: string, canSend: () => boolean):
    Promise<"queued" | "notSent" | "uncertain"> {
    if (!playbackId?.trim() || !approvedText?.trim() || typeof canSend !== "function") return "notSent";
    if (this.streams.has(playbackId) || this.retired.has(playbackId)) return "uncertain";
    const state: StreamState = { abort: new AbortController(), canceled: false, queued: false,
      attemptedSend: false, sentCount: 0, lastSequence: -1, settling: false };
    this.streams.set(playbackId, state);
    try {
      const source = this.synthesis.stream(approvedText, state.abort.signal);
      const iterator = source[Symbol.asyncIterator]();
      for (let sequence = 0; sequence < this.maxChunks; sequence += 1) {
        if (state.canceled || !canSend()) return this.failed(playbackId, state);
        const next = await this.bounded(() => iterator.next(), state.abort);
        if (!next.ok) return this.failed(playbackId, state);
        if (next.value.done) {
          if (!state.sentCount || state.canceled || !canSend()) return this.failed(playbackId, state);
          state.attemptedSend = true;
          const finished = await this.bounded(
            () => state.canceled || !canSend() ? Promise.resolve("notSent" as const)
              : this.output.finishQueue(playbackId, state.lastSequence, state.abort.signal), state.abort);
          if (!finished.ok || finished.value !== "queued" || state.canceled || !canSend()) {
            return this.failed(playbackId, state);
          }
          state.queued = true;
          return "queued";
        }
        if (!validChunk(next.value.value) || state.canceled || !canSend()) return this.failed(playbackId, state);
        const bytes = new Uint8Array(next.value.value);
        state.attemptedSend = true;
        const sent = await this.bounded(
          () => state.canceled || !canSend() ? Promise.resolve("notSent" as const)
            : this.output.queueChunk(playbackId, sequence, bytes, state.abort.signal), state.abort);
        if (!sent.ok || sent.value !== "queued" || state.canceled) {
          return this.failed(playbackId, state, sent.ok && sent.value === "notSent" && state.sentCount === 0);
        }
        state.sentCount += 1;
        state.lastSequence = sequence;
      }
      return this.failed(playbackId, state);
    } catch {
      return this.failed(playbackId, state);
    } finally {
      if (!state.queued) {
        this.streams.delete(playbackId);
        this.retired.add(playbackId);
      }
    }
  }

  async clear(playbackId: string): Promise<boolean> {
    this.retired.add(playbackId);
    const state = this.streams.get(playbackId);
    if (state) {
      state.canceled = true;
      state.abort.abort();
      this.streams.delete(playbackId);
    }
    const cleared = await this.bounded(() => this.output.clear(playbackId));
    return cleared.ok && cleared.value === true;
  }

  /** Retain provider evidence for an exact retry until its durable voice-session settlement succeeds. */
  async acceptCompletion(event: PlaybackCompletion, settle: (event: PlaybackCompletion) => Promise<boolean>):
    Promise<Result<PlaybackCompletion, PlaybackEvidenceFailure>> {
    if (!event || typeof event.playbackId !== "string" ||
        !Number.isSafeInteger(event.lastSequence) || event.lastSequence < 0 ||
        (event.status !== "played" && event.status !== "failed")) {
      return err({ kind: "invalidPlaybackEvidence" });
    }
    const state = this.streams.get(event.playbackId);
    if (!state) return err({ kind: "playbackUnknown" });
    if (!state.queued || state.canceled || state.settling) return err({ kind: "playbackNotQueued" });
    if (event.lastSequence !== state.lastSequence) return err({ kind: "invalidPlaybackEvidence" });
    if (state.completion && state.completion.status !== event.status) return err({ kind: "invalidPlaybackEvidence" });
    state.completion = event;
    state.settling = true;
    try {
      const result = await this.bounded(() => settle(event));
      if (!result.ok || !result.value || state.canceled) return err({ kind: "settlementUnavailable" });
      this.streams.delete(event.playbackId);
      this.retired.add(event.playbackId);
      return ok(event);
    } finally { state.settling = false; }
  }
}
