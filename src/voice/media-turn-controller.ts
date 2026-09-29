import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { TranscriptEvent } from "./turn-assembler.ts";

/** Transport adapters decode and resample provider audio before creating this frame. */
export type MediaFrame = Readonly<{ sessionId: string; sequence: number; capturedAt: string; bytes: Uint8Array }>;
export type MediaFailure = Readonly<{ kind: "invalidMedia" | "mediaOutOfOrder" | "mediaOverloaded" |
  "mediaClosed" | "mediaUnavailable" | "targetUnavailable" | "transcriptionUnavailable" | "turnTooLong" }>;
export type MediaProgress<T> =
  | Readonly<{ kind: "listening" | "speaking" }>
  | Readonly<{ kind: "turnCompleted"; value: T }>;
export type TranscriptionFailure = Readonly<{ kind: "transcriptionUnavailable" }>;

/** A provider may stream internally, but this boundary returns events in frame order. */
export type TranscriptionPort = Readonly<{
  accept(frame: MediaFrame, generation: number, signal: AbortSignal): Promise<Result<readonly TranscriptEvent[], TranscriptionFailure>>;
  flush(generation: number, signal: AbortSignal): Promise<Result<readonly TranscriptEvent[], TranscriptionFailure>>;
  cancel?(generation: number): Promise<void>;
  close?(): Promise<void>;
}>;

export type MediaTurnTarget<T, F> = Readonly<{
  speechStarted(now: string): Promise<Result<number, F>>;
  acceptTranscript(event: TranscriptEvent): Result<void, F>;
  finishTurn(now: string): Promise<Result<T, F>>;
}>;

export type MediaTurnOptions = Readonly<{
  speechThreshold?: number;
  speechStartMs?: number;
  silenceMs?: number;
  maxTurnMs?: number;
  maxQueuedFrames?: number;
  transcriptionDeadlineMs?: number;
}>;

function decodedFrame(frame: MediaFrame, sessionId: string): number | undefined {
  if (!frame || frame.sessionId !== sessionId || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0 ||
      typeof frame.capturedAt !== "string" || !Number.isFinite(Date.parse(frame.capturedAt)) ||
      !(frame.bytes instanceof Uint8Array) || frame.bytes.length < 320 || frame.bytes.length > 3_200 ||
      frame.bytes.length % 32 !== 0) return undefined;
  return frame.bytes.length / 32;
}

function averageAmplitude(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let total = 0;
  for (let offset = 0; offset < bytes.length; offset += 2) total += Math.abs(view.getInt16(offset, true));
  return total / (bytes.length / 2);
}

/** Bounded, process-local endpointing. Audio and partial hypotheses never enter the ledger. */
export class MediaTurnController<T, F> {
  private readonly sessionId: string;
  private readonly target: MediaTurnTarget<T, F>;
  private readonly transcription: TranscriptionPort;
  private readonly speechThreshold: number;
  private readonly speechStartMs: number;
  private readonly silenceMs: number;
  private readonly maxTurnMs: number;
  private readonly maxQueuedFrames: number;
  private readonly transcriptionDeadlineMs: number;
  private nextSequence = 0;
  private lastCapturedMs = Number.NEGATIVE_INFINITY;
  private queuedFrames = 0;
  private queue: Promise<void> = Promise.resolve();
  private activeAbort: (() => void) | undefined;
  private closed = false;
  private candidate: MediaFrame[] = [];
  private candidateMs = 0;
  private generation: number | undefined;
  private turnMs = 0;
  private trailingSilenceMs = 0;

  idle(): boolean {
    return !this.closed && this.queuedFrames === 0 && this.generation === undefined && this.candidateMs === 0;
  }

