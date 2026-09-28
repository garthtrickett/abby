import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { CallState, LocationScope, PendingLocationCall, Result } from "../core/model.ts";
import { callIdFor } from "./admission.ts";
import type { AuthenticatedInboundCall } from "./admission.ts";
import { MediaTurnController } from "./media-turn-controller.ts";
import type { MediaFailure, MediaFrame, MediaTurnOptions, TranscriptionPort } from "./media-turn-controller.ts";
import { SharedNumberIntakeService } from "./shared-number-intake.ts";
import { SharedNumberVoiceCall } from "./shared-number-voice-call.ts";
import type { FullVoiceSessionFactory, SharedVoiceFailure, SharedVoiceStart, SharedVoiceTurn } from "./shared-number-voice-call.ts";
import { StreamedPlaybackPort } from "./streamed-playback-port.ts";
import type { AudioOutputPort, PlaybackCompletion, PlaybackEvidenceFailure, SpeechSynthesisPort,
  StreamedPlaybackOptions } from "./streamed-playback-port.ts";
import type { DispatchResult } from "./voice-session.ts";
import type { PrelocationPromptResult } from "./prelocation-voice-session.ts";

export type ConnectedVoiceCallConfig = Readonly<{
  event: AuthenticatedInboundCall;
  sessionId: string;
  ledger: LedgerStore;
  intake: SharedNumberIntakeService;
  fullFactory: FullVoiceSessionFactory;
  transcription: TranscriptionPort;
  synthesis: SpeechSynthesisPort;
  output: AudioOutputPort;
  monotonicNow?: () => number;
  mediaOptions?: MediaTurnOptions;
  playbackOptions?: StreamedPlaybackOptions;
}>;

export type ConnectedVoiceFailure = SharedVoiceFailure | MediaFailure | PlaybackEvidenceFailure |
  Readonly<{ kind: "notStarted" }>;
export type ConnectedVoiceStart =
  | Extract<SharedVoiceStart, { kind: "locationChoice" }>
  | (Extract<SharedVoiceStart, { kind: "admitted" }> & Readonly<{ delivery: DispatchResult }>);
export type ConnectedVoiceProgress =
  | Readonly<{ kind: "listening" | "speaking" }>
  | Readonly<{ kind: "turnCompleted"; turn: SharedVoiceTurn;
    delivery: DispatchResult | PrelocationPromptResult }>;

/** Owns one authenticated call's synthetic media, durable playback evidence, and disconnect cleanup. */
export class ConnectedVoiceCall {
  private readonly call: SharedNumberVoiceCall;
  private readonly media: MediaTurnController<SharedVoiceTurn, SharedVoiceFailure>;
  private readonly playback: StreamedPlaybackPort;
  private readonly ledger: LedgerStore;
  private readonly callId: string;
  private scope: LocationScope | undefined;
  private begun = false;
  private starting = false;
  private closing = false;
  private stopped = false;
  private terminal: PendingLocationCall | CallState | undefined;

  constructor(config: ConnectedVoiceCallConfig) {
    this.ledger = config.ledger;
    this.callId = callIdFor(config.event.key);
    const gatedOutput: AudioOutputPort = {
      queueChunk: (id, sequence, bytes, signal) => this.closing || this.stopped || this.terminal
        ? Promise.resolve("notSent") : config.output.queueChunk(id, sequence, bytes, signal),
      finishQueue: (id, sequence, signal) => this.closing || this.stopped || this.terminal
        ? Promise.resolve("notSent") : config.output.finishQueue(id, sequence, signal),
      clear: id => config.output.clear(id),
    };
    this.playback = new StreamedPlaybackPort(config.synthesis, gatedOutput, config.playbackOptions);
    this.call = new SharedNumberVoiceCall(config.event, config.sessionId, config.ledger, config.intake,
      this.playback, config.fullFactory, config.monotonicNow);
    this.media = new MediaTurnController(config.sessionId, this.call, config.transcription, config.mediaOptions);
  }

  async begin(now: string): Promise<Result<ConnectedVoiceStart, ConnectedVoiceFailure>> {
    if (this.closing || this.stopped || this.terminal) return err({ kind: "disconnected" });
    if (this.begun || this.starting) return err({ kind: "invalidTransition" });
    this.starting = true;
    try {
      const started = await this.call.begin(now);
      if (this.closing || this.stopped || this.terminal) return err({ kind: "disconnected" });
      if (!started.ok) {
        await this.close(now, "sessionClosed");
        return started;
      }
      this.begun = true;
      if (started.value.kind === "locationChoice") return ok(started.value);
      this.scope = started.value.receipt.scope;
      const delivered = await this.call.dispatchPending(now);
      if (!delivered.ok) {
        await this.close(now, "sessionClosed");
        return delivered;
      }
      return ok({ ...started.value, delivery: delivered.value });
    } catch {
      if (!this.closing) await this.close(now, "sessionClosed");
      return err({ kind: "targetUnavailable" });
    } finally {
      this.starting = false;
    }
  }

