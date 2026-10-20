import { patientDetailFields, validPatientDetailChanges } from "../cliniko/patient-details.ts";
import type { PatientDetailChanges, PatientDetailField } from "../cliniko/patient-details.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { validClinikoId } from "./appointment-change-authority.ts";
import { clinicDateAt } from "./clinic-clock.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { approvalInstant, approvalRef, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";

export const patientUpdateScopeText = "Changes to your patient details apply across all clinics in this Cliniko account. They do not change your appointments.";
type Terms = Readonly<{ version: string; approvedText: string }>;
export type PatientUpdateApproval = ClinicApproval & Readonly<{
  policyVersion: string; correctionVersion: string; businessId: string; credentialFingerprint: string; timeZone: string;
  operation: "patients.update"; recordScope: "clinikoAccount";
  callerEligibility: "selfOnly"; minors: "deny"; representatives: "deny"; minimumAgeYears: number;
  leapDayBirthday: "march1"; patientPermission: "independentClinicHost";
  verificationMethod: "registeredEmailOtp"; emailChangeVerification: "prospectiveEmailOtp";
  confirmation: "privateReadback"; contactSynchronization: "revokeProofsAndInvalidateAccountLookups";
  allowedFields: readonly PatientDetailField[]; privacyTerms: Terms; correctionTerms: Terms;
}>;
export type PatientUpdatePolicyBinding = Pick<PatientUpdateApproval, "scope" | "policyVersion" | "correctionVersion" |
  "businessId" | "credentialFingerprint" | "timeZone">;
type Config = PatientUpdatePolicyBinding & Readonly<{
  path: string; directory: AdminDirectory; correctionsEnabled: boolean; clock?: () => string; timeoutMs?: number;
}>;
type Failure = Readonly<{ kind: "patientUpdatePolicyUnavailable" | "patientCorrectionDenied" }>;
export type PatientCorrectionPolicyQuery = Readonly<{
  scope: LocationScope; caller: "patient" | "proxy";
  /** Trusted native before-snapshot input; a caller/model age assertion cannot supply it. */
  existingBirthDate: string;
  changes: PatientDetailChanges; privacyAccepted: boolean; privacyTermsVersion: string;
  correctionAccepted: boolean; correctionTermsVersion: string;
}>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const scope = (value: unknown): value is LocationScope => object(value) && Object.keys(value).sort().join(",") === "clinicId,locationId,tenantId" &&
  [value.tenantId, value.clinicId, value.locationId].every(approvalRef);
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
function terms(value: unknown): value is Terms {
  return object(value) && Object.keys(value).sort().join(",") === "approvedText,version" && approvalRef(value.version) &&
    typeof value.approvedText === "string" && !!value.approvedText.trim() && value.approvedText.length <= 1000 && !/[\p{Cc}\p{Cf}]/u.test(value.approvedText);
}
function decode(value: unknown, bound: LocationScope): PatientUpdateApproval | undefined {
  const common = decodeClinicApproval(value, bound, [...clinicApprovalKeys, "policyVersion", "correctionVersion", "businessId", "credentialFingerprint", "timeZone",
    "operation", "recordScope", "callerEligibility", "minors", "representatives", "minimumAgeYears", "leapDayBirthday", "patientPermission",
    "verificationMethod", "emailChangeVerification", "confirmation", "contactSynchronization", "allowedFields", "privacyTerms", "correctionTerms"]);
  if (!common || !object(value) || !approvalRef(value.policyVersion) || !approvalRef(value.correctionVersion) || !validClinikoId(value.businessId) ||
      typeof value.credentialFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.credentialFingerprint) ||
      typeof value.timeZone !== "string" || value.timeZone.length > 128 || value.operation !== "patients.update" || value.recordScope !== "clinikoAccount" ||
      value.callerEligibility !== "selfOnly" || value.minors !== "deny" || value.representatives !== "deny" ||
      !Number.isSafeInteger(value.minimumAgeYears) || Number(value.minimumAgeYears) < 18 || Number(value.minimumAgeYears) > 120 ||
      value.leapDayBirthday !== "march1" || value.patientPermission !== "independentClinicHost" || value.verificationMethod !== "registeredEmailOtp" ||
      value.emailChangeVerification !== "prospectiveEmailOtp" || value.confirmation !== "privateReadback" ||
      value.contactSynchronization !== "revokeProofsAndInvalidateAccountLookups" ||
      !Array.isArray(value.allowedFields) || !value.allowedFields.length || new Set(value.allowedFields).size !== value.allowedFields.length ||
      value.allowedFields.some(field => !patientDetailFields.includes(field)) || !terms(value.privacyTerms) || !terms(value.correctionTerms) ||
      value.correctionTerms.approvedText !== patientUpdateScopeText) return undefined;
  try { new Intl.DateTimeFormat("en", { timeZone: value.timeZone }); } catch { return undefined; }
  return value as unknown as PatientUpdateApproval;
}
async function bounded<T>(run: (signal: AbortSignal) => Promise<T>, external: AbortSignal | undefined, timeoutMs: number): Promise<T | undefined> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal;
  try { return await awaitUntilAbort(Promise.resolve().then(() => signal.aborted ? undefined : run(signal)), signal); }
  catch { return undefined; } finally { clearTimeout(timer); controller.abort(); }
}

