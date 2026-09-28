import type { PolicyFailure, PolicyStore } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { CallPolicy, CallState, FinalCallerTurn, LocationScope, Result, StaffChangeRequest, StaffItem, TransitionFailure } from "../core/model.ts";
import { TextReception } from "./text-reception.ts";
import type { TextReceptionFailure } from "./text-reception.ts";
import type { CallSummary } from "./call-review.ts";
import { CallReview } from "./call-review.ts";
import type { StaffQueue } from "./staff-queue.ts";
import type { StaffQueuePage } from "./staff-queue.ts";
import type { CallOutcomeReport, CallOutcomePage } from "./call-outcome-report.ts";

export type HostActor = Readonly<{
  actorRef: string;
  role: "clinicAdmin" | "staff" | "agent";
  scope: LocationScope;
}>;

export type CapabilityDescriptor = Readonly<{
  id: "settings.read.v1" | "settings.appointments.booking.enabled.change.v1" | "booking.propose.v1" | "knowledge.answer.v1" | "availability.read.v1" | "calls.read.v1" | "calls.outcomes.v1" | "staff.list.v1" | "staff.change.v1";
  inputVersion: 1;
  outputVersion: 1;
  effect: "read" | "policyChange" | "proposalOnly" | "staffChange";
  requiresCallerConfirmation: boolean;
}>;

export type GatewayCommand =
  | Readonly<{ kind: "settings.read.v1" }>
  | Readonly<{ kind: "settings.appointments.booking.enabled.change.v1"; expectedVersion: string; enabled: boolean }>
  | Readonly<{ kind: "booking.propose.v1"; turn: FinalCallerTurn; verificationRef: string; offerRef: string; now: string }>
  | Readonly<{ kind: "knowledge.answer.v1"; turn: FinalCallerTurn; sourceRefs: readonly string[]; proposedText: string; now: string }>
  | Readonly<{ kind: "availability.read.v1"; turn: FinalCallerTurn; from: string; to: string; now: string }>
  | Readonly<{ kind: "calls.read.v1"; callId: string }>
  | Readonly<{ kind: "calls.outcomes.v1"; afterCallId?: string }>
  | Readonly<{ kind: "staff.list.v1"; afterTaskKey?: string }>
  | Readonly<{ kind: "staff.change.v1"; callId: string; taskKey: string; expectedVersion: number; change: StaffChangeRequest; now: string }>;

export type GatewayReply =
  | Readonly<{ kind: "settings"; policy: CallPolicy }>
  | Readonly<{ kind: "bookingProposal"; state: CallState }>
  | Readonly<{ kind: "knowledgeAnswer"; state: CallState }>
  | Readonly<{ kind: "availabilityAnswer"; state: CallState }>
  | Readonly<{ kind: "callSummary"; call: CallSummary }>
  | Readonly<{ kind: "callOutcomes"; page: CallOutcomePage }>
  | Readonly<{ kind: "staffQueue"; page: StaffQueuePage }>
  | Readonly<{ kind: "staffChange"; taskKey: string; callVersion: number; status: StaffItem["status"]; pending: boolean; reviewRequired: boolean }>;

export type GatewayFailure = PolicyFailure | TextReceptionFailure | TransitionFailure | Readonly<{ kind: "forbidden" | "invalid" }>;

export class CommandGateway {
  private readonly actor: HostActor;
  private readonly policy: PolicyStore;
  private readonly reception: TextReception;
  private readonly review: CallReview | undefined;
  private readonly staffQueue: StaffQueue | undefined;
  private readonly outcomeReport: CallOutcomeReport | undefined;

  constructor(actor: HostActor, policy: PolicyStore, reception: TextReception, review?: CallReview, staffQueue?: StaffQueue, outcomeReport?: CallOutcomeReport) {
    if (!actor.actorRef || !actor.scope.tenantId || !actor.scope.clinicId || !actor.scope.locationId) throw new Error("host actor identity is required");
    this.actor = structuredClone(actor);
    this.policy = policy;
    this.reception = reception;
    this.review = review;
    this.staffQueue = staffQueue;
    this.outcomeReport = outcomeReport;
  }

  listPermitted(): readonly CapabilityDescriptor[] {
    const common: CapabilityDescriptor[] = [
      { id: "settings.read.v1", inputVersion: 1, outputVersion: 1, effect: "read", requiresCallerConfirmation: false },
      { id: "booking.propose.v1", inputVersion: 1, outputVersion: 1, effect: "proposalOnly", requiresCallerConfirmation: true },
      { id: "knowledge.answer.v1", inputVersion: 1, outputVersion: 1, effect: "proposalOnly", requiresCallerConfirmation: false },
    ];
    if (this.reception.availabilityEnabled()) common.push({ id: "availability.read.v1", inputVersion: 1, outputVersion: 1, effect: "read", requiresCallerConfirmation: false });
    if (this.review) common.push({ id: "calls.read.v1", inputVersion: 1, outputVersion: 1, effect: "read", requiresCallerConfirmation: false });
    if (this.outcomeReport) common.push({ id: "calls.outcomes.v1", inputVersion: 1, outputVersion: 1, effect: "read", requiresCallerConfirmation: false });
    if (this.staffQueue) common.push({ id: "staff.list.v1", inputVersion: 1, outputVersion: 1, effect: "read", requiresCallerConfirmation: false });
    if (this.actor.role !== "agent" && this.reception.staffLifecycleEnabled()) common.push({ id: "staff.change.v1", inputVersion: 1, outputVersion: 1, effect: "staffChange", requiresCallerConfirmation: false });
    if (this.actor.role === "clinicAdmin") common.push({ id: "settings.appointments.booking.enabled.change.v1", inputVersion: 1, outputVersion: 1, effect: "policyChange", requiresCallerConfirmation: false });
    return common;
  }

