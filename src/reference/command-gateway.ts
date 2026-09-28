import type { PolicyFailure, PolicyStore } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { CallPolicy, CallState, FinalCallerTurn, LocationScope, Result, TransitionFailure } from "../core/model.ts";
import { TextReception } from "./text-reception.ts";
import type { TextReceptionFailure } from "./text-reception.ts";
import type { CallSummary } from "./call-review.ts";
import { CallReview } from "./call-review.ts";

export type HostActor = Readonly<{
  actorRef: string;
  role: "clinicAdmin" | "staff" | "agent";
  scope: LocationScope;
}>;

export type CapabilityDescriptor = Readonly<{
  id: "settings.read.v1" | "settings.appointments.booking.enabled.change.v1" | "booking.propose.v1" | "calls.read.v1";
  inputVersion: 1;
  outputVersion: 1;
  effect: "read" | "policyChange" | "proposalOnly";
  requiresCallerConfirmation: boolean;
}>;

export type GatewayCommand =
  | Readonly<{ kind: "settings.read.v1" }>
  | Readonly<{ kind: "settings.appointments.booking.enabled.change.v1"; expectedVersion: string; enabled: boolean }>
  | Readonly<{ kind: "booking.propose.v1"; turn: FinalCallerTurn; verificationRef: string; offerRef: string; now: string }>
  | Readonly<{ kind: "calls.read.v1"; callId: string }>;

export type GatewayReply =
  | Readonly<{ kind: "settings"; policy: CallPolicy }>
  | Readonly<{ kind: "bookingProposal"; state: CallState }>
  | Readonly<{ kind: "callSummary"; call: CallSummary }>;

export type GatewayFailure = PolicyFailure | TextReceptionFailure | TransitionFailure | Readonly<{ kind: "forbidden" | "invalid" }>;

export class CommandGateway {
  private readonly actor: HostActor;
  private readonly policy: PolicyStore;
  private readonly reception: TextReception;
  private readonly review: CallReview | undefined;

  constructor(actor: HostActor, policy: PolicyStore, reception: TextReception, review?: CallReview) {
    if (!actor.actorRef || !actor.scope.tenantId || !actor.scope.clinicId || !actor.scope.locationId) throw new Error("host actor identity is required");
    this.actor = structuredClone(actor);
    this.policy = policy;
    this.reception = reception;
    this.review = review;
  }

  listPermitted(): readonly CapabilityDescriptor[] {
    const common: CapabilityDescriptor[] = [
      { id: "settings.read.v1", inputVersion: 1, outputVersion: 1, effect: "read", requiresCallerConfirmation: false },
      { id: "booking.propose.v1", inputVersion: 1, outputVersion: 1, effect: "proposalOnly", requiresCallerConfirmation: true },
    ];
    if (this.review) common.push({ id: "calls.read.v1", inputVersion: 1, outputVersion: 1, effect: "read", requiresCallerConfirmation: false });
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
      case "calls.read.v1": {
        if (!this.review || !command.callId || command.callId.length > 256) return err({ kind: "invalid" });
        const result = await this.review.read(command.callId, this.actor.scope);
        return result.ok ? ok({ kind: "callSummary", call: result.value }) : result;
      }
    }
  }
}
