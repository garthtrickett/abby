import { err, ok } from "../core/model.ts";
import type { LocationScope } from "../core/model.ts";
import { validStaffLabel } from "../core/staff-outcome.ts";
import { validClinikoId } from "./appointment-change-authority.ts";
import { approvalRef, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";

export type StaffApproval = ClinicApproval & Readonly<{
  policyVersion: string; businessId: string; credentialFingerprint: string; recallTypeId: string; timeZone: string;
  reviewProcess: "clinikoRecallsFullType"; reviewOwnerRef: string; reviewBackupRef: string;
  reviewCadenceMinutes: number; staffLabels: readonly string[];
}>;
type Binding = Pick<StaffApproval, "scope" | "policyVersion" | "businessId" | "credentialFingerprint" | "recallTypeId" | "timeZone">;
type Config = Binding & Readonly<{ path: string; directory: AdminDirectory; clock?: () => string }>;
function decode(value: unknown, scope: LocationScope): StaffApproval | undefined {
  if (!decodeClinicApproval(value, scope, [...clinicApprovalKeys, "policyVersion", "businessId", "credentialFingerprint", "recallTypeId", "timeZone",
    "reviewProcess", "reviewOwnerRef", "reviewBackupRef", "reviewCadenceMinutes", "staffLabels"])) return undefined;
  const row = value as Record<string, unknown>;
  if (!approvalRef(row.policyVersion) || !validClinikoId(row.businessId) || !validClinikoId(row.recallTypeId) ||
      typeof row.credentialFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.credentialFingerprint) ||
      typeof row.timeZone !== "string" || row.timeZone.length > 128 || row.reviewProcess !== "clinikoRecallsFullType" ||
      !approvalRef(row.reviewOwnerRef) || !approvalRef(row.reviewBackupRef) || row.reviewOwnerRef === row.reviewBackupRef ||
      !Number.isSafeInteger(row.reviewCadenceMinutes) || Number(row.reviewCadenceMinutes) < 1 || Number(row.reviewCadenceMinutes) > 1440 ||
      !Array.isArray(row.staffLabels) || row.staffLabels.length > 32 || row.staffLabels.some(label => !validStaffLabel(label)) ||
      new Set(row.staffLabels.map(label => label.toLowerCase())).size !== row.staffLabels.length) return undefined;
  try { new Intl.DateTimeFormat("en-AU", { timeZone: row.timeZone }); } catch { return undefined; }
  return row as unknown as StaffApproval;
}

/** Independent accepted queue process and public person labels; no patient authority or claim of human receipt. */
export class OwnerFileStaffPolicy {
  readonly #config: Config;
  readonly #source: OwnerFileClinicApproval<StaffApproval>;
  private constructor(config: Config, source: OwnerFileClinicApproval<StaffApproval>) { this.#config = config; this.#source = source; }
  static async capture(incoming: Config) {
    const config = Object.freeze({ ...incoming, scope: Object.freeze({ ...incoming.scope }) });
    const source = await OwnerFileClinicApproval.capture({ ...config, decode });
    if (!source.ok) return err({ kind: "staffPolicyUnavailable" as const });
    const result = new OwnerFileStaffPolicy(config, source.value);
    return (await result.current(config.scope)).ok ? ok(result) : err({ kind: "staffPolicyUnavailable" as const });
  }
  async current(scope: LocationScope) {
    const found = await this.#source.current(scope), config = this.#config;
    if (!found.ok || !found.value || found.value.policyVersion !== config.policyVersion || found.value.businessId !== config.businessId ||
        found.value.credentialFingerprint !== config.credentialFingerprint || found.value.recallTypeId !== config.recallTypeId ||
        found.value.timeZone !== config.timeZone) return err({ kind: "staffPolicyUnavailable" as const });
    return ok(found.value);
  }
}
