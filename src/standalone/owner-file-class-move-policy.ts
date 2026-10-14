import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { approvalRef, approvalInstant, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";
import { sameScope, validClinikoId } from "./appointment-change-authority.ts";

type Terms = Readonly<{ version: string; approvedText: string }>;
export type ClassMoveApproval = ClinicApproval & Readonly<{
  policyVersion: string; businessId: string; credentialFingerprint: string; recallTypeId: string; timeZone: string;
  sourceServiceRef: string; destinationServiceRef: string;
  writeContract: "bestEffort"; notificationOwner: "cliniko"; membership: "independentHost";
  compensation: "cancelReplacementIfOriginalUnsent";
  cancellationReason: 10 | 20 | 30 | 40 | 50 | 60;
  lateNoticeHours: number; maxAdvanceDays: number; offerTtlSeconds: number;
  standardTerms: Terms; lateTerms: Terms; recoveryTerms: Terms;
}>;
type Binding = Pick<ClassMoveApproval, "scope" | "policyVersion" | "businessId" | "credentialFingerprint" | "recallTypeId" | "timeZone" | "sourceServiceRef" | "destinationServiceRef">;
type Config = Binding & Readonly<{ path: string; directory: AdminDirectory; clock: () => string }>;
type Failure = Readonly<{ kind: "classMovePolicyUnavailable" }>;
const terms = (value: unknown, max: number): value is Terms => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(",") === "approvedText,version" && approvalRef(row.version) && typeof row.approvedText === "string" &&
    !!row.approvedText && row.approvedText.trim() === row.approvedText && row.approvedText.length <= max && !/[\u0000-\u001f\u007f]/.test(row.approvedText);
};
function decode(value: unknown, scope: LocationScope): ClassMoveApproval | undefined {
  const common = decodeClinicApproval(value, scope, [...clinicApprovalKeys, "policyVersion", "businessId", "credentialFingerprint", "recallTypeId", "timeZone",
    "sourceServiceRef", "destinationServiceRef", "writeContract", "notificationOwner", "membership", "compensation", "cancellationReason",
    "lateNoticeHours", "maxAdvanceDays", "offerTtlSeconds", "standardTerms", "lateTerms", "recoveryTerms"]);
  if (!common) return undefined;
  const row = value as Record<string, unknown>;
  const integer = (key: string, min: number, max: number) => Number.isSafeInteger(row[key]) && Number(row[key]) >= min && Number(row[key]) <= max;
  if (![row.policyVersion, row.sourceServiceRef, row.destinationServiceRef].every(approvalRef) || ![row.businessId, row.recallTypeId].every(validClinikoId) ||
      typeof row.credentialFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.credentialFingerprint) || typeof row.timeZone !== "string" || row.timeZone.length > 128 ||
      row.writeContract !== "bestEffort" || row.notificationOwner !== "cliniko" || row.membership !== "independentHost" || row.compensation !== "cancelReplacementIfOriginalUnsent" ||
      ![10, 20, 30, 40, 50, 60].includes(Number(row.cancellationReason)) || typeof row.cancellationReason !== "number" || !integer("lateNoticeHours", 1, 168) ||
      !integer("maxAdvanceDays", 1, 90) || !integer("offerTtlSeconds", 15, 120) || !terms(row.standardTerms, 150) || !terms(row.lateTerms, 150) || !terms(row.recoveryTerms, 180) ||
      new Set([row.standardTerms.version, row.lateTerms.version, row.recoveryTerms.version]).size !== 3) return undefined;
  try { new Intl.DateTimeFormat("en", { timeZone: row.timeZone }); } catch { return undefined; }
  return row as unknown as ClassMoveApproval;
}
/** An explicit service-pair move/recovery approval. Separate book/cancel approval
 * never authorises this composed non-atomic operation or membership changes. */
export class OwnerFileClassMovePolicy {
  readonly #config: Config;
  readonly #source: OwnerFileClinicApproval<ClassMoveApproval>;
  private constructor(config: Config, source: OwnerFileClinicApproval<ClassMoveApproval>) { this.#config = config; this.#source = source; }
  static async capture(input: Config): Promise<Result<OwnerFileClassMovePolicy, Failure>> {
    const config = Object.freeze({ ...input, scope: Object.freeze({ ...input.scope }) });
    const source = await OwnerFileClinicApproval.capture({ ...config, decode });
    if (!source.ok) return err({ kind: "classMovePolicyUnavailable" });
    const policy = new OwnerFileClassMovePolicy(config, source.value);
    return (await policy.current(config.scope)).ok ? ok(policy) : err({ kind: "classMovePolicyUnavailable" });
  }
  async current(scope: LocationScope): Promise<Result<ClassMoveApproval, Failure>> {
    const current = await this.#source.current(scope), c = this.#config;
    if (!sameScope(scope, c.scope) || !current.ok || !current.value || ["policyVersion", "businessId", "credentialFingerprint", "recallTypeId", "timeZone", "sourceServiceRef", "destinationServiceRef"]
      .some(key => current.value![key as keyof Binding] !== c[key as keyof Binding])) return err({ kind: "classMovePolicyUnavailable" });
    return ok(current.value);
  }
  static termsFor(approval: ClassMoveApproval, startsAt: string, now: string): Terms | undefined {
    const start = approvalInstant(startsAt), at = approvalInstant(now);
    if (start === undefined || at === undefined || start <= at || start - at > approval.maxAdvanceDays * 86400000 ||
        at < Date.parse(approval.effectiveFrom) || at >= Date.parse(approval.effectiveUntil)) return undefined;
    return start - at < approval.lateNoticeHours * 3600000 ? approval.lateTerms : approval.standardTerms;
  }
}
