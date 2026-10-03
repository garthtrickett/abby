import { err, ok } from "../core/model.ts";
import type { CallState, PendingLocationCall, Result } from "../core/model.ts";
import { ConnectedVoiceCall } from "./connected-voice-call.ts";
import type { ConnectedVoiceCallConfig, ConnectedVoiceFailure, ConnectedVoiceProgress,
  ConnectedVoiceStart } from "./connected-voice-call.ts";
import { TwilioMediaStream } from "./twilio-media-stream.ts";
import type { TwilioStreamConfig, TwilioStreamEvent, TwilioStreamFailure } from "./twilio-media-stream.ts";
import { VoiceLeaseLoop } from "./voice-lease-loop.ts";
import { systemTimer } from "./timer.ts";
import type { TimerPort } from "./timer.ts";

export type TwilioConnectedCallConfig = Omit<ConnectedVoiceCallConfig, "output"> & Readonly<{
  streamStartedAt: string;
  send: TwilioStreamConfig["send"];
  now?: () => string;
  /** Null means the option is intentionally disabled; undefined means its clock failed. */
  keypadAvailabilityRange?: (digit: string) => Readonly<{ from: string; to: string }> | null | undefined;
  leaseTimer?: TimerPort;
  silenceTimer?: TimerPort;
  silenceWaitMs?: number;
  playbackDeadlineMs?: number;
  closeTransport?: (kind: "normal" | "failure") => void;
  /** PHI-free diagnostic: never exposes the renewed call state. */
  onLeaseAttempt?: (outcome: Readonly<{ kind: "renewed" }> |
    Readonly<{ kind: "failed"; reason: string }>) => void;
}>;
export type TwilioConnectedProgress =
  | Readonly<{ kind: "connected" | "ignored" | "stopped" }>
  | Readonly<{ kind: "started"; value: ConnectedVoiceStart }>
  | Readonly<{ kind: "media"; value: ConnectedVoiceProgress }>
  | Readonly<{ kind: "keypad"; value: ConnectedVoiceProgress }>
  | Readonly<{ kind: "played"; value: PendingLocationCall | CallState }>;
export type TwilioConnectedFailure = TwilioStreamFailure | ConnectedVoiceFailure |
  Readonly<{ kind: "streamOverloaded" | "keypadUnavailable" }>;

/** Serializes provider events through Abby's call owner; the host owns signature verification and WebSocket closure. */
export class TwilioConnectedCall {
  readonly stream: TwilioMediaStream;
  private readonly call: ConnectedVoiceCall;
  private readonly now: () => string;
  private readonly keypadAvailabilityRange: ((digit: string) => Readonly<{ from: string; to: string }> | null | undefined) | undefined;
  private readonly lease: VoiceLeaseLoop<PendingLocationCall | CallState, ConnectedVoiceFailure>;
  private readonly silenceTimer: TimerPort;
  private readonly silenceWaitMs: number;
  private readonly playbackDeadlineMs: number;
  private readonly closeTransport: ((kind: "normal" | "failure") => void) | undefined;
  private readonly stopCall: () => void;
  private callStopDelivered = false;
  private tail: Promise<void> = Promise.resolve();
  private outstanding = 0;
  private begun = false;
  private closed = false;
  private silenceHandle: unknown;
  private silenceGeneration = 0;
  private pendingPlayback: Readonly<{ id: string; kind: "normal" | "retry" | "final" }> | undefined;
  private retriedSilence = false;
  private blockedSilenceChecks = 0;

