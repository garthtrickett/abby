import type { ApprovedUrgentResponse, CallPolicy, CallState, LocationScope } from "./model.ts";
import { staffRequestNotice } from "./staff-fallback.ts";

const NO_APPROVED_URGENT_RESPONSE = "I can't give advice on that request. Please contact the clinic directly.";

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

function canonicalInstant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function validUrgentResponseShape(value: unknown, scope: LocationScope): value is ApprovedUrgentResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  const responseScope = response.scope as Record<string, unknown> | undefined;
  if (Object.keys(response).sort().join(",") !== "approved,approvedText,effectiveFrom,effectiveUntil,ownerRef,scope,version" ||
      !responseScope || typeof responseScope !== "object" || Array.isArray(responseScope) ||
      Object.keys(responseScope).sort().join(",") !== "clinicId,locationId,tenantId" ||
      !sameScope(responseScope as LocationScope, scope) || response.approved !== true ||
      typeof response.version !== "string" || !response.version.trim() || response.version.length > 128 ||
      typeof response.ownerRef !== "string" || !response.ownerRef.trim() || response.ownerRef.length > 256 ||
      typeof response.approvedText !== "string" || !response.approvedText.trim() || response.approvedText.length > 1_500 ||
      /[\u0000-\u001f\u007f]/.test(response.version + response.ownerRef + response.approvedText) ||
      !canonicalInstant(response.effectiveFrom) || !canonicalInstant(response.effectiveUntil)) return false;
  return Date.parse(response.effectiveFrom) < Date.parse(response.effectiveUntil);
}

export function validUrgentResponse(value: unknown, scope: LocationScope, now: string): value is ApprovedUrgentResponse {
  if (!validUrgentResponseShape(value, scope)) return false;
  const from = Date.parse(value.effectiveFrom);
  const until = Date.parse(value.effectiveUntil);
  const current = Date.parse(now);
  return Number.isFinite(current) && from <= current && current < until;
}

export function approvedUrgentText(policy: CallPolicy, now: string): string | undefined {
  return validUrgentResponse(policy.urgentResponse, policy.scope, now) ? policy.urgentResponse.approvedText : undefined;
}

/** An urgent model classification is a routing cue, never a diagnosis or authority to invent advice. */
export function urgentHandoffNotice(state: CallState, now: string): string {
  const approved = approvedUrgentText(state.policy, now);
  return approved ? `${approved} ${staffRequestNotice(state)}` : NO_APPROVED_URGENT_RESPONSE;
}
