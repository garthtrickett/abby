import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { CallState, FinalCallerTurn, LocationScope, Presentation, Result, StaffReason, TransitionFailure } from "../core/model.ts";
import { CallRuntime } from "../core/runtime.ts";
import type { TextReceptionFailure } from "../reference/text-reception.ts";
import { TextReception } from "../reference/text-reception.ts";
import { TurnAssembler } from "./turn-assembler.ts";
import type { TranscriptEvent, TranscriptFailure } from "./turn-assembler.ts";

export type VoiceIntent =
  | Readonly<{ kind: "book"; verificationRef: string; offerRef: string }>
  | Readonly<{ kind: "affirm" }>
  | Readonly<{ kind: "handoff"; reason: StaffReason }>
  | Readonly<{ kind: "transfer"; reason: StaffReason }>;
export type IntentResolver = (turn: FinalCallerTurn) => Promise<Result<VoiceIntent, Readonly<{ kind: "intentUnavailable" }>>>;
export type PlaybackPort = Readonly<{
  enqueue(playbackId: string, approvedText: string): Promise<"queued" | "notSent" | "uncertain">;
  clear(playbackId: string): Promise<boolean>;
}>;
export type TransferOutcome = Readonly<{ kind: "connected"; providerConnectionRef: string }> | Readonly<{ kind: "failed" | "unproven" }>;
export type TransferPort = Readonly<{ request(transferId: string, destinationRef: string): Promise<TransferOutcome> }>;
export type VoiceSessionFailure = TransitionFailure | TextReceptionFailure | TranscriptFailure |
  Readonly<{ kind: "sessionUnknown" | "deliveryBlocked" | "playbackUnknown" | "transportUnavailable" | "intentUnavailable" }>;
export type DispatchResult = Readonly<{ kind: "none" | "queued" | "played" | "failed" | "unproven" | "interrupted" | "transferConnected" | "transferFailed" | "transferUnproven" | "transferCanceled"; playbackId?: string }>;

type ActivePlayback = { id: string; presentationId: string; generation: number };

function clearAffirmation(text: string): boolean {
  return /^(yes|yes, book it|yes book it|yes, please|yes please)[.!]?$/i.test(text.trim());
}

function decodeTransferOutcome(value: unknown): TransferOutcome {
  if (typeof value !== "object" || value === null) return { kind: "unproven" };
  const outcome = value as Record<string, unknown>;
  if (outcome.kind === "connected" && typeof outcome.providerConnectionRef === "string" && outcome.providerConnectionRef.trim()) {
    return { kind: "connected", providerConnectionRef: outcome.providerConnectionRef };
  }
  if (outcome.kind === "failed") return { kind: "failed" };
  return { kind: "unproven" };
}

export class VoiceSession {
  private readonly callId: string;
  private readonly sessionId: string;
  private readonly scope: LocationScope;
  private readonly runtime: CallRuntime;
  private readonly reception: TextReception;
  private readonly playback: PlaybackPort;
  private readonly transfer: TransferPort | undefined;
  private readonly resolveIntent: IntentResolver;
  private readonly monotonicNow: () => number;
  private readonly assembler: TurnAssembler;
  private attached = false;
  private localSendDeadlineMs: number | undefined;
  private leaseVersion: number | undefined;
  private renewalInFlight = false;
  private speechOpen = false;
  private activePlayback: ActivePlayback | undefined;
  private cachedIntent: VoiceIntent | undefined;

  constructor(callId: string, sessionId: string, scope: LocationScope, ledger: LedgerStore, reception: TextReception, playback: PlaybackPort, resolveIntent: IntentResolver, transfer?: TransferPort, monotonicNow: () => number = () => performance.now()) {
    this.callId = callId;
    this.sessionId = sessionId;
    this.scope = scope;
    this.runtime = new CallRuntime(ledger, scope);
    this.reception = reception;
    this.playback = playback;
    this.transfer = transfer;
    this.resolveIntent = resolveIntent;
    this.monotonicNow = monotonicNow;
    this.assembler = new TurnAssembler(callId, sessionId);
  }

  private recordLease(state: CallState, startedMs: number): void {
    const lease = state.sessionLease;
    if (!lease || !Number.isFinite(startedMs)) return;
    const validForMs = lease.validForMs;
    if (!Number.isFinite(validForMs) || validForMs <= 0) return;
    this.leaseVersion = lease.version;
    this.localSendDeadlineMs = startedMs + Math.max(0, validForMs - 2_000);
  }

