import type { LocationScope } from "../core/model.ts";
import { err, ok } from "../core/model.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { approvalRef, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";
import { validClinikoId } from "./appointment-change-authority.ts";

export const guardianOperations = ["appointments.read", "appointments.book", "appointments.cancel", "appointments.reschedule"] as const;
export type GuardianOperation = typeof guardianOperations[number];
type Approval = ClinicApproval & Readonly<{
  policyVersion: string; businessId: string; credentialFingerprint: string; timeZone: string;
  subjects: "clinicApprovedGuardianRecords"; identity: "exactNameAndBirthDate"; caller: "freshGuardianRegisteredChannelProof";
  authority: "independentClinicHost"; recipient: "selectedPatientRegisteredEmail";
  allowedAuthorities: readonly ("guardian" | "adultRepresentative")[];
  adultAgeYears: number; leapDayBirthday: "march1"; operations: readonly GuardianOperation[];
}>;
type Config = Readonly<{ path: string; scope: LocationScope; policyVersion: string; businessId: string; credentialFingerprint: string;
  timeZone: string; directory: AdminDirectory; clock: () => string }>;
function decode(value: unknown, scope: LocationScope): Approval | undefined {
  if (!decodeClinicApproval(value, scope, [...clinicApprovalKeys, "policyVersion", "businessId", "credentialFingerprint", "timeZone",
    "subjects", "identity", "caller", "authority", "recipient", "allowedAuthorities", "adultAgeYears", "leapDayBirthday", "operations"])) return undefined;
  const row = value as Approval;
  if (!approvalRef(row.policyVersion) || !validClinikoId(row.businessId) || !/^[a-f0-9]{64}$/.test(row.credentialFingerprint) ||
      typeof row.timeZone !== "string" || row.timeZone.length > 128 || row.subjects !== "clinicApprovedGuardianRecords" || row.identity !== "exactNameAndBirthDate" ||
      row.caller !== "freshGuardianRegisteredChannelProof" || row.authority !== "independentClinicHost" || row.recipient !== "selectedPatientRegisteredEmail" ||
      !Array.isArray(row.allowedAuthorities) || !row.allowedAuthorities.length || row.allowedAuthorities.length > 2 || new Set(row.allowedAuthorities).size !== row.allowedAuthorities.length ||
      row.allowedAuthorities.some(kind => !["guardian", "adultRepresentative"].includes(kind)) ||
      !Number.isSafeInteger(row.adultAgeYears) || row.adultAgeYears < 18 || row.adultAgeYears > 120 || row.leapDayBirthday !== "march1" ||
      !Array.isArray(row.operations) || !row.operations.length || row.operations.length > guardianOperations.length || new Set(row.operations).size !== row.operations.length ||
      row.operations.some(operation => !guardianOperations.includes(operation))) return undefined;
  try { new Intl.DateTimeFormat("en", { timeZone: row.timeZone }); } catch { return undefined; }
  return row;
}
/** Non-patient representative process approval only. No patient's authority is granted here. */
export class OwnerFileGuardianPolicy {
  readonly #config: Config;
  readonly #source: OwnerFileClinicApproval<Approval>;
  private constructor(config: Config, source: OwnerFileClinicApproval<Approval>) { this.#config = config; this.#source = source; }
  static async capture(incoming: Config) {
    const config = Object.freeze({ ...incoming, scope: Object.freeze({ ...incoming.scope }) });
    const found = await OwnerFileClinicApproval.capture({ ...config, decode });
    if (!found.ok) return err({ kind: "guardianPolicyUnavailable" as const });
    const policy = new OwnerFileGuardianPolicy(config, found.value);
    return (await policy.current(config.scope)).ok ? ok(policy) : err({ kind: "guardianPolicyUnavailable" as const });
  }
  async current(scope: LocationScope) {
    const found = await this.#source.current(scope), c = this.#config;
    return found.ok && found.value && (["policyVersion", "businessId", "credentialFingerprint", "timeZone"] as const).every(key => found.value![key] === c[key])
      ? ok(found.value) : err({ kind: "guardianPolicyUnavailable" as const });
  }
}
