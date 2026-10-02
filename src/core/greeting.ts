import type { ApprovedGreeting, CallPolicy, LocationScope } from "./model.ts";

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

export function validGreetingShape(value: unknown, scope: LocationScope): value is ApprovedGreeting {
  if (!scope || typeof scope !== "object" || Array.isArray(scope) ||
      Object.keys(scope).sort().join(",") !== "clinicId,locationId,tenantId" ||
      [scope.tenantId, scope.clinicId, scope.locationId].some(part => typeof part !== "string" || !part)) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const greeting = value as Record<string, unknown>;
  const greetingScope = greeting.scope;
  if (Object.keys(greeting).sort().join(",") !== "approved,approvedText,ownerRef,scope,version" ||
      !greetingScope || typeof greetingScope !== "object" || Array.isArray(greetingScope) ||
      Object.keys(greetingScope).sort().join(",") !== "clinicId,locationId,tenantId" ||
      !sameScope(greetingScope as LocationScope, scope) || greeting.approved !== true ||
      typeof greeting.version !== "string" || !greeting.version.trim() || greeting.version.length > 256 ||
      typeof greeting.ownerRef !== "string" || !greeting.ownerRef.trim() || greeting.ownerRef.length > 256 ||
      typeof greeting.approvedText !== "string" || !greeting.approvedText.trim() || greeting.approvedText.length > 2_000) return false;
  return !/[\u0000-\u001f\u007f]/.test(greeting.version + greeting.ownerRef + greeting.approvedText);
}

export function validApprovedGreeting(policy: CallPolicy): policy is CallPolicy & { greeting: ApprovedGreeting } {
  return validGreetingShape(policy.greeting, policy.scope);
}
