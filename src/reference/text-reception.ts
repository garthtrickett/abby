import { EffectWorker } from "../core/effect-worker.ts";
import type { AppointmentHost, AvailabilityHost, BookingEvidenceHost, HostEffects, KnowledgeHost, ModelKnowledgeContextHost, OperatorAlertHost, PolicyFailure, PolicyStore, StaffLifecycleHost } from "../core/host.ts";
import { validKnowledgeSource } from "../core/knowledge-evidence.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err } from "../core/model.ts";
import type { CallState, FinalCallerTurn, LocationScope, Result, StaffChangeRequest, TransitionFailure, TurnInterpretation } from "../core/model.ts";
import { CallRuntime } from "../core/runtime.ts";
import { modelTaskRef } from "../model/work.ts";
import type { ModelWork } from "../model/work.ts";

export type TextHost = BookingEvidenceHost & HostEffects & KnowledgeHost & Partial<ModelKnowledgeContextHost & StaffLifecycleHost & OperatorAlertHost>;
export type TextReceptionFailure = TransitionFailure | PolicyFailure | Readonly<{ kind: "effectFailure" }>;

export class TextReception {
  private readonly ledger: LedgerStore;
  private readonly policy: PolicyStore;
  private readonly host: TextHost;
  private readonly availability: AvailabilityHost | undefined;
  private readonly appointments: AppointmentHost | undefined;
  private readonly model: ModelWork | undefined;

  constructor(ledger: LedgerStore, policy: PolicyStore, host: TextHost, availability?: AvailabilityHost, appointments?: AppointmentHost, model?: ModelWork) {
    this.ledger = ledger;
    this.policy = policy;
    this.host = host;
    this.availability = availability;
    this.appointments = appointments;
    this.model = model;
  }

  availabilityEnabled(): boolean { return this.availability !== undefined; }
  appointmentReadEnabled(): boolean { return this.appointments !== undefined; }
  modelEnabled(): boolean { return this.model !== undefined; }
  staffLifecycleEnabled(): boolean { return !!this.host.advanceTask && !!this.host.reconcileTaskChange; }

  private runtime(scope: LocationScope): CallRuntime {
    return new CallRuntime(this.ledger, scope);
  }

  async startCall(callId: string, scope: LocationScope): Promise<Result<CallState, TextReceptionFailure>> {
    const policy = await this.policy.read(scope);
    if (!policy.ok) return policy;
    return this.runtime(scope).start(callId, policy.value);
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
    if (this.host.listModelKnowledge) {
      try {
        const listed = await this.host.listModelKnowledge(scope, now);
        if (!listed.ok || !Array.isArray(listed.value) || listed.value.length > 8 ||
            listed.value.some(source => !validKnowledgeSource(source, scope, now)) ||
            new Set(listed.value.map(source => source.sourceRef)).size !== listed.value.length) {
          const fallback = await runtime.acceptTurn(turn, { kind: "modelFallback" }, now, current.value.conversationRevision);
          if (fallback.ok) this.forgetCanceledModelWork(current.value, fallback.value);
          return fallback;
        }
        knowledge = listed.value.map(source => ({ sourceRef: source.sourceRef, approvedText: source.approvedText }));
      } catch {
        const fallback = await runtime.acceptTurn(turn, { kind: "modelFallback" }, now, current.value.conversationRevision);
        if (fallback.ok) this.forgetCanceledModelWork(current.value, fallback.value);
        return fallback;
      }
    }
    const input = { scope, turn, knowledge, conversationRevision: current.value.conversationRevision + 1,
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
    if (accepted.ok) this.forgetCanceledModelWork(current.value, accepted.value);
    return accepted;
  }

  private forgetCanceledModelWork(before: CallState, after: CallState): void {
    for (const effect of Object.values(before.effects)) {
      if ((effect.kind === "model" || effect.kind === "modelKnowledge") && effect.status === "pending" &&
          after.effects[effect.id]?.status === "canceled") this.model?.forget(effect.taskRef);
    }
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
        const read = await this.host.readKnowledge(scope, sourceRefs);
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

  async acknowledgeTextPresentation(scope: LocationScope, callId: string, presentationId: string): Promise<Result<CallState, TransitionFailure>> {
    const runtime = this.runtime(scope);
    const started = await runtime.startPresentation(callId, presentationId);
    if (!started.ok) return started;
    return runtime.resolvePresentation(callId, presentationId, "played");
  }

  affirm(scope: LocationScope, turn: FinalCallerTurn, actionKey: string, digest: string, now: string, expectedConversationRevision?: number): Promise<Result<CallState, TransitionFailure>> {
    return this.runtime(scope).acceptTurn(turn, { kind: "affirm", actionKey, digest, affirmative: true }, now, expectedConversationRevision);
  }

  async drain(scope: LocationScope, callId: string, now: string): Promise<Result<CallState, TextReceptionFailure>> {
    const runtime = this.runtime(scope);
    const read = await runtime.read(callId);
    if (!read.ok) return read;
    const worker = new EffectWorker(runtime, this.host, this.model);
    for (const effect of Object.values(read.value.effects)) {
      if (effect.status !== "pending") continue;
      try {
        await worker.process(callId, effect.id, now);
      } catch {
        return err({ kind: "effectFailure" });
      }
    }
    return runtime.read(callId);
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
    try { await new EffectWorker(runtime, this.host).process(callId, effectId, now); }
    catch { /* The persisted intent remains available to the recovery worker. */ }
    return runtime.read(callId);
  }

  read(scope: LocationScope, callId: string): Promise<Result<CallState, TransitionFailure>> {
    return this.runtime(scope).read(callId);
  }
}
