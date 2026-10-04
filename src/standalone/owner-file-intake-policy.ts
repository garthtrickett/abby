import { validClinikoIntakeDraft } from "../cliniko/patient-intake.ts";
import type { ClinikoIntakeDraft } from "../cliniko/patient-intake.ts";
import { normalizePatientPhone } from "../cliniko/phone-number.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { validClinikoId } from "./appointment-change-authority.ts";
import { clinicDateAt } from "./clinic-clock.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { approvalInstant, approvalRef, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";

export const intakeRequiredFields = Object.freeze(["firstName", "lastName", "email", "dateOfBirth", "patientPhone", "phoneType"] as const);
type Terms = Readonly<{ version: string; approvedText: string }>;
export type IntakeApproval = ClinicApproval & Readonly<{
  policyVersion: string; intakeVersion: string; businessId: string; credentialFingerprint: string;
  countryCallingCode: string; timeZone: string; operation: "patients.intake";
  callerEligibility: "selfOnly"; minors: "deny"; representatives: "deny"; minimumAgeYears: number;
  leapDayBirthday: "march1"; callerPhone: "admittedCallerOnly"; verificationMethod: "prospectiveEmailOtp";
  patientPermission: "independentClinicHost"; duplicatePolicy: "exactEmailAndBirthDateDenyCandidates";
  requiredFields: readonly (typeof intakeRequiredFields)[number][]; privacyTerms: Terms; intakeTerms: Terms;
}>;
export type IntakePolicyBinding = Pick<IntakeApproval, "scope" | "policyVersion" | "intakeVersion" | "businessId" |
  "credentialFingerprint" | "countryCallingCode" | "timeZone">;
type Config = IntakePolicyBinding & Readonly<{
  path: string; directory: AdminDirectory; intakeEnabled: boolean; clock?: () => string; timeoutMs?: number;
}>;
export type IntakePolicyFailure = Readonly<{ kind: "intakePolicyUnavailable" }>;
export type IntakeDraftQuery = Readonly<{
  scope: LocationScope; draft: ClinikoIntakeDraft; admittedCallerPhone: string;
  caller: "patient" | "proxy"; privacyAccepted: boolean; intakeAccepted: boolean;
  privacyTermsVersion: string; intakeTermsVersion: string;
}>;
export type IntakeDraftPolicyCheck = Readonly<{
  scope: LocationScope; revision: string; intakeVersion: string; privacyTerms: Terms; intakeTerms: Terms; expiresAt: string;
}>;
type DraftFailure = IntakePolicyFailure | Readonly<{ kind: "intakeDraftDenied" }>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function scope(value: unknown): value is LocationScope {
  return record(value) && Object.keys(value).sort().join(",") === "clinicId,locationId,tenantId" &&
    [value.tenantId, value.clinicId, value.locationId].every(approvalRef);
}
function terms(value: unknown): value is Terms {
  return record(value) && Object.keys(value).sort().join(",") === "approvedText,version" && approvalRef(value.version) &&
    typeof value.approvedText === "string" && !!value.approvedText.trim() && value.approvedText.length <= 1000 && !/[\u0000-\u001f\u007f]/.test(value.approvedText);
}
function decode(value: unknown, bound: LocationScope): IntakeApproval | undefined {
  const common = decodeClinicApproval(value, bound, [...clinicApprovalKeys, "policyVersion", "intakeVersion", "businessId", "credentialFingerprint",
    "countryCallingCode", "timeZone", "operation", "callerEligibility", "minors", "representatives", "minimumAgeYears", "leapDayBirthday",
    "callerPhone", "verificationMethod", "patientPermission", "duplicatePolicy", "requiredFields", "privacyTerms", "intakeTerms"]);
  if (!common || !record(value)) return undefined;
  if (!approvalRef(value.policyVersion) || typeof value.intakeVersion !== "string" || !/^[1-9][0-9]*$/.test(value.intakeVersion) ||
      !Number.isSafeInteger(Number(value.intakeVersion)) || !validClinikoId(value.businessId) ||
      typeof value.credentialFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.credentialFingerprint) ||
      typeof value.countryCallingCode !== "string" || !/^[1-9][0-9]{0,2}$/.test(value.countryCallingCode) ||
      typeof value.timeZone !== "string" || value.timeZone.length > 128 || value.operation !== "patients.intake" ||
      value.callerEligibility !== "selfOnly" || value.minors !== "deny" || value.representatives !== "deny" ||
      !Number.isSafeInteger(value.minimumAgeYears) || Number(value.minimumAgeYears) < 18 || Number(value.minimumAgeYears) > 120 ||
      value.leapDayBirthday !== "march1" || value.callerPhone !== "admittedCallerOnly" || value.verificationMethod !== "prospectiveEmailOtp" ||
      value.patientPermission !== "independentClinicHost" || value.duplicatePolicy !== "exactEmailAndBirthDateDenyCandidates" ||
      !Array.isArray(value.requiredFields) || value.requiredFields.length !== intakeRequiredFields.length ||
      new Set(value.requiredFields).size !== intakeRequiredFields.length || value.requiredFields.some(field => !intakeRequiredFields.includes(field)) ||
      !terms(value.privacyTerms) || !terms(value.intakeTerms)) return undefined;
  try { new Intl.DateTimeFormat("en", { timeZone: value.timeZone }); } catch { return undefined; }
  return value as unknown as IntakeApproval;
}
async function bounded<Value>(run: (signal: AbortSignal) => Promise<Value>, signal: AbortSignal | undefined, timeoutMs: number): Promise<Value | undefined> {
  const controller = new AbortController(), consumer = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await awaitUntilAbort(Promise.resolve().then(() => consumer.aborted ? undefined : run(consumer)), consumer); }
  catch { return undefined; }
  finally { clearTimeout(timer); controller.abort(); }
}

