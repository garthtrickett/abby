import { randomUUID } from "node:crypto";
import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import { SILENCE_FINAL_NOTICE } from "../core/silence-notices.ts";
import type { AdmissionResult, PendingLocationCall, Result, TransitionFailure } from "../core/model.ts";
import { callIdFor } from "./admission.ts";
import type { AuthenticatedInboundCall, RouteFailure } from "./admission.ts";
import { locationChoicePrompt } from "./location-choice.ts";
import { SharedNumberIntakeService } from "./shared-number-intake.ts";
import type { PlaybackPort } from "./voice-session.ts";
import { TurnAssembler } from "./turn-assembler.ts";
import type { TranscriptEvent, TranscriptFailure } from "./turn-assembler.ts";

export type PrelocationVoiceFailure = TransitionFailure | RouteFailure | TranscriptFailure |
  Readonly<{ kind: "sessionUnknown" | "deliveryBlocked" | "playbackUnknown" | "transportUnavailable" | "locationChoiceUnclear" }>;
export type PrelocationPromptResult = Readonly<{ kind: "queued" | "played" | "failed" | "unproven" | "interrupted"; playbackId: string }>;

/** Owns only the media interval before a shared-number call gains a location scope. */
export class PrelocationVoiceSession {
  private readonly event: AuthenticatedInboundCall;
  private readonly sessionId: string;
  private readonly ledger: LedgerStore;
  private readonly intake: SharedNumberIntakeService;
  private readonly playback: PlaybackPort;
  private readonly monotonicNow: () => number;
  private readonly callId: string;
  private readonly assembler: TurnAssembler;
  private attached = false;
  private speechOpen = false;
  private finishing = false;
  private ending = false;
  private leaseVersion: number | undefined;
  private localDeadlineMs: number | undefined;
  private activePlaybackId: string | undefined;
  private pending: PendingLocationCall | undefined;

  constructor(event: AuthenticatedInboundCall, sessionId: string,
              ledger: LedgerStore, intake: SharedNumberIntakeService,
              playback: PlaybackPort, monotonicNow: () => number = () => performance.now()) {
    this.event = event;
    this.sessionId = sessionId;
    this.ledger = ledger;
    this.intake = intake;
    this.playback = playback;
    this.monotonicNow = monotonicNow;
    this.callId = callIdFor(event.key);
    this.assembler = new TurnAssembler(this.callId, sessionId, "prelocation");
  }

  private canSend(): boolean {
    const now = this.monotonicNow();
    return this.attached && !this.ending && this.localDeadlineMs !== undefined && Number.isFinite(now) && now < this.localDeadlineMs;
  }

  private recordLease(pending: PendingLocationCall, startedMs: number): void {
    const lease = pending.sessionLease;
    if (!lease || !Number.isFinite(startedMs)) return;
    this.pending = pending;
    this.leaseVersion = lease.version;
    this.localDeadlineMs = startedMs + Math.max(0, lease.validForMs - 2_000);
  }

  async attach(): Promise<Result<PendingLocationCall, PrelocationVoiceFailure>> {
    if (this.attached) return err({ kind: "invalidTransition" });
    const startedMs = this.monotonicNow();
    const attached = await this.intake.attachSession(this.event, this.sessionId);
    if (!attached.ok) return attached;
    this.attached = true;
    this.recordLease(attached.value, startedMs);
    if (attached.value.prompt?.sessionId === this.sessionId &&
        (attached.value.prompt.status === "started" || attached.value.prompt.status === "queued")) {
      this.activePlaybackId = attached.value.prompt.playbackId;
    }
    return attached;
  }

  async renew(): Promise<Result<PendingLocationCall, PrelocationVoiceFailure>> {
    if (this.ending) return err({ kind: "deliveryBlocked" });
    if (!this.canSend() || this.leaseVersion === undefined) return err({ kind: "leaseLost" });
    const startedMs = this.monotonicNow();
    const renewed = await this.intake.renewSession(this.event, this.sessionId, this.leaseVersion);
    if (renewed.ok && !this.canSend()) return err({ kind: "leaseLost" });
    if (renewed.ok) this.recordLease(renewed.value, startedMs);
    return renewed;
  }

  async dispatchPrompt(now: string, notice?: "retrySilence" | "finalSilence"): Promise<Result<PrelocationPromptResult, PrelocationVoiceFailure>> {
    if (this.ending) return err({ kind: "deliveryBlocked" });
    if (!this.attached || !this.pending || this.leaseVersion === undefined) return err({ kind: "sessionUnknown" });
    if (this.speechOpen) return err({ kind: "deliveryBlocked" });
    if (!this.canSend()) return err({ kind: "leaseLost" });
    const text = notice === "finalSilence" ? SILENCE_FINAL_NOTICE : locationChoicePrompt(this.pending.route);
    if (!text) return err({ kind: "invalidTransition" });
    const playbackId = `${this.callId}:location:${randomUUID()}`;
    const started = await this.ledger.startPendingLocationPrompt(this.callId, playbackId, this.sessionId, this.leaseVersion,
      now, notice !== undefined);
    if (!started.ok) return started;
    const prompt = started.value.pending.prompt!;
    this.pending = started.value.pending;
    if (!started.value.newStart) return ok({ kind: prompt.status === "started" ? "unproven" : prompt.status,
      playbackId: prompt.playbackId });
    this.activePlaybackId = playbackId;
    if (this.speechOpen || !this.canSend()) {
      this.activePlaybackId = undefined;
      const settled = await this.ledger.resolvePendingLocationPrompt(this.callId, playbackId, this.sessionId,
        this.leaseVersion, this.speechOpen ? "interrupted" : "failed", now);
      return settled.ok ? this.speechOpen ? ok({ kind: "interrupted", playbackId }) : err({ kind: "leaseLost" }) : settled;
    }
    let outcome: "queued" | "notSent" | "uncertain";
    try { outcome = await this.playback.enqueue(playbackId, text,
      () => this.activePlaybackId === playbackId && !this.speechOpen && this.canSend()); }
    catch { outcome = "uncertain"; }
    if (this.activePlaybackId !== playbackId) {
      const latest = await this.ledger.findPendingLocation(this.callId);
      if (!latest.ok) return latest;
      const status = latest.value?.prompt?.status;
      return ok({ kind: status === "interrupted" || status === "played" || status === "failed" ? status : "unproven", playbackId });
    }
    const status = outcome === "notSent" ? "failed" : outcome === "uncertain" ? "unproven" : "queued";
    const resolved = await this.ledger.resolvePendingLocationPrompt(this.callId, playbackId, this.sessionId,
      this.leaseVersion, status, now);
    if (!resolved.ok) return resolved;
    this.pending = resolved.value;
    if (status !== "queued") this.activePlaybackId = undefined;
    return ok({ kind: status, playbackId });
  }