  async submit(command: GatewayCommand): Promise<Result<GatewayReply, GatewayFailure>> {
    if (!this.listPermitted().some(capability => capability.id === command.kind)) return err({ kind: "forbidden" });
    switch (command.kind) {
      case "settings.read.v1": {
        const result = await this.policy.read(this.actor.scope);
        return result.ok ? ok({ kind: "settings", policy: result.value }) : result;
      }
      case "settings.appointments.booking.enabled.change.v1": {
        const result = await this.policy.changeBookingEnabled(this.actor.scope, command.expectedVersion, command.enabled);
        return result.ok ? ok({ kind: "settings", policy: result.value }) : result;
      }
      case "booking.propose.v1": {
        if (!command.turn.turnId || !command.turn.callId || !command.turn.text || !command.verificationRef || !command.offerRef) return err({ kind: "invalid" });
        const result = await this.reception.proposeBooking(this.actor.scope, command.turn, command.verificationRef, command.offerRef, command.now);
        return result.ok ? ok({ kind: "bookingProposal", state: result.value }) : result;
      }
      case "knowledge.answer.v1": {
        if (!command.turn || !command.turn.turnId || !command.turn.callId || !command.turn.text ||
            typeof command.now !== "string" || !Number.isFinite(Date.parse(command.now)) ||
            !Array.isArray(command.sourceRefs) || command.sourceRefs.some(ref => typeof ref !== "string") ||
            typeof command.proposedText !== "string") return err({ kind: "invalid" });
        const result = await this.reception.answer(this.actor.scope, command.turn, command.sourceRefs, command.proposedText, command.now);
        return result.ok ? ok({ kind: "knowledgeAnswer", state: result.value }) : result;
      }
      case "availability.read.v1": {
        if (!command.turn || !command.turn.turnId || !command.turn.callId || !command.turn.text ||
            typeof command.from !== "string" || typeof command.to !== "string" ||
            typeof command.now !== "string" || !Number.isFinite(Date.parse(command.now))) return err({ kind: "invalid" });
        const result = await this.reception.checkAvailability(this.actor.scope, command.turn, command.from, command.to, command.now);
        return result.ok ? ok({ kind: "availabilityAnswer", state: result.value }) : result;
      }
      case "calls.read.v1": {
        if (!this.review || !command.callId || command.callId.length > 256) return err({ kind: "invalid" });
        const result = await this.review.read(command.callId, this.actor.scope);
        return result.ok ? ok({ kind: "callSummary", call: result.value }) : result;
      }
      case "calls.outcomes.v1": {
        if (!this.outcomeReport || (command.afterCallId !== undefined &&
            (typeof command.afterCallId !== "string" || !command.afterCallId || command.afterCallId.length > 256))) return err({ kind: "invalid" });
        const result = await this.outcomeReport.list(this.actor.scope, command.afterCallId);
        return result.ok ? ok({ kind: "callOutcomes", page: result.value }) : result;
      }
      case "staff.list.v1": {
        if (!this.staffQueue || (command.afterTaskKey !== undefined &&
            (typeof command.afterTaskKey !== "string" || !command.afterTaskKey || command.afterTaskKey.length > 256))) return err({ kind: "invalid" });
        const result = await this.staffQueue.list(this.actor.scope, command.afterTaskKey);
        return result.ok ? ok({ kind: "staffQueue", page: result.value }) : result;
      }
      case "staff.change.v1": {
        if (!command.callId || command.callId.length > 256 || !command.taskKey || command.taskKey.length > 256 ||
            !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0 ||
            !command.change || !["acknowledge", "resolve", "reassign"].includes(command.change.kind) ||
            (command.change.kind === "reassign" && !["staff", "operator"].includes(command.change.target)) ||
            typeof command.now !== "string" || !Number.isFinite(Date.parse(command.now))) return err({ kind: "invalid" });
        const result = await this.reception.changeStaff(this.actor.scope, command.callId, command.expectedVersion,
          command.taskKey, this.actor.actorRef, command.change, command.now);
        if (!result.ok) return result;
        const item = result.value.staffItems[command.taskKey];
        return item ? ok({ kind: "staffChange", taskKey: item.key, callVersion: result.value.version,
          status: item.status, pending: !!item.pendingChangeKey, reviewRequired: !!item.reviewRequired })
          : err({ kind: "storageCorrupt" });
      }
    }
  }
}