  constructor(config: TwilioConnectedCallConfig) {
    const silenceWaitMs = config.silenceWaitMs ?? 15_000;
    const playbackDeadlineMs = config.playbackDeadlineMs ?? 60_000;
    if (!Number.isSafeInteger(silenceWaitMs) || silenceWaitMs < 3_000 || silenceWaitMs > 60_000 ||
        !Number.isSafeInteger(playbackDeadlineMs) || playbackDeadlineMs < 5_000 || playbackDeadlineMs > 120_000) {
      throw new RangeError("invalid silence timeout configuration");
    }
    this.silenceTimer = config.silenceTimer ?? systemTimer;
    this.silenceWaitMs = silenceWaitMs;
    this.playbackDeadlineMs = playbackDeadlineMs;
    this.stopCall = () => {
      if (this.callStopDelivered) return;
      this.callStopDelivered = true;
      this.call.requestStop();
      try { config.onCallStop?.(); } catch { /* Call shutdown remains required. */ }
    };
    this.stream = new TwilioMediaStream({ accountSid: config.event.key.accountRef,
      callSid: config.event.key.providerCallRef, sessionId: config.sessionId,
      startedAt: config.streamStartedAt, send: config.send });
    this.call = new ConnectedVoiceCall({ event: config.event, sessionId: config.sessionId,
      ledger: config.ledger, intake: config.intake, fullFactory: config.fullFactory,
      speech: config.speech, output: this.stream,
      ...(config.monotonicNow ? { monotonicNow: config.monotonicNow } : {}),
      ...(config.mediaOptions ? { mediaOptions: config.mediaOptions } : {}),
      ...(config.playbackOptions ? { playbackOptions: config.playbackOptions } : {}),
      ...(config.callerCandidateLookup ? { callerCandidateLookup: config.callerCandidateLookup } : {}),
      onCallStop: this.stopCall,
    });
    this.now = config.now ?? (() => new Date().toISOString());
    this.keypadAvailabilityRange = config.keypadAvailabilityRange;
    this.closeTransport = config.closeTransport;
    this.lease = new VoiceLeaseLoop({ renew: now => this.renew(now) }, outcome => {
      try { config.onLeaseAttempt?.(outcome.ok ? { kind: "renewed" } :
        { kind: "failed", reason: outcome.error.kind }); } catch { /* diagnostics cannot interrupt lease loss */ }
      if (!this.closed && !outcome.ok &&
          (outcome.error.kind === "leaseLost" || outcome.error.kind === "sessionUnknown")) {
        void this.failSession().catch(() => undefined);
      }
    }, { clock: this.now, ...(config.leaseTimer ? { timer: config.leaseTimer } : {}) });
  }

  private cancelSilenceTimer(): void {
    this.silenceGeneration += 1;
    if (this.silenceHandle !== undefined) this.silenceTimer.cancel(this.silenceHandle);
    this.silenceHandle = undefined;
  }

  private scheduleSilenceTimer(kind: "listening" | "playback"): void {
    this.cancelSilenceTimer();
    if (this.closed) return;
    const delay = kind === "playback" ? this.playbackDeadlineMs : this.silenceWaitMs;
    const generation = this.silenceGeneration;
    this.silenceHandle = this.silenceTimer.schedule(() => {
      if (generation !== this.silenceGeneration) return;
      this.silenceHandle = undefined;
      const handled = this.tail.then(() => {
        if (generation === this.silenceGeneration) return this.onSilenceTimer(kind);
      }).catch(async () => {
        try { await this.failSession(); } catch { /* shutdown is best effort */ }
      });
      this.tail = handled.then(() => undefined);
    }, delay);
    // An idle call must not keep a finished local test process alive by itself.
    const handle = this.silenceHandle;
    if (handle && typeof handle === "object" && "unref" in handle && typeof handle.unref === "function") handle.unref();
  }

  private watchPlayback(id: string, kind: "normal" | "retry" | "final"): void {
    this.blockedSilenceChecks = 0;
    this.pendingPlayback = { id, kind };
    this.scheduleSilenceTimer("playback");
  }

  private trackDelivery(delivery: Readonly<{ kind: string; playbackId?: string }>, kind: "normal" | "retry" | "final" = "normal"): void {
    if (delivery.kind === "queued" && delivery.playbackId) this.watchPlayback(delivery.playbackId, kind);
    else if (delivery.kind === "none" || delivery.kind === "played") this.scheduleSilenceTimer("listening");
  }

  private async onSilenceTimer(kind: "listening" | "playback"): Promise<void> {
    if (this.closed) return;
    if (kind === "playback") {
      if (this.pendingPlayback) await this.failSession();
      return;
    }
    if (this.pendingPlayback) return;
    const stage = this.retriedSilence ? "final" : "retry";
    const result = await this.call.silenceTimeout(stage, this.now());
    if (!result.ok) {
      if (result.error.kind === "deliveryBlocked") {
        this.blockedSilenceChecks += 1;
        if (this.blockedSilenceChecks >= 2) {
          await this.failSession();
          return;
        }
        this.scheduleSilenceTimer("listening");
        return;
      }
      await this.failSession();
      return;
    }
    if (result.value.kind !== "queued" || !result.value.playbackId) {
      await this.failSession();
      return;
    }
    if (stage === "retry") this.retriedSilence = true;
    this.blockedSilenceChecks = 0;
    this.watchPlayback(result.value.playbackId, stage);
  }

  private renew(now: string): Promise<Result<PendingLocationCall | CallState, ConnectedVoiceFailure>> {
    const handled = this.tail.then(() => this.closed
      ? err<ConnectedVoiceFailure>({ kind: "sessionUnknown" }) : this.call.renew(now))
      .catch(() => err<ConnectedVoiceFailure>({ kind: "targetUnavailable" }));
    this.tail = handled.then(() => undefined);
    return handled;
  }

