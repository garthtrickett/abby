import { err, ok } from "../core/model.ts";
import type { LocationScope } from "../core/model.ts";
import { validClinikoId } from "./appointment-change-authority.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { approvalRef, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";

export type AppointmentHistoryApproval = ClinicApproval & Readonly<{ policyVersion: string; businessId: string;
  credentialFingerprint: string; timeZone: string; lookBackDays: number; purpose: "previousPractitioner" }>;
type Binding = Pick<AppointmentHistoryApproval, "scope" | "policyVersion" | "businessId" | "credentialFingerprint" | "timeZone">;
type Config = Binding & Readonly<{ path: string; directory: AdminDirectory; clock?: () => string }>;
function decode(value: unknown, scope: LocationScope): AppointmentHistoryApproval | undefined {
  if (!decodeClinicApproval(value, scope, [...clinicApprovalKeys, "policyVersion", "businessId", "credentialFingerprint", "timeZone", "lookBackDays", "purpose"])) return undefined;
  const row = value as AppointmentHistoryApproval;
  if (!approvalRef(row.policyVersion) || !validClinikoId(row.businessId) || !/^[a-f0-9]{64}$/.test(row.credentialFingerprint) ||
      row.purpose !== "previousPractitioner" || !Number.isSafeInteger(row.lookBackDays) || row.lookBackDays < 1 || row.lookBackDays > 36525) return undefined;
  try { new Intl.DateTimeFormat("en", { timeZone: row.timeZone }); } catch { return undefined; }
  return row;
}
/** History is approved separately from the existing upcoming-only enquiry. */
export class OwnerFileAppointmentHistoryPolicy {
  readonly #config: Config;
  readonly #source: OwnerFileClinicApproval<AppointmentHistoryApproval>;
  private constructor(config: Config, source: OwnerFileClinicApproval<AppointmentHistoryApproval>) { this.#config = config; this.#source = source; }
  static async capture(incoming: Config) {
    const config = Object.freeze({ ...incoming, scope: Object.freeze({ ...incoming.scope }) });
    const source = await OwnerFileClinicApproval.capture({ ...config, decode });
    if (!source.ok) return source;
    const policy = new OwnerFileAppointmentHistoryPolicy(config, source.value);
    return (await policy.current(config.scope)).ok ? ok(policy) : err({ kind: "unavailable" as const });
  }
  async current(scope: LocationScope) {
    const found = await this.#source.current(scope);
    if (!found.ok || !found.value || ["policyVersion", "businessId", "credentialFingerprint", "timeZone"].some(key =>
      found.value![key as keyof AppointmentHistoryApproval] !== this.#config[key as keyof Binding])) return err({ kind: "unavailable" as const });
    return ok(found.value);
  }
}