/** Public eligibility/consent policy only. It never issues caller proof, recovery authority or a create permission. */
export class OwnerFileIntakePolicy {
  readonly #config: Config;
  readonly #source: OwnerFileClinicApproval<IntakeApproval>;
  private constructor(config: Config, source: OwnerFileClinicApproval<IntakeApproval>) { this.#config = config; this.#source = source; }
  static async capture(incoming: Config, signal?: AbortSignal): Promise<Result<OwnerFileIntakePolicy, IntakePolicyFailure>> {
    try {
      if (!incoming || !scope(incoming.scope) || incoming.intakeEnabled !== true ||
          (incoming.timeoutMs !== undefined && (!Number.isSafeInteger(incoming.timeoutMs) || incoming.timeoutMs < 1 || incoming.timeoutMs > 30_000))) {
        return err({ kind: "intakePolicyUnavailable" });
      }
      const config = Object.freeze({ ...incoming, scope: Object.freeze({ ...incoming.scope }) });
      const result = await bounded(async lifetime => {
        const source = await OwnerFileClinicApproval.capture({ ...config, decode });
        if (!source.ok || lifetime.aborted) return undefined;
        const policy = new OwnerFileIntakePolicy(config, source.value);
        return (await policy.current(config.scope, lifetime)).ok ? policy : undefined;
      }, signal, config.timeoutMs ?? 5000);
      return result && !signal?.aborted ? ok(result) : err({ kind: "intakePolicyUnavailable" });
    } catch { return err({ kind: "intakePolicyUnavailable" }); }
  }
  binding(): IntakePolicyBinding {
    const { scope, policyVersion, intakeVersion, businessId, credentialFingerprint, countryCallingCode, timeZone } = this.#config;
    return { scope: { ...scope }, policyVersion, intakeVersion, businessId, credentialFingerprint, countryCallingCode, timeZone };
  }
  async current(bound: LocationScope, signal?: AbortSignal): Promise<Result<IntakeApproval, IntakePolicyFailure>> {
    try {
      if (!scope(bound)) return err({ kind: "intakePolicyUnavailable" });
      bound = structuredClone(bound);
      const found = await bounded(() => this.#source.current(bound), signal, this.#config.timeoutMs ?? 5000);
      const binding = this.binding();
      if (!found?.ok || !found.value || signal?.aborted || Object.entries(binding).some(([key, value]) => key !== "scope" && found.value![key as keyof IntakeApproval] !== value)) {
        return err({ kind: "intakePolicyUnavailable" });
      }
      return ok(found.value);
    } catch { return err({ kind: "intakePolicyUnavailable" }); }
  }
  async checkDraft(query: IntakeDraftQuery, signal?: AbortSignal): Promise<Result<IntakeDraftPolicyCheck, DraftFailure>> {
    try {
      query = structuredClone(query);
      if (!record(query) || Object.keys(query).sort().join(",") !== "admittedCallerPhone,caller,draft,intakeAccepted,intakeTermsVersion,privacyAccepted,privacyTermsVersion,scope" || !scope(query.scope) ||
          !record(query.draft) || Object.keys(query.draft).sort().join(",") !== [...intakeRequiredFields].sort().join(",") ||
          !validClinikoIntakeDraft(query.draft) || query.caller !== "patient" || query.privacyAccepted !== true || query.intakeAccepted !== true) return err({ kind: "intakeDraftDenied" });
      const found = await this.current(query.scope, signal);
      if (!found.ok) return found;
      const approval = found.value, now = approvalInstant((this.#config.clock ?? (() => new Date().toISOString()))());
      if (now === undefined || now < Date.parse(approval.effectiveFrom) || now >= Date.parse(approval.effectiveUntil) || signal?.aborted) {
        return err({ kind: "intakePolicyUnavailable" });
      }
      if (query.privacyTermsVersion !== approval.privacyTerms.version || query.intakeTermsVersion !== approval.intakeTerms.version) return err({ kind: "intakeDraftDenied" });
      const admitted = normalizePatientPhone(query.admittedCallerPhone, approval.countryCallingCode);
      if (!admitted || admitted !== normalizePatientPhone(query.draft.patientPhone, approval.countryCallingCode)) return err({ kind: "intakeDraftDenied" });
      const today = clinicDateAt(approval.timeZone, new Date(now)), born = query.draft.dateOfBirth;
      const age = Number(today.slice(0, 4)) - Number(born.slice(0, 4)) - (today.slice(5) < born.slice(5) ? 1 : 0);
      if (born > today || age < approval.minimumAgeYears) return err({ kind: "intakeDraftDenied" });
      return ok({ scope: { ...query.scope }, revision: approval.revision, intakeVersion: approval.intakeVersion,
        privacyTerms: { ...approval.privacyTerms }, intakeTerms: { ...approval.intakeTerms }, expiresAt: approval.effectiveUntil });
    } catch { return err({ kind: "intakeDraftDenied" }); }
  }
}
