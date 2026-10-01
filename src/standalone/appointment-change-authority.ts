import type { ClinikoCancellationRequest, ClinikoRescheduleRequest } from "../cliniko/appointment-write.ts";
import type { AppointmentChangeEvidenceQuery, HostReadFailure } from "../core/host.ts";
import type { ActionRequest, AppointmentChangeTerms, AppointmentTarget, BookableOffer,
  LocationScope, Result } from "../core/model.ts";

export type AppointmentChangeRequest = Extract<ActionRequest, { kind: "cancel" | "reschedule" }>;
export type ClinikoChangeProviderRequest = ClinikoCancellationRequest | ClinikoRescheduleRequest;
type Reason = ClinikoCancellationRequest["cancellationReason"];

export type AppointmentChangeAuthorityEvidence = Readonly<{
  scope: LocationScope;
  callId: string;
  sessionId: string;
  policyVersion: string;
  patientId: string;
  targetRef: string;
  businessId: string;
  credentialFingerprint: string;
  practitionerId: string;
  appointmentTypeId: string;
  target: AppointmentTarget;
  terms: AppointmentChangeTerms;
}> & (Readonly<{ kind: "cancel"; cancellationReason: Reason }> |
  Readonly<{ kind: "reschedule"; offer: BookableOffer }>);

export type AppointmentChangeAuthority = Readonly<{
  /** Re-read selected appointment, fee terms and permission at proposal and commit. */
  resolve(query: AppointmentChangeEvidenceQuery & Readonly<{
    patientId: string;
    phase: "proposal" | "commit";
    signal: AbortSignal;
  }>): Promise<Result<AppointmentChangeAuthorityEvidence, HostReadFailure>>;
}>;

export function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId &&
    left.locationId === right.locationId;
}

export function validClinikoId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value);
}

/** Pure projection from host-selected evidence to the exact provider mutation target. */
export function providerRequest(request: AppointmentChangeRequest, evidence: AppointmentChangeAuthorityEvidence,
                                scope: LocationScope): ClinikoChangeProviderRequest | undefined {
  if (evidence.kind !== request.kind || evidence.target.appointmentRef !== request.target.appointmentRef ||
      evidence.target.patientRef !== request.patient.patientRef ||
      ![evidence.patientId, evidence.businessId, evidence.practitionerId,
        evidence.appointmentTypeId, evidence.target.appointmentRef].every(validClinikoId)) return undefined;
  const target = { scope, patientId: evidence.patientId,
    appointmentId: evidence.target.appointmentRef, practitionerId: evidence.practitionerId,
    appointmentTypeId: evidence.appointmentTypeId,
    startsAt: request.target.startsAt, endsAt: request.target.endsAt };
  if (request.kind === "cancel" && evidence.kind === "cancel") {
    return [10, 20, 30, 40, 50, 60].includes(evidence.cancellationReason)
      ? { ...target, cancellationReason: evidence.cancellationReason } : undefined;
  }
  if (request.kind === "reschedule" && evidence.kind === "reschedule") {
    const start = Date.parse(request.target.startsAt);
    const end = Date.parse(request.target.endsAt);
    const newStart = Date.parse(request.offer.startsAt);
    const newEnd = newStart + end - start;
    if (!Number.isFinite(newEnd) || newEnd <= newStart) return undefined;
    return { ...target, newStartsAt: request.offer.startsAt,
      newEndsAt: new Date(newEnd).toISOString() };
  }
  return undefined;
}

export function sameProviderRequest(left: ClinikoChangeProviderRequest,
                                    right: ClinikoChangeProviderRequest): boolean {
  return sameScope(left.scope, right.scope) && left.patientId === right.patientId &&
    left.appointmentId === right.appointmentId && left.practitionerId === right.practitionerId &&
    left.appointmentTypeId === right.appointmentTypeId && left.startsAt === right.startsAt &&
    left.endsAt === right.endsAt &&
    ("cancellationReason" in left && "cancellationReason" in right
      ? left.cancellationReason === right.cancellationReason
      : "newStartsAt" in left && "newStartsAt" in right &&
        left.newStartsAt === right.newStartsAt && left.newEndsAt === right.newEndsAt);
}
