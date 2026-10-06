import { ReschedulingMenuTurns } from "./rescheduling-menu-turns.ts";
import { BookingMenuTurns } from "./booking-menu-turns.ts";
import { EffectWorker } from "../core/effect-worker.ts";
import { EffectCallLeaseCoordinator } from "../core/effect-call-lease.ts";
import type { EffectCallLeaseStore } from "../core/effect-call-lease.ts";
import type { WorkflowHost, AppointmentChangeEvidenceHost, AppointmentChangeEvidenceQuery, AppointmentChangeSelection, AppointmentHost, AvailabilityHost, ReschedulingMenuHost, BookingMenuHost, BookingEvidenceHost, HostEffects, IntakeEvidenceHost, KnowledgeHost, ModelKnowledgeContextHost, NotificationHost, OperatorAlertHost, PolicyFailure, PolicyStore, StaffLifecycleHost } from "../core/host.ts";
import { captureKnowledgeSnapshot, validCallKnowledgeSource, validKnowledgeSource } from "../core/knowledge-evidence.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err } from "../core/model.ts";
import type { CallState, FinalCallerTurn, LocationScope, Result, StaffChangeRequest, TransitionFailure, TurnInterpretation } from "../core/model.ts";
import { CallRuntime } from "../core/runtime.ts";
import { appointmentChangeEvidenceFailure, noticePresentationId } from "../core/transition.ts";
import { modelTaskRef } from "../model/work.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import type { ModelWork } from "../model/work.ts";

export type TextHost = BookingEvidenceHost & HostEffects & KnowledgeHost & Partial<import("../core/host.ts").StaffRequestHost & WorkflowHost & ReschedulingMenuHost & BookingMenuHost & ModelKnowledgeContextHost & StaffLifecycleHost & OperatorAlertHost & IntakeEvidenceHost & AppointmentChangeEvidenceHost & NotificationHost>;
export type TextReceptionFailure = TransitionFailure | PolicyFailure | Readonly<{ kind: "effectFailure" }>;

function validIntakeRef(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 256;
}

export class TextReception {
  private readonly ledger: LedgerStore;
  private readonly policy: PolicyStore;
  private readonly host: TextHost;
  private readonly knowledge: KnowledgeHost & Partial<ModelKnowledgeContextHost>;
  private readonly pinKnowledge: boolean;
  private readonly availability: AvailabilityHost | undefined;
  private readonly appointments: AppointmentHost | undefined;
  private readonly model: ModelWork | undefined;
  private readonly effectLeases: EffectCallLeaseCoordinator;

  constructor(ledger: LedgerStore & EffectCallLeaseStore, policy: PolicyStore, host: TextHost, availability?: AvailabilityHost, appointments?: AppointmentHost, model?: ModelWork,
              knowledge?: KnowledgeHost & Partial<ModelKnowledgeContextHost>) {
    this.ledger = ledger;
    this.effectLeases = new EffectCallLeaseCoordinator(ledger);
    this.policy = policy;
    this.host = host;
    this.knowledge = knowledge ?? host;
    this.pinKnowledge = knowledge !== undefined;
    this.availability = availability;
    this.appointments = appointments;
    this.model = model;
  }

