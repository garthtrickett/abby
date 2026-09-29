import type { BookingEvidenceHost, HostEffects, HostReadFailure } from "../core/host.ts";
import { err } from "../core/model.ts";
import type { ActionRequest, HostMutation, HostWriteReceipt, LocationScope, ReconcileObservation, Result,
  StaffItem, StaffTaskObservation, StaffTaskReceipt } from "../core/model.ts";
import { NoStoredKnowledge } from "./no-stored-knowledge.ts";

/** Standalone text supports no patient mutation or staff task until a Cliniko-owned route is approved. */
export class DisabledStandaloneHost extends NoStoredKnowledge implements BookingEvidenceHost, HostEffects {
  async resolveBooking(_scope: LocationScope, _verificationRef: string, _offerRef: string, _now: string):
    Promise<Result<Extract<ActionRequest, { kind: "book" }>, HostReadFailure>> {
    return err({ kind: "unavailable", target: "offer" });
  }

  async write(mutation: HostMutation): Promise<HostWriteReceipt> {
    return { kind: "unsupported", actionKey: mutation.actionKey };
  }

  async reconcile(mutation: HostMutation): Promise<ReconcileObservation> {
    return { kind: "definitiveNonCommit", actionKey: mutation.actionKey };
  }

  async openTask(item: StaffItem): Promise<StaffTaskReceipt> {
    return { kind: "rejected", taskKey: item.key };
  }

  async reconcileTask(item: StaffItem): Promise<StaffTaskObservation> {
    return { kind: "definitiveNonOpen", taskKey: item.key };
  }
}
