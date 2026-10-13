import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { validBookingServiceChoice } from "../core/booking-service-choice.ts";
import type { BookingServiceChoice } from "../core/booking-service-choice.ts";
import { err, ok } from "../core/model.ts";
import type { ClinikoCallFlowConfig } from "./cliniko-call-flow.ts";
import { OwnerFileServiceCatalogue } from "./owner-file-service-catalogue.ts";

export type ServiceCatalogueConfig = Readonly<{ approvalPath: string; services: readonly Readonly<{ serviceRef: string;
  practitioners: readonly Readonly<{ practitionerId: string; bookingApprovalPath: string }>[] }>[] }>;

/** Map a validated caller request to private approved writer bindings. This
 * creates no verifier, provider traffic, offer or clinical mutation. */
export async function serviceBookingConfig(config: ClinikoCallFlowConfig, incoming: BookingServiceChoice) {
  const denied = () => err({ kind: "workflowUnavailable" as const });
  if (!config.serviceCatalogue || !validBookingServiceChoice(incoming)) return denied();
  const choice = Object.freeze({ ...incoming }), c = config.serviceCatalogue;
  const result = await OwnerFileServiceCatalogue.capture({ path: c.approvalPath, scope: config.receipt.scope, policyVersion: config.policyVersion,
    businessId: config.cliniko.businessId, credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey), timeZone: config.cliniko.timeZone,
    directory: config.directory, ...(config.clock ? { clock: config.clock } : {}) });
  if (!result.ok) return denied();
  const selected = await result.value.select(config.receipt.scope, choice); if (!selected.ok) return denied();
  const service = selected.value, mappings = c.services.filter(row => row.serviceRef === service.serviceRef);
  if (mappings.length !== 1 || mappings[0]!.practitioners.length !== service.practitioners.length ||
      mappings[0]!.practitioners.some((member, index) => member.practitionerId !== service.practitioners[index]?.practitionerId ||
        typeof member.bookingApprovalPath !== "string" || !member.bookingApprovalPath.trim())) return denied();
  const primary = mappings[0]!.practitioners[0]!;
  return ok({ ...config, cliniko: Object.freeze({ ...config.cliniko, practitionerId: primary.practitionerId, appointmentTypeId: service.appointmentTypeId }),
    approvals: Object.freeze({ ...config.approvals, booking: primary.bookingApprovalPath }), catalogue: Object.freeze({ approvalPath: c.approvalPath,
      practitioners: mappings[0]!.practitioners, serviceBinding: Object.freeze({ catalogue: result.value, serviceRef: service.serviceRef }) }) });
}