  async startWorkflow(scope: LocationScope, turn: FinalCallerTurn, operation: import("../core/model.ts").ActionKind, now: string,
    expectedConversationRevision?: number, external?: AbortSignal, replaceCanceledChange = false) {
    const state = await this.ledger.read(turn.callId, scope);
    if (!state.ok) return state;
    if (!this.host.startWorkflow || !state.value.policy.policyVersion || !turn.sessionId || turn.quality !== "clear" || state.value.sessionLease?.sessionId !== turn.sessionId ||
        (expectedConversationRevision !== undefined && state.value.conversationRevision !== expectedConversationRevision)) return err({ kind: "invalidTransition" as const });
    if (state.value.processedTurnIds.includes(turn.turnId)) return state;
    const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(external ? [external] : [])]);
    if (signal.aborted) return err({ kind: "staleTurn" as const });
    let selected;
    try { selected = await awaitUntilAbort(this.host.startWorkflow({ scope, callId: turn.callId, sessionId: turn.sessionId,
      policyVersion: state.value.policy.policyVersion, operation, signal, expectedConversationRevision: state.value.conversationRevision,
      ...(replaceCanceledChange ? { replaceCanceledChange: true as const } : {}) }), signal); }
    catch { selected = undefined; }
    if (external?.aborted) return err({ kind: "staleTurn" as const });
    const runtime = new CallRuntime(this.ledger, scope);
    return selected?.ok ? runtime.acceptTurn(turn, { kind: "workflowStarted", operation, next: selected.value.kind }, now, expectedConversationRevision)
      : runtime.acceptTurn(turn, { kind: "unavailableAction", actionKind: operation }, now, expectedConversationRevision);
  }

  reschedulingMenuEnabled(): boolean {
    return !!this.host.resolveAppointmentChange && new ReschedulingMenuTurns(this.ledger, this.policy, this.host).enabled();
  }
  async requestStaff(scope: LocationScope, turn: FinalCallerTurn, requestedPerson: string | undefined, now: string,
    expectedConversationRevision?: number, external?: AbortSignal) {
    const state = await this.ledger.read(turn.callId, scope);
    if (!state.ok) return state;
    if (turn.quality !== "clear" || !turn.sessionId || expectedConversationRevision !== undefined && state.value.conversationRevision !== expectedConversationRevision) return err({ kind: "staleTurn" as const });
    const revision = expectedConversationRevision ?? state.value.conversationRevision;
    if (state.value.processedTurnIds.includes(turn.turnId)) return state;
    const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(external ? [external] : [])]);
    let selected;
    try { selected = await awaitUntilAbort(this.host.prepareStaffRequest?.({ scope, callId: turn.callId, sessionId: turn.sessionId,
      turnId: turn.turnId, callerText: turn.text, policyVersion: state.value.policy.policyVersion, expectedConversationRevision: revision,
      ...(requestedPerson === undefined ? {} : { requestedPerson }), signal }) ?? Promise.resolve(undefined), signal); }
    catch { selected = undefined; }
    if (external?.aborted) return err({ kind: "staleTurn" as const });
    const interpretation: TurnInterpretation = !selected?.ok ? { kind: "staffUnavailable" } : selected.value.kind === "codeRequired"
      ? { kind: "staffVerificationRequired" } : selected.value.kind === "existing" ? { kind: "staffOutcomeQuery" }
        : { kind: "staffRequestReady", ...("requestedPerson" in selected.value && selected.value.requestedPerson ? { requestedPerson: selected.value.requestedPerson } : {}) };
    return this.runtime(scope).acceptTurn(turn, interpretation, now, revision);
  }
  staffOutcome(scope: LocationScope, turn: FinalCallerTurn, now: string) {
    return this.runtime(scope).acceptTurn(turn, { kind: "staffOutcomeQuery" }, now);
  }
  staffRequestEnabled(): boolean { return typeof this.host.prepareStaffRequest === "function"; }
  readReschedulingMenu(scope: LocationScope, turn: FinalCallerTurn, stage: "targets" | "offers", from: string, to: string, now: string, correcting = false) {
    return new ReschedulingMenuTurns(this.ledger, this.policy, this.host).run(scope, turn, now, stage, { from, to, ...(correcting ? { correcting: true as const } : {}) });
  }
  selectReschedulingMenu(scope: LocationScope, turn: FinalCallerTurn, stage: "targets" | "offers", choice: 1 | 2 | 3, now: string) {
    return new ReschedulingMenuTurns(this.ledger, this.policy, this.host).run(scope, turn, now, stage, { choice });
  }

  bookingMenuEnabled(): boolean { return new BookingMenuTurns(this.ledger, this.policy, this.host).enabled(); }
  readBookingMenu(scope: LocationScope, turn: FinalCallerTurn, from: string, to: string, now: string) {
    return new BookingMenuTurns(this.ledger, this.policy, this.host).run(scope, turn, now, { from, to });
  }
  selectBookingMenu(scope: LocationScope, turn: FinalCallerTurn, choice: 1 | 2 | 3, now: string) {
    return new BookingMenuTurns(this.ledger, this.policy, this.host).run(scope, turn, now, { choice });
  }

  availabilityEnabled(): boolean { return this.availability !== undefined; }
  appointmentReadEnabled(): boolean { return this.appointments !== undefined; }
  modelEnabled(): boolean { return this.model !== undefined; }
  cancelPendingModel(scope: LocationScope, callId: string): boolean {
    return this.model?.cancelCall(scope, callId) ?? false;
  }
  staffLifecycleEnabled(): boolean { return !!this.host.advanceTask && !!this.host.reconcileTaskChange; }

  private runtime(scope: LocationScope): CallRuntime {
    return new CallRuntime(this.ledger, scope);
  }

  async startCall(callId: string, scope: LocationScope, now: string = new Date().toISOString()): Promise<Result<CallState, TextReceptionFailure>> {
    const policy = await this.policy.read(scope);
    if (!policy.ok) return policy;
    if (!this.pinKnowledge) return this.runtime(scope).start(callId, policy.value);
    if (!this.knowledge.listModelKnowledge) return err({ kind: "effectFailure" });
    const snapshot = await captureKnowledgeSnapshot(this.knowledge as ModelKnowledgeContextHost, scope, now);
    if (!snapshot.ok) return err({ kind: "effectFailure" });
    return this.runtime(scope).start(callId, { ...policy.value, knowledgeSnapshot: snapshot.value });
  }

  async interpretModelTurn(scope: LocationScope, turn: FinalCallerTurn, now: string,
                           expectedConversationRevision?: number): Promise<Result<CallState, TextReceptionFailure>> {
    if (!this.model) return err({ kind: "effectFailure" });
    const runtime = this.runtime(scope);
    const current = await runtime.read(turn.callId);
    if (!current.ok) return current;
    if (!current.value.policy.automationEnabled || current.value.lifecycle !== "active") return err({ kind: "invalidTransition" });
    if (expectedConversationRevision !== undefined && expectedConversationRevision !== current.value.conversationRevision) return err({ kind: "staleTurn" });
    if (turn.quality !== "clear") {
      const accepted = await runtime.acceptTurn(turn, { kind: "clarify" }, now, expectedConversationRevision);
      if (accepted.ok) this.forgetCanceledModelWork(current.value, accepted.value);
      return accepted;
    }
    const taskRef = modelTaskRef({ scope, turn });
    const interpretation: TurnInterpretation = { kind: "modelPending", taskRef };
    if (current.value.processedTurnIds.includes(turn.turnId)) {
      const prior = await runtime.acceptTurn(turn, interpretation, now);
      return !prior.ok && prior.error.kind === "keyMismatch"
        ? runtime.acceptTurn(turn, { kind: "modelFallback" }, now) : prior;
    }
    let knowledge: readonly { sourceRef: string; approvedText: string }[] = [];
    if (this.knowledge.listModelKnowledge) {
      try {
        const listed = await this.knowledge.listModelKnowledge(scope, now);
        if (!listed.ok || !Array.isArray(listed.value) || listed.value.length > 256 ||
            listed.value.some(source => !validKnowledgeSource(source, scope, now)) ||
            new Set(listed.value.map(source => source.sourceRef)).size !== listed.value.length) {
          const fallback = await runtime.acceptTurn(turn, { kind: "modelFallback" }, now, current.value.conversationRevision);
          if (fallback.ok) this.forgetCanceledModelWork(current.value, fallback.value);
          return fallback;
        }
        const pinned = listed.value.filter(source => validCallKnowledgeSource(source, current.value.policy, now));
        if (pinned.length > 8) {
          const fallback = await runtime.acceptTurn(turn, { kind: "modelFallback" }, now, current.value.conversationRevision);
          if (fallback.ok) this.forgetCanceledModelWork(current.value, fallback.value);
          return fallback;
        }
        knowledge = pinned.map(source => ({ sourceRef: source.sourceRef, approvedText: source.approvedText }));
      } catch {
        const fallback = await runtime.acceptTurn(turn, { kind: "modelFallback" }, now, current.value.conversationRevision);
        if (fallback.ok) this.forgetCanceledModelWork(current.value, fallback.value);
        return fallback;
      }
    }
    const priorCallerTurns = this.model.priorCallerTurns(scope, turn.callId);
    const input = { scope, turn, priorCallerTurns, knowledge, conversationRevision: current.value.conversationRevision + 1,
      policyVersion: current.value.policy.policyVersion, promptVersion: this.model.promptVersion };
    const prepared = this.model.prepare(input);
    if (!prepared.ok) {
      if (prepared.error.kind === "keyMismatch") return err({ kind: "keyMismatch" });
      if (prepared.error.kind === "invalidInput") return err({ kind: "invalidTransition" });
      const fallback = await runtime.acceptTurn(turn, { kind: "modelFallback" }, now,
        current.value.conversationRevision);
      if (fallback.ok) this.forgetCanceledModelWork(current.value, fallback.value);
      return fallback;
    }
    const accepted = await runtime.acceptTurn(turn, interpretation, now, current.value.conversationRevision);
    if (!accepted.ok && prepared.value.created) this.model.forget(taskRef);
    if (accepted.ok) {
      this.model.recordAcceptedTurn(scope, turn.callId, turn.text);
      this.forgetCanceledModelWork(current.value, accepted.value);
    }
    return accepted;
  }

  private forgetCanceledModelWork(before: CallState, after: CallState): void {
    for (const effect of Object.values(before.effects)) {
      if ((effect.kind === "model" || effect.kind === "modelKnowledge") && effect.status === "pending" &&
          after.effects[effect.id]?.status === "canceled") this.model?.forget(effect.taskRef);
    }
  }

  forgetCanceledModelTasks(state: CallState): void {
    for (const effect of Object.values(state.effects)) {
      if ((effect.kind === "model" || effect.kind === "modelKnowledge") && effect.status === "canceled") {
        this.model?.forget(effect.taskRef);
      }
    }
  }

  forgetModelCall(scope: LocationScope, callId: string): void {
    this.model?.forgetCall(scope, callId);
  }

  async proposeBooking(scope: LocationScope, turn: FinalCallerTurn, verificationRef: string, offerRef: string, now: string, expectedConversationRevision?: number): Promise<Result<CallState, TextReceptionFailure>> {
    const runtime = this.runtime(scope);
    const current = await runtime.read(turn.callId);
    if (!current.ok) return current;
    if (current.value.policy.capabilities.book === "unavailable") {
      return runtime.acceptTurn(turn, { kind: "unavailableAction", actionKind: "book" }, now, expectedConversationRevision);
    }
    let interpretation: TurnInterpretation;
    if (turn.quality !== "clear") {
      interpretation = { kind: "ambiguousTarget" };
    } else {
      const evidence = await this.host.resolveBooking(scope, verificationRef, offerRef, now);
      if (evidence.ok) {
        interpretation = { kind: "requestAction", request: evidence.value };
      } else if (evidence.error.kind === "ambiguous" || evidence.error.kind === "expired") {
        interpretation = { kind: "ambiguousTarget" };
      } else {
        interpretation = { kind: "readFailure", target: evidence.error.target, failure: evidence.error.kind === "unavailable" ? "unavailable" : "notFound" };
      }
    }
    return runtime.acceptTurn(turn, interpretation, now, expectedConversationRevision);
  }

  async proposeAppointmentChange(scope: LocationScope, turn: FinalCallerTurn,
                                 selection: AppointmentChangeSelection,
                                 now: string, expectedConversationRevision?: number): Promise<Result<CallState, TextReceptionFailure>> {
    const runtime = this.runtime(scope);
    const current = await runtime.read(turn.callId);
    if (!current.ok) return current;
    if (!selection || (selection.kind !== "cancel" && selection.kind !== "reschedule")) {
      return runtime.acceptTurn(turn, { kind: "ambiguousTarget" }, now, expectedConversationRevision);
    }
    if (current.value.policy.capabilities[selection.kind] === "unavailable" || !this.host.resolveAppointmentChange) {
      return runtime.acceptTurn(turn, { kind: "unavailableAction", actionKind: selection.kind }, now, expectedConversationRevision);
    }
    let interpretation: TurnInterpretation;
    if (turn.quality !== "clear" || !turn.sessionId ||
        current.value.sessionLease?.sessionId !== turn.sessionId ||
        !validIntakeRef(selection.verificationRef) || !validIntakeRef(selection.targetRef) ||
        (selection.kind === "reschedule" && !validIntakeRef(selection.offerRef))) {
      interpretation = { kind: "ambiguousTarget" };
    } else {
      try {
        const context = { scope, callId: turn.callId, sessionId: turn.sessionId,
          policyVersion: current.value.policy.policyVersion, now };
        const query: AppointmentChangeEvidenceQuery = selection.kind === "cancel"
          ? { ...context, kind: "cancel", verificationRef: selection.verificationRef,
            targetRef: selection.targetRef }
          : { ...context, kind: "reschedule", verificationRef: selection.verificationRef,
            targetRef: selection.targetRef, offerRef: selection.offerRef };
        const evidence = await this.host.resolveAppointmentChange(query);
        if (!evidence.ok) {
          interpretation = evidence.error.kind === "ambiguous" || evidence.error.kind === "expired"
            ? { kind: "ambiguousTarget" }
            : { kind: "readFailure", target: evidence.error.target,
              failure: evidence.error.kind === "unavailable" ? "unavailable" : "notFound" };
        } else if (evidence.value.kind !== selection.kind ||
                   appointmentChangeEvidenceFailure(scope, evidence.value, now)) {
          interpretation = { kind: "readFailure", target: "appointment", failure: "unavailable" };
        } else interpretation = { kind: "requestAction", request: evidence.value };
      } catch {
        interpretation = { kind: "readFailure", target: "appointment", failure: "unavailable" };
      }
    }
    return runtime.acceptTurn(turn, interpretation, now, expectedConversationRevision);
  }

  async proposeIntake(scope: LocationScope, turn: FinalCallerTurn, draftRef: string, now: string,
                      expectedConversationRevision?: number): Promise<Result<CallState, TextReceptionFailure>> {
    const runtime = this.runtime(scope);
    const current = await runtime.read(turn.callId);
    if (!current.ok) return current;
    if (current.value.policy.capabilities.intake === "unavailable" || !this.host.resolveIntake) {
      return runtime.acceptTurn(turn, { kind: "unavailableAction", actionKind: "intake" }, now, expectedConversationRevision);
    }
    let interpretation: TurnInterpretation;
    if (turn.quality !== "clear" || typeof turn.sessionId !== "string" || !turn.sessionId.trim() ||
        current.value.sessionLease?.sessionId !== turn.sessionId ||
        !validIntakeRef(draftRef)) {
      interpretation = { kind: "intakeFailure", reason: "missing" };
    } else {
      try {
        const evidence = await this.host.resolveIntake({ scope, callId: turn.callId, sessionId: turn.sessionId,
          policyVersion: current.value.policy.policyVersion, draftRef, now });
        if (evidence.ok && evidence.value.kind === "intake" &&
            evidence.value.scope.tenantId === scope.tenantId && evidence.value.scope.clinicId === scope.clinicId &&
            evidence.value.scope.locationId === scope.locationId && evidence.value.approvedDraftRef === draftRef &&
            validIntakeRef(evidence.value.consentRef) && validIntakeRef(evidence.value.duplicateCheckRef)) {
          interpretation = { kind: "requestAction", request: evidence.value };
        } else {
          interpretation = { kind: "intakeFailure", reason: !evidence.ok && evidence.error.kind !== "unavailable" ? "missing" : "unavailable" };
        }
      } catch {
        interpretation = { kind: "intakeFailure", reason: "unavailable" };
      }
    }
    return runtime.acceptTurn(turn, interpretation, now, expectedConversationRevision);
  }

  async answer(scope: LocationScope, turn: FinalCallerTurn, sourceRefs: readonly string[], proposedText: string, now: string, expectedConversationRevision?: number): Promise<Result<CallState, TextReceptionFailure>> {
    const runtime = this.runtime(scope);
    const current = await runtime.read(turn.callId);
    if (!current.ok) return current;
    let interpretation: TurnInterpretation;
    if (turn.quality !== "clear" || !Array.isArray(sourceRefs) || sourceRefs.length < 1 || sourceRefs.length > 8 ||
        sourceRefs.some(ref => typeof ref !== "string" || !ref.trim() || ref.length > 256) || new Set(sourceRefs).size !== sourceRefs.length ||
        typeof proposedText !== "string" || !proposedText.trim() || proposedText.length > 2_000) {
      interpretation = { kind: "knowledgeFailure", reason: "invalidQuery" };
    } else {
      try {
        const read = await this.knowledge.readKnowledge(scope, sourceRefs);
        interpretation = read.ok
          ? { kind: "answer", sources: read.value, proposedText }
          : { kind: "knowledgeFailure", reason: read.error.kind };
      } catch {
        interpretation = { kind: "knowledgeFailure", reason: "unavailable" };
      }
    }
    return runtime.acceptTurn(turn, interpretation, now, expectedConversationRevision);
  }

  async checkAvailability(scope: LocationScope, turn: FinalCallerTurn, from: string, to: string, now: string, expectedConversationRevision?: number): Promise<Result<CallState, TextReceptionFailure>> {
    const runtime = this.runtime(scope);
    const current = await runtime.read(turn.callId);
    if (!current.ok) return current;
    let interpretation: TurnInterpretation;
    if (turn.quality !== "clear") {
      interpretation = { kind: "availabilityFailure", reason: "unclear" };
    } else if (typeof from !== "string" || typeof to !== "string" || !this.availability) {
      interpretation = { kind: "availabilityFailure", reason: this.availability ? "invalidRange" : "notConfigured" };
    } else {
      try {
        const read = await this.availability.list(scope, from, to);
        if (!read.ok) interpretation = { kind: "availabilityFailure", reason: read.error.kind };
        else if (read.value.kind === "times") interpretation = { kind: "availability", from, to, snapshot: read.value };
        else interpretation = { kind: "availabilityFailure", reason: "notEligible" };
      } catch {
        interpretation = { kind: "availabilityFailure", reason: "unavailable" };
      }
    }
    return runtime.acceptTurn(turn, interpretation, now, expectedConversationRevision);
  }

  async checkAppointments(scope: LocationScope, turn: FinalCallerTurn, verificationRef: string, from: string, to: string, now: string,
                          expectedConversationRevision?: number): Promise<Result<CallState, TextReceptionFailure>> {
    const runtime = this.runtime(scope);
    const current = await runtime.read(turn.callId);
    if (!current.ok) return current;
    let interpretation: TurnInterpretation;
    if (turn.quality !== "clear") {
      interpretation = { kind: "appointmentsFailure", reason: "unclear" };
    } else if (!this.appointments) {
      interpretation = { kind: "appointmentsFailure", reason: "notConfigured" };
    } else {
      try {
        const read = await this.appointments.list(scope, verificationRef, from, to, now);
        interpretation = read.ok
          ? { kind: "appointments", from, to, snapshot: read.value }
          : { kind: "appointmentsFailure", reason: read.error.kind };
      } catch {
        interpretation = { kind: "appointmentsFailure", reason: "unavailable" };
      }
    }
    return runtime.acceptTurn(turn, interpretation, now, expectedConversationRevision);
  }

  async selectAppointment(scope: LocationScope, turn: FinalCallerTurn, verificationRef: string, choice: 1 | 2 | 3,
                          now: string, expectedConversationRevision?: number): Promise<Result<CallState, TextReceptionFailure>> {
    const runtime = this.runtime(scope);
    const current = await runtime.read(turn.callId);
    if (!current.ok) return current;
    if (current.value.lifecycle !== "active") return err({ kind: "invalidTransition" });
    if (expectedConversationRevision !== undefined &&
        current.value.conversationRevision !== expectedConversationRevision) return err({ kind: "staleTurn" });
    const last = current.value.appointmentReads.at(-1);
    const notice = last ? current.value.presentations[noticePresentationId(turn.callId, last.turnId)] : undefined;
    let interpretation: TurnInterpretation;
    if (turn.quality !== "clear" || !this.appointments?.select ||
        !last || last.status !== "shown" || (last.shownCount ?? 0) < 2 ||
        current.value.processedTurnIds.at(-1) !== last.turnId ||
        current.value.pendingPresentationId || notice?.status !== "played" ||
        ![1, 2, 3].includes(choice)) {
      interpretation = { kind: "appointmentsFailure", reason: "notFound" };
    } else {
      try {
        const selected = await this.appointments.select(scope, verificationRef, choice, now);
        if (!selected.ok) interpretation = { kind: "appointmentsFailure", reason: selected.error.kind };
        else if (selected.value.snapshot?.verificationRef !== verificationRef ||
                 selected.value.snapshot.appointments?.length !== 1) {
          interpretation = { kind: "appointmentsFailure", reason: "malformed" };
        } else interpretation = { kind: "appointments", ...selected.value };
      } catch {
        interpretation = { kind: "appointmentsFailure", reason: "unavailable" };
      }
    }
    return runtime.acceptTurn(turn, interpretation, now, expectedConversationRevision);
  }

  async acknowledgeTextPresentation(scope: LocationScope, callId: string, presentationId: string): Promise<Result<CallState, TransitionFailure>> {
    const runtime = this.runtime(scope);
    const started = await runtime.startPresentation(callId, presentationId);
    if (!started.ok) return started;
    return runtime.resolvePresentation(callId, presentationId, "played");
  }

  completeTextPresentation(scope: LocationScope, callId: string, presentationId: string, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.runtime(scope).completeTextPresentation(callId, presentationId, now);
  }

  affirm(scope: LocationScope, turn: FinalCallerTurn, actionKey: string, digest: string, now: string, expectedConversationRevision?: number): Promise<Result<CallState, TransitionFailure>> {
    return this.runtime(scope).acceptTurn(turn, { kind: "affirm", actionKey, digest, affirmative: true }, now, expectedConversationRevision);
  }

  async drain(scope: LocationScope, callId: string, now: string): Promise<Result<CallState, TextReceptionFailure>> {
    const runtime = this.runtime(scope);
    try {
      const leased = await this.effectLeases.run(callId, scope, async (signal, guard) => {
        const read = await runtime.read(callId);
        if (!read.ok) return read;
        const worker = new EffectWorker(runtime, this.host, this.model, this.knowledge, { signal, leaseGuard: guard });
        for (const effect of Object.values(read.value.effects)) {
          if (effect.status !== "pending") continue;
          try {
            if (await worker.process(callId, effect.id, now) === "canceled") break;
          }
          catch { return err({ kind: "effectFailure" as const }); }
        }
        return runtime.read(callId);
      });
      if (!leased.ok) return leased;
      if (leased.value.kind === "busy") return runtime.read(callId);
      return leased.value.kind === "lost" ? err({ kind: "effectFailure" }) : leased.value.value;
    } catch { return err({ kind: "effectFailure" }); }
  }

  async changeStaff(scope: LocationScope, callId: string, expectedVersion: number, taskKey: string, actorRef: string,
                    change: StaffChangeRequest, now: string): Promise<Result<CallState, TextReceptionFailure>> {
    if (!this.staffLifecycleEnabled() || !Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
    const runtime = this.runtime(scope);
    const requested = await runtime.requestStaffChange(callId, expectedVersion, taskKey, actorRef, change);
    if (!requested.ok) return requested;
    const item = requested.value.staffItems[taskKey];
    const effectId = item?.pendingChangeKey ? `${item.pendingChangeKey}:send` : undefined;
    if (!effectId) return err({ kind: "effectFailure" });
    try {
      await this.effectLeases.run(callId, scope, (signal, guard) =>
        new EffectWorker(runtime, this.host, undefined, undefined, { signal, leaseGuard: guard }).process(callId, effectId, now));
    }
    catch { /* The persisted intent remains available to the recovery worker. */ }
    return runtime.read(callId);
  }

  read(scope: LocationScope, callId: string): Promise<Result<CallState, TransitionFailure>> {
    return this.runtime(scope).read(callId);
  }
}