  private async closeSession(kind: "normal" | "failure"): Promise<void> {
    this.closed = true;
    this.cancelSilenceTimer();
    this.pendingPlayback = undefined;
    this.stopCall();
    void this.lease.stop();
    this.stream.close();
    try { this.closeTransport?.(kind); } catch { /* call cleanup remains required */ }
    if (this.begun) {
      if (kind === "normal") await this.call.finish(this.now());
      else await this.call.disconnect(this.now());
    }
  }

  private failSession(): Promise<void> {
    return this.closeSession("failure");
  }

  private async handle(received: Result<TwilioStreamEvent, TwilioStreamFailure>):
    Promise<Result<TwilioConnectedProgress, TwilioConnectedFailure>> {
    if (this.closed) return err({ kind: "streamClosed" });
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
      try { this.lease.start(); }
      catch { await this.failSession(); return err({ kind: "streamUnavailable" }); }
      this.trackDelivery(started.value.kind === "locationChoice" ? started.value.prompt : started.value.delivery);
      return ok({ kind: "started", value: started.value });
    }
    if (event.kind === "media") {
      const progressed = await this.call.acceptMedia(event.frame);
      if (!progressed.ok) { await this.failSession(); return progressed; }
      if (progressed.value.kind === "speaking") {
        this.cancelSilenceTimer();
        this.pendingPlayback = undefined;
        this.retriedSilence = false;
        this.blockedSilenceChecks = 0;
      } else if (progressed.value.kind === "turnCompleted") this.trackDelivery(progressed.value.delivery);
      return ok({ kind: "media", value: progressed.value });
    }
    if (event.kind === "dtmf") {
      if (!this.keypadAvailabilityRange || !["1", "2", "3"].includes(event.digit)) return ok({ kind: "ignored" });
      const range = this.keypadAvailabilityRange(event.digit);
      if (range === null) return ok({ kind: "ignored" });
      if (!range) { await this.failSession(); return err({ kind: "keypadUnavailable" }); }
      const progressed = await this.call.acceptKeypadAvailabilityRange(range.from, range.to, this.now());
      if (!progressed.ok && progressed.error.kind === "deliveryBlocked") return ok({ kind: "ignored" });
      if (!progressed.ok) { await this.failSession(); return progressed; }
      this.cancelSilenceTimer();
      this.pendingPlayback = undefined;
      this.retriedSilence = false;
      this.blockedSilenceChecks = 0;
      if (progressed.value.kind === "turnCompleted") this.trackDelivery(progressed.value.delivery);
      return ok({ kind: "keypad", value: progressed.value });
    }
    if (event.kind === "played") {
      const completed = await this.call.acceptPlaybackCompletion(event.completion, this.now());
      if (!completed.ok) await this.failSession();
      if (completed.ok && this.pendingPlayback?.id === event.completion.playbackId) {
        const kind = this.pendingPlayback.kind;
        this.pendingPlayback = undefined;
        this.cancelSilenceTimer();
        if (event.completion.status === "failed") await this.failSession();
        else if (kind === "final") await this.closeSession("normal");
        else this.scheduleSilenceTimer("listening");
      }
      return completed.ok ? ok({ kind: "played", value: completed.value }) : completed;
    }
    if (event.kind === "stopped") {
      this.closed = true;
      this.cancelSilenceTimer();
      this.pendingPlayback = undefined;
      this.stopCall();
      void this.lease.stop();
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
    // Decode wire order immediately. A clear fence must be acknowledged while an earlier
    // media turn is awaiting that same fence; semantic call transitions stay serialized.
    const received = this.stream.receive(raw);
    if (!received.ok) this.stopCall();
    if (received.ok && received.value.kind === "stopped") this.stopCall();
    if (received.ok && received.value.kind === "media") this.call.observePendingCorrection(received.value.frame);
    if (received.ok && received.value.kind === "ignoredMark") return Promise.resolve(ok({ kind: "ignored" }));
    if (this.outstanding >= 64) {
      this.closed = true;
      this.cancelSilenceTimer();
      this.stopCall();
      this.stream.close();
      return this.tail.then(async () => {
        await this.failSession();
        return err<TwilioConnectedFailure>({ kind: "streamOverloaded" });
      });
    }
    this.outstanding += 1;
    const handled = this.tail.then(() => this.handle(received)).catch(async () => {
      try { await this.failSession(); } catch { /* original failure remains authoritative */ }
      return err<TwilioConnectedFailure>({ kind: "streamUnavailable" });
    });
    this.tail = handled.then(() => { this.outstanding -= 1; });
    return handled;
  }

  async disconnect(): Promise<Result<PendingLocationCall | CallState | undefined, TwilioConnectedFailure>> {
    this.closed = true;
    this.cancelSilenceTimer();
    this.pendingPlayback = undefined;
    this.stopCall();
    const stopped = this.lease.stop();
    this.stream.close();
    await this.tail;
    await stopped;
    return this.begun ? this.call.disconnect(this.now()) : ok(undefined);
  }
}
