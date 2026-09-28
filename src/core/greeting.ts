import type { ApprovedGreeting, CallPolicy, LocationScope } from "./model.ts";

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

export function validApprovedGreeting(policy: CallPolicy): policy is CallPolicy & { greeting: ApprovedGreeting } {
  const greeting = policy.greeting;
  return !!greeting && greeting.approved === true && !!greeting.scope && sameScope(greeting.scope, policy.scope) &&
    typeof greeting.version === "string" && greeting.version.trim().length > 0 && greeting.version.length <= 256 &&
    typeof greeting.ownerRef === "string" && greeting.ownerRef.trim().length > 0 && greeting.ownerRef.length <= 256 &&
    typeof greeting.approvedText === "string" && greeting.approvedText.trim().length > 0 && greeting.approvedText.length <= 2_000;
}
