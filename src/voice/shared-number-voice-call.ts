import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { AdmissionReceipt, CallState, PendingLocationCall, Result } from "../core/model.ts";
import { callIdFor } from "./admission.ts";
import type { AuthenticatedInboundCall } from "./admission.ts";
import { PrelocationVoiceSession } from "./prelocation-voice-session.ts";
import type { PrelocationPromptResult, PrelocationVoiceFailure } from "./prelocation-voice-session.ts";
import { SharedNumberIntakeService } from "./shared-number-intake.ts";
import type { TranscriptEvent } from "./turn-assembler.ts";
import type { DispatchResult, PlaybackPort, VoiceSessionFailure } from "./voice-session.ts";
import { VoiceSession } from "./voice-session.ts";

export type SharedVoiceFailure = PrelocationVoiceFailure | VoiceSessionFailure |
  Readonly<{ kind: "sessionUnavailable" | "disconnected" }>;
export type SharedVoiceStart =
  | Readonly<{ kind: "locationChoice"; prompt: PrelocationPromptResult }>
  | Readonly<{ kind: "admitted"; receipt: AdmissionReceipt; state: CallState }>;
export type SharedVoiceTurn =
  | Readonly<{ kind: "locationBound"; receipt: AdmissionReceipt; state: CallState }>
  | Readonly<{ kind: "callerTurn"; state: CallState }>;
export type FullVoiceSessionFactory = (receipt: AdmissionReceipt, sessionId: string, playback: PlaybackPort) => VoiceSession;

/** A transport-facing call controller. It never carries a location-scoped session before the choice commits. */
export class SharedNumberVoiceCall {
  private readonly event: AuthenticatedInboundCall;
  private readonly sessionId: string;
  private readonly ledger: LedgerStore;
  private readonly intake: SharedNumberIntakeService;
  private readonly playback: PlaybackPort;
  private readonly fullFactory: FullVoiceSessionFactory;
  private readonly monotonicNow: () => number;
  private readonly callId: string;
  private prelocation: PrelocationVoiceSession | undefined;
  private full: VoiceSession | undefined;
  private receipt: AdmissionReceipt | undefined;
  private beginning = false;
  private attachingBound = false;
  private inFlight: Promise<void> | undefined;
  private closing = false;
  private terminal: PendingLocationCall | CallState | undefined;

  constructor(event: AuthenticatedInboundCall, sessionId: string,
              ledger: LedgerStore, intake: SharedNumberIntakeService,
              playback: PlaybackPort, fullFactory: FullVoiceSessionFactory,
              monotonicNow: () => number = () => performance.now()) {
    this.event = event;
    this.sessionId = sessionId;
    this.ledger = ledger;
    this.intake = intake;
    this.playback = playback;
    this.fullFactory = fullFactory;
    this.monotonicNow = monotonicNow;
    this.callId = callIdFor(event.key);
  }

  private async attachBound(now: string): Promise<Result<CallState, SharedVoiceFailure>> {
    if (!this.receipt || this.full || this.attachingBound) return err({ kind: "invalidTransition" });
    this.attachingBound = true;
    try {
      let session: VoiceSession;
      try { session = this.fullFactory(this.receipt, this.sessionId, this.playback); }
      catch { return err({ kind: "sessionUnavailable" }); }
      try {
        if (!session.matches({ callId: this.callId, sessionId: this.sessionId,
          scope: this.receipt.scope, presentationId: "" })) return err({ kind: "sessionUnavailable" });
      } catch { return err({ kind: "sessionUnavailable" }); }
      const attached = await session.attach(now);
      if (!attached.ok) return attached;
      this.full = session;
      return attached;
    } finally { this.attachingBound = false; }
  }

  private trackTransition(): () => void {
    let resolve!: () => void;
    const operation = new Promise<void>(done => { resolve = done; });
    this.inFlight = operation;
    return () => {
      if (this.inFlight === operation) this.inFlight = undefined;
      resolve();
    };
  }

  /** Retries a bound call's full-session attach after a factory or storage fault. */
  async resumeBound(now: string): Promise<Result<CallState, SharedVoiceFailure>> {
    if (this.closing || this.terminal) return err({ kind: "disconnected" });
    if (this.inFlight) return err({ kind: "deliveryBlocked" });
    const done = this.trackTransition();
    try { return await this.attachBound(now); }
    finally { done(); }
  }

  async begin(now: string): Promise<Result<SharedVoiceStart, SharedVoiceFailure>> {
    if (this.closing || this.terminal) return err({ kind: "disconnected" });
    if (this.prelocation || this.full || this.receipt || this.beginning || this.inFlight) return err({ kind: "invalidTransition" });
    this.beginning = true;
    const done = this.trackTransition();
    try {
      const started = await this.intake.begin(this.event);
      if (!started.ok) return started;
      if (started.value.kind === "admitted") {
        this.receipt = started.value.admission.receipt;
        const attached = await this.attachBound(now);
        return attached.ok ? ok({ kind: "admitted", receipt: this.receipt, state: attached.value }) : attached;
      }
      const session = new PrelocationVoiceSession(this.event, this.sessionId, this.ledger, this.intake,
        this.playback, this.monotonicNow);
      const attached = await session.attach();
      if (!attached.ok) return attached;
      this.prelocation = session;
      const prompt = await session.dispatchPrompt(now);
      return prompt.ok ? ok({ kind: "locationChoice", prompt: prompt.value }) : prompt;
    } finally { this.beginning = false; done(); }
  }