  constructor(sessionId: string, target: MediaTurnTarget<T, F>, transcription: TranscriptionPort,
              options: MediaTurnOptions = {}) {
    const speechThreshold = options.speechThreshold ?? 700;
    const speechStartMs = options.speechStartMs ?? 40;
    const silenceMs = options.silenceMs ?? 700;
    const maxTurnMs = options.maxTurnMs ?? 20_000;
    const maxQueuedFrames = options.maxQueuedFrames ?? 32;
    const transcriptionDeadlineMs = options.transcriptionDeadlineMs ?? 2_000;
    if (!sessionId?.trim() || sessionId.length > 256 ||
        !Number.isSafeInteger(speechThreshold) || speechThreshold < 1 || speechThreshold > 10_000 ||
        !Number.isSafeInteger(speechStartMs) || speechStartMs < 10 || speechStartMs > 200 ||
        !Number.isSafeInteger(silenceMs) || silenceMs < 100 || silenceMs > 3_000 ||
        !Number.isSafeInteger(maxTurnMs) || maxTurnMs < 1_000 || maxTurnMs > 60_000 ||
        !Number.isSafeInteger(maxQueuedFrames) || maxQueuedFrames < 1 || maxQueuedFrames > 64 ||
        !Number.isSafeInteger(transcriptionDeadlineMs) || transcriptionDeadlineMs < 50 || transcriptionDeadlineMs > 10_000) {
      throw new RangeError("invalid media turn configuration");
    }
    this.sessionId = sessionId;
    this.target = target;
    this.transcription = transcription;
    this.speechThreshold = speechThreshold;
    this.speechStartMs = speechStartMs;
    this.silenceMs = silenceMs;
    this.maxTurnMs = maxTurnMs;
    this.maxQueuedFrames = maxQueuedFrames;
    this.transcriptionDeadlineMs = transcriptionDeadlineMs;
  }