  private canSend(): boolean {
    const currentMs = this.monotonicNow();
    return this.attached && this.localSendDeadlineMs !== undefined && Number.isFinite(currentMs) && currentMs < this.localSendDeadlineMs;
  }

  private async closeAfterLeaseLoss(now: string): Promise<Result<DispatchResult, VoiceSessionFailure>> {
    this.attached = false;
    this.localSendDeadlineMs = undefined;
    this.activePlayback = undefined;
    const ended = await this.runtime.endCall(this.callId, this.sessionId, now);
    if (ended.ok) return err({ kind: "leaseLost" });
    const latest = await this.runtime.read(this.callId);
    return latest.ok && latest.value.lifecycle === "ended" ? err({ kind: "leaseLost" }) : ended;
  }

  async attach(now: string): Promise<Result<CallState, VoiceSessionFailure>> {
    if (this.attached) return err({ kind: "invalidTransition" });
    const startedMs = this.monotonicNow();
    const result = await this.runtime.activate(this.callId, this.sessionId, now);
    if (result.ok) {
      this.attached = true;
      this.recordLease(result.value, startedMs);
    }
    return result;
  }

  async renew(now: string): Promise<Result<CallState, VoiceSessionFailure>> {
    if (!this.attached || this.leaseVersion === undefined) return err({ kind: "sessionUnknown" });
    if (!this.canSend()) return err({ kind: "leaseLost" });
    if (this.renewalInFlight) return err({ kind: "invalidTransition" });
    this.renewalInFlight = true;
    const startedMs = this.monotonicNow();
    try {
      const result = await this.runtime.renewSession(this.callId, this.sessionId, this.leaseVersion, now);
      if (result.ok && !this.canSend()) return err({ kind: "leaseLost" });
      if (result.ok) this.recordLease(result.value, startedMs);
      return result;
    } finally {
      this.renewalInFlight = false;
    }
  }

  async speechStarted(now: string): Promise<Result<number, VoiceSessionFailure>> {
    if (!this.attached) return err({ kind: "sessionUnknown" });
    if (!this.canSend()) return err({ kind: "leaseLost" });
    const generation = this.assembler.beginSpeech();
    this.cachedIntent = undefined;
    this.speechOpen = true;
    const active = this.activePlayback;
    if (active) this.activePlayback = undefined;
    let cleared = false;
    let clear: Promise<void> = Promise.resolve();
    if (active) {
      try {
        clear = this.playback.clear(active.id).then(result => { cleared = result; }, () => { /* no terminal transport evidence */ });
      } catch { /* no terminal transport evidence */ }
    }
    const began = await this.runtime.beginSpeech(this.callId, this.sessionId, now);
    await clear;
    if (!began.ok) {
      this.attached = false;
      this.speechOpen = false;
      return began;
    }
    if (!active) return ok(generation);
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
    if (!this.canSend()) return err({ kind: "leaseLost" });
    const generation = this.assembler.currentGeneration();
    const final = this.assembler.finish(now);
    if (!final.ok) return final;
    const turn = final.value;
    const existing = await this.runtime.read(this.callId);
    if (!existing.ok) return existing;
    if (generation !== this.assembler.currentGeneration()) return err({ kind: "staleTurn" });
    if (existing.value.processedTurnIds.includes(turn.turnId)) {
      this.speechOpen = false;
      return existing;
    }
    if (!this.cachedIntent) {
      let intent: Result<VoiceIntent, Readonly<{ kind: "intentUnavailable" }>>;
      try { intent = await this.resolveIntent(turn); } catch { return err({ kind: "intentUnavailable" }); }
      if (!intent.ok) return intent;
      if (generation !== this.assembler.currentGeneration()) return err({ kind: "staleTurn" });
      this.cachedIntent = intent.value;
    }
    let result: Result<CallState, VoiceSessionFailure>;
    if (this.cachedIntent.kind === "book") {
      result = await this.reception.proposeBooking(this.scope, turn, this.cachedIntent.verificationRef, this.cachedIntent.offerRef, now, existing.value.conversationRevision);
    } else if (this.cachedIntent.kind === "transfer") {
      result = await this.runtime.acceptTurn(turn, { kind: "transfer", reason: this.cachedIntent.reason }, now, existing.value.conversationRevision);
    } else if (this.cachedIntent.kind === "handoff") {
      result = await this.runtime.acceptTurn(turn, { kind: "handoff", reason: this.cachedIntent.reason }, now, existing.value.conversationRevision);
    } else {
      if (turn.quality !== "clear" || !clearAffirmation(turn.text)) return err({ kind: "confirmationMissing" });
      const candidates = Object.values(existing.value.actions).filter(action => action.status === "awaitingConfirmation" && existing.value.presentations[action.presentationId]?.status === "played");
      if (candidates.length !== 1) return err({ kind: "confirmationMissing" });
      result = await this.reception.affirm(this.scope, turn, candidates[0]!.key, candidates[0]!.digest, now, existing.value.conversationRevision);
    }
    if (result.ok && generation === this.assembler.currentGeneration()) this.speechOpen = false;
    return result;
  }

