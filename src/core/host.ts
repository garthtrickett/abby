import type { ActionRequest, BookableOffer, CallPolicy, HostMutation, HostWriteReceipt, LocationScope, ReconcileObservation, Result, StaffItem, StaffTaskReceipt, VerifiedPatient } from "./model.ts";

export type HostReadFailure = Readonly<{ kind: "notFound" | "ambiguous" | "expired" | "unavailable"; target: "patient" | "offer" }>;
export type PolicyFailure = Readonly<{ kind: "versionConflict" | "invalidValue" | "storageFailure" }>;

export interface BookingEvidenceHost {
  resolveBooking(scope: LocationScope, verificationRef: string, offerRef: string, now: string): Promise<Result<Extract<ActionRequest, { kind: "book" }>, HostReadFailure>>;
}

export interface HostEffects {
  write(mutation: HostMutation, now: string): Promise<HostWriteReceipt>;
  reconcile(mutation: HostMutation): Promise<ReconcileObservation>;
  openTask(item: StaffItem): Promise<StaffTaskReceipt>;
}

export interface PolicyStore {
  read(scope: LocationScope): Promise<Result<CallPolicy, PolicyFailure>>;
  changeBookingEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean): Promise<Result<CallPolicy, PolicyFailure>>;
}