  private async transcriptionResult(operation: (signal: AbortSignal) => Promise<Result<readonly TranscriptEvent[], TranscriptionFailure>>):
    Promise<Result<readonly TranscriptEvent[], TranscriptionFailure>> {
    const controller = new AbortController();
    const canceled = new Promise<Result<readonly TranscriptEvent[], TranscriptionFailure>>(resolve => {
      controller.signal.addEventListener("abort", () => resolve(err({ kind: "transcriptionUnavailable" })), { once: true });
    });
    const abort = () => controller.abort();
    this.activeAbort = abort;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Result<readonly TranscriptEvent[], TranscriptionFailure>>(resolve => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(err({ kind: "transcriptionUnavailable" }));
      }, this.transcriptionDeadlineMs);
    });
    try { return await Promise.race([operation(controller.signal), deadline, canceled]); }
    catch { return err({ kind: "transcriptionUnavailable" }); }
    finally {
      if (timeout) clearTimeout(timeout);
      if (this.activeAbort === abort) this.activeAbort = undefined;
    }
  }

  private async acceptEvents(events: readonly TranscriptEvent[]): Promise<Result<void, F | MediaFailure>> {
    if (!Array.isArray(events)) return err({ kind: "transcriptionUnavailable" });
    for (const event of events) {
      let accepted: Result<void, F>;
      try { accepted = this.target.acceptTranscript(event); }
      catch { return err({ kind: "targetUnavailable" }); }
      if (!accepted.ok) return accepted;
    }
    return ok(undefined);
  }

  private async transcribe(frame: MediaFrame, generation: number): Promise<Result<void, F | MediaFailure>> {
    const result = await this.transcriptionResult(signal => this.transcription.accept(frame, generation, signal));
    if (!result?.ok) return err({ kind: "transcriptionUnavailable" });
    return this.acceptEvents(result.value);
  }

  private async process(frame: MediaFrame, durationMs: number): Promise<Result<MediaProgress<T>, F | MediaFailure>> {
    const voiced = averageAmplitude(frame.bytes) >= this.speechThreshold;
    if (this.generation === undefined) {
      if (!voiced) {
        this.candidate = [];
        this.candidateMs = 0;
        return ok({ kind: "listening" });
      }
      this.candidate.push(frame);
      this.candidateMs += durationMs;
      if (this.candidateMs < this.speechStartMs) return ok({ kind: "listening" });
      let started: Result<number, F>;
      try { started = await this.target.speechStarted(frame.capturedAt); }
      catch { this.closed = true; return err({ kind: "targetUnavailable" }); }
      if (!started.ok) { this.closed = true; return started; }
      this.generation = started.value;
      this.turnMs = this.candidateMs;
      for (const buffered of this.candidate) {
        const accepted = await this.transcribe(buffered, started.value);
        if (!accepted.ok) { this.closed = true; return accepted; }
      }
      this.candidate = [];
      this.candidateMs = 0;
      return ok({ kind: "speaking" });
    }

    this.turnMs += durationMs;
    if (this.turnMs > this.maxTurnMs) {
      this.closed = true;
      return err({ kind: "turnTooLong" });
    }
    const accepted = await this.transcribe(frame, this.generation);
    if (!accepted.ok) { this.closed = true; return accepted; }
    this.trailingSilenceMs = voiced ? 0 : this.trailingSilenceMs + durationMs;
    if (this.trailingSilenceMs < this.silenceMs) return ok({ kind: "speaking" });
    const flushed = await this.transcriptionResult(signal => this.transcription.flush(this.generation!, signal));
    if (!flushed?.ok) { this.closed = true; return err({ kind: "transcriptionUnavailable" }); }
    const finals = await this.acceptEvents(flushed.value);
    if (!finals.ok) { this.closed = true; return finals; }
    let completed: Result<T, F>;
    try { completed = await this.target.finishTurn(frame.capturedAt); }
    catch { this.closed = true; return err({ kind: "targetUnavailable" }); }
    this.generation = undefined;
    this.turnMs = 0;
    this.trailingSilenceMs = 0;
    return completed.ok ? ok({ kind: "turnCompleted", value: completed.value }) : completed;
  }

  acceptMedia(frame: MediaFrame): Promise<Result<MediaProgress<T>, F | MediaFailure>> {
    if (this.closed) return Promise.resolve(err({ kind: "mediaClosed" }));
    const durationMs = decodedFrame(frame, this.sessionId);
    if (durationMs === undefined) return Promise.resolve(err({ kind: "invalidMedia" }));
    const capturedMs = Date.parse(frame.capturedAt);
    if (frame.sequence !== this.nextSequence || capturedMs < this.lastCapturedMs) {
      return Promise.resolve(err({ kind: "mediaOutOfOrder" }));
    }
    if (this.queuedFrames >= this.maxQueuedFrames) return Promise.resolve(err({ kind: "mediaOverloaded" }));
    this.nextSequence += 1;
    this.lastCapturedMs = capturedMs;
    this.queuedFrames += 1;
    const copy: MediaFrame = { ...frame, bytes: new Uint8Array(frame.bytes) };
    const processing = this.queue.then(() => this.closed
      ? err<MediaFailure>({ kind: "mediaClosed" })
      : this.process(copy, durationMs)).catch(() => {
      this.closed = true;
      return err<MediaFailure>({ kind: "mediaUnavailable" });
    });
    this.queue = processing.then(() => { this.queuedFrames -= 1; });
    return processing;
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.activeAbort?.();
    await this.queue;
    this.candidate = [];
    const generation = this.generation;
    this.generation = undefined;
    if (generation !== undefined) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => this.transcription.cancel?.(generation)),
          new Promise<void>(resolve => { timeout = setTimeout(resolve, this.transcriptionDeadlineMs); }),
        ]);
      } catch { /* media already closed */ }
      finally { if (timeout) clearTimeout(timeout); }
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => this.transcription.close?.()),
        new Promise<void>(resolve => { timeout = setTimeout(resolve, this.transcriptionDeadlineMs); }),
      ]);
    } catch { /* media already closed */ }
    finally { if (timeout) clearTimeout(timeout); }
  }
}
