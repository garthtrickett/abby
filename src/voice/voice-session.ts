import { randomUUID } from "node:crypto";
import { clearAffirmation } from "../core/caller-affirmation.ts";
export { clearAffirmation } from "../core/caller-affirmation.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { ApprovedGreeting, CallState, FinalCallerTurn, LocationScope, MenuClarificationReason, PendingPresentationRef, Presentation, Result, StaffReason, TransitionFailure } from "../core/model.ts";
import { CallRuntime } from "../core/runtime.ts";
import type { TextReceptionFailure } from "../reference/text-reception.ts";
import { TextReception } from "../reference/text-reception.ts";
import { TurnAssembler } from "./turn-assembler.ts";
import { UnattendedTurnGuard } from "./unattended-turn-guard.ts";
import { conversationControl, conversationControlText } from "../core/conversation-control.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import type { TranscriptEvent, TranscriptFailure } from "./turn-assembler.ts";

export type VoiceIntent =
  | Readonly<{ kind: "presence" }>
  | Readonly<{ kind: "missedCall" }>
  | Readonly<{ kind: "bookingHorizon" }>
  | Readonly<{ kind: "requestBoundary"; reason: import("../core/request-boundary.ts").RequestBoundary }>
  | Readonly<{ kind: "callerIdentityDenied"; reason: import("../core/caller-identity.ts").CallerIdentityDenial }>
  | Readonly<{ kind: "clarify"; reason?: MenuClarificationReason; approvedLocation?: string }>
  | Readonly<{ kind: "workflow"; operation: import("../core/model.ts").WorkflowOperation; replaceCanceledChange?: true; serviceChoice?: import("../core/booking-service-choice.ts").BookingServiceChoice }>
  | Readonly<{ kind: "outcome" }>
  | Readonly<{ kind: "notificationOutcome" }>
  | Readonly<{ kind: "staffOutcome" }>
  | Readonly<{ kind: "staffRequest"; requestedPerson?: string; requestSubject?: import("../core/staff-request-subject.ts").StaffRequestSubject }>
  | Readonly<{ kind: "bookingMenu"; from: string; to: string; preference?: import("../core/booking-search-preference.ts").BookingSearchPreference; window?: import("../core/booking-search-window.ts").BookingSearchWindow | null }>
  | Readonly<{ kind: "bookingChoice"; choice: 1 | 2 | 3 }>
  | Readonly<{ kind: "reschedulingMenu"; stage: "targets" | "offers"; from: string; to: string; window?: import("../core/booking-search-window.ts").BookingSearchWindow | null; correcting?: true }>
  | Readonly<{ kind: "reschedulingChoice"; stage: "targets" | "offers"; choice: 1 | 2 | 3 }>
  | Readonly<{ kind: "model" }>
  | Readonly<{ kind: "book"; verificationRef: string; offerRef: string }>
  | Readonly<{ kind: "cancel"; verificationRef: string; targetRef: string }>
  | Readonly<{ kind: "reschedule"; verificationRef: string; targetRef: string; offerRef: string }>
  | Readonly<{ kind: "intake"; draftRef: string }>
  | Readonly<{ kind: "answer"; sourceRefs: readonly string[]; proposedText: string }>
  | Readonly<{ kind: "availability"; from: string; to: string }>
  | Readonly<{ kind: "appointments"; verificationRef: string; from: string; to: string }>
  | Readonly<{ kind: "appointmentSelection"; verificationRef: string; choice: 1 | 2 | 3 }>
  | Readonly<{ kind: "appointmentEnquiry"; from: string; to: string }>
  | Readonly<{ kind: "appointmentEnquiryChoice"; choice: 1 | 2 | 3 }>
  | Readonly<{ kind: "affirm" }>
  | Readonly<{ kind: "handoff"; reason: StaffReason; staffWorkUnavailable?: true; checkedAt?: string }>
  | Readonly<{ kind: "transfer"; reason: StaffReason }>;
export type IntentResolver = (turn: FinalCallerTurn, signal?: AbortSignal) =>
  Promise<Result<VoiceIntent, Readonly<{ kind: "intentUnavailable" }>>>;
