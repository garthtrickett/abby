import type { ApprovedGreeting, CallPolicy, LocationScope } from "./model.ts";

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

function canonicalInstant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function validGreetingShape(value: unknown, scope: LocationScope): value is ApprovedGreeting {
  if (!scope || typeof scope !== "object" || Array.isArray(scope) ||
      Object.keys(scope).sort().join(",") !== "clinicId,locationId,tenantId" ||
      [scope.tenantId, scope.clinicId, scope.locationId].some(part => typeof part !== "string" || !part)) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const greeting = value as Record<string, unknown>;
  const greetingScope = greeting.scope;
  const keys = Object.keys(greeting).sort().join(",");
  if (keys !== "approved,approvedText,ownerRef,scope,version" &&
      keys !== "approved,approvedText,effectiveFrom,effectiveUntil,ownerRef,scope,version") return false;
  if (
      !greetingScope || typeof greetingScope !== "object" || Array.isArray(greetingScope) ||
      Object.keys(greetingScope).sort().join(",") !== "clinicId,locationId,tenantId" ||
      !sameScope(greetingScope as LocationScope, scope) || greeting.approved !== true ||
      typeof greeting.version !== "string" || !greeting.version.trim() || greeting.version.length > 256 ||
      typeof greeting.ownerRef !== "string" || !greeting.ownerRef.trim() || greeting.ownerRef.length > 256 ||
      typeof greeting.approvedText !== "string" || !greeting.approvedText.trim() || greeting.approvedText.length > 2_000) return false;
  if (/[\u0000-\u001f\u007f]/.test(greeting.version + greeting.ownerRef + greeting.approvedText)) return false;
  return keys === "approved,approvedText,ownerRef,scope,version" ||
    (canonicalInstant(greeting.effectiveFrom) && canonicalInstant(greeting.effectiveUntil) &&
      Date.parse(greeting.effectiveFrom) < Date.parse(greeting.effectiveUntil));
}

export function validGreetingAt(value: unknown, scope: LocationScope, now: string): value is ApprovedGreeting {
  if (!validGreetingShape(value, scope) || !Number.isFinite(Date.parse(now))) return false;
  if (value.effectiveFrom === undefined || value.effectiveUntil === undefined) return true;
  return Date.parse(value.effectiveFrom) <= Date.parse(now) && Date.parse(now) < Date.parse(value.effectiveUntil);
}

export function validApprovedGreeting(policy: CallPolicy): policy is CallPolicy & { greeting: ApprovedGreeting } {
  return validGreetingShape(policy.greeting, policy.scope);
}
