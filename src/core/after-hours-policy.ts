import type { AfterHoursMode, ApprovedAfterHoursInfo, CallPolicy, LocationScope } from "./model.ts";

export function validAfterHoursInfo(value: unknown, scope: LocationScope): value is ApprovedAfterHoursInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const info = value as Record<string, unknown>;
  const bound = info.scope as Record<string, unknown> | undefined;
  return Object.keys(info).sort().join(",") === "approved,approvedText,ownerRef,scope,version" &&
    !!bound && typeof bound === "object" && !Array.isArray(bound) &&
    Object.keys(bound).sort().join(",") === "clinicId,locationId,tenantId" &&
    bound.tenantId === scope.tenantId && bound.clinicId === scope.clinicId && bound.locationId === scope.locationId &&
    typeof info.version === "string" && !!info.version.trim() && info.version.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(info.version) &&
    typeof info.ownerRef === "string" && !!info.ownerRef.trim() && info.ownerRef.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(info.ownerRef) &&
    typeof info.approvedText === "string" && !!info.approvedText.trim() && info.approvedText.length <= 1_500 &&
    !/[\u0000-\u001f\u007f]/.test(info.approvedText) && info.approved === true;
}

export function validAfterHoursSetting(mode: unknown, info: unknown, scope: LocationScope): mode is AfterHoursMode {
  return mode === "staffRequest" ? info === undefined :
    mode === "approvedInfoAndRequest" && validAfterHoursInfo(info, scope);
}

export function approvedAfterHoursText(policy: CallPolicy): string | undefined {
  return policy.afterHoursMode === "approvedInfoAndRequest" &&
    validAfterHoursInfo(policy.afterHoursInfo, policy.scope) ? policy.afterHoursInfo.approvedText : undefined;
}
