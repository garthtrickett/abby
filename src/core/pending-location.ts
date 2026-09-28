import { createHash } from "node:crypto";
import type { Admission, CallPolicy, PendingLocationCall, PendingLocationRoute } from "./model.ts";

export const LOCATION_CHOICE_TIMEOUT_MS = 120_000;
export const PENDING_LOCATION_LEASE_MS = 30_000;

function validRef(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 256;
}

export function normalizedSpokenName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 80 || /[\p{Cc}\p{Cf}]/u.test(value)) return undefined;
  const normalized = value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-AU");
  return normalized && /^[\p{L}\p{N}](?:[\p{L}\p{N} .,'&-]*[\p{L}\p{N}])?$/u.test(normalized) ? normalized : undefined;
}

export function validCandidateNames(ids: readonly string[], names: unknown): boolean {
  if (!Array.isArray(names) || names.length !== ids.length) return false;
  const normalized = new Set<string>();
  return names.every((item, index) => {
    const name = item && typeof item === "object" ? item as { locationId?: unknown; spokenName?: unknown } : undefined;
    const key = normalizedSpokenName(name?.spokenName);
    if (name?.locationId !== ids[index] || !key || normalized.has(key)) return false;
    normalized.add(key);
    return true;
  });
}

export function validPendingRoute(route: unknown): route is PendingLocationRoute {
  if (!route || typeof route !== "object") return false;
  const value = route as Partial<PendingLocationRoute>;
  return validRef(value.tenantId) && validRef(value.clinicId) && validRef(value.routeVersion) &&
    Array.isArray(value.candidateLocationIds) && value.candidateLocationIds.length >= 2 &&
    value.candidateLocationIds.length <= 32 && value.candidateLocationIds.every(validRef) &&
    new Set(value.candidateLocationIds).size === value.candidateLocationIds.length &&
    validCandidateNames(value.candidateLocationIds, value.candidateNames);
}

export function pendingCallId(key: Admission["key"]): string {
  return createHash("sha256").update(JSON.stringify([key.accountRef, key.providerCallRef])).digest("hex");
}

export function validPendingAdmission(callId: string, admission: unknown): admission is Admission {
  if (!admission || typeof admission !== "object") return false;
  const value = admission as Partial<Admission>;
  return !!value.key && validRef(value.key.accountRef) && validRef(value.key.providerCallRef) &&
    pendingCallId(value.key) === callId && validRef(value.dialedNumber) &&
    typeof value.acceptedAt === "string" && Number.isFinite(Date.parse(value.acceptedAt)) &&
    typeof value.deadline === "string" && Number.isFinite(Date.parse(value.deadline)) &&
    Date.parse(value.deadline) > Date.parse(value.acceptedAt);
}

export function validPendingLocation(value: unknown, callId: string): value is PendingLocationCall {
  if (!value || typeof value !== "object") return false;
  const pending = value as Partial<PendingLocationCall>;
  const lease = pending.sessionLease;
  const evidence = pending.choiceEvidence;
  return pending.callId === callId && validPendingRoute(pending.route) &&
    validPendingAdmission(callId, pending.admission) &&
    (pending.status === "pending" || pending.status === "expired" || pending.status === "bound") &&
    (lease === undefined || (validRef(lease.sessionId) && Number.isSafeInteger(lease.version) && lease.version >= 1 &&
      typeof lease.expiresAt === "string" && Number.isFinite(Date.parse(lease.expiresAt)) &&
      typeof lease.validForMs === "number" && lease.validForMs > 0 && lease.validForMs <= PENDING_LOCATION_LEASE_MS)) &&
    (evidence === undefined || (validRef(evidence.sessionId) && Number.isSafeInteger(evidence.leaseVersion) &&
      evidence.leaseVersion >= 1 && validRef(evidence.turnId) &&
      validRef(evidence.selectedLocationId) && typeof evidence.at === "string" && Number.isFinite(Date.parse(evidence.at))));
}

export function pendingDueAt(pending: PendingLocationCall): number {
  return Math.min(Date.parse(pending.admission.deadline),
    pending.sessionLease ? Date.parse(pending.sessionLease.expiresAt) : Number.POSITIVE_INFINITY);
}

export function pendingMatchesAdmission(pending: PendingLocationCall, admission: Admission): boolean {
  return pending.admission.key.accountRef === admission.key.accountRef &&
    pending.admission.key.providerCallRef === admission.key.providerCallRef &&
    pending.admission.dialedNumber === admission.dialedNumber;
}

export function policyMatchesPending(pending: PendingLocationCall, policy: CallPolicy): boolean {
  return policy.scope.tenantId === pending.route.tenantId && policy.scope.clinicId === pending.route.clinicId &&
    pending.route.candidateLocationIds.includes(policy.scope.locationId) &&
    policy.numberRouteVersion === pending.route.routeVersion;
}
