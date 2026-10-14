import { err, ok } from "../core/model.ts";
import type { LocationScope } from "../core/model.ts";
import { normalizeEmailAddress } from "../shared/email-address.ts";
import { validClinikoId } from "./appointment-change-authority.ts";
import { approvalRef, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ConfirmationContentKind, ConfirmationTemplate } from "./smtp-appointment-confirmation-delivery.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";

export type ConfirmationResendApproval = ClinicApproval & Readonly<{
  policyVersion: string; businessId: string; credentialFingerprint: string; timeZone: string;
  owner: "abby"; sender: string; template: ConfirmationTemplate; contentKinds?: readonly ConfirmationContentKind[];
  recipient: "verifiedRegisteredEmail"; patientPermission: "independentClinicHost";
  consent: "separatePlayedConfirmation"; submission: "durableSingleAttempt";
  recallTypeId: string; reviewProcess: "clinikoRecallsFullType";
  reviewOwnerRef: string; reviewBackupRef: string; reviewCadenceMinutes: number;
}>;
type Binding = Pick<ConfirmationResendApproval, "scope" | "policyVersion" | "businessId" | "credentialFingerprint" | "timeZone" | "sender" | "recallTypeId">;
type Config = Binding & Readonly<{ path: string; directory: AdminDirectory; clock?: () => string }>;
function decode(value: unknown, scope: LocationScope): ConfirmationResendApproval | undefined {
  const incoming = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const extended = incoming?.template === "appointmentDetails.v2";
  if (!decodeClinicApproval(value, scope, [...clinicApprovalKeys, "policyVersion", "businessId", "credentialFingerprint", "timeZone",
    "owner", "sender", "template", "recipient", "patientPermission", "consent", "submission", "recallTypeId", "reviewProcess",
    "reviewOwnerRef", "reviewBackupRef", "reviewCadenceMinutes", ...(extended ? ["contentKinds"] : [])])) return undefined;
  const row = value as ConfirmationResendApproval;
  if (!approvalRef(row.policyVersion) || !validClinikoId(row.businessId) || !/^[a-f0-9]{64}$/.test(row.credentialFingerprint) ||
      typeof row.sender !== "string" || normalizeEmailAddress(row.sender) !== row.sender ||
      row.owner !== "abby" || !["appointmentDetails.v1", "appointmentDetails.v2"].includes(row.template) || row.recipient !== "verifiedRegisteredEmail" ||
      row.patientPermission !== "independentClinicHost" || row.consent !== "separatePlayedConfirmation" || row.submission !== "durableSingleAttempt" ||
      !validClinikoId(row.recallTypeId) || row.reviewProcess !== "clinikoRecallsFullType" || !approvalRef(row.reviewOwnerRef) ||
      !approvalRef(row.reviewBackupRef) || row.reviewOwnerRef === row.reviewBackupRef || !Number.isSafeInteger(row.reviewCadenceMinutes) ||
      row.reviewCadenceMinutes < 1 || row.reviewCadenceMinutes > 1440 ||
      typeof row.timeZone !== "string" || row.timeZone.length > 128) return undefined;
  if (extended && (!Array.isArray(row.contentKinds) || row.contentKinds.length < 1 || row.contentKinds.length > 3 ||
      new Set(row.contentKinds).size !== row.contentKinds.length || row.contentKinds.some(kind => !["activeInPerson", "activeTelehealth", "cancelled"].includes(kind)))) return undefined;
  try { new Intl.DateTimeFormat("en-GB", { timeZone: row.timeZone }); } catch { return undefined; }
  return row;
}

/** Separate approval for caller-requested appointment emails. A read approval,
 * code-delivery sender or automatic notification owner cannot grant this action. */
export class OwnerFileConfirmationResendPolicy {
  readonly #config: Config;
  readonly #source: OwnerFileClinicApproval<ConfirmationResendApproval>;
  private constructor(config: Config, source: OwnerFileClinicApproval<ConfirmationResendApproval>) { this.#config = config; this.#source = source; }
  static async capture(incoming: Config) {
    const config = Object.freeze({ ...incoming, scope: Object.freeze({ ...incoming.scope }) });
    const source = await OwnerFileClinicApproval.capture({ ...config, decode });
    if (!source.ok) return err({ kind: "resendPolicyUnavailable" as const });
    const policy = new OwnerFileConfirmationResendPolicy(config, source.value);
    return (await policy.current(config.scope)).ok ? ok(policy) : err({ kind: "resendPolicyUnavailable" as const });
  }
  /** Public configuration fingerprint only, never derived from patient/message data. */
  bindingFingerprint(): string { return this.#source.bindingFingerprint(); }
  async current(scope: LocationScope) {
    const found = await this.#source.current(scope);
    if (!found.ok || !found.value || (["policyVersion", "businessId", "credentialFingerprint", "timeZone", "sender", "recallTypeId"] as const)
      .some(key => found.value![key] !== this.#config[key])) return err({ kind: "resendPolicyUnavailable" as const });
    return ok(found.value);
  }
}
