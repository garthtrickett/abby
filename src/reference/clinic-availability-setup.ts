import type { LocationScope, Result } from "../core/model.ts";
import type { HostActor } from "./command-gateway.ts";

/** Provider-neutral clinic setup contract. It grants read-only availability, never patient actions. */
export type ClinicAvailabilitySelection = Readonly<{
  businessId: string;
  practitionerId: string;
  appointmentTypeId: string;
  policyVersion: string;
}>;
export type ClinicAvailabilityRoute = Readonly<{
  accountRef: string;
  dialedNumber: string;
  routeVersion: string;
}>;
export type ClinicAvailabilityBusinessCatalogue = Readonly<{
  scope: LocationScope;
  observedAt: string;
  credentialFingerprint: string;
  status: "complete";
  businesses: readonly Readonly<{
    businessId: string;
    name: string;
    timeZone: string | null;
    onlineBooking: boolean;
    archived: boolean;
  }>[];
}>;
export type ClinicAvailabilityPractitionerCatalogue = Readonly<{
  scope: LocationScope;
  businessId: string;
  observedAt: string;
  credentialFingerprint: string;
  status: "complete";
  practitioners: readonly Readonly<{ practitionerId: string; name: string; active: boolean; onlineBooking: boolean }>[];
}>;
export type ClinicAvailabilityTypeCatalogue = Readonly<{
  scope: LocationScope;
  businessId: string;
  practitionerId: string;
  observedAt: string;
  credentialFingerprint: string;
  status: "complete";
  appointmentTypes: readonly Readonly<{
    appointmentTypeId: string; name: string; onlineBooking: boolean; archived: boolean; businessSelected: boolean;
  }>[];
}>;
export type ClinicAvailabilitySelectionSnapshot = Readonly<{
  scope: LocationScope;
  selection: ClinicAvailabilitySelection;
  observedAt: string;
  credentialFingerprint: string;
  businessName: string;
  practitionerName: string;
  appointmentTypeName: string;
  timeZone: string | null;
  status: "candidate" | "unavailable";
  reasons: readonly string[];
  patientActionMode: "unavailable";
  patientRequestMode: "unavailable";
}>;
export type ClinicAvailabilityApprovalState = Readonly<{
  version: number;
  approval: Readonly<{
    scope: LocationScope;
    route: ClinicAvailabilityRoute;
    selection: ClinicAvailabilitySelection;
    alternatives: readonly ClinicAvailabilitySelection[];
    businessTimeZone: string;
    credentialFingerprint: string;
    catalogueObservedAt: string;
    approvedBy: string;
    approvedAt: string;
    patientActionMode: "unavailable";
    patientRequestMode: "unavailable";
  }> | null;
}>;
export type ClinicAvailabilitySetupFailure = Readonly<{ kind: "forbidden" | "invalid" | "scopeMismatch" |
  "routeChanged" | "policyChanged" | "credentialForbidden" | "catalogueRateLimited" |
  "catalogueUnavailable" | "selectionUnavailable" |
  "staleCatalogue" | "notApproved" | "staleApproval" | "versionConflict" | "storageFailure" }>;

export interface ClinicAvailabilitySetup {
  businesses(actor: HostActor): Promise<Result<ClinicAvailabilityBusinessCatalogue, ClinicAvailabilitySetupFailure>>;
  practitioners(actor: HostActor, businessId: string): Promise<Result<ClinicAvailabilityPractitionerCatalogue, ClinicAvailabilitySetupFailure>>;
  appointmentTypes(actor: HostActor, businessId: string, practitionerId: string):
    Promise<Result<ClinicAvailabilityTypeCatalogue, ClinicAvailabilitySetupFailure>>;
  inspect(actor: HostActor, selection: ClinicAvailabilitySelection):
    Promise<Result<ClinicAvailabilitySelectionSnapshot, ClinicAvailabilitySetupFailure>>;
  current(actor: HostActor): Promise<Result<ClinicAvailabilityApprovalState, ClinicAvailabilitySetupFailure>>;
  /** Recheck the stored route and every approved selection against current provider metadata. */
  checkApprovedRoute(actor: HostActor): Promise<Result<Readonly<{ eligible: true }>, ClinicAvailabilitySetupFailure>>;
  approve(actor: HostActor, route: ClinicAvailabilityRoute, selection: ClinicAvailabilitySelection, expectedVersion: number):
    Promise<Result<ClinicAvailabilityApprovalState, ClinicAvailabilitySetupFailure>>;
  approveAlternatives(actor: HostActor, route: ClinicAvailabilityRoute, selection: ClinicAvailabilitySelection,
    alternatives: readonly ClinicAvailabilitySelection[], expectedVersion: number):
    Promise<Result<ClinicAvailabilityApprovalState, ClinicAvailabilitySetupFailure>>;
  revoke(actor: HostActor, expectedVersion: number):
    Promise<Result<ClinicAvailabilityApprovalState, ClinicAvailabilitySetupFailure>>;
}