  dispatchPending(now: string): Promise<Result<PrelocationPromptResult | DispatchResult, SharedVoiceFailure>> {
    if (this.closing || this.terminal) return Promise.resolve(err({ kind: "disconnected" }));
    if (this.prelocation) return this.prelocation.dispatchPrompt(now);
    if (this.full) return this.full.dispatchPending(now);
    return Promise.resolve(err({ kind: "sessionUnknown" }));
  }

  silenceTimeout(stage: "retry" | "final", now: string): Promise<Result<PrelocationPromptResult | DispatchResult, SharedVoiceFailure>> {
    if (this.closing || this.terminal) return Promise.resolve(err({ kind: "disconnected" }));
    if (this.inFlight) return Promise.resolve(err({ kind: "deliveryBlocked" }));
    if (this.prelocation) return this.prelocation.silenceTimeout(stage, now);
    if (this.full) return this.full.silenceTimeout(stage, now);
    return Promise.resolve(err({ kind: "sessionUnknown" }));
  }

  speechStarted(now: string): Promise<Result<number, SharedVoiceFailure>> {
    if (this.closing || this.terminal) return Promise.resolve(err({ kind: "disconnected" }));
    if (this.prelocation) return this.prelocation.speechStarted(now);
    if (this.full) return this.full.speechStarted(now);
    return Promise.resolve(err({ kind: "sessionUnknown" }));
  }

  acceptTranscript(event: TranscriptEvent): Result<void, SharedVoiceFailure> {
    if (this.closing || this.terminal) return err({ kind: "disconnected" });
    if (this.prelocation) return this.prelocation.acceptTranscript(event);
    if (this.full) return this.full.acceptTranscript(event);
    return err({ kind: "sessionUnknown" });
  }

  async renew(now: string): Promise<Result<PendingLocationCall | CallState, SharedVoiceFailure>> {
    if (this.closing || this.terminal) return err({ kind: "disconnected" });
    if (this.inFlight) return err({ kind: "deliveryBlocked" });
    const done = this.trackTransition();
    try {
      if (this.prelocation) return await this.prelocation.renew();
      if (this.full) return await this.full.renew(now);
      return err({ kind: "sessionUnknown" });
    } finally { done(); }
  }

  async finishTurn(now: string): Promise<Result<SharedVoiceTurn, SharedVoiceFailure>> {
    if (this.closing || this.terminal) return err({ kind: "disconnected" });
    if (this.inFlight) return err({ kind: "deliveryBlocked" });
    const done = this.trackTransition();
    try {
      if (this.prelocation) {
        const chosen = await this.prelocation.finishTurn(now);
        if (!chosen.ok) return chosen;
        this.receipt = chosen.value.receipt;
        this.prelocation = undefined;
        const attached = await this.attachBound(now);
        return attached.ok ? ok({ kind: "locationBound", receipt: this.receipt, state: attached.value }) : attached;
      }
      if (this.full) {
        const turn = await this.full.finishTurn(now);
        return turn.ok ? ok({ kind: "callerTurn", state: turn.value }) : turn;
      }
      return err({ kind: "sessionUnknown" });
    } finally { done(); }
  }

  async acceptKeypadAvailability(date: string, now: string): Promise<Result<SharedVoiceTurn, SharedVoiceFailure>> {
    return this.acceptKeypadAvailabilityRange(date, date, now);
  }

  async acceptKeypadAvailabilityRange(from: string, to: string, now: string):
    Promise<Result<SharedVoiceTurn, SharedVoiceFailure>> {
    if (this.closing || this.terminal) return err({ kind: "disconnected" });
    if (this.inFlight) return err({ kind: "deliveryBlocked" });
    if (!this.full) return err({ kind: "sessionUnknown" });
    const done = this.trackTransition();
    try {
      const turn = await this.full.acceptKeypadAvailabilityRange(from, to, now);
      return turn.ok ? ok({ kind: "callerTurn", state: turn.value }) : turn;
    } finally { done(); }
  }

  acceptPlaybackResult(playbackId: string, status: "played" | "failed", now: string):
    Promise<Result<PendingLocationCall | CallState, SharedVoiceFailure>> {
    if (this.closing || this.terminal) return Promise.resolve(err({ kind: "disconnected" }));
    if (this.prelocation) return this.prelocation.acceptPlaybackResult(playbackId, status, now);
    if (this.full) return this.full.acceptPlaybackResult(playbackId, status, now);
    return Promise.resolve(err({ kind: "sessionUnknown" }));
  }

  drainEffects(now: string): Promise<Result<CallState, SharedVoiceFailure>> {
    return this.full?.drainEffects(now) ?? Promise.resolve(err({ kind: "sessionUnknown" }));
  }

  async end(now: string, reason: "callerDisconnected" | "sessionClosed" = "sessionClosed"):
    Promise<Result<PendingLocationCall | CallState, SharedVoiceFailure>> {
    if (this.terminal) return ok(this.terminal);
    if (this.closing) return err({ kind: "deliveryBlocked" });
    this.closing = true;
    try {
      await this.inFlight;
      const closed = this.full ? await this.full.end(now, reason)
        : this.prelocation ? await this.prelocation.end(now, reason)
        : err({ kind: this.receipt ? "sessionUnavailable" as const : "sessionUnknown" as const });
      if (closed.ok) this.terminal = closed.value;
      return closed;
    } finally { this.closing = false; }
  }
}
