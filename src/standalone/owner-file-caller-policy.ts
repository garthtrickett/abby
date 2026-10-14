import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import type { PatientOperation, VerificationPolicyGate } from "./transient-patient-proof.ts";
import { patientOperations } from "./transient-patient-proof.ts";
import { approvalRef, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";

export type CallerPolicyFailure = Readonly<{ kind: "callerPolicyUnavailable" }>;
export type CallerVerificationApproval = ClinicApproval & Readonly<{
  method: "emailOtp"; maxAnswers: 3; lifetimeSeconds: 300;
  sharedNumbers: "deny"; representatives: "deny" | "independentClinicHost"; representativeRecipient?: "selectedPatientRegisteredEmail"; patientPermission: "independentClinicHost";
  operations: readonly PatientOperation[];
}>;
const operations: readonly PatientOperation[] = patientOperations;
function approval(value: unknown, scope: LocationScope): CallerVerificationApproval | undefined {
  const extended = value && typeof value === "object" && (value as Record<string, unknown>).representatives === "independentClinicHost";
  const common = decodeClinicApproval(value, scope, [...clinicApprovalKeys, "method", "maxAnswers", "lifetimeSeconds", "sharedNumbers", "representatives", "patientPermission", "operations", ...(extended ? ["representativeRecipient"] : [])]);
  if (!common) return undefined;
  const row = value as Record<string, unknown>;
  if (row.method !== "emailOtp" || row.maxAnswers !== 3 || row.lifetimeSeconds !== 300 || row.sharedNumbers !== "deny" ||
      (extended ? row.representativeRecipient !== "selectedPatientRegisteredEmail" : row.representatives !== "deny") || row.patientPermission !== "independentClinicHost" ||
      !Array.isArray(row.operations) || !row.operations.length || row.operations.length > operations.length ||
      row.operations.some(value => !operations.includes(value)) || new Set(row.operations).size !== row.operations.length) return undefined;
  return row as unknown as CallerVerificationApproval;
}
type Config = Readonly<{ path: string; scope: LocationScope; policyVersion: string; operation: PatientOperation;
  directory: AdminDirectory; clock?: () => string }>;

/** One call captures one operator-owned approval and current administrator membership.
 * It approves a verification method/operation only, never patient authority or caller/write activation. */
export class OwnerFileCallerPolicy implements VerificationPolicyGate {
  readonly #config: Config;
  readonly #source: OwnerFileClinicApproval<CallerVerificationApproval>;
  private constructor(config: Config, source: OwnerFileClinicApproval<CallerVerificationApproval>) {
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) });
    this.#source = source;
  }

  get operation(): PatientOperation { return this.#config.operation; }

  static async capture(config: Config): Promise<Result<OwnerFileCallerPolicy, CallerPolicyFailure>> {
    try {
      if (!approvalRef(config.policyVersion) || !operations.includes(config.operation)) return err({ kind: "callerPolicyUnavailable" });
      const source = await OwnerFileClinicApproval.capture({ ...config, decode: approval });
      return source.ok ? ok(new OwnerFileCallerPolicy(config, source.value)) : err({ kind: "callerPolicyUnavailable" });
    } catch { return err({ kind: "callerPolicyUnavailable" }); }
  }

  async allowsRepresentative(scope: LocationScope): Promise<boolean> {
    const found = await this.#source.current(scope);
    return found.ok && found.value?.representatives === "independentClinicHost" &&
      found.value.representativeRecipient === "selectedPatientRegisteredEmail" && found.value.operations.includes(this.#config.operation);
  }
  async current(scope: LocationScope): ReturnType<VerificationPolicyGate["current"]> {
    const found = await this.#source.current(scope), config = this.#config;
    return found.ok ? ok({ scope: config.scope, enabled: !!found.value?.operations.includes(config.operation), version: config.policyVersion }) : found;
  }
}
