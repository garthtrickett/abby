import type { ActionRequest, CallPolicy, LocationScope, TransitionFailure } from "./model.ts";
export type ConfirmationResendAction = Extract<ActionRequest, { kind: "confirmationResend" }>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const scopePart = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(value);
const scope = (value: unknown): value is LocationScope => object(value) && Object.keys(value).sort().join(",") === "clinicId,locationId,tenantId" && [value.tenantId, value.clinicId, value.locationId].every(scopePart);
function instant(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString() === value ? Date.parse(value) : undefined;
}
/** Exact references only. Private recipient, details/readback and proof remain with the host. */
export function confirmationResendEvidenceFailure(policy: CallPolicy, action: ConfirmationResendAction, now: string): TransitionFailure | undefined {
  if (!object(action) || Object.keys(action).sort().join(",") !== "expiresAt,kind,requestRef,resendVersion,scope" || action.kind !== "confirmationResend" ||
      typeof action.requestRef !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(action.requestRef) ||
      typeof action.resendVersion !== "string" || !/^[a-f0-9]{64}$/.test(action.resendVersion)) return { kind: "invalidTransition" };
  if (!scope(policy.scope) || !scope(action.scope) || policy.scope.tenantId !== action.scope.tenantId || policy.scope.clinicId !== action.scope.clinicId || policy.scope.locationId !== action.scope.locationId) return { kind: "scopeMismatch" };
  if (policy.capabilities.confirmationResend === "execute" && policy.confirmationResendVersion !== action.resendVersion) return { kind: "invalidTransition" };
  const at = instant(now), expiry = instant(action.expiresAt);
  if (at === undefined || expiry === undefined || expiry - at > 300_000) return { kind: "invalidTransition" };
  return expiry <= at ? { kind: "evidenceExpired" } : undefined;
}
