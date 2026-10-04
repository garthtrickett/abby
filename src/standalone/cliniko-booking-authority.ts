import type { ClinikoBookingRequest, ClinikoBookingSelection } from "../cliniko/booking-write.ts";
import type { HostReadFailure } from "../core/host.ts";
import type { ActionRequest, BookableOffer, LocationScope, Result } from "../core/model.ts";
import { approvalInstant, approvalRef } from "./owner-file-clinic-approval.ts";
import { sameScope, validClinikoId } from "./appointment-change-authority.ts";

export type ClinikoBookingEvidence = Readonly<{
  scope: LocationScope; callId: string; sessionId: string; policyVersion: string; patientId: string;
  businessId: string; practitionerId: string; appointmentTypeId: string; credentialFingerprint: string;
  offer: BookableOffer; endsAt: string; timeZone: string; bookingPolicyVersion: string; contract: "bestEffort";
}>;
export type ClinikoBookingQuery = Readonly<{
  scope: LocationScope; callId: string; sessionId: string; policyVersion: string; patientId: string;
  verificationRef: string; offerRef: string; now: string; phase: "proposal" | "commit"; signal: AbortSignal;
}>;
export interface ClinikoBookingAuthority {
  /** Fresh approved selection/eligibility/available time at both phases; this is never slot exclusivity. */
  resolve(query: ClinikoBookingQuery): Promise<Result<ClinikoBookingEvidence, HostReadFailure>>;
}
export type PreparedClinikoBooking = Readonly<{
  request: Extract<ActionRequest, { kind: "book" }>;
  query: Omit<ClinikoBookingQuery, "phase" | "signal">;
  evidence: ClinikoBookingEvidence;
}>;

/** Validate provider bindings and the exact approved interval outside the portable booking shape. */
export function validClinikoBookingEvidence(value: ClinikoBookingEvidence, query: ClinikoBookingQuery,
  selection: ClinikoBookingSelection, fingerprint: string): boolean {
  try {
    const offer = value.offer, now = approvalInstant(query.now), start = approvalInstant(offer.startsAt), end = approvalInstant(value.endsAt);
    const expiry = approvalInstant(offer.expiresAt);
    new Intl.DateTimeFormat("en", { timeZone: value.timeZone });
    return now !== undefined && start !== undefined && end !== undefined && expiry !== undefined &&
      start > now && end > start && end - start <= 480 * 60_000 && expiry > now &&
      sameScope(value.scope, query.scope) && sameScope(selection.scope, query.scope) && sameScope(offer.scope, query.scope) &&
      value.callId === query.callId && value.sessionId === query.sessionId && value.policyVersion === query.policyVersion &&
      value.patientId === query.patientId && validClinikoId(value.patientId) && value.businessId === selection.businessId &&
      value.practitionerId === selection.practitionerId && value.appointmentTypeId === selection.appointmentTypeId &&
      value.credentialFingerprint === fingerprint && offer.offerRef === query.offerRef && approvalRef(offer.serviceRef) &&
      value.contract === "bestEffort" && approvalRef(value.bookingPolicyVersion) && typeof value.timeZone === "string" && value.timeZone.length <= 128;
  } catch { return false; }
}
export function bookingProviderRequest(prepared: PreparedClinikoBooking, marker: string): ClinikoBookingRequest {
  return { scope: prepared.request.patient.scope, patientId: prepared.request.patient.patientRef,
    startsAt: prepared.request.offer.startsAt, marker };
}
export function sameClinikoBookingEvidence(left: ClinikoBookingEvidence, right: ClinikoBookingEvidence): boolean {
  return left.endsAt === right.endsAt && left.timeZone === right.timeZone && left.bookingPolicyVersion === right.bookingPolicyVersion &&
    left.businessId === right.businessId && left.practitionerId === right.practitionerId && left.appointmentTypeId === right.appointmentTypeId &&
    left.credentialFingerprint === right.credentialFingerprint && left.contract === right.contract;
}
