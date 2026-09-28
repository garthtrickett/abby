import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { CallState, FinalCallerTurn, LocationScope, Result, StaffReason, TransitionFailure } from "../core/model.ts";
import { CallRuntime } from "../core/runtime.ts";
import type { TextReceptionFailure } from "../reference/text-reception.ts";
import { TextReception } from "../reference/text-reception.ts";
import { TurnAssembler } from "./turn-assembler.ts";
import type { TranscriptEvent, TranscriptFailure } from "./turn-assembler.ts";

export type VoiceIntent =
  | Readonly<{ kind: "book"; verificationRef: string; offerRef: string }>
  | Readonly<{ kind: "affirm" }>
  | Readonly<{ kind: "handoff"; reason: StaffReason }>;
export type IntentResolver = (turn: FinalCallerTurn) => Promise<Result<VoiceIntent, Readonly<{ kind: "intentUnavailable" }>>>;
export type PlaybackPort = Readonly<{
  enqueue(playbackId: string, approvedText: string): Promise<"queued" | "notSent" | "uncertain">;
  clear(playbackId: string): Promise<boolean>;
}>;
export type VoiceSessionFailure = TransitionFailure | TextReceptionFailure | TranscriptFailure |
  Readonly<{ kind: "sessionUnknown" | "deliveryBlocked" | "playbackUnknown" | "transportUnavailable" | "intentUnavailable" }>;
export type DispatchResult = Readonly<{ kind: "none" | "queued" | "played" | "failed" | "unproven" | "interrupted"; playbackId?: string }>;

type ActivePlayback = { id: string; presentationId: string; generation: number };

function clearAffirmation(text: string): boolean {
  return /^(yes|yes, book it|yes book it|yes, please|yes please)[.!]?$/i.test(text.trim());
}

export class VoiceSession {
  private readonly callId: string;
  private readonly sessionId: string;
  private readonly scope: LocationScope;
  private readonly runtime: CallRuntime;
  private readonly reception: TextReception;
  private readonly playback: PlaybackPort;
  private readonly resolveIntent: IntentResolver;
  private readonly assembler: TurnAssembler;
  private attached = false;
  private speechOpen = false;
  private activePlayback: ActivePlayback | undefined;
  private cachedIntent: VoiceIntent | undefined;

  constructor(callId: string, sessionId: string, scope: LocationScope, ledger: LedgerStore, reception: TextReception, playback: PlaybackPort, resolveIntent: IntentResolver) {
    this.callId = callId;
    this.sessionId = sessionId;
    this.scope = scope;
    this.runtime = new CallRuntime(ledger, scope);
    this.reception = reception;
    this.playback = playback;
    this.resolveIntent = resolveIntent;
    this.assembler = new TurnAssembler(callId, sessionId);
  }

  async attach(now: string): Promise<Result<CallState, VoiceSessionFailure>> {
    if (this.attached) return err({ kind: "invalidTransition" });
    const result = await this.runtime.activate(this.callId, this.sessionId, now);
    if (result.ok) this.attached = true;
    return result;
  }

  async speechStarted(now: string): Promise<Result<number, VoiceSessionFailure>> {
    if (!this.attached) return err({ kind: "sessionUnknown" });
    const generation = this.assembler.beginSpeech();
    this.cachedIntent = undefined;
    this.speechOpen = true;
    const active = this.activePlayback;
    if (!active) return ok(generation);
    this.activePlayback = undefined;
    let cleared = false;
    try { cleared = await this.playback.clear(active.id); } catch { /* no terminal transport evidence */ }
    const result = await this.runtime.resolvePresentation(this.callId, active.presentationId, cleared ? "interrupted" : "unproven", this.sessionId, now);
    if (!cleared) {
      const ended = await this.runtime.endCall(this.callId, this.sessionId, now);
      if (ended.ok) this.attached = false;
      if (!result.ok) return result;
      if (!ended.ok) return ended;
      return err({ kind: "transportUnavailable" });
    }
    return result.ok ? ok(generation) : result;
  }

  acceptTranscript(event: TranscriptEvent): Result<void, VoiceSessionFailure> {
    if (!this.attached || !this.speechOpen) return err({ kind: "sessionUnknown" });
    return this.assembler.accept(event);
  }

