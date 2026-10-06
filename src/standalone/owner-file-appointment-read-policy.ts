import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { validClinikoId } from "./appointment-change-authority.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { approvalRef, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";

export type AppointmentReadApproval = ClinicApproval & Readonly<{ policyVersion: string; businessId: string;
  credentialFingerprint: string; timeZone: string; searchDays: number }>;
type Binding = Pick<AppointmentReadApproval, "scope" | "policyVersion" | "businessId" | "credentialFingerprint" | "timeZone">;
type Config = Binding & Readonly<{ path: string; directory: AdminDirectory; clock?: () => string }>;
function decode(value: unknown, scope: LocationScope): AppointmentReadApproval | undefined {
  if (!decodeClinicApproval(value, scope, [...clinicApprovalKeys, "policyVersion", "businessId", "credentialFingerprint", "timeZone", "searchDays"])) return undefined;
  const row = value as AppointmentReadApproval;
  if (!approvalRef(row.policyVersion) || !validClinikoId(row.businessId) || !/^[0-9a-f]{64}$/.test(row.credentialFingerprint) ||
      !Number.isSafeInteger(row.searchDays) || row.searchDays < 1 || row.searchDays > 90) return undefined;
  try { new Intl.DateTimeFormat("en", { timeZone: row.timeZone }); } catch { return undefined; }
  return row;
}
/** Current scoped read approval; it grants neither a patient proof nor any mutation. */
export class OwnerFileAppointmentReadPolicy {
  readonly #config: Config;
  readonly #source: OwnerFileClinicApproval<AppointmentReadApproval>;
  private constructor(config: Config, source: OwnerFileClinicApproval<AppointmentReadApproval>) { this.#config = config; this.#source = source; }
  static async capture(incoming: Config): Promise<Result<OwnerFileAppointmentReadPolicy, Readonly<{ kind: "unavailable" }>>> {
    const config = Object.freeze({ ...incoming, scope: Object.freeze({ ...incoming.scope }) });
    const source = await OwnerFileClinicApproval.capture({ ...config, decode });
    if (!source.ok) return source;
    const policy = new OwnerFileAppointmentReadPolicy(config, source.value);
    return (await policy.current(config.scope)).ok ? ok(policy) : err({ kind: "unavailable" });
  }
  async current(scope: LocationScope): Promise<Result<AppointmentReadApproval, Readonly<{ kind: "unavailable" }>>> {
    const found = await this.#source.current(scope);
    if (!found.ok || !found.value || ["policyVersion", "businessId", "credentialFingerprint", "timeZone"].some(
      key => found.value![key as keyof AppointmentReadApproval] !== this.#config[key as keyof Binding])) return err({ kind: "unavailable" });
    return ok(found.value);
  }
}
