import type { Admission, InboundAdmission } from "./model.ts";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function reference(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 256;
}
function exactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
/** Validate the durable shape before storage; never silently strip private fields. */
export function validAdmission(value: unknown): value is Admission {
  if (!record(value) || !record(value.key) || !exactly(value.key, ["accountRef", "providerCallRef"]) ||
      !reference(value.key.accountRef) || !reference(value.key.providerCallRef) ||
      typeof value.acceptedAt !== "string" || typeof value.deadline !== "string" ||
      !Number.isFinite(Date.parse(value.acceptedAt)) || !Number.isFinite(Date.parse(value.deadline)) ||
      Date.parse(value.deadline) <= Date.parse(value.acceptedAt)) return false;
  return value.direction === "outbound"
    ? exactly(value, ["direction", "key", "clinicNumber", "acceptedAt", "deadline"]) && reference(value.clinicNumber)
    : exactly(value, ["key", "dialedNumber", "acceptedAt", "deadline"]) && reference(value.dialedNumber);
}
export function isInboundAdmission(value: unknown): value is InboundAdmission {
  return validAdmission(value) && value.direction !== "outbound";
}
/** Identity ignores retry timing, but preserves direction and the public number's role. */
export function sameCallAdmission(left: Admission, right: Admission): boolean {
  return left.key.accountRef === right.key.accountRef && left.key.providerCallRef === right.key.providerCallRef &&
    (left.direction === "outbound" ? right.direction === "outbound" && left.clinicNumber === right.clinicNumber
      : right.direction !== "outbound" && left.dialedNumber === right.dialedNumber);
}
export function admissionAudit(admission: Admission): Record<string, string> {
  return { accountRef: admission.key.accountRef, providerCallRef: admission.key.providerCallRef,
    ...(admission.direction === "outbound" ? { direction: "outbound", clinicNumber: admission.clinicNumber }
      : { dialedNumber: admission.dialedNumber }) };
}
