import { err, ok } from "../core/model.ts";
import type { AppointmentChangeTerms, LocationScope, Result } from "../core/model.ts";
import { validClinikoId } from "./appointment-change-authority.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { approvalRef, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";

type Terms = Readonly<{ version: string; approvedText: string }>;
export type CancellationApproval = ClinicApproval & Readonly<{
  policyVersion: string; businessId: string; credentialFingerprint: string; recallTypeId: string; timeZone: string;
  writeContract: "bestEffort"; notificationOwner: "cliniko"; cancellationReason: 10 | 20 | 30 | 40 | 50 | 60;
  lateNoticeHours: number; maxAdvanceDays: number; standardTerms: Terms; lateTerms: Terms;
}>;
export type CancellationPolicyFailure = Readonly<{ kind: "cancellationPolicyUnavailable" }>;
export type CancellationPolicyBinding = Pick<CancellationApproval, "scope" | "policyVersion" | "businessId" | "credentialFingerprint" | "recallTypeId" | "timeZone">;
type Config = CancellationPolicyBinding & Readonly<{ path: string; directory: AdminDirectory; clock?: () => string }>;

function terms(value: unknown): value is Terms {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(",") === "approvedText,version" && approvalRef(row.version) &&
    typeof row.approvedText === "string" && row.approvedText.trim().length > 0 && row.approvedText.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(row.approvedText);
}
function decode(value: unknown, scope: LocationScope): CancellationApproval | undefined {
  const common = decodeClinicApproval(value, scope, [...clinicApprovalKeys, "policyVersion", "businessId", "credentialFingerprint", "recallTypeId", "timeZone",
    "writeContract", "notificationOwner", "cancellationReason", "lateNoticeHours", "maxAdvanceDays", "standardTerms", "lateTerms"]);
  if (!common) return undefined;
  const row = value as Record<string, unknown>;
  if (!approvalRef(row.policyVersion) || !validClinikoId(row.businessId) || !validClinikoId(row.recallTypeId) ||
      typeof row.credentialFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(row.credentialFingerprint) ||
      typeof row.timeZone !== "string" || row.timeZone.length > 128 || row.writeContract !== "bestEffort" || row.notificationOwner !== "cliniko" ||
      ![10, 20, 30, 40, 50, 60].includes(row.cancellationReason as number) ||
      !Number.isSafeInteger(row.lateNoticeHours) || Number(row.lateNoticeHours) < 1 || Number(row.lateNoticeHours) > 168 ||
      !Number.isSafeInteger(row.maxAdvanceDays) || Number(row.maxAdvanceDays) < 1 || Number(row.maxAdvanceDays) > 90 ||
      !terms(row.standardTerms) || !terms(row.lateTerms) || row.standardTerms.version === row.lateTerms.version) return undefined;
  try { new Intl.DateTimeFormat("en-AU", { timeZone: row.timeZone }); } catch { return undefined; }
  return row as unknown as CancellationApproval;
}

/** Public clinic policy only: never supplies caller/patient consent, fee charging or staff receipt. */
export class OwnerFileCancellationPolicy {
  readonly #config: Config;
  readonly #source: OwnerFileClinicApproval<CancellationApproval>;
  private constructor(config: Config, source: OwnerFileClinicApproval<CancellationApproval>) {
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) }); this.#source = source;
  }
  static async capture(config: Config): Promise<Result<OwnerFileCancellationPolicy, CancellationPolicyFailure>> {
    const source = await OwnerFileClinicApproval.capture({ ...config, decode });
    if (!source.ok) return err({ kind: "cancellationPolicyUnavailable" });
    const policy = new OwnerFileCancellationPolicy(config, source.value);
    return (await policy.current(config.scope)).ok ? ok(policy) : err({ kind: "cancellationPolicyUnavailable" });
  }
  binding(): CancellationPolicyBinding {
    const { scope, policyVersion, businessId, credentialFingerprint, recallTypeId, timeZone } = this.#config;
    return { scope: { ...scope }, policyVersion, businessId, credentialFingerprint, recallTypeId, timeZone };
  }
  async current(scope: LocationScope): Promise<Result<CancellationApproval, CancellationPolicyFailure>> {
    const found = await this.#source.current(scope), config = this.#config;
    if (!found.ok || !found.value || found.value.policyVersion !== config.policyVersion || found.value.businessId !== config.businessId ||
        found.value.credentialFingerprint !== config.credentialFingerprint || found.value.recallTypeId !== config.recallTypeId ||
        found.value.timeZone !== config.timeZone) return err({ kind: "cancellationPolicyUnavailable" });
    return ok(found.value);
  }
  static termsFor(approval: CancellationApproval, startsAt: string, now: string): AppointmentChangeTerms | undefined {
    const start = Date.parse(startsAt), at = Date.parse(now), notice = start - at;
    if (!Number.isFinite(start) || !Number.isFinite(at) || notice <= 0 || notice > approval.maxAdvanceDays * 86_400_000 ||
        at < Date.parse(approval.effectiveFrom) || at >= Date.parse(approval.effectiveUntil)) return undefined;
    const selected = notice < approval.lateNoticeHours * 3_600_000 ? approval.lateTerms : approval.standardTerms;
    return { ...selected, expiresAt: approval.effectiveUntil };
  }
}