export type PlaybackPort = Readonly<{
  /** Check this gate immediately before each media chunk and the final queue marker. */
  enqueue(playbackId: string, approvedText: string, canSend: () => boolean): Promise<"queued" | "notSent" | "uncertain">;
  /** Must cancel this ID even when its enqueue is still in flight; a late enqueue may never revive it. */
  clear(playbackId: string): Promise<boolean>;
}>;
export type TransferOutcome = Readonly<{ kind: "connected"; providerConnectionRef: string }> | Readonly<{ kind: "failed" | "unproven" }>;
export type TransferContext = Readonly<{
  scope: LocationScope;
  callId: string;
  sessionId: string;
  policyVersion: string;
  /** Present for a route approved by StaffedDestinationRegistry; legacy host fixtures may omit it. */
  hostVersion?: string;
}>;
/** The host must validate scope, call/session and the captured route version before initiating a transfer. */
export type TransferPort = Readonly<{ request(transferId: string, destinationRef: string, context: TransferContext): Promise<TransferOutcome> }>;
/** Speech content is kept in this live session; durable presentation rows may contain only status and opaque IDs. */
export type TransientPresentationConfig = Readonly<{ greeting: ApprovedGreeting; staffWorkUnavailable?: true }>;
export type VoiceSessionFailure = TransitionFailure | TextReceptionFailure | TranscriptFailure |
  Readonly<{ kind: "sessionUnknown" | "deliveryBlocked" | "playbackUnknown" | "transportUnavailable" | "intentUnavailable" | "automatedCallUnavailable" }>;
export type DispatchResult = Readonly<{ kind: "none" | "queued" | "played" | "failed" | "unproven" | "interrupted" | "transferConnected" | "transferFailed" | "transferUnproven" | "transferCanceled"; playbackId?: string; conversationControl?: "pause" | "goodbye" }>;

