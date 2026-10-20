import type { LocationScope } from "../core/model.ts";
import { err, ok } from "../core/model.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import type { PatientOperation } from "./transient-patient-proof.ts";
import { patientOperations } from "./transient-patient-proof.ts";
import { approvalRef, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";
import { validClinikoId } from "./appointment-change-authority.ts";

type Approval = ClinicApproval & Readonly<{
  policyVersion: string; businessId: string; credentialFingerprint: string; timeZone: string;
  subjects: "nativeRelatedPatients"; identity: "exactNameAndBirthDate"; caller: "freshRegisteredChannelProof";
  authority: "independentClinicHost"; recipient: "selectedPatientRegisteredEmail";
  adultAgeYears: number; leapDayBirthday: "march1";
  allowedAuthorities: readonly ("adultRepresentative" | "guardian")[]; operations: readonly PatientOperation[];
}>;
type Config = Readonly<{ path: string; scope: LocationScope; policyVersion: string; businessId: string; credentialFingerprint: string;
  timeZone: string; directory: AdminDirectory; clock: () => string }>;
function decode(value: unknown, scope: LocationScope): Approval | undefined {
  if (!decodeClinicApproval(value, scope, [...clinicApprovalKeys, "policyVersion", "businessId", "credentialFingerprint", "timeZone",
    "subjects", "identity", "caller", "authority", "recipient", "adultAgeYears", "leapDayBirthday", "allowedAuthorities", "operations"])) return undefined;
  const row = value as Approval;
  if (!approvalRef(row.policyVersion) || !validClinikoId(row.businessId) || !/^[a-f0-9]{64}$/.test(row.credentialFingerprint) ||
      typeof row.timeZone !== "string" || row.timeZone.length > 128 || row.subjects !== "nativeRelatedPatients" || row.identity !== "exactNameAndBirthDate" ||
      row.caller !== "freshRegisteredChannelProof" || row.authority !== "independentClinicHost" || row.recipient !== "selectedPatientRegisteredEmail" ||
      !Number.isSafeInteger(row.adultAgeYears) || row.adultAgeYears < 18 || row.adultAgeYears > 120 || row.leapDayBirthday !== "march1" ||
      !Array.isArray(row.allowedAuthorities) || !row.allowedAuthorities.length || row.allowedAuthorities.length > 2 || new Set(row.allowedAuthorities).size !== row.allowedAuthorities.length ||
      row.allowedAuthorities.some(kind => !["adultRepresentative", "guardian"].includes(kind)) ||
      !Array.isArray(row.operations) || !row.operations.length || row.operations.length > patientOperations.length || new Set(row.operations).size !== row.operations.length ||
      row.operations.some(operation => !patientOperations.includes(operation))) return undefined;
  try { new Intl.DateTimeFormat("en", { timeZone: row.timeZone }); } catch { return undefined; }
  return row;
}
/** Public process approval only. A family link and this approval cannot grant patient authority. */
export class OwnerFileRepresentativePolicy {
  readonly #config: Config;
  readonly #source: OwnerFileClinicApproval<Approval>;
  private constructor(config: Config, source: OwnerFileClinicApproval<Approval>) { this.#config = config; this.#source = source; }
  static async capture(incoming: Config) {
    const config = Object.freeze({ ...incoming, scope: Object.freeze({ ...incoming.scope }) });
    const found = await OwnerFileClinicApproval.capture({ ...config, decode });
    if (!found.ok) return err({ kind: "representativePolicyUnavailable" as const });
    const policy = new OwnerFileRepresentativePolicy(config, found.value);
    return (await policy.current(config.scope)).ok ? ok(policy) : err({ kind: "representativePolicyUnavailable" as const });
  }
  async current(scope: LocationScope) {
    const found = await this.#source.current(scope), c = this.#config;
    return found.ok && found.value && (["policyVersion", "businessId", "credentialFingerprint", "timeZone"] as const).every(key => found.value![key] === c[key])
      ? ok(found.value) : err({ kind: "representativePolicyUnavailable" as const });
  }
}
