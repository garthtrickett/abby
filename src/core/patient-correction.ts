import type { ActionRequest, LocationScope, TransitionFailure } from "./model.ts";

export type PatientCorrectionAction = Extract<ActionRequest, { kind: "patientUpdate" }>;
const ref = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const scope = (value: unknown): value is LocationScope => record(value) && Object.keys(value).sort().join(",") === "clinicId,locationId,tenantId" &&
  [value.tenantId, value.clinicId, value.locationId].every(ref);
const same = (a: LocationScope, b: LocationScope) => a.tenantId === b.tenantId && a.clinicId === b.clinicId && a.locationId === b.locationId;
function instant(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 19) === value.slice(0, 19) ? at : undefined;
}
/** Shared state contains host references only. Private readback/prospective proof
 * must be resolved again by the owning host before its one possible write. */
export function patientCorrectionEvidenceFailure(bound: LocationScope, action: PatientCorrectionAction, now: string): TransitionFailure | undefined {
  if (!record(action) || Object.keys(action).sort().join(",") !== "consentRef,correctionRef,correctionVersion,expiresAt,kind,patient" || action.kind !== "patientUpdate" ||
      !record(action.patient) || Object.keys(action.patient).sort().join(",") !== "expiresAt,patientRef,scope,verificationRef" ||
      ![action.correctionRef, action.consentRef, action.correctionVersion].every(ref) || typeof action.patient.verificationRef !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(action.patient.verificationRef) ||
      typeof action.patient.patientRef !== "string" || !action.patient.patientRef.trim() || action.patient.patientRef.length > 256 || /[\p{Cc}\p{Cf}]/u.test(action.patient.patientRef)) return { kind: "invalidTransition" };
  if (!scope(bound) || !scope(action.patient.scope) || !same(bound, action.patient.scope)) return { kind: "scopeMismatch" };
  const at = instant(now), expiry = instant(action.expiresAt), proof = instant(action.patient.expiresAt);
  if (at === undefined || expiry === undefined || proof === undefined || expiry > proof || expiry - at > 300_000) return { kind: "invalidTransition" };
  return expiry <= at || proof <= at ? { kind: "evidenceExpired" } : undefined;
}
