import type { AppointmentChangeEvidenceQuery, BookingMenuQuery, IntakeEvidenceQuery, ReschedulingMenuQuery, ReschedulingMenuReadQuery, WorkflowQuery } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { HostMutation, HostWriteReceipt, LocationScope, Result, StaffItem } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { callIdFor } from "../voice/admission.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { ClinikoBookingSession } from "./cliniko-booking-session.ts";
import type { ClinikoBookingSessionConfig } from "./cliniko-booking-session.ts";
import { ClinikoCancellationSession } from "./cliniko-cancellation-session.ts";
import { ClinikoIntakeBookingSession } from "./cliniko-intake-booking-session.ts";
import type { ClinikoIntakeBookingSessionConfig } from "./cliniko-intake-booking-session.ts";
import { ClinikoReschedulingSession } from "./cliniko-rescheduling-session.ts";
import { NoStoredKnowledge } from "./no-stored-knowledge.ts";
import type { ClinikoIntakeDraft } from "../cliniko/patient-intake.ts";
import type { FinalCallerTurn } from "../core/model.ts";
import type { VoiceIntent } from "../voice/voice-session.ts";
import { PlayedMenuSelection } from "./played-menu-selection.ts";
import { noticePresentationId } from "../core/transition.ts";

export type ClinikoWorkflow = "book" | "cancel" | "reschedule" | "intake";
export type ClinikoCallFlowConfig = Omit<ClinikoBookingSessionConfig, "callerApprovalPath" | "bookingApprovalPath"> & Readonly<{
  approvals: Readonly<{ bookCaller: string; cancelCaller: string; rescheduleCaller: string; booking: string; cancellation: string; rescheduling: string }>;
  intake?: Pick<ClinikoIntakeBookingSessionConfig, "policy" | "permission" | "presentation">;
}>;
type Owner = ClinikoBookingSession | ClinikoCancellationSession | ClinikoReschedulingSession | ClinikoIntakeBookingSession;
type Failure = Readonly<{ kind: "workflowUnavailable" }>;
const unavailable = <T>(): Result<T, Failure> => err({ kind: "workflowUnavailable" });
const readDenied = () => err({ kind: "unavailable" as const, target: "appointment" as const });

/** An admitted call owns its current workflow. No eager verifier, model credential, cross-operation grant or implicit intake booking.
 * Concrete workflow owners retain all permission, public approval, SAM, inspection and single-send checks. */