  async finishTurn(now: string): Promise<Result<CallState, VoiceSessionFailure>> {
    if (!this.attached || !this.speechOpen) return err({ kind: "sessionUnknown" });
    const final = this.assembler.finish(now);
    if (!final.ok) return final;
    const turn = final.value;
    const existing = await this.runtime.read(this.callId);
    if (!existing.ok) return existing;
    if (existing.value.processedTurnIds.includes(turn.turnId)) {
      this.speechOpen = false;
      return existing;
    }
    if (!this.cachedIntent) {
      let intent: Result<VoiceIntent, Readonly<{ kind: "intentUnavailable" }>>;
      try { intent = await this.resolveIntent(turn); } catch { return err({ kind: "intentUnavailable" }); }
      if (!intent.ok) return intent;
      this.cachedIntent = intent.value;
    }
    let result: Result<CallState, VoiceSessionFailure>;
    if (this.cachedIntent.kind === "book") {
      result = await this.reception.proposeBooking(this.scope, turn, this.cachedIntent.verificationRef, this.cachedIntent.offerRef, now);
    } else if (this.cachedIntent.kind === "handoff") {
      result = await this.runtime.acceptTurn(turn, { kind: "handoff", reason: this.cachedIntent.reason }, now);
    } else {
      if (turn.quality !== "clear" || !clearAffirmation(turn.text)) return err({ kind: "confirmationMissing" });
      const candidates = Object.values(existing.value.actions).filter(action => action.status === "awaitingConfirmation" && existing.value.presentations[action.presentationId]?.status === "played");
      if (candidates.length !== 1) return err({ kind: "confirmationMissing" });
      result = await this.reception.affirm(this.scope, turn, candidates[0]!.key, candidates[0]!.digest, now);
    }
    if (result.ok) this.speechOpen = false;
    return result;
  }

  async dispatchPending(now: string): Promise<Result<DispatchResult, VoiceSessionFailure>> {
    if (!this.attached) return err({ kind: "sessionUnknown" });
    if (this.speechOpen || this.activePlayback) return err({ kind: "deliveryBlocked" });
    const read = await this.runtime.read(this.callId);
    if (!read.ok) return read;
    const presentationId = read.value.pendingPresentationId;
    if (!presentationId) return ok({ kind: "none" });
    const presentation = read.value.presentations[presentationId];
    if (!presentation) return err({ kind: "invalidTransition" });
    const generation = this.assembler.currentGeneration();
    const started = await this.runtime.startPresentation(this.callId, presentationId, this.sessionId, now);
    if (!started.ok) return started;
    const playbackId = `${presentationId}:playback`;
    this.activePlayback = { id: playbackId, presentationId, generation };
    if (this.speechOpen || generation !== this.assembler.currentGeneration()) {
      this.activePlayback = undefined;
      const resolved = await this.runtime.resolvePresentation(this.callId, presentationId, "interrupted", this.sessionId, now);
      return resolved.ok ? ok({ kind: "interrupted" }) : resolved;
    }
    let send: "queued" | "notSent" | "uncertain";
    try { send = await this.playback.enqueue(playbackId, presentation.approvedText); } catch { send = "uncertain"; }
    if (this.activePlayback?.id !== playbackId) {
      const settled = await this.runtime.read(this.callId);
      if (!settled.ok) return settled;
      const status = settled.value.presentations[presentationId]?.status;
      if (status === "interrupted") return ok({ kind: "interrupted" });
      if (status === "played") return ok({ kind: "played", playbackId });
      return ok({ kind: "unproven" });
    }
    if (send === "queued") return ok({ kind: "queued", playbackId });
    this.activePlayback = undefined;
    const status = send === "notSent" ? "failed" : "unproven";
    const resolved = await this.runtime.resolvePresentation(this.callId, presentationId, status, this.sessionId, now);
    return resolved.ok ? ok({ kind: status }) : resolved;
  }

  async acceptPlaybackResult(playbackId: string, status: "played" | "failed", now: string): Promise<Result<CallState, VoiceSessionFailure>> {
    const active = this.activePlayback;
    if (!active || active.id !== playbackId) return err({ kind: "playbackUnknown" });
    const result = await this.runtime.resolvePresentation(this.callId, active.presentationId, status, this.sessionId, now);
    if (result.ok) this.activePlayback = undefined;
    return result;
  }

  drainEffects(now: string): Promise<Result<CallState, VoiceSessionFailure>> {
    return this.reception.drain(this.scope, this.callId, now);
  }

  async end(now: string): Promise<Result<CallState, VoiceSessionFailure>> {
    if (!this.attached) return err({ kind: "sessionUnknown" });
    this.speechOpen = true;
    const active = this.activePlayback;
    this.activePlayback = undefined;
    const ended = await this.runtime.endCall(this.callId, this.sessionId, now);
    if (!ended.ok) return ended;
    this.attached = false;
    if (active) {
      try { await this.playback.clear(active.id); } catch { /* durable status is unproven */ }
    }
    return ended;
  }
}