type ActivePlayback = { id: string; presentationId: string; generation: number };

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
  private readonly transientContent: Map<string, string> | undefined;
  private readonly transientGreeting: ApprovedGreeting | undefined;
  /** Restricts automatic handoff only; verified caller-requested work uses its own approval. */
  private readonly staffWorkUnavailable: true | undefined;
  private attached = false;
  private localSendDeadlineMs: number | undefined;
  private leaseVersion: number | undefined;
  private renewalInFlight = false;
  private speechOpen = false;
  private activePlayback: ActivePlayback | undefined;
  private cachedIntent: VoiceIntent | undefined;
  private pendingIntent: Readonly<{ cancel: () => void }> | undefined;
  private unclearTurns = 0;
  private readonly unattended = new UnattendedTurnGuard();
  private consecutivePauses = 0;
  private controlPresentation: Readonly<{ id: string; mode: "pause" | "goodbye" }> | undefined;
  private readonly privatePlayback = new Map<string, (played: boolean) => void>();

  /** A qualified new speech onset may fence a still-pending classifier or menu operation before wire-order work resumes. */
  supersedePendingIntent(): boolean {
    if (!this.attached || !this.pendingIntent) return false;
    this.pendingIntent.cancel();
    return true;
  }

  private async withPendingIntent<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(), pending = { cancel: () => controller.abort() };
    this.pendingIntent = pending;
    try { return await work(controller.signal); }
    finally { if (this.pendingIntent === pending) this.pendingIntent = undefined; }
  }

  supersedePendingModel(): boolean {
    return this.attached && !this.speechOpen && this.reception.cancelPendingModel(this.scope, this.callId);
  }

  /** Transport loss must release transient work before the serialized call owner can end. */
  stopTransientWork(): void {
    this.consecutivePauses = 0;
    this.controlPresentation = undefined;
    this.unattended.clear();
    this.pendingIntent?.cancel();
    this.reception.cancelPendingModel(this.scope, this.callId);
    for (const resolve of this.privatePlayback.values()) resolve(false);
    this.privatePlayback.clear();
  }

  constructor(callId: string, sessionId: string, scope: LocationScope, ledger: LedgerStore, reception: TextReception, playback: PlaybackPort, resolveIntent: IntentResolver, transfer?: TransferPort, monotonicNow: () => number = () => performance.now(), transient?: TransientPresentationConfig) {
    if (transient && (transient.greeting.approved !== true ||
        transient.greeting.scope.tenantId !== scope.tenantId ||
        transient.greeting.scope.clinicId !== scope.clinicId ||
        transient.greeting.scope.locationId !== scope.locationId ||
        !transient.greeting.version?.trim() || transient.greeting.version.length > 256 ||
        !transient.greeting.ownerRef?.trim() || transient.greeting.ownerRef.length > 256 ||
        !transient.greeting.approvedText?.trim() || transient.greeting.approvedText.length > 2_000)) {
      throw new RangeError("invalid transient greeting");
    }
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
    this.transientGreeting = transient ? structuredClone(transient.greeting) : undefined;
    this.staffWorkUnavailable = transient?.staffWorkUnavailable;
    this.transientContent = this.transientGreeting
      ? new Map([[`${callId}:greeting`, this.transientGreeting.approvedText]]) : undefined;
  }

  private rememberPending(state: CallState): void {
    if (!this.transientContent || state.callId !== this.callId || !state.pendingPresentationId) return;
    const presentation = state.presentations[state.pendingPresentationId];
    if (presentation && presentation.kind !== "transfer" && presentation.approvedText.trim() &&
        presentation.approvedText.length <= 2_000) {
      this.transientContent.set(presentation.id, presentation.approvedText);
    }
  }

  matches(ref: PendingPresentationRef): boolean {
    return this.callId === ref.callId && this.sessionId === ref.sessionId &&
      this.scope.tenantId === ref.scope.tenantId && this.scope.clinicId === ref.scope.clinicId && this.scope.locationId === ref.scope.locationId;
  }

  activeForDelivery(): boolean {
    return this.canSend();
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
    const active = this.activePlayback;
    this.attached = false;
    this.localSendDeadlineMs = undefined;
    this.activePlayback = undefined;
    this.transientContent?.clear();
    if (active) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => this.playback.clear(active.id)).catch(() => false),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2_000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    }
    const ended = await this.runtime.endCall(this.callId, this.sessionId, now, "localLeaseClosed");
    if (ended.ok) return err({ kind: "leaseLost" });
    const latest = await this.runtime.read(this.callId);
    return latest.ok && latest.value.lifecycle === "ended" ? err({ kind: "leaseLost" }) : ended;
  }

  async attach(now: string): Promise<Result<CallState, VoiceSessionFailure>> {
    if (this.attached) return err({ kind: "invalidTransition" });
    if (this.transientGreeting) {
      const read = await this.runtime.read(this.callId);
      if (!read.ok) return read;
      const admitted = read.value.policy.greeting;
      if (!admitted || admitted.approved !== true ||
          admitted.version !== this.transientGreeting.version ||
          admitted.ownerRef !== this.transientGreeting.ownerRef ||
          (admitted.approvedText && admitted.approvedText !== this.transientGreeting.approvedText)) {
        return err({ kind: "invalidTransition" });
      }
    }
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
    this.pendingIntent?.cancel();
    this.cachedIntent = undefined;
    this.controlPresentation = undefined;
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
    if (began.ok) this.reception.forgetCanceledModelTasks(began.value);
    await clear;
    if (!began.ok) {
      this.attached = false;
      this.speechOpen = false;
      return began;
    }
    this.transientContent?.clear();
    if (!active) return ok(generation);
    const result = await this.runtime.resolvePresentation(this.callId, active.presentationId, cleared ? "interrupted" : "unproven", this.sessionId, now);
    if (!cleared) {
      const ended = await this.runtime.endCall(this.callId, this.sessionId, now, "mediaFailure");
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
    let existing = await this.runtime.read(this.callId);
    if (!existing.ok) return existing;
    if (generation !== this.assembler.currentGeneration()) return err({ kind: "staleTurn" });
    if (existing.value.processedTurnIds.includes(turn.turnId)) {
      this.speechOpen = false;
      return existing;
    }
    if (turn.quality === "needsClarification") {
      if (this.unclearTurns >= 1) return err({ kind: "intentUnavailable" });
      const clarified = await this.runtime.acceptTurn(turn, { kind: "clarify" }, now,
        existing.value.conversationRevision);
      if (clarified.ok && generation === this.assembler.currentGeneration()) {
        this.rememberPending(clarified.value);
        this.speechOpen = false;
        this.unclearTurns += 1;
      }
      return clarified;
    }
    if (!clearAffirmation(turn.text) && Object.values(existing.value.actions).some(action =>
      action.status === "awaitingConfirmation" || action.status === "ready")) {
      existing = await this.runtime.nonAffirmativeFinal(turn, existing.value.conversationRevision, now);
      if (!existing.ok) return existing;
      if (generation !== this.assembler.currentGeneration()) return err({ kind: "staleTurn" });
    }
    const control = conversationControl(turn.text);
    if (control) {
      const notice = control === "pause" && this.consecutivePauses >= 2 ? "pauseLimit" : control;
      const accepted = await this.runtime.acceptTurn(turn, { kind: "conversationControl", notice }, now, existing.value.conversationRevision);
      if (accepted.ok && generation === this.assembler.currentGeneration()) {
        this.reception.conversationControlAccepted(turn, accepted.value);
        this.consecutivePauses = control === "pause" ? Math.min(3, this.consecutivePauses + 1) : 0;
        const id = accepted.value.pendingPresentationId;
        const presentation = id ? accepted.value.presentations[id] : undefined;
        if (id && presentation?.kind === "notice" && (notice === "pause" || notice === "goodbye") && presentation.approvedText === conversationControlText[notice])
          this.controlPresentation = { id, mode: notice };
        this.rememberPending(accepted.value);
        this.speechOpen = false;
        this.unclearTurns = 0;
      }
      return accepted;
    }
    this.consecutivePauses = 0;
    const unattended = this.unattended.accept(turn.text);
    if (unattended === "close") return err({ kind: "automatedCallUnavailable" });
    if (unattended === "notice") this.cachedIntent = { kind: "clarify", reason: "unattendedAnnouncement" };
    if (!this.cachedIntent) {
      let intent: Result<VoiceIntent, Readonly<{ kind: "intentUnavailable" }>>;
      const controller = new AbortController();
      const pending = { cancel: () => controller.abort() };
      const canceled = new Promise<Result<VoiceIntent, Readonly<{ kind: "intentUnavailable" }>>>(resolve => {
        controller.signal.addEventListener("abort", () => resolve(err({ kind: "intentUnavailable" })), { once: true });
      });
      this.pendingIntent = pending;
      try { intent = await Promise.race([this.resolveIntent(turn, controller.signal), canceled]); }
      catch { intent = err({ kind: "intentUnavailable" }); }
      finally { if (this.pendingIntent === pending) this.pendingIntent = undefined; }
      if (controller.signal.aborted || generation !== this.assembler.currentGeneration()) return err({ kind: "staleTurn" });
      if (!intent.ok) {
        const fallback = await this.runtime.acceptTurn(turn, { kind: "modelFallback", ...(this.staffWorkUnavailable ? { staffWorkUnavailable: true as const } : {}) }, now,
          existing.value.conversationRevision);
        if (fallback.ok && generation === this.assembler.currentGeneration()) {
          this.rememberPending(fallback.value);
          this.speechOpen = false;
          this.unclearTurns = 0;
        }
        return fallback;
      }
      this.cachedIntent = intent.value;
    }
    let result: Result<CallState, VoiceSessionFailure>;
    if (this.cachedIntent.kind === "presence") {
      result = await this.reception.respondPresence(this.scope, turn, existing.value.conversationRevision);
    } else if (this.cachedIntent.kind === "missedCall") {
      result = await this.reception.respondMissedCall(this.scope, turn, existing.value.conversationRevision);
    } else if (this.cachedIntent.kind === "bookingHorizon") {
      const controller = new AbortController(), pending = { cancel: () => controller.abort() };
      this.pendingIntent = pending;
      try { result = await this.reception.readBookingHorizon(this.scope, turn, existing.value.conversationRevision, controller.signal); }
      finally { if (this.pendingIntent === pending) this.pendingIntent = undefined; }
    } else if (this.cachedIntent.kind === "requestBoundary") {
      result = await this.reception.respondRequestBoundary(this.scope, turn, this.cachedIntent.reason, existing.value.conversationRevision);
    } else if (this.cachedIntent.kind === "callerIdentityDenied") {
      result = await this.reception.denyCallerIdentity(this.scope, turn, this.cachedIntent.reason, existing.value.conversationRevision);
    } else if (this.cachedIntent.kind === "clarify") {
      result = await this.runtime.acceptTurn(turn, this.cachedIntent, now, existing.value.conversationRevision);
    } else if (this.cachedIntent.kind === "workflow") {
      const controller = new AbortController(), pending = { cancel: () => controller.abort() };
      this.pendingIntent = pending;
      try { result = await this.reception.startWorkflow(this.scope, turn, this.cachedIntent.operation, now, existing.value.conversationRevision,
        controller.signal, this.cachedIntent.replaceCanceledChange, this.cachedIntent.serviceChoice); }
      finally { if (this.pendingIntent === pending) this.pendingIntent = undefined; }
    } else if (this.cachedIntent.kind === "outcome") {
      result = await this.runtime.acceptTurn(turn, { kind: "outcomeQuery" }, now, existing.value.conversationRevision);
    } else if (this.cachedIntent.kind === "notificationOutcome") {
      result = await this.runtime.acceptTurn(turn, { kind: "notificationOutcomeQuery" }, now, existing.value.conversationRevision);
    } else if (this.cachedIntent.kind === "bookingMenu") {
      const intent = this.cachedIntent;
      result = await this.withPendingIntent(signal => this.reception.readBookingMenu(this.scope, turn, intent.from, intent.to, now, intent.window, intent.preference, signal));
    } else if (this.cachedIntent.kind === "bookingChoice") {
      const intent = this.cachedIntent;
      result = await this.withPendingIntent(signal => this.reception.selectBookingMenu(this.scope, turn, intent.choice, now, signal));
    } else if (this.cachedIntent.kind === "reschedulingMenu") {
      const intent = this.cachedIntent;
      result = await this.withPendingIntent(signal => this.reception.readReschedulingMenu(this.scope, turn, intent.stage, intent.from, intent.to, now, intent.correcting, intent.window, signal));
    } else if (this.cachedIntent.kind === "reschedulingChoice") {
      const intent = this.cachedIntent;
      result = await this.withPendingIntent(signal => this.reception.selectReschedulingMenu(this.scope, turn, intent.stage, intent.choice, now, signal));
    } else if (this.cachedIntent.kind === "model") {
      result = this.reception.modelEnabled()
        ? await this.reception.interpretModelTurn(this.scope, turn, now, existing.value.conversationRevision)
        : await this.runtime.acceptTurn(turn, { kind: "modelFallback", ...(this.staffWorkUnavailable ? { staffWorkUnavailable: true as const } : {}) }, now, existing.value.conversationRevision);
    } else if (this.cachedIntent.kind === "book") {
      const intent = this.cachedIntent;
      result = await this.withPendingIntent(signal => this.reception.proposeBooking(this.scope, turn, intent.verificationRef, intent.offerRef, now, existing.value.conversationRevision, signal));
    } else if (this.cachedIntent.kind === "cancel" || this.cachedIntent.kind === "reschedule") {
      const intent = this.cachedIntent;
      result = await this.withPendingIntent(signal => this.reception.proposeAppointmentChange(this.scope, turn, intent,
        now, existing.value.conversationRevision, signal));
    } else if (this.cachedIntent.kind === "intake") {
      result = await this.reception.proposeIntake(this.scope, turn, this.cachedIntent.draftRef, now, existing.value.conversationRevision);
    } else if (this.cachedIntent.kind === "answer") {
      const controller = new AbortController(), pending = { cancel: () => controller.abort() };
      this.pendingIntent = pending;
      try { result = await this.reception.answer(this.scope, turn, this.cachedIntent.sourceRefs, this.cachedIntent.proposedText, now, existing.value.conversationRevision, controller.signal); }
      finally { if (this.pendingIntent === pending) this.pendingIntent = undefined; }
    } else if (this.cachedIntent.kind === "availability") {
      result = await this.reception.checkAvailability(this.scope, turn, this.cachedIntent.from, this.cachedIntent.to, now, existing.value.conversationRevision);
    } else if (this.cachedIntent.kind === "appointmentEnquiry" || this.cachedIntent.kind === "appointmentEnquiryChoice") {
      const controller = new AbortController(), pending = { cancel: () => controller.abort() };
      this.pendingIntent = pending;
      const request = this.cachedIntent.kind === "appointmentEnquiry" ? { from: this.cachedIntent.from, to: this.cachedIntent.to } : { choice: this.cachedIntent.choice };
      try { result = await this.reception.enquireAppointments(this.scope, turn, request, now, existing.value.conversationRevision, controller.signal); }
      finally { if (this.pendingIntent === pending) this.pendingIntent = undefined; }
    } else if (this.cachedIntent.kind === "appointments") {
      result = await this.reception.checkAppointments(this.scope, turn, this.cachedIntent.verificationRef,
        this.cachedIntent.from, this.cachedIntent.to, now, existing.value.conversationRevision);
    } else if (this.cachedIntent.kind === "appointmentSelection") {
      result = await this.reception.selectAppointment(this.scope, turn, this.cachedIntent.verificationRef,
        this.cachedIntent.choice, now, existing.value.conversationRevision);
    } else if (this.cachedIntent.kind === "transfer") {
      result = await this.runtime.acceptTurn(turn, this.staffWorkUnavailable === true
        ? { kind: "handoff", reason: this.cachedIntent.reason, staffWorkUnavailable: true }
        : { kind: "transfer", reason: this.cachedIntent.reason }, now, existing.value.conversationRevision);
    } else if (this.cachedIntent.kind === "staffRequest") {
      const controller = new AbortController(), pending = { cancel: () => controller.abort() };
      this.pendingIntent = pending;
      try { result = await this.reception.requestStaff(this.scope, turn, this.cachedIntent.requestedPerson, now, existing.value.conversationRevision, controller.signal, this.cachedIntent.requestSubject); }
      finally { if (this.pendingIntent === pending) this.pendingIntent = undefined; }
      if (controller.signal.aborted || generation !== this.assembler.currentGeneration()) return err({ kind: "staleTurn" });
    } else if (this.cachedIntent.kind === "staffOutcome") {
      result = await this.withPendingIntent(signal => this.reception.staffOutcome(this.scope, turn, now, existing.value.conversationRevision, signal));
    } else if (this.cachedIntent.kind === "handoff") {
      // A trusted standalone classifier may finish after the media-turn clock.
      // Revalidate the captured urgent script at its bounded fresh authority time.
      let acceptedAt = now;
      if (this.cachedIntent.checkedAt !== undefined) {
        const checked = Date.parse(this.cachedIntent.checkedAt), received = Date.parse(now);
        if (this.cachedIntent.reason !== "potentiallyUrgent" || !Number.isFinite(checked) || !Number.isFinite(received) ||
            Math.abs(checked - received) > 30_000) return err({ kind: "invalidTransition" });
        acceptedAt = new Date(Math.max(checked, received)).toISOString();
      }
      result = await this.runtime.acceptTurn(turn, { kind: "handoff", reason: this.cachedIntent.reason,
        ...(this.cachedIntent.staffWorkUnavailable === true || this.staffWorkUnavailable === true ? { staffWorkUnavailable: true as const } : {}) }, acceptedAt, existing.value.conversationRevision);
    } else {
      if (turn.quality !== "clear" || !clearAffirmation(turn.text)) return err({ kind: "confirmationMissing" });
      const candidates = Object.values(existing.value.actions).filter(action => action.status === "awaitingConfirmation" && existing.value.presentations[action.presentationId]?.status === "played");
      if (candidates.length !== 1) return err({ kind: "confirmationMissing" });
      result = await this.reception.affirm(this.scope, turn, candidates[0]!.key, candidates[0]!.digest, now, existing.value.conversationRevision);
    }
    if (result.ok && generation === this.assembler.currentGeneration()) {
      this.rememberPending(result.value);
      this.speechOpen = false;
      this.unclearTurns = 0;
    }
    return result;
  }

  /** A validated keypad event is exact caller input; it bypasses speech transcription and intent inference. */
  async acceptKeypadAvailability(date: string, now: string): Promise<Result<CallState, VoiceSessionFailure>> {
    return this.acceptKeypadAvailabilityRange(date, date, now);
  }

  /** The caller-selected calendar range stays bounded and transient. */
  async acceptKeypadAvailabilityRange(from: string, to: string, now: string):
    Promise<Result<CallState, VoiceSessionFailure>> {
    if (!this.attached) return err({ kind: "sessionUnknown" });
    if (!this.canSend()) return err({ kind: "leaseLost" });
    const dateValue = (date: string): number => /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) &&
      new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date
      ? Date.parse(`${date}T00:00:00.000Z`) : NaN;
    const fromMs = dateValue(from);
    const toMs = dateValue(to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs ||
        toMs - fromMs > 6 * 86_400_000) return err({ kind: "invalidTransition" });
    if (this.speechOpen || this.activePlayback) return err({ kind: "deliveryBlocked" });
    const existing = await this.runtime.read(this.callId);
    if (!existing.ok) return existing;
    if (existing.value.pendingPresentationId) return err({ kind: "deliveryBlocked" });
    if (existing.value.lifecycle !== "active" || !existing.value.policy.automationEnabled) return err({ kind: "invalidTransition" });
    const turn: FinalCallerTurn = { callId: this.callId, sessionId: this.sessionId,
      turnId: randomUUID(), text: `Keypad availability request from ${from} to ${to}`, quality: "clear", at: now };
    const checked = await this.reception.checkAvailability(this.scope, turn, from, to, now,
      existing.value.conversationRevision);
    if (checked.ok) { this.rememberPending(checked.value); this.unclearTurns = 0; }
    return checked;
  }

  /** Private intake speech is absent from SAM text/history and the model. Only the exact
   * transport completion can fulfill this promise. The source owns consent/draft authority. */
  async presentPrivateIntake(text: string, signal: AbortSignal, now: string): Promise<boolean> {
    if (!this.transientContent || signal.aborted || !this.canSend() || this.speechOpen || this.activePlayback ||
        typeof text !== "string" || !text.trim() || text.length > 2_000) return false;
    const id = randomUUID();
    const queued = await this.runtime.privateIntakePrompt(this.callId, id, this.sessionId, now);
    if (!queued.ok || signal.aborted) return false;
    this.transientContent.set(id, text);
    let resolve!: (played: boolean) => void;
    const receipt = new Promise<boolean>(done => { resolve = done; });
    this.privatePlayback.set(id, resolve);
    let played = false;
    try {
      const dispatched = await this.dispatchPending(now);
      if (!dispatched.ok || !["queued", "played"].includes(dispatched.value.kind)) return false;
      played = await awaitUntilAbort(receipt, AbortSignal.any([signal, AbortSignal.timeout(20_000)])) === true;
      return played;
    } finally {
      this.privatePlayback.delete(id); this.transientContent.delete(id);
      if (!played) await this.clearPrivateIntakePrompt(id, now);
    }
  }

  private async clearPrivateIntakePrompt(id: string, now: string): Promise<void> {
    const active = this.activePlayback;
    if (active?.presentationId !== id) return;
    this.activePlayback = undefined;
    await this.runtime.resolvePresentation(this.callId, id, "unproven", this.sessionId, now);
    await this.playback.clear(active.id).catch(() => false);
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
    const approvedText = this.transientContent?.get(presentationId) ??
      (this.transientContent ? undefined : presentation.approvedText);
    if (!approvedText?.trim()) {
      const ended = await this.runtime.endCall(this.callId, this.sessionId, now, "mediaFailure");
      if (!ended.ok) return ended;
      this.attached = false;
      this.transientContent?.clear();
      return err({ kind: "transportUnavailable" });
    }
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
    try { send = await this.playback.enqueue(playbackId, approvedText,
      () => this.activePlayback?.id === playbackId && !this.speechOpen &&
        generation === this.assembler.currentGeneration() && this.canSend()); }
    catch { send = "uncertain"; }
    if (this.activePlayback?.id !== playbackId) {
      const settled = await this.runtime.read(this.callId);
      if (!settled.ok) return settled;
      const status = settled.value.presentations[presentationId]?.status;
      if (status === "interrupted") return ok({ kind: "interrupted" });
      if (status === "played") return ok({ kind: "played", playbackId });
      return ok({ kind: "unproven" });
    }
    if (!this.canSend()) return this.closeAfterLeaseLoss(now);
    if (send === "queued") {
      if (!this.privatePlayback.has(presentationId)) this.unattended.rememberOutput(approvedText);
      const control = this.controlPresentation?.id === presentationId ? this.controlPresentation.mode : undefined;
      return ok({ kind: "queued", playbackId, ...(control ? { conversationControl: control } : {}) });
    }
    this.activePlayback = undefined;
    this.transientContent?.delete(presentationId);
    const status = send === "notSent" ? "failed" : "unproven";
    const resolved = await this.runtime.resolvePresentation(this.callId, presentationId, status, this.sessionId, now);
    return resolved.ok ? ok({ kind: status }) : resolved;
  }

  /** No caller turn is invented for an idle interval; the core issues only fixed notices. */
  async silenceTimeout(stage: "retry" | "final", now: string): Promise<Result<DispatchResult, VoiceSessionFailure>> {
    if (!this.attached) return err({ kind: "sessionUnknown" });
    if (this.speechOpen || this.activePlayback) return err({ kind: "deliveryBlocked" });
    if (!this.canSend()) return err({ kind: "leaseLost" });
    const noticed = await this.runtime.silenceTimeout(this.callId, this.sessionId, stage, now);
    if (!noticed.ok) return noticed;
    this.rememberPending(noticed.value);
    return this.dispatchPending(now);
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
    if (marked.value.presentations[presentation.id]?.status === "canceled") return ok({ kind: "transferCanceled" });
    if (!this.attached || this.speechOpen || generation !== this.assembler.currentGeneration()) {
      const unresolved = await this.runtime.resolvePresentation(this.callId, presentation.id, "unproven", this.sessionId, now);
      if (unresolved.ok) this.attached = false;
      return unresolved.ok ? ok({ kind: "transferUnproven" }) : unresolved;
    }
    if (!this.canSend()) return this.closeAfterLeaseLoss(now);
    let outcome: TransferOutcome;
    try { outcome = decodeTransferOutcome(await this.transfer.request(`${presentation.id}:transfer`, presentation.destinationRef, {
      scope: structuredClone(marked.value.policy.scope), callId: this.callId, sessionId: this.sessionId,
      policyVersion: marked.value.policy.policyVersion,
      ...(marked.value.policy.transferDestinationVersion === undefined ? {} : { hostVersion: marked.value.policy.transferDestinationVersion }),
    })); }
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
    if (result.ok) {
      this.activePlayback = undefined;
      this.transientContent?.delete(active.presentationId);
      this.privatePlayback.get(active.presentationId)?.(status === "played");
    }
    return result;
  }

  async drainEffects(now: string): Promise<Result<CallState, VoiceSessionFailure>> {
    const result = await this.reception.drain(this.scope, this.callId, now);
    if (result.ok) this.rememberPending(result.value);
    return result;
  }

  /** A model answer needs its separately validated knowledge effect before voice can present it. */
  async drainVoiceEffects(now: string): Promise<Result<CallState, VoiceSessionFailure>> {
    const first = await this.drainEffects(now);
    return first.ok && Object.values(first.value.effects).some(effect =>
      effect.kind === "modelKnowledge" && effect.status === "pending")
      ? this.drainEffects(now) : first;
  }

  async end(now: string, reason: "callerDisconnected" | "sessionClosed" = "sessionClosed"): Promise<Result<CallState, VoiceSessionFailure>> {
    if (!this.attached) return err({ kind: "sessionUnknown" });
    this.speechOpen = true;
    this.stopTransientWork();
    const active = this.activePlayback;
    this.activePlayback = undefined;
    const ended = await this.runtime.endCall(this.callId, this.sessionId, now, reason);
    if (!ended.ok) return ended;
    this.reception.forgetModelCall(this.scope, this.callId);
    this.attached = false;
    this.localSendDeadlineMs = undefined;
    this.transientContent?.clear();
    if (active) {
      try { await this.playback.clear(active.id); } catch { /* durable status is unproven */ }
    }
    return ended;
  }
}