  silenceTimeout(stage: "retry" | "final", now: string): Promise<Result<PrelocationPromptResult, PrelocationVoiceFailure>> {
    if (this.activePlaybackId) return Promise.resolve(err({ kind: "deliveryBlocked" }));
    return this.dispatchPrompt(now, stage === "final" ? "finalSilence" : "retrySilence");
  }

  async acceptPlaybackResult(playbackId: string, status: "played" | "failed", now: string): Promise<Result<PendingLocationCall, PrelocationVoiceFailure>> {
    if (!this.activePlaybackId || this.activePlaybackId !== playbackId) return err({ kind: "playbackUnknown" });
    if (!this.canSend() || this.leaseVersion === undefined) return err({ kind: "leaseLost" });
    const settled = await this.ledger.resolvePendingLocationPrompt(this.callId, playbackId, this.sessionId,
      this.leaseVersion, status, now);
    if (settled.ok) {
      this.pending = settled.value;
      this.activePlaybackId = undefined;
    }
    return settled;
  }

  async speechStarted(now: string): Promise<Result<number, PrelocationVoiceFailure>> {
    if (this.ending) return err({ kind: "deliveryBlocked" });
    if (!this.attached) return err({ kind: "sessionUnknown" });
    if (this.finishing) return err({ kind: "deliveryBlocked" });
    if (!this.canSend() || this.leaseVersion === undefined) return err({ kind: "leaseLost" });
    this.speechOpen = true;
    const generation = this.assembler.beginSpeech();
    const playbackId = this.activePlaybackId;
    this.activePlaybackId = undefined;
    if (!playbackId) return ok(generation);
    let cleared = false;
    try { cleared = await this.playback.clear(playbackId); } catch { /* no terminal transport evidence */ }
    const settled = await this.ledger.resolvePendingLocationPrompt(this.callId, playbackId, this.sessionId,
      this.leaseVersion, cleared ? "interrupted" : "unproven", now);
    if (!settled.ok) return settled;
    this.pending = settled.value;
    if (!cleared) {
      this.attached = false;
      return err({ kind: "transportUnavailable" });
    }
    return ok(generation);
  }

  acceptTranscript(event: TranscriptEvent): Result<void, PrelocationVoiceFailure> {
    if (this.ending) return err({ kind: "deliveryBlocked" });
    if (!this.attached || !this.speechOpen) return err({ kind: "sessionUnknown" });
    return this.assembler.accept(event);
  }

  async finishTurn(now: string): Promise<Result<AdmissionResult, PrelocationVoiceFailure>> {
    if (this.ending) return err({ kind: "deliveryBlocked" });
    if (!this.attached || !this.speechOpen || this.leaseVersion === undefined) return err({ kind: "sessionUnknown" });
    if (this.finishing) return err({ kind: "deliveryBlocked" });
    if (!this.canSend()) return err({ kind: "leaseLost" });
    const finished = this.assembler.finish(now);
    if (!finished.ok) return finished;
    this.finishing = true;
    try {
      const result = await this.intake.chooseFromTurn(this.event, finished.value, this.leaseVersion);
      if (result.ok || result.error.kind === "locationChoiceUnclear") this.speechOpen = false;
      if (result.ok) this.attached = false;
      return result;
    } finally { this.finishing = false; }
  }

  async end(now: string, reason: "callerDisconnected" | "sessionClosed" | "mediaFailure" = "sessionClosed"):
    Promise<Result<PendingLocationCall, PrelocationVoiceFailure>> {
    if (!this.attached || this.leaseVersion === undefined) return err({ kind: "sessionUnknown" });
    if (this.finishing || this.ending) return err({ kind: "deliveryBlocked" });
    this.ending = true;
    try {
      const version = this.leaseVersion;
      const playbackId = this.activePlaybackId;
      this.activePlaybackId = undefined;
      if (playbackId) {
        let cleared = false;
        try { cleared = await this.playback.clear(playbackId); } catch { /* possibly sent audio remains unproven */ }
        await this.ledger.resolvePendingLocationPrompt(this.callId, playbackId, this.sessionId, version,
          cleared ? "interrupted" : "unproven", now);
      }
      const closed = await this.ledger.closePendingLocationSession(this.callId, this.sessionId, version, reason, now);
      if (closed.ok) {
        this.attached = false;
        this.speechOpen = false;
        this.localDeadlineMs = undefined;
      }
      return closed;
    } finally { this.ending = false; }
  }
}
