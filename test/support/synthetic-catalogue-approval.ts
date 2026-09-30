import type { ClinikoAvailabilityReader } from "../../src/cliniko/availability.ts";
import type { ClinikoSelectionApproval, ClinikoSetupRoute } from "../../src/cliniko/catalogue-setup.ts";
import { err, ok } from "../../src/core/model.ts";
import type { LocationScope } from "../../src/core/model.ts";

/** Synthetic approval port for tests focused on another voice contract. */
export function syntheticCatalogueApproval(availability: ClinikoAvailabilityReader, scope: LocationScope,
                                           route: ClinikoSetupRoute, policyVersion = "0") {
  const approval: ClinikoSelectionApproval = { scope, route,
    selection: { businessId: "11", practitionerId: "22", appointmentTypeId: "33", policyVersion },
    credentialFingerprint: availability.credentialFingerprint(),
    catalogueObservedAt: "2026-09-29T10:00:00.000Z", approvedAt: "2026-09-29T10:00:00.000Z",
    approvedBy: "synthetic-admin", patientActionMode: "unavailable", patientRequestMode: "unavailable" };
  return { async readApprovedRoute(requestScope: LocationScope, requestedRoute: ClinikoSetupRoute) {
    return requestScope.tenantId === scope.tenantId && requestScope.clinicId === scope.clinicId &&
      requestScope.locationId === scope.locationId && requestedRoute.accountRef === route.accountRef &&
      requestedRoute.dialedNumber === route.dialedNumber && requestedRoute.routeVersion === route.routeVersion
      ? ok(approval) : err({ kind: "routeChanged" } as const);
  } };
}
