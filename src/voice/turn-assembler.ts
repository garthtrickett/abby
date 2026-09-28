import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { FinalCallerTurn, Result } from "../core/model.ts";

export type TranscriptEvent =
  | Readonly<{ kind: "partial"; sessionId: string; generation: number; utteranceId: string; text: string }>
  | Readonly<{ kind: "segmentFinal"; sessionId: string; generation: number; utteranceId: string; text: string; quality: FinalCallerTurn["quality"] }>;

export type TranscriptFailure = Readonly<{ kind: "staleGeneration" | "keyMismatch" | "invalidTranscript" | "noFinalSpeech" }>;

export class TurnAssembler {
  private readonly callId: string;
  private readonly sessionId: string;
  private readonly namespace: string;
  private generation = 0;
  private segments = new Map<string, Extract<TranscriptEvent, { kind: "segmentFinal" }>>();
  private completed: FinalCallerTurn | undefined;

  constructor(callId: string, sessionId: string, namespace = "call") {
    this.callId = callId;
    this.sessionId = sessionId;
    this.namespace = namespace;
  }

  beginSpeech(): number {
    this.generation += 1;
    this.segments = new Map();
    this.completed = undefined;
    return this.generation;
  }

  accept(event: TranscriptEvent): Result<void, TranscriptFailure> {
    if (event.sessionId !== this.sessionId || event.generation !== this.generation || this.generation === 0) return err({ kind: "staleGeneration" });
    if (!event.utteranceId || !event.text.trim() || this.completed) return err({ kind: "invalidTranscript" });
    if (event.kind === "partial") return ok(undefined);
    const previous = this.segments.get(event.utteranceId);
    if (previous) {
      return previous.text === event.text && previous.quality === event.quality ? ok(undefined) : err({ kind: "keyMismatch" });
    }
    this.segments.set(event.utteranceId, event);
    return ok(undefined);
  }

  finish(at: string): Result<FinalCallerTurn, TranscriptFailure> {
    if (this.completed) return ok(this.completed);
    if (!Number.isFinite(Date.parse(at))) return err({ kind: "invalidTranscript" });
    const segments = [...this.segments.values()];
    if (!segments.length) return err({ kind: "noFinalSpeech" });
    const text = segments.map(segment => segment.text.trim()).join(" ");
    const turnId = createHash("sha256").update(JSON.stringify([this.callId, this.sessionId, this.namespace,
      this.generation, segments.map(segment => segment.utteranceId)])).digest("hex");
    this.completed = {
      callId: this.callId,
      sessionId: this.sessionId,
      turnId,
      text,
      quality: segments.some(segment => segment.quality === "needsClarification") ? "needsClarification" : "clear",
      at,
    };
    return ok(this.completed);
  }

  currentGeneration(): number {
    return this.generation;
  }
}
