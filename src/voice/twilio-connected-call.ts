import type { MediaFrame } from "./media-turn-controller.ts";
import { callIdFor } from "./admission.ts";
import type { PrivateKeypadInput } from "./private-keypad-input.ts";
import { err, ok } from "../core/model.ts";
import type { CallState, PendingLocationCall, Result } from "../core/model.ts";
import { ConnectedVoiceCall } from "./connected-voice-call.ts";
import type { ConnectedVoiceCallCommonConfig, VoiceCallAdmissionConfig, ConnectedVoiceFailure, ConnectedVoiceProgress,
  ConnectedVoiceStart } from "./connected-voice-call.ts";
import { TwilioMediaStream } from "./twilio-media-stream.ts";
import type { TwilioStreamConfig, TwilioStreamEvent, TwilioStreamFailure } from "./twilio-media-stream.ts";
import { VoiceLeaseLoop } from "./voice-lease-loop.ts";
import { systemTimer } from "./timer.ts";
import type { TimerPort } from "./timer.ts";

export type TwilioConnectedCallConfig = Omit<ConnectedVoiceCallCommonConfig, "output"> & VoiceCallAdmissionConfig & Readonly<{
  streamStartedAt: string;
  /** Opt-in trusted secret entry; the production standalone runner leaves it unset. */
  privateKeypadInput?: PrivateKeypadInput;
  /** Trusted contact-only queue; never receives packets from a call with a private input adapter. */
  onPublicContactMedia?: (frame: MediaFrame) => void;
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
  | Readonly<{ kind: "connected" | "ignored" | "stopped" | "privateInput" }>
  | Readonly<{ kind: "started"; value: ConnectedVoiceStart }>
  | Readonly<{ kind: "media"; value: ConnectedVoiceProgress }>
  | Readonly<{ kind: "keypad"; value: ConnectedVoiceProgress }>
  | Readonly<{ kind: "played"; value: PendingLocationCall | CallState }>;
export type TwilioConnectedFailure = TwilioStreamFailure | ConnectedVoiceFailure |
  Readonly<{ kind: "streamOverloaded" | "keypadUnavailable" | "privateInputUnavailable" }>;

/** Serializes provider events through Abby's call owner; the host owns signature verification and WebSocket closure. */
export class TwilioConnectedCall {
  readonly stream: TwilioMediaStream;
  private readonly privateKeypadInput: PrivateKeypadInput | undefined;
  private readonly onPublicContactMedia: ((frame: MediaFrame) => void) | undefined;
  private privateResuming = false;
  private privateQuietMs = 0;
  private privateQuietUntil: number | undefined;
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
  private locationBound = false;
  private outstanding = 0;
  private begun = false;
  private closed = false;
  private silenceHandle: unknown;
  private silenceGeneration = 0;
  private pendingPlayback: Readonly<{ id: string; kind: "normal" | "retry" | "final" }> | undefined;
  private retriedSilence = false;
  private blockedSilenceChecks = 0;
  private listeningControl: "pause" | "goodbye" | undefined;
  private confirmationWaitMs: number | undefined;

  constructor(config: TwilioConnectedCallConfig) {
    const key = config.entry ? config.entry.key : config.event.key;
    const silenceWaitMs = config.silenceWaitMs ?? 15_000;
    const playbackDeadlineMs = config.playbackDeadlineMs ?? 60_000;
    if (!Number.isSafeInteger(silenceWaitMs) || silenceWaitMs < 3_000 || silenceWaitMs > 60_000 ||
        !Number.isSafeInteger(playbackDeadlineMs) || playbackDeadlineMs < 5_000 || playbackDeadlineMs > 120_000) {
      throw new RangeError("invalid silence timeout configuration");
    }
    if (config.privateKeypadInput && (!config.privateKeypadInput.claim(callIdFor(key), config.sessionId) ||
        config.privateKeypadInput.blocked() !== true)) throw new TypeError("invalid private input ownership");
    this.privateKeypadInput = config.privateKeypadInput;
    this.onPublicContactMedia = config.onPublicContactMedia;
    this.silenceTimer = config.silenceTimer ?? systemTimer;
    this.silenceWaitMs = silenceWaitMs;
    this.playbackDeadlineMs = playbackDeadlineMs;
    this.stopCall = () => {
      if (this.callStopDelivered) return;
      this.callStopDelivered = true;
      try { this.privateKeypadInput?.stop(); } catch { /* Call shutdown remains required. */ }
      this.call.requestStop();
      try { config.onCallStop?.(); } catch { /* Call shutdown remains required. */ }
    };
    this.stream = new TwilioMediaStream({ accountSid: key.accountRef,
      callSid: key.providerCallRef, sessionId: config.sessionId,
      startedAt: config.streamStartedAt, send: config.send });
    this.call = new ConnectedVoiceCall({ ...config, output: this.stream, onCallStop: this.stopCall });
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
    const delay = kind === "playback" ? this.playbackDeadlineMs : this.listeningControl === "goodbye" ? 5_000 :
      this.listeningControl === "pause" ? 30_000 : this.confirmationWaitMs ?? this.silenceWaitMs;
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

  private trackDelivery(delivery: Readonly<{ kind: string; playbackId?: string; conversationControl?: "pause" | "goodbye"; confirmationWaitSeconds?: number }>, kind: "normal" | "retry" | "final" = "normal"): void {
    this.listeningControl = delivery.kind === "queued" ? delivery.conversationControl : undefined;
    // This is an explicit caller-facing wait, starting only after its playback mark.
    // It does not extend confirmation evidence or execute the pending action.
    this.confirmationWaitMs = delivery.kind === "queued" && Number.isSafeInteger(delivery.confirmationWaitSeconds) &&
      delivery.confirmationWaitSeconds! >= 1 && delivery.confirmationWaitSeconds! <= 60 ?
      delivery.confirmationWaitSeconds! * 1000 + 3000 : undefined;
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
    if (this.listeningControl === "goodbye") { await this.closeSession("normal"); return; }
    this.listeningControl = undefined;
    this.confirmationWaitMs = undefined;
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
    if (this.locationBound) return (this.closed
      ? Promise.resolve(err<ConnectedVoiceFailure>({ kind: "sessionUnknown" })) : this.call.renew(now))
      .catch(() => err<ConnectedVoiceFailure>({ kind: "targetUnavailable" }));
    const handled = this.tail.then(() => this.closed
      ? err<ConnectedVoiceFailure>({ kind: "sessionUnknown" }) : this.call.renew(this.now()))
      .catch(() => err<ConnectedVoiceFailure>({ kind: "targetUnavailable" }));
    this.tail = handled.then(() => undefined);
    return handled;
  }

  private async closeSession(kind: "normal" | "failure"): Promise<void> {
    this.closed = true;
    this.cancelSilenceTimer();
    this.pendingPlayback = undefined;
    this.listeningControl = undefined;
    this.confirmationWaitMs = undefined;
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

  private privateInputMode(): "collecting" | "draining" | undefined {
    if (!this.locationBound) return undefined;
    if (this.privateKeypadInput?.blocked()) return "collecting";
    return this.privateResuming ? "draining" : undefined;
  }

  private async handlePrivateInput(event: TwilioStreamEvent, privateAtArrival: "collecting" | "draining" | undefined, digitArrival?: object):
    Promise<Result<TwilioConnectedProgress, TwilioConnectedFailure> | undefined> {
    if (event.kind === "media" && (privateAtArrival || this.privateInputMode())) {
      const discarded = this.call.discardPrivateMedia(event.frame);
      if (!discarded.ok) { await this.failSession(); return discarded; }
      if (privateAtArrival === "collecting" && this.privateKeypadInput?.blocked() && this.privateKeypadInput.acceptMedia) {
        if (await this.privateKeypadInput.acceptMedia(event.frame) === "failed") { await this.failSession(); return err({ kind: "privateInputUnavailable" }); }
      }
      // Only audio arriving after verification can establish a fresh resume interval.
      // Held earlier private silence and late voiced code packets cannot open transcription.
      if (privateAtArrival === "draining" && this.privateResuming) {
        const captured = Date.parse(event.frame.capturedAt);
        this.privateQuietMs = discarded.value === 0 ? 0 : (this.privateQuietUntil === captured ? this.privateQuietMs : 0) + discarded.value;
        this.privateQuietUntil = discarded.value === 0 ? undefined : captured + discarded.value;
        if (this.privateQuietMs >= 500) this.privateResuming = false;
      }
      return ok({ kind: "privateInput" });
    }
    const privateEdit = event.kind === "dtmf" && this.privateKeypadInput?.handlesDigit?.(event.digit) === true;
    if (event.kind === "dtmf" && (privateAtArrival || this.privateInputMode() || privateEdit)) {
      if (!this.privateKeypadInput) { await this.failSession(); return err({ kind: "privateInputUnavailable" }); }
      // A queued private digit never becomes an availability choice after verification opens media.
      if (!this.privateKeypadInput.blocked() && !privateEdit) return ok({ kind: "privateInput" });
      const entered = await this.privateKeypadInput.accept(event.digit, digitArrival);
      if (entered === "failed") { await this.failSession(); return err({ kind: "privateInputUnavailable" }); }
      if (entered === "verified") { this.privateResuming = true; this.privateQuietMs = 0; this.privateQuietUntil = undefined; }
      if (!this.pendingPlayback) this.scheduleSilenceTimer("listening");
      return ok({ kind: "privateInput" });
    }
    return undefined;
  }

  private async handle(received: Result<TwilioStreamEvent, TwilioStreamFailure>, privateAtArrival: "collecting" | "draining" | undefined, digitArrival?: object):
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
      this.locationBound = started.value.kind === "admitted";
      if (this.privateKeypadInput && this.locationBound && !this.privateKeypadInput.start()) {
        await this.failSession(); return err({ kind: "privateInputUnavailable" });
      }
      try { this.lease.start(); }
      catch { await this.failSession(); return err({ kind: "streamUnavailable" }); }
      this.trackDelivery(started.value.kind === "locationChoice" ? started.value.prompt : started.value.delivery);
      return ok({ kind: "started", value: started.value });
    }
    const privateInput = await this.handlePrivateInput(event, privateAtArrival, digitArrival);
    if (privateInput) return privateInput;
    if (event.kind === "media") {
      const progressed = await this.call.acceptMedia(event.frame);
      if (!progressed.ok) { await this.failSession(); return progressed; }
      if (progressed.value.kind === "speaking") {
        this.cancelSilenceTimer();
        this.pendingPlayback = undefined;
        this.listeningControl = undefined;
        this.confirmationWaitMs = undefined;
        this.retriedSilence = false;
        this.blockedSilenceChecks = 0;
      } else if (progressed.value.kind === "turnCompleted") {
        if (progressed.value.turn.kind === "locationBound") {
          this.locationBound = true;
          if (this.privateKeypadInput && !this.privateKeypadInput.start()) {
            await this.failSession(); return err({ kind: "privateInputUnavailable" });
          }
        }
        this.trackDelivery(progressed.value.delivery);
      }
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
      this.listeningControl = undefined;
      this.confirmationWaitMs = undefined;
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
    let privateAtArrival: "collecting" | "draining" | undefined;
    try { privateAtArrival = this.privateInputMode(); }
    catch { this.stopCall(); return this.failSession().then(() => err({ kind: "privateInputUnavailable" })); }
    const received = this.stream.receive(raw);
    let digitArrival: object | undefined;
    try { digitArrival = received.ok && received.value.kind === "dtmf" ? this.privateKeypadInput?.captureDigit?.(received.value.digit, this.pendingPlayback !== undefined) : undefined; }
    catch { this.stopCall(); return this.failSession().then(() => err({ kind: "privateInputUnavailable" })); }
    if (!received.ok) this.stopCall();
    if (received.ok && received.value.kind === "stopped") this.stopCall();
    if (received.ok && received.value.kind === "media" && !privateAtArrival) {
      if (!this.privateKeypadInput) {
        try { this.onPublicContactMedia?.(received.value.frame); } catch { this.stopCall(); return this.failSession().then(() => err({ kind: "streamUnavailable" })); }
      }
      this.call.observePendingCorrection(received.value.frame);
    }
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
    const handled = this.tail.then(() => this.handle(received, privateAtArrival, digitArrival)).catch(async () => {
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