export class ClinikoCallFlow extends NoStoredKnowledge {
  readonly effectDeadlineMs = 30_000;
  readonly #config: ClinikoCallFlowConfig;
  readonly #lifetime = new AbortController();
  readonly #onClose = () => this.dispose();
  #owner: Owner | undefined;
  #workflow: ClinikoWorkflow | undefined;
  #selecting = false;
  #verificationRequired = false;
  #intakeDraftRef: string | undefined;
  #publicMenu: Readonly<{ kind: "booking" | "rescheduling"; stage: "targets" | "offers" | null }> | undefined;
  #reschedulingTargetSelected = false;
  readonly #spokenMenu = new PlayedMenuSelection();
  private constructor(config: ClinikoCallFlowConfig) {
    super(); this.#config = Object.freeze({ ...config, receipt: structuredClone(config.receipt), inbound: structuredClone(config.inbound),
      cliniko: Object.freeze({ ...config.cliniko }), approvals: Object.freeze({ ...config.approvals }), ...(config.intake ? { intake: Object.freeze({ ...config.intake }) } : {}) });
    config.signal.addEventListener("abort", this.#onClose, { once: true }); if (config.signal.aborted) this.dispose();
  }
  static create(config: ClinikoCallFlowConfig): Result<ClinikoCallFlow, Failure> {
    try {
      if (!config || !(config.signal instanceof AbortSignal) || config.signal.aborted || config.receipt.callId !== callIdFor(config.inbound.key) ||
          config.receipt.admission.key.accountRef !== config.inbound.key.accountRef || config.receipt.admission.key.providerCallRef !== config.inbound.key.providerCallRef ||
          config.receipt.admission.dialedNumber !== config.inbound.dialedNumber || !config.sessionId || !config.policyVersion ||
          !config.approvals || Object.values(config.approvals).some(path => typeof path !== "string" || !path.trim())) return unavailable();
      return ok(new ClinikoCallFlow(config));
    } catch { return unavailable(); }
  }
  binding() { return { callId: this.#config.receipt.callId, sessionId: this.#config.sessionId }; }
  get workflow(): ClinikoWorkflow | undefined { return this.#workflow; }
  get closed(): boolean { return this.#lifetime.signal.aborted; }
  /** Non-secret transport state. The input owner closes ordinary media before mail starts. */
  get verificationRequired(): boolean { return this.#verificationRequired; }
  async spokenMenuIntent(text: string) {
    if (this.closed || this.#verificationRequired) return undefined;
    const state = await this.#config.ledger.read(this.#config.receipt.callId, this.#config.receipt.scope);
    if (!state.ok || this.closed || state.value.sessionLease?.sessionId !== this.#config.sessionId) return undefined;
    return this.#spokenMenu.resolve(text, state.value, (this.#config.clock ?? (() => new Date().toISOString()))());
  }
  async correctionIntent(turn: FinalCallerTurn, external?: AbortSignal): Promise<VoiceIntent | undefined> {
    if (this.closed || this.#verificationRequired || turn.callId !== this.#config.receipt.callId || turn.sessionId !== this.#config.sessionId) return undefined;
    const found = await this.#config.ledger.read(turn.callId, this.#config.receipt.scope);
    if (!found.ok || this.closed) return undefined;
    const now = (this.#config.clock ?? (() => new Date().toISOString()))();
    const correction = this.#spokenMenu.correction(turn.text, found.value, now);
    if (!correction) return undefined;
    if (correction.kind === "clarify") return correction;
    const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(15_000), ...(external ? [external] : [])]);
    const query = { scope: this.#config.receipt.scope,
      callId: turn.callId, sessionId: this.#config.sessionId, policyVersion: this.#config.policyVersion,
      turnId: turn.turnId, now, signal, menuTurnId: correction.menuTurnId, startsAt: correction.startsAt };
    let intent: VoiceIntent | undefined;
    if (correction.menuKind === "booking") {
      const selection = await awaitUntilAbort(this.#booking()?.correctBookingMenu(query) ?? Promise.resolve(readDenied()), signal);
      if (selection?.ok) intent = { kind: "book", ...selection.value };
    } else if (this.#owner instanceof ClinikoReschedulingSession) {
      const selection = await awaitUntilAbort(this.#owner.effects.correctReschedulingMenu({ ...query, stage: "offers" }), signal);
      if (selection?.ok) intent = { kind: "reschedule", ...selection.value };
    }
    if (!intent || signal.aborted || this.closed) return { kind: "clarify", reason: "menuUnavailable" };
    this.#spokenMenu.corrected(turn.turnId, correction.startsAt);
    return intent;
  }
  /** The model sees only routing and action-status enums; patient data and host refs stay in this owner. */
  async publicIntentContext(): Promise<Readonly<{ workflow: ClinikoWorkflow | null; verificationRequired: boolean;
    lastAction: Readonly<{ kind: "book" | "cancel" | "reschedule" | "intake"; status: string; confirmationPlayed: boolean }> | null;
    now: string; timeZone: string;
    lastMenu: Readonly<{ kind: "booking" | "rescheduling"; stage: "targets" | "offers" | null }> | null;
    reschedulingTargetSelected: boolean }> | undefined> {
    if (this.closed) return undefined;
    const binding = this.binding(), found = await this.#config.ledger.read(binding.callId, this.#config.receipt.scope);
    if (!found.ok || this.closed || found.value.lifecycle !== "active" || found.value.sessionLease?.sessionId !== binding.sessionId) return undefined;
    const last = Object.values(found.value.actions).at(-1);
    return { workflow: this.#workflow ?? null, verificationRequired: this.#verificationRequired,
      lastAction: last ? { kind: last.kind, status: last.status,
        confirmationPlayed: found.value.presentations[last.presentationId]?.status === "played" } : null,
      now: (this.#config.clock ?? (() => new Date().toISOString()))(), timeZone: this.#config.cliniko.timeZone,
      lastMenu: this.#publicMenu ?? null, reschedulingTargetSelected: this.#reschedulingTargetSelected };
  }
  /** Trusted owner wiring only; the classifier receives no private draft reference. */
  get intakeDraftRef(): string | undefined { return !this.closed && !this.#verificationRequired ? this.#intakeDraftRef : undefined; }
  async collectIntake(draft: ClinikoIntakeDraft) {
    const source = this.intake;
    if (!source || this.closed) return unavailable<Readonly<{ draftRef: string }>>();
    this.#verificationRequired = true; this.#intakeDraftRef = undefined;
    const result = await source.collect(draft, { privacyAccepted: true, intakeAccepted: true });
    if (!result.ok || this.closed || this.intake !== source) return unavailable<Readonly<{ draftRef: string }>>();
    this.#intakeDraftRef = result.value.draftRef; return result;
  }
  async startWorkflow(query: WorkflowQuery) {
    const config = this.#config;
    if (!sameScope(query.scope, config.receipt.scope) || query.callId !== config.receipt.callId || query.sessionId !== config.sessionId ||
        query.policyVersion !== config.policyVersion || query.signal.aborted) return unavailable<Readonly<{ kind: "codeRequired" | "intakeRequired" }>>();
    const selected = await this.choose(query.operation, query.signal, query.replaceCanceledChange === true, query.expectedConversationRevision);
    if (selected.ok && !query.signal.aborted && selected.value.kind === "codeRequired") this.beginVerification();
    return selected;
  }
  get intake(): ClinikoIntakeBookingSession["intake"] | undefined {
    return this.#owner instanceof ClinikoIntakeBookingSession ? this.#owner.intake : undefined;
  }
  async #active(operation: ClinikoWorkflow, external?: AbortSignal): Promise<boolean> {
    const config = this.#config, scope = config.receipt.scope;
    const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(5_000), ...(external ? [external] : [])]);
    const checked = await awaitUntilAbort(Promise.all([config.ledger.read(config.receipt.callId, scope), config.policies.read(scope), config.ledger.readWriteStop(scope)]), signal);
    if (!checked || signal.aborted) return false;
    const [found, current, stop] = checked;
    const now = Date.parse((config.clock ?? (() => new Date().toISOString()))());
    return !this.#lifetime.signal.aborted && found.ok && current.ok && stop.ok && !stop.value.stopped && Number.isFinite(now) &&
      found.value.lifecycle === "active" && sameScope(found.value.policy.scope, scope) && sameScope(current.value.scope, scope) &&
      found.value.policy.policyVersion === config.policyVersion && current.value.policyVersion === config.policyVersion &&
      found.value.policy.automationEnabled && current.value.automationEnabled && found.value.policy.capabilities[operation] === "execute" && current.value.capabilities[operation] === "execute" &&
      found.value.sessionLease?.sessionId === config.sessionId && Date.parse(found.value.sessionLease.expiresAt) > now &&
      found.value.admission?.key.accountRef === config.inbound.key.accountRef && found.value.admission.key.providerCallRef === config.inbound.key.providerCallRef &&
      found.value.admission.dialedNumber === config.inbound.dialedNumber;
  }
  async choose(operation: ClinikoWorkflow, external?: AbortSignal, replaceCanceledChange = false, expectedRevision?: number): Promise<Result<Readonly<{ kind: "codeRequired" | "intakeRequired" }>, Failure>> {
    if (!["book", "cancel", "reschedule", "intake"].includes(operation) || this.#selecting || this.#lifetime.signal.aborted || external?.aborted) return unavailable();
    if (this.#owner && this.#workflow === operation) return await this.#active(operation, external)
      ? ok({ kind: operation === "intake" ? "intakeRequired" : "codeRequired" }) : unavailable();
    this.#selecting = true;
    const signal = AbortSignal.any([this.#lifetime.signal, this.#config.signal, AbortSignal.timeout(20_000), ...(external ? [external] : [])]);
    const buildLifetime = new AbortController();
    let published = false;
    let building: Promise<Result<Owner, Readonly<{ kind: string }>>> | undefined;
    let created: Owner | undefined;
    try {
      const previousOwner = this.#owner;
      const before = await awaitUntilAbort(this.#config.ledger.read(this.#config.receipt.callId, this.#config.receipt.scope), signal);
      if (!before?.ok || expectedRevision !== undefined && before.value.conversationRevision !== expectedRevision) return unavailable();
      // Only an explicitly requested unsent cancellation/move may be replaced.
      // New owners issue new operation-bound verification; no prior grant or target transfers.
      if (previousOwner && (!replaceCanceledChange || !["cancel", "reschedule"].includes(operation) ||
          !["cancel", "reschedule"].includes(this.#workflow!) ||
          Object.values(before.value.actions).some(action => action.status !== "canceled"))) return unavailable();
      if (!await this.#active(operation, signal) || signal.aborted) return unavailable();
      const config = { ...this.#config, signal: AbortSignal.any([this.#lifetime.signal, this.#config.signal, buildLifetime.signal]) }, paths = config.approvals;
      building = operation === "book" ? ClinikoBookingSession.create({ ...config, callerApprovalPath: paths.bookCaller, bookingApprovalPath: paths.booking }) :
        operation === "cancel" ? ClinikoCancellationSession.create({ ...config, callerApprovalPath: paths.cancelCaller, cancellationApprovalPath: paths.cancellation }) :
        operation === "reschedule" ? ClinikoReschedulingSession.create({ ...config, callerApprovalPath: paths.rescheduleCaller, bookingApprovalPath: paths.booking, reschedulingApprovalPath: paths.rescheduling }) :
        config.intake ? ClinikoIntakeBookingSession.create({ ...config, ...config.intake, bookingPermission: config.permission, bookingApprovalPath: paths.booking }) : undefined;
      const result = building ? await awaitUntilAbort(building, signal) : undefined;
      if (!result?.ok) return unavailable();
      created = result.value;
      if (signal.aborted || !await this.#active(operation, signal)) return unavailable();
      const after = await awaitUntilAbort(this.#config.ledger.read(this.#config.receipt.callId, this.#config.receipt.scope), signal);
      if (!after?.ok || after.value.conversationRevision !== before.value.conversationRevision || this.#owner !== previousOwner ||
          signal.aborted || previousOwner && Object.values(after.value.actions).some(action => action.status !== "canceled")) return unavailable();
      previousOwner?.dispose(); this.#publicMenu = undefined; this.#spokenMenu.clear(); this.#reschedulingTargetSelected = false;
      this.#owner = created; this.#workflow = operation; this.#verificationRequired = operation !== "intake"; created = undefined; published = true;
      return ok({ kind: operation === "intake" ? "intakeRequired" : "codeRequired" });
    } catch { return unavailable(); }
    finally {
      if (!published) { buildLifetime.abort(); void building?.then(result => { if (result.ok) result.value.dispose(); }, () => undefined); }
      created?.dispose(); this.#selecting = false;
    }
  }
  beginVerification(): boolean {
    const owner = this.#owner;
    if (this.#lifetime.signal.aborted || !owner || owner instanceof ClinikoIntakeBookingSession) return false;
    owner.beginVerification(); return true;
  }
  async submitCode(code: string): Promise<Readonly<{ verified: boolean }>> {
    const owner = this.#owner;
    if (this.#lifetime.signal.aborted || !owner) return { verified: false };
    const result = await (owner instanceof ClinikoIntakeBookingSession ? owner.intake.submitCode(code) : owner.submitCode(code));
    if (this.#lifetime.signal.aborted || owner !== this.#owner) return { verified: false };
    if (result.verified) this.#verificationRequired = false;
    return result;
  }
  async cancellationProof(): Promise<Readonly<{ verificationRef: string; expiresAt: string }> | undefined> {
    return this.#owner instanceof ClinikoCancellationSession && !this.#lifetime.signal.aborted ? this.#owner.verified() : undefined;
  }
  /** Exact bounded cancellation selection over the latest actually played list.
   * Only private host state is selected; the ordinary SAM proposal still owns
   * action preparation, exact playback and separate affirmation. */
  async selectCancellationIntent(turn: FinalCallerTurn, choice: 1 | 2 | 3, external?: AbortSignal): Promise<VoiceIntent> {
    const denied = { kind: "clarify", reason: "menuUnavailable" } as const, owner = this.#owner;
    if (!(owner instanceof ClinikoCancellationSession) || this.closed || this.#verificationRequired ||
        turn.callId !== this.#config.receipt.callId || turn.sessionId !== this.#config.sessionId) return denied;
    const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(15_000), ...(external ? [external] : [])]);
    const config = this.#config, before = await awaitUntilAbort(config.ledger.read(turn.callId, config.receipt.scope), signal);
    if (!before?.ok) return denied;
    const last = before.value.appointmentReads.at(-1), notice = last && before.value.presentations[noticePresentationId(turn.callId, last.turnId)];
    if (!last || last.status !== "shown" || (last.shownCount ?? 0) < 2 || before.value.pendingPresentationId ||
        before.value.processedTurnIds.at(-1) !== last.turnId || notice?.status !== "played") return denied;
    const proof = await owner.verified(signal);
    if (!proof) return denied;
    const now = (config.clock ?? (() => new Date().toISOString()))();
    const selected = await awaitUntilAbort(owner.appointments.select(config.receipt.scope, proof.verificationRef, choice, now, signal), signal);
    const after = await awaitUntilAbort(config.ledger.read(turn.callId, config.receipt.scope), signal);
    if (!selected?.ok || !after?.ok || signal.aborted || this.closed || this.#owner !== owner ||
        after.value.conversationRevision !== before.value.conversationRevision || after.value.lifecycle !== "active" ||
        after.value.sessionLease?.sessionId !== config.sessionId || selected.value.snapshot.verificationRef !== proof.verificationRef ||
        selected.value.snapshot.appointments.length !== 1) return denied;
    return { kind: "cancel", verificationRef: proof.verificationRef, targetRef: "selected" };
  }
  get appointments() { return this.#owner instanceof ClinikoCancellationSession ? this.#owner.appointments : undefined; }
  #booking() { return this.#owner instanceof ClinikoBookingSession ? this.#owner.effects : this.#owner instanceof ClinikoIntakeBookingSession ? this.#owner : undefined; }
  bookingMenuAvailable(): boolean { return this.#booking()?.bookingMenuAvailable() === true; }
  async readBookingMenu(query: BookingMenuQuery & Readonly<{ from: string; to: string }>) {
    this.#spokenMenu.clear();
    const result = await (this.#booking()?.readBookingMenu(query) ?? readDenied());
    if (result.ok && !this.closed) {
      this.#publicMenu = { kind: "booking", stage: null };
      this.#spokenMenu.remember({ kind: "booking", stage: null, turnId: query.turnId, snapshot: result.value });
    }
    return result;
  }
  async selectBookingMenu(query: BookingMenuQuery & Readonly<{ menuTurnId: string; choice: 1 | 2 | 3 }>) {
    const result = await (this.#booking()?.selectBookingMenu(query) ?? readDenied());
    if (result.ok && !this.closed) { this.#publicMenu = undefined; this.#spokenMenu.consumed(query.turnId, query.choice); }
    else this.#spokenMenu.clear();
    return result;
  }
  async resolveBooking(scope: LocationScope, verificationRef: string, offerRef: string, now: string, signal?: AbortSignal) { return this.#booking()?.resolveBooking(scope, verificationRef, offerRef, now, signal) ?? readDenied(); }
  reschedulingMenuAvailable(): boolean { return this.#owner instanceof ClinikoReschedulingSession && this.#owner.effects.reschedulingMenuAvailable(); }
  async readReschedulingMenu(query: ReschedulingMenuReadQuery) {
    this.#spokenMenu.clear();
    const result = await (this.#owner instanceof ClinikoReschedulingSession ? this.#owner.effects.readReschedulingMenu(query) : readDenied());
    if (result.ok && !this.closed) {
      this.#publicMenu = { kind: "rescheduling", stage: query.stage };
      this.#spokenMenu.remember({ kind: "rescheduling", stage: query.stage, turnId: query.turnId, snapshot: result.value });
    }
    return result;
  }
  async selectReschedulingMenu(query: ReschedulingMenuQuery & Readonly<{ menuTurnId: string; choice: 1 | 2 | 3 }>) {
    const result = await (this.#owner instanceof ClinikoReschedulingSession ? this.#owner.effects.selectReschedulingMenu(query) : readDenied());
    if (result.ok && !this.closed) {
      this.#publicMenu = undefined;
      if (result.value.kind === "targetSelected") { this.#reschedulingTargetSelected = true; this.#spokenMenu.clear(); }
      else this.#spokenMenu.consumed(query.turnId, query.choice);
    }
    else this.#spokenMenu.clear();
    return result;
  }
  async resolveAppointmentChange(query: AppointmentChangeEvidenceQuery) { return this.#owner instanceof ClinikoCancellationSession || this.#owner instanceof ClinikoReschedulingSession ? this.#owner.effects.resolveAppointmentChange(query) : readDenied(); }
  async resolveIntake(query: IntakeEvidenceQuery) { return this.#owner instanceof ClinikoIntakeBookingSession ? this.#owner.resolveIntake(query) : readDenied(); }
  async write(mutation: HostMutation, now: string, signal?: AbortSignal): Promise<HostWriteReceipt> {
    const owner = this.#owner;
    if (!owner || this.#lifetime.signal.aborted) return { kind: "rejected", actionKey: mutation.actionKey, reason: "forbidden" };
    return (owner instanceof ClinikoIntakeBookingSession ? owner : owner.effects).write(mutation, now, signal);
  }
  async reconcile(mutation: HostMutation) { return { kind: "stillUnknown" as const, actionKey: mutation.actionKey }; }
  async openTask(item: StaffItem) { return { kind: "rejected" as const, taskKey: item.key }; }
  async reconcileTask(item: StaffItem) { return { kind: "stillUnknown" as const, taskKey: item.key }; }
  dispose(): void { this.#spokenMenu.clear(); this.#lifetime.abort(); this.#config.signal.removeEventListener("abort", this.#onClose); this.#owner?.dispose(); this.#owner = undefined; this.#workflow = undefined; this.#verificationRequired = false; this.#intakeDraftRef = undefined; this.#publicMenu = undefined; this.#reschedulingTargetSelected = false; }
}
