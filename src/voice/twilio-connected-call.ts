import { err, ok } from "../core/model.ts";
import type { CallState, PendingLocationCall, Result } from "../core/model.ts";
import { ConnectedVoiceCall } from "./connected-voice-call.ts";
import type { ConnectedVoiceCallConfig, ConnectedVoiceFailure, ConnectedVoiceProgress,
  ConnectedVoiceStart } from "./connected-voice-call.ts";
import { TwilioMediaStream } from "./twilio-media-stream.ts";
import type { TwilioStreamConfig, TwilioStreamFailure } from "./twilio-media-stream.ts";

export type TwilioConnectedCallConfig = Omit<ConnectedVoiceCallConfig, "output"> & Readonly<{
  streamStartedAt: string;
  send: TwilioStreamConfig["send"];
  now?: () => string;
}>;
export type TwilioConnectedProgress =
  | Readonly<{ kind: "connected" | "ignored" | "stopped" }>
  | Readonly<{ kind: "started"; value: ConnectedVoiceStart }>
  | Readonly<{ kind: "media"; value: ConnectedVoiceProgress }>
  | Readonly<{ kind: "played"; value: PendingLocationCall | CallState }>;
export type TwilioConnectedFailure = TwilioStreamFailure | ConnectedVoiceFailure |
  Readonly<{ kind: "streamOverloaded" }>;

/** Serializes provider events through Abby's call owner; the host owns signature verification and WebSocket closure. */
export class TwilioConnectedCall {
  readonly stream: TwilioMediaStream;
  private readonly call: ConnectedVoiceCall;
  private readonly now: () => string;
  private tail: Promise<void> = Promise.resolve();
  private outstanding = 0;
  private begun = false;
  private closed = false;

  constructor(config: TwilioConnectedCallConfig) {
    this.stream = new TwilioMediaStream({ accountSid: config.event.key.accountRef,
      callSid: config.event.key.providerCallRef, sessionId: config.sessionId,
      startedAt: config.streamStartedAt, send: config.send });
    this.call = new ConnectedVoiceCall({ event: config.event, sessionId: config.sessionId,
      ledger: config.ledger, intake: config.intake, fullFactory: config.fullFactory,
      transcription: config.transcription, synthesis: config.synthesis, output: this.stream,
      ...(config.monotonicNow ? { monotonicNow: config.monotonicNow } : {}),
      ...(config.mediaOptions ? { mediaOptions: config.mediaOptions } : {}),
      ...(config.playbackOptions ? { playbackOptions: config.playbackOptions } : {}),
      ...(config.callerCandidateLookup ? { callerCandidateLookup: config.callerCandidateLookup } : {}),
    });
    this.now = config.now ?? (() => new Date().toISOString());
  }

  private async failSession(): Promise<void> {
    this.closed = true;
    this.stream.close();
    if (this.begun) await this.call.disconnect(this.now());
  }

  private async handle(raw: string | Uint8Array): Promise<Result<TwilioConnectedProgress, TwilioConnectedFailure>> {
    if (this.closed) return err({ kind: "streamClosed" });
    const received = this.stream.receive(raw);
    if (!received.ok) {
      await this.failSession();
      return received;
    }
    const event = received.value;
    if (event.kind === "connected") return ok({ kind: "connected" });
    if (event.kind === "started") {
      const started = await this.call.begin(this.now());
      if (!started.ok) { await this.failSession(); return started; }
      this.begun = true;
      return ok({ kind: "started", value: started.value });
    }
    if (event.kind === "media") {
      const progressed = await this.call.acceptMedia(event.frame);
      if (!progressed.ok) { await this.failSession(); return progressed; }
      return ok({ kind: "media", value: progressed.value });
    }
    if (event.kind === "played") {
      const completed = await this.call.acceptPlaybackCompletion(event.completion, this.now());
      if (!completed.ok) await this.failSession();
      return completed.ok ? ok({ kind: "played", value: completed.value }) : completed;
    }
    if (event.kind === "stopped") {
      this.closed = true;
      if (this.begun) {
        const ended = await this.call.disconnect(this.now());
        if (!ended.ok) return ended;
      }
      return ok({ kind: "stopped" });
    }
    return ok({ kind: "ignored" });
  }

  receive(raw: string | Uint8Array): Promise<Result<TwilioConnectedProgress, TwilioConnectedFailure>> {
    if (this.closed) return Promise.resolve(err({ kind: "streamClosed" }));
    if (this.outstanding >= 64) {
      this.closed = true;
      this.stream.close();
      return this.tail.then(async () => {
        await this.failSession();
        return err<TwilioConnectedFailure>({ kind: "streamOverloaded" });
      });
    }
    this.outstanding += 1;
    const handled = this.tail.then(() => this.handle(raw)).catch(async () => {
      try { await this.failSession(); } catch { /* original failure remains authoritative */ }
      return err<TwilioConnectedFailure>({ kind: "streamUnavailable" });
    });
    this.tail = handled.then(() => { this.outstanding -= 1; });
    return handled;
  }

  async disconnect(): Promise<Result<PendingLocationCall | CallState | undefined, TwilioConnectedFailure>> {
    this.closed = true;
    this.stream.close();
    await this.tail;
    return this.begun ? this.call.disconnect(this.now()) : ok(undefined);
  }
}