  async dispatchPending(now: string): Promise<Result<DispatchResult, VoiceSessionFailure>> {
    if (!this.attached) return err({ kind: "sessionUnknown" });
    if (this.speechOpen || this.activePlayback) return err({ kind: "deliveryBlocked" });
    if (!this.canSend()) return err({ kind: "leaseLost" });
    const read = await this.runtime.read(this.callId);
    if (!read.ok) return read;
    const presentationId = read.value.pendingPresentationId;
    if (!presentationId) return ok({ kind: "none" });
    const presentation = read.value.presentations[presentationId];
    if (!presentation) return err({ kind: "invalidTransition" });
    if (presentation.kind === "transfer") return this.dispatchTransfer(presentation, now);
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
    if (!this.canSend()) return this.closeAfterLeaseLoss(now);
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

  private async dispatchTransfer(presentation: Extract<Presentation, { kind: "transfer" }>, now: string): Promise<Result<DispatchResult, VoiceSessionFailure>> {
    if (!this.transfer) return err({ kind: "transportUnavailable" });
    const generation = this.assembler.currentGeneration();
    const started = await this.runtime.startPresentation(this.callId, presentation.id, this.sessionId, now);
    if (!started.ok) return started;
    if (!this.attached || this.speechOpen || generation !== this.assembler.currentGeneration()) {
      const canceled = await this.runtime.resolvePresentation(this.callId, presentation.id, "canceled", this.sessionId, now);
      return canceled.ok ? ok({ kind: "transferCanceled" }) : canceled;
    }
    if (!this.canSend()) return this.closeAfterLeaseLoss(now);
    const marked = await this.runtime.markTransferPossiblySent(this.callId, presentation.id, this.sessionId, now);
    if (!marked.ok) return marked;
    if (!this.attached || this.speechOpen || generation !== this.assembler.currentGeneration()) {
      const unresolved = await this.runtime.resolvePresentation(this.callId, presentation.id, "unproven", this.sessionId, now);
      if (unresolved.ok) this.attached = false;
      return unresolved.ok ? ok({ kind: "transferUnproven" }) : unresolved;
    }
    if (!this.canSend()) return this.closeAfterLeaseLoss(now);
    let outcome: TransferOutcome;
    try { outcome = decodeTransferOutcome(await this.transfer.request(`${presentation.id}:transfer`, presentation.destinationRef)); }
    catch { outcome = { kind: "unproven" }; }
    const status = outcome.kind === "connected" ? "connected" : outcome.kind === "failed" ? "failed" : "unproven";
    const resolved = await this.runtime.resolvePresentation(this.callId, presentation.id, status, this.sessionId, now,
      outcome.kind === "connected" ? outcome.providerConnectionRef : undefined);
    if (!resolved.ok) {
      const latest = await this.runtime.read(this.callId);
      if (latest.ok && latest.value.presentations[presentation.id]?.status === "unproven") return ok({ kind: "transferUnproven" });
      return resolved;
    }
    if (status === "connected" || status === "unproven") this.attached = false;
    return ok({ kind: status === "connected" ? "transferConnected" : status === "failed" ? "transferFailed" : "transferUnproven" });
  }

  async acceptPlaybackResult(playbackId: string, status: "played" | "failed", now: string): Promise<Result<CallState, VoiceSessionFailure>> {
    const active = this.activePlayback;
    if (!active || active.id !== playbackId) return err({ kind: "playbackUnknown" });
    if (!this.canSend()) return err({ kind: "leaseLost" });
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
    this.localSendDeadlineMs = undefined;
    if (active) {
      try { await this.playback.clear(active.id); } catch { /* durable status is unproven */ }
    }
    return ended;
  }
}