  private fatalFailure(kind: string): boolean {
    return !["invalidMedia", "mediaOutOfOrder", "mediaOverloaded",
      "noFinalSpeech", "confirmationMissing", "locationChoiceUnclear"].includes(kind);
  }

  async acceptMedia(frame: MediaFrame): Promise<Result<ConnectedVoiceProgress, ConnectedVoiceFailure>> {
    if (this.closing || this.stopped || this.terminal) return err({ kind: "disconnected" });
    if (!this.begun) return err({ kind: "notStarted" });
    const result = await this.media.acceptMedia(frame);
    if (!result.ok) {
      if (this.fatalFailure(result.error.kind)) await this.close(frame.capturedAt, "sessionClosed");
      return result;
    }
    if (result.value.kind !== "turnCompleted") return ok({ kind: result.value.kind });
    const turn = result.value.value;
    if (this.closing || this.stopped || this.terminal) return err({ kind: "disconnected" });
    try {
      if (turn.kind === "locationBound") this.scope = turn.receipt.scope;
      if (turn.kind === "callerTurn") {
        const drained = await this.call.drainEffects(frame.capturedAt);
        if (!drained.ok) {
          await this.close(frame.capturedAt, "sessionClosed");
          return drained;
        }
      }
      if (this.closing || this.stopped || this.terminal) return err({ kind: "disconnected" });
      const delivery = await this.call.dispatchPending(frame.capturedAt);
      if (!delivery.ok) {
        await this.close(frame.capturedAt, "sessionClosed");
        return delivery;
      }
      return ok({ kind: "turnCompleted", turn, delivery: delivery.value });
    } catch {
      await this.close(frame.capturedAt, "sessionClosed");
      return err({ kind: "targetUnavailable" });
    }
  }

  private async alreadySettled(event: PlaybackCompletion): Promise<PendingLocationCall | CallState | undefined> {
    if (!this.scope) {
      const pending = await this.ledger.findPendingLocation(this.callId);
      return pending.ok && pending.value?.prompt?.playbackId === event.playbackId &&
        pending.value.prompt.status === event.status ? pending.value : undefined;
    }
    if (!event.playbackId.endsWith(":playback")) return undefined;
    const presentationId = event.playbackId.slice(0, -":playback".length);
    const stored = await this.ledger.read(this.callId, this.scope);
    return stored.ok && stored.value.presentations[presentationId]?.status === event.status
      ? stored.value : undefined;
  }

  /** Validated provider evidence is retried by ID if the first durable acknowledgment is lost. */
  async acceptPlaybackCompletion(event: PlaybackCompletion, now: string):
    Promise<Result<PendingLocationCall | CallState, ConnectedVoiceFailure>> {
    if (this.closing || this.stopped || this.terminal) return err({ kind: "disconnected" });
    if (!this.begun) return err({ kind: "notStarted" });
    let state: PendingLocationCall | CallState | undefined;
    const completed = await this.playback.acceptCompletion(event, async evidence => {
      const settled = await this.call.acceptPlaybackResult(evidence.playbackId, evidence.status, now);
      if (settled.ok) { state = settled.value; return true; }
      state = await this.alreadySettled(evidence);
      return state !== undefined;
    });
    if (!completed.ok) return completed;
    return state ? ok(state) : err({ kind: "settlementUnavailable" });
  }

  private async close(now: string, reason: "callerDisconnected" | "sessionClosed"):
    Promise<Result<PendingLocationCall | CallState, ConnectedVoiceFailure>> {
    if (this.terminal) return ok(this.terminal);
    if (!this.begun && !this.starting && !this.stopped) return err({ kind: "notStarted" });
    if (this.closing) return err({ kind: "deliveryBlocked" });
    this.closing = true;
    this.stopped = true;
    try {
      await this.media.stop();
      const ended = await this.call.end(now, reason);
      if (ended.ok) this.terminal = ended.value;
      return ended;
    } catch { return err({ kind: "targetUnavailable" }); }
    finally { this.closing = false; }
  }

  disconnect(now: string): Promise<Result<PendingLocationCall | CallState, ConnectedVoiceFailure>> {
    return this.close(now, "callerDisconnected");
  }
}
