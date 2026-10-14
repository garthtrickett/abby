import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { sameScope, validClinikoId } from "./appointment-change-authority.ts";
import { clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval, approvalRef } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
export type ClassApproval = ClinicApproval & Readonly<{
  policyVersion: string;
  businessId: string;
  practitionerId: string;
  appointmentTypeId: string;
  credentialFingerprint: string;
  recallTypeId: string;
  timeZone: string;
  attendance: "existingOccurrence";
  writeContract: "bestEffort";
  notificationOwner: "cliniko";
  membership: "independentHost";
  serviceRef: string;
  className: string;
  practitionerName: string;
  locationName: string;
  durationMinutes: number;
  bookingTerms: Readonly<{
    version: string;
    approvedText: string;
  }>;
  minNoticeMinutes: number;
  maxAdvanceDays: number;
  offerTtlSeconds: number;
}>;
export type ClassPolicyBinding = Pick<ClassApproval, "scope" | "policyVersion" | "businessId" | "practitionerId" | "appointmentTypeId" | "credentialFingerprint" | "recallTypeId" | "timeZone">;
type Config = ClassPolicyBinding & Readonly<{
  path: string;
  directory: AdminDirectory;
  clock: () => string;
}>;
type Failure = Readonly<{
  kind: "classPolicyUnavailable";
}>;
const name = (v: unknown): v is string => typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= 120 && /^[\p{L}\p{M}\p{N} .,'()&/-]+$/u.test(v);
function decode(value: unknown, scope: LocationScope): ClassApproval | undefined {
  const common = decodeClinicApproval(value, scope, [...clinicApprovalKeys, "policyVersion", "businessId", "practitionerId", "appointmentTypeId", "credentialFingerprint",
    "recallTypeId", "timeZone", "attendance", "writeContract", "notificationOwner", "membership", "serviceRef", "className", "practitionerName", "locationName", "durationMinutes",
    "bookingTerms", "minNoticeMinutes", "maxAdvanceDays", "offerTtlSeconds"]);
  if (!common)
    return undefined;
  const row = value as Record<string, unknown>, terms = row.bookingTerms as Record<string, unknown> | undefined;
  const integer = (key: string, min: number, max: number) => Number.isSafeInteger(row[key]) && Number(row[key]) >= min && Number(row[key]) <= max;
  if (![row.policyVersion, row.serviceRef].every(approvalRef) || ![row.businessId, row.practitionerId, row.appointmentTypeId, row.recallTypeId].every(validClinikoId) ||
    typeof row.credentialFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(row.credentialFingerprint) || row.attendance !== "existingOccurrence" ||
    row.writeContract !== "bestEffort" || row.notificationOwner !== "cliniko" || row.membership !== "independentHost" ||
    ![row.className, row.practitionerName, row.locationName].every(name) || !integer("durationMinutes", 1, 480) || !integer("minNoticeMinutes", 1, 10080) ||
    !integer("maxAdvanceDays", 1, 90) || !integer("offerTtlSeconds", 15, 120) || Number(row.minNoticeMinutes) >= Number(row.maxAdvanceDays) * 1440 ||
    !terms || typeof terms !== "object" || Array.isArray(terms) || Object.keys(terms).sort().join(",") !== "approvedText,version" || !approvalRef(terms.version) ||
    typeof terms.approvedText !== "string" || terms.approvedText.trim() !== terms.approvedText || !terms.approvedText || terms.approvedText.length > 2000 ||
    /[\u0000-\u001f\u007f]/.test(terms.approvedText) || typeof row.timeZone !== "string" || row.timeZone.length > 128)
    return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: row.timeZone });
  }
  catch {
    return undefined;
  }
  return row as unknown as ClassApproval;
}
/** Explicit class occurrence policy; ordinary appointment approval cannot opt in.
 * A membership/pass or financial entitlement still comes from independent host authority. */
export class OwnerFileClassPolicy {
  readonly #config: Config;
  readonly #source: OwnerFileClinicApproval<ClassApproval>;
  private constructor(config: Config, source: OwnerFileClinicApproval<ClassApproval>) { this.#config = config; this.#source = source; }
  static async capture(input: Config): Promise<Result<OwnerFileClassPolicy, Failure>> {
    const config = Object.freeze({ ...input, scope: Object.freeze({ ...input.scope }) });
    const source = await OwnerFileClinicApproval.capture({ ...config, decode });
    if (!source.ok)
      return err({ kind: "classPolicyUnavailable" });
    const policy = new OwnerFileClassPolicy(config, source.value);
    return (await policy.current(config.scope)).ok ? ok(policy) : err({ kind: "classPolicyUnavailable" });
  }
  binding(): ClassPolicyBinding {
    const { scope, policyVersion, businessId, practitionerId, appointmentTypeId, credentialFingerprint, recallTypeId, timeZone } = this.#config;
    return { scope: { ...scope }, policyVersion, businessId, practitionerId, appointmentTypeId, credentialFingerprint, recallTypeId, timeZone };
  }
  async current(scope: LocationScope): Promise<Result<ClassApproval, Failure>> {
    const found = await this.#source.current(scope), binding = this.binding();
    if (!found.ok || !found.value || !sameScope(scope, binding.scope) || Object.entries(binding).some(([key, value]) => key !== "scope" && found.value![key as keyof ClassApproval] !== value))
      return err({ kind: "classPolicyUnavailable" });
    return ok(found.value);
  }
}