/** Clinic approval only: neither an email challenge nor this policy grants patient
 * authority, plays confirmation, performs a write or synchronizes contact state. */
export class OwnerFilePatientUpdatePolicy {
  readonly #config: Config;
  readonly #source: OwnerFileClinicApproval<PatientUpdateApproval>;
  private constructor(config: Config, source: OwnerFileClinicApproval<PatientUpdateApproval>) { this.#config = config; this.#source = source; }
  static async capture(incoming: Config, signal?: AbortSignal): Promise<Result<OwnerFilePatientUpdatePolicy, Failure>> {
    try {
      if (!incoming || !scope(incoming.scope) || incoming.correctionsEnabled !== true || !approvalRef(incoming.policyVersion) ||
          !approvalRef(incoming.correctionVersion) || !validClinikoId(incoming.businessId) ||
          typeof incoming.credentialFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(incoming.credentialFingerprint) ||
          typeof incoming.timeZone !== "string" || (incoming.timeoutMs !== undefined && (!Number.isSafeInteger(incoming.timeoutMs) || incoming.timeoutMs < 1 || incoming.timeoutMs > 30_000))) {
        return err({ kind: "patientUpdatePolicyUnavailable" });
      }
      const config = Object.freeze({ ...incoming, scope: Object.freeze({ ...incoming.scope }) });
      const captured = await bounded(async lifetime => {
        const source = await OwnerFileClinicApproval.capture({ ...config, decode });
        if (!source.ok || lifetime.aborted) return undefined;
        const policy = new OwnerFilePatientUpdatePolicy(config, source.value);
        return (await policy.current(config.scope, lifetime)).ok ? policy : undefined;
      }, signal, config.timeoutMs ?? 5000);
      return captured && !signal?.aborted ? ok(captured) : err({ kind: "patientUpdatePolicyUnavailable" });
    } catch { return err({ kind: "patientUpdatePolicyUnavailable" }); }
  }
  binding(): PatientUpdatePolicyBinding {
    const { scope, policyVersion, correctionVersion, businessId, credentialFingerprint, timeZone } = this.#config;
    return { scope: { ...scope }, policyVersion, correctionVersion, businessId, credentialFingerprint, timeZone };
  }
  async current(bound: LocationScope, signal?: AbortSignal): Promise<Result<PatientUpdateApproval, Failure>> {
    const unavailable = () => err({ kind: "patientUpdatePolicyUnavailable" as const });
    if (!scope(bound)) return unavailable();
    const found = await bounded(() => this.#source.current(bound), signal, this.#config.timeoutMs ?? 5000);
    if (!found?.ok || !found.value || signal?.aborted) return unavailable();
    const approval = found.value;
    if (["policyVersion", "correctionVersion", "businessId", "credentialFingerprint", "timeZone"].some(key =>
      approval[key as keyof PatientUpdatePolicyBinding] !== this.#config[key as keyof PatientUpdatePolicyBinding])) return unavailable();
    return ok(approval);
  }
  async checkCorrection(incoming: PatientCorrectionPolicyQuery, signal?: AbortSignal): Promise<Result<Readonly<{
    scope: LocationScope; revision: string; correctionVersion: string; allowedFields: readonly PatientDetailField[]; expiresAt: string;
  }>, Failure>> {
    try {
      const query = structuredClone(incoming);
      if (!object(query) || Object.keys(query).sort().join(",") !== "caller,changes,correctionAccepted,correctionTermsVersion,existingBirthDate,privacyAccepted,privacyTermsVersion,scope" ||
          !scope(query.scope) || query.caller !== "patient" || !date(query.existingBirthDate) || !validPatientDetailChanges(query.changes) ||
          query.privacyAccepted !== true || query.correctionAccepted !== true) return err({ kind: "patientCorrectionDenied" });
      const found = await this.current(query.scope, signal);
      if (!found.ok) return found;
      const approval = found.value;
      if (query.privacyTermsVersion !== approval.privacyTerms.version || query.correctionTermsVersion !== approval.correctionTerms.version ||
          Object.keys(query.changes).some(key => !approval.allowedFields.includes(key as PatientDetailField))) return err({ kind: "patientCorrectionDenied" });
      const now = approvalInstant((this.#config.clock ?? (() => new Date().toISOString()))());
      if (now === undefined || now < Date.parse(approval.effectiveFrom) || now >= Date.parse(approval.effectiveUntil) || signal?.aborted) {
        return err({ kind: "patientUpdatePolicyUnavailable" });
      }
      const today = clinicDateAt(approval.timeZone, new Date(now));
      const adult = (born: string) => born <= today && Number(today.slice(0, 4)) - Number(born.slice(0, 4)) -
        (today.slice(5) < born.slice(5) ? 1 : 0) >= approval.minimumAgeYears;
      if (!adult(query.existingBirthDate) || Object.hasOwn(query.changes, "date_of_birth") &&
          (!query.changes.date_of_birth || !adult(query.changes.date_of_birth)) ||
          Object.hasOwn(query.changes, "email") && query.changes.email === null || signal?.aborted) return err({ kind: "patientCorrectionDenied" });
      return ok({ scope: { ...query.scope }, revision: approval.revision, correctionVersion: approval.correctionVersion,
        allowedFields: [...approval.allowedFields], expiresAt: approval.effectiveUntil });
    } catch { return err({ kind: "patientCorrectionDenied" }); }
  }
}
