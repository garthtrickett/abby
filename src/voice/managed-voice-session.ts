import { err, ok } from "../core/model.ts";
import type { CallState, LocationScope, PendingPresentationRef, Result } from "../core/model.ts";
import type { DeliveryAttempt } from "./presentation-dispatcher.ts";
import type { TimerPort } from "./timer.ts";
import type { TranscriptEvent } from "./turn-assembler.ts";
import { VoiceLeaseLoop } from "./voice-lease-loop.ts";
import type { LeaseRenewalFailure } from "./voice-lease-loop.ts";
import type { VoiceSession, VoiceSessionFailure } from "./voice-session.ts";
import type { WorkFailure } from "./voice-work-loop.ts";
import { VoiceWorkLoop } from "./voice-work-loop.ts";

export type RegisterFailure = Readonly<{ kind: "sessionUnknown" | "sessionAlreadyAttached" | "schedulerUnavailable" }>;
export type CommittedVoiceState = Readonly<{ state: CallState; wake: Result<DeliveryAttempt, WorkFailure> }>;

/** A process-local registry. Durable admission and lease fencing still live in the ledger. */
export class AttachedVoiceSessions {
  private readonly calls = new Map<string, Readonly<{ session: VoiceSession; managed: ManagedVoiceSession }>>();

  readonly lookup = (ref: PendingPresentationRef): VoiceSession | undefined => {
    const entry = this.calls.get(ref.callId);
    return entry?.managed.matches(ref) && entry.session.activeForDelivery() ? entry.session : undefined;
  };

  register(
    callId: string,
    sessionId: string,
    scope: LocationScope,
    session: VoiceSession,
    work: VoiceWorkLoop,
    onRenewal: (callId: string, outcome: Result<CallState, LeaseRenewalFailure>) => void,
    options: Readonly<{ clock?: () => string; timer?: TimerPort }> = {},
  ): Result<ManagedVoiceSession, RegisterFailure> {
    if (this.calls.has(callId)) return err({ kind: "sessionAlreadyAttached" });
    if (!session.matches({ callId, sessionId, scope, presentationId: "" }) || !session.activeForDelivery()) return err({ kind: "sessionUnknown" });
    let managed!: ManagedVoiceSession;
    const lease = new VoiceLeaseLoop(session, outcome => {
      if (!outcome.ok && (outcome.error.kind === "leaseLost" || outcome.error.kind === "sessionUnknown")) {
        this.remove(callId, managed);
      }
      onRenewal(callId, outcome);
    }, options);
    managed = new ManagedVoiceSession(callId, sessionId, scope, session, work, lease, this);
    this.calls.set(callId, { session, managed });
    try { lease.start(); }
    catch {
      this.calls.delete(callId);
      return err({ kind: "schedulerUnavailable" });
    }
    return ok(managed);
  }

  remove(callId: string, managed: ManagedVoiceSession): void {
    if (this.calls.get(callId)?.managed === managed) this.calls.delete(callId);
  }
}

/** Calls through this handle wake committed presentations and manage the session's renewal timer. */
export class ManagedVoiceSession {
  private readonly session: VoiceSession;
  private readonly callId: string;
  private readonly sessionId: string;
  private readonly scope: LocationScope;
  private readonly work: VoiceWorkLoop;
  private readonly lease: VoiceLeaseLoop;
  private readonly registry: AttachedVoiceSessions;
  private closed = false;

  constructor(callId: string, sessionId: string, scope: LocationScope, session: VoiceSession, work: VoiceWorkLoop, lease: VoiceLeaseLoop, registry: AttachedVoiceSessions) {
    this.callId = callId;
    this.sessionId = sessionId;
    this.scope = structuredClone(scope);
    this.session = session;
    this.work = work;
    this.lease = lease;
    this.registry = registry;
  }

  matches(ref: PendingPresentationRef): boolean {
    return this.callId === ref.callId && this.sessionId === ref.sessionId &&
      this.scope.tenantId === ref.scope.tenantId && this.scope.clinicId === ref.scope.clinicId && this.scope.locationId === ref.scope.locationId;
  }

  private async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.registry.remove(this.callId, this);
    await this.lease.stop();
  }

  private async afterCommit(result: Result<CallState, VoiceSessionFailure>): Promise<Result<CommittedVoiceState, VoiceSessionFailure>> {
    if (!result.ok) {
      if (!this.session.activeForDelivery()) await this.close();
      return result;
    }
    const wake = await this.work.notifyCommitted(this.callId, this.scope);
    if (!this.session.activeForDelivery()) await this.close();
    return ok({ state: result.value, wake });
  }

  async speechStarted(now: string): Promise<Result<number, VoiceSessionFailure>> {
    const result = await this.session.speechStarted(now);
    if (!this.session.activeForDelivery()) await this.close();
    return result;
  }

  acceptTranscript(event: TranscriptEvent): Result<void, VoiceSessionFailure> {
    return this.session.acceptTranscript(event);
  }

  async finishTurn(now: string): Promise<Result<CommittedVoiceState, VoiceSessionFailure>> {
    return this.afterCommit(await this.session.finishTurn(now));
  }

  async acceptPlaybackResult(playbackId: string, status: "played" | "failed", now: string): Promise<Result<CommittedVoiceState, VoiceSessionFailure>> {
    return this.afterCommit(await this.session.acceptPlaybackResult(playbackId, status, now));
  }

  async drainEffects(now: string): Promise<Result<CommittedVoiceState, VoiceSessionFailure>> {
    return this.afterCommit(await this.session.drainEffects(now));
  }

  async end(now: string, reason: "callerDisconnected" | "sessionClosed" = "sessionClosed"): Promise<Result<CallState, VoiceSessionFailure>> {
    try { return await this.session.end(now, reason); }
    finally { await this.close(); }
  }
}
