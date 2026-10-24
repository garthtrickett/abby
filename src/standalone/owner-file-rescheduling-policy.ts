import { err, ok } from "../core/model.ts";
import type { AppointmentChangeTerms, LocationScope, Result } from "../core/model.ts";
import { validClinikoId } from "./appointment-change-authority.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { approvalRef, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";
import { appointmentNoticeTerms, validNoticeRanges } from "./appointment-notice-policy.ts";
import type { AppointmentNoticeRange } from "./appointment-notice-policy.ts";

type Terms = Readonly<{ version: string; approvedText: string }>;
export type ApprovedPractitionerMove = Readonly<{ fromPractitionerId: string; toPractitionerId: string; appointmentTypeId: string; durationMinutes: number }>;
export type ReschedulingApproval = ClinicApproval & Readonly<{
  policyVersion: string; businessId: string; credentialFingerprint: string; recallTypeId: string; timeZone: string;
  writeContract: "bestEffort"; notificationOwner: "cliniko";
  lateNoticeHours: number; maxAdvanceDays: number; standardTerms: Terms; lateTerms: Terms;
  practitionerMoves?: readonly ApprovedPractitionerMove[];
  noticeRanges?: readonly AppointmentNoticeRange[];
}>;
export type ReschedulingPolicyFailure = Readonly<{ kind: "reschedulingPolicyUnavailable" }>;
export type ReschedulingPolicyBinding = Pick<ReschedulingApproval, "scope" | "policyVersion" | "businessId" | "credentialFingerprint" | "recallTypeId" | "timeZone">;
type Config = ReschedulingPolicyBinding & Readonly<{ path: string; directory: AdminDirectory; clock?: () => string }>;

function terms(value: unknown): value is Terms {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(",") === "approvedText,version" && approvalRef(row.version) &&
    typeof row.approvedText === "string" && row.approvedText.trim().length > 0 && row.approvedText.length <= 500 && !/[\u0000-\u001f\u007f]/.test(row.approvedText);
}
function decode(value: unknown, scope: LocationScope): ReschedulingApproval | undefined {
  const common = decodeClinicApproval(value, scope, [...clinicApprovalKeys, "policyVersion", "businessId", "credentialFingerprint", "recallTypeId", "timeZone",
    "writeContract", "notificationOwner", "lateNoticeHours", "maxAdvanceDays", "standardTerms", "lateTerms",
    ...(value && typeof value === "object" && Object.hasOwn(value, "practitionerMoves") ? ["practitionerMoves"] : []),
    ...(value && typeof value === "object" && Object.hasOwn(value, "noticeRanges") ? ["noticeRanges"] : [])]);
  if (!common) return undefined;
  const row = value as Record<string, unknown>;
  if (!approvalRef(row.policyVersion) || !validClinikoId(row.businessId) || !validClinikoId(row.recallTypeId) ||
      typeof row.credentialFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(row.credentialFingerprint) ||
      typeof row.timeZone !== "string" || row.timeZone.length > 128 || row.writeContract !== "bestEffort" || row.notificationOwner !== "cliniko" ||
      !Number.isSafeInteger(row.lateNoticeHours) || Number(row.lateNoticeHours) < 1 || Number(row.lateNoticeHours) > 168 ||
      !Number.isSafeInteger(row.maxAdvanceDays) || Number(row.maxAdvanceDays) < 1 || Number(row.maxAdvanceDays) > 90 ||
      !terms(row.standardTerms) || !terms(row.lateTerms) || row.standardTerms.version === row.lateTerms.version) return undefined;
  if (Object.hasOwn(row, "noticeRanges") && !validNoticeRanges(row.noticeRanges, row.standardTerms.version, 500)) return undefined;
  try { new Intl.DateTimeFormat("en-AU", { timeZone: row.timeZone }); } catch { return undefined; }
  if (row.practitionerMoves !== undefined) {
    if (!Array.isArray(row.practitionerMoves) || row.practitionerMoves.length < 1 || row.practitionerMoves.length > 72) return undefined;
    const seen = new Set<string>();
    for (const move of row.practitionerMoves) {
      if (!move || typeof move !== "object" || Array.isArray(move) || Object.keys(move).sort().join(",") !== "appointmentTypeId,durationMinutes,fromPractitionerId,toPractitionerId" ||
          ![move.fromPractitionerId, move.toPractitionerId, move.appointmentTypeId].every(validClinikoId) || move.fromPractitionerId === move.toPractitionerId ||
          !Number.isSafeInteger(move.durationMinutes) || move.durationMinutes < 1 || move.durationMinutes > 480) return undefined;
      const key = `${move.fromPractitionerId}:${move.toPractitionerId}:${move.appointmentTypeId}`;
      if (seen.has(key)) return undefined;
      seen.add(key);
    }
  }
  return row as unknown as ReschedulingApproval;
}

/** Public clinic policy only: never supplies caller/patient consent, fee charging or staff receipt. */
export class OwnerFileReschedulingPolicy {
  readonly #config: Config;
  readonly #source: OwnerFileClinicApproval<ReschedulingApproval>;
  private constructor(config: Config, source: OwnerFileClinicApproval<ReschedulingApproval>) {
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) }); this.#source = source;
  }
  static async capture(config: Config): Promise<Result<OwnerFileReschedulingPolicy, ReschedulingPolicyFailure>> {
    config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) });
    const source = await OwnerFileClinicApproval.capture({ ...config, decode });
    if (!source.ok) return err({ kind: "reschedulingPolicyUnavailable" });
    const policy = new OwnerFileReschedulingPolicy(config, source.value);
    return (await policy.current(config.scope)).ok ? ok(policy) : err({ kind: "reschedulingPolicyUnavailable" });
  }
  binding(): ReschedulingPolicyBinding {
    const { scope, policyVersion, businessId, credentialFingerprint, recallTypeId, timeZone } = this.#config;
    return { scope: { ...scope }, policyVersion, businessId, credentialFingerprint, recallTypeId, timeZone };
  }
  async current(scope: LocationScope): Promise<Result<ReschedulingApproval, ReschedulingPolicyFailure>> {
    const found = await this.#source.current(scope), config = this.#config;
    if (!found.ok || !found.value || found.value.policyVersion !== config.policyVersion || found.value.businessId !== config.businessId ||
        found.value.credentialFingerprint !== config.credentialFingerprint || found.value.recallTypeId !== config.recallTypeId ||
        found.value.timeZone !== config.timeZone) return err({ kind: "reschedulingPolicyUnavailable" });
    return ok(found.value);
  }
  static termsFor(approval: ReschedulingApproval, startsAt: string, now: string): AppointmentChangeTerms | undefined {
    return appointmentNoticeTerms(approval, startsAt, now);
  }
}
