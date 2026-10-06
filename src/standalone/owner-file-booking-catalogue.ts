import { normalizedSpokenName } from "../core/pending-location.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { validClinikoId } from "./appointment-change-authority.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { approvalRef, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";

export type BookingCatalogueApproval = ClinicApproval & Readonly<{ policyVersion: string; businessId: string; appointmentTypeId: string;
  credentialFingerprint: string; timeZone: string; locationName: string; appointmentTypeName: string;
  searchDays: number; practitioners: readonly Readonly<{ practitionerId: string; name: string }>[] }>;
type Binding = Pick<BookingCatalogueApproval, "scope" | "policyVersion" | "businessId" | "appointmentTypeId" | "credentialFingerprint" | "timeZone">;
type Config = Binding & Readonly<{ path: string; directory: AdminDirectory; clock?: () => string }>;
function decode(value: unknown, scope: LocationScope): BookingCatalogueApproval | undefined {
  if (!decodeClinicApproval(value, scope, [...clinicApprovalKeys, "policyVersion", "businessId", "appointmentTypeId", "credentialFingerprint", "timeZone",
    "locationName", "appointmentTypeName", "searchDays", "practitioners"])) return undefined;
  const row = value as BookingCatalogueApproval;
  if (!approvalRef(row.policyVersion) || !validClinikoId(row.businessId) || !validClinikoId(row.appointmentTypeId) ||
      !/^[0-9a-f]{64}$/.test(row.credentialFingerprint) || !normalizedSpokenName(row.locationName) || !normalizedSpokenName(row.appointmentTypeName) ||
      !Number.isSafeInteger(row.searchDays) || row.searchDays < 1 || row.searchDays > 7 || !Array.isArray(row.practitioners) ||
      row.practitioners.length < 1 || row.practitioners.length > 3) return undefined;
  const ids = new Set<string>(), names = new Set<string>();
  for (const item of row.practitioners) {
    if (!item || Object.keys(item).sort().join(",") !== "name,practitionerId" || !validClinikoId(item.practitionerId)) return undefined;
    const name = normalizedSpokenName(item.name);
    if (!name || name === "any" || ids.has(item.practitionerId) || names.has(name)) return undefined;
    ids.add(item.practitionerId); names.add(name);
  }
  try { new Intl.DateTimeFormat("en", { timeZone: row.timeZone }); } catch { return undefined; }
  return row;
}
/** Exact public search approval and current admin membership. Each catalogue
 * member still needs its independent booking/write approval and patient proof. */
export class OwnerFileBookingCatalogue {
  readonly #config: Config;
  readonly #source: OwnerFileClinicApproval<BookingCatalogueApproval>;
  private constructor(config: Config, source: OwnerFileClinicApproval<BookingCatalogueApproval>) { this.#config = config; this.#source = source; }
  static async capture(incoming: Config): Promise<Result<OwnerFileBookingCatalogue, Readonly<{ kind: "unavailable" }>>> {
    const config = Object.freeze({ ...incoming, scope: Object.freeze({ ...incoming.scope }) });
    const source = await OwnerFileClinicApproval.capture({ ...config, decode });
    if (!source.ok) return source;
    const catalogue = new OwnerFileBookingCatalogue(config, source.value);
    return (await catalogue.current(config.scope)).ok ? ok(catalogue) : err({ kind: "unavailable" });
  }
  async current(scope: LocationScope): Promise<Result<BookingCatalogueApproval, Readonly<{ kind: "unavailable" }>>> {
    const found = await this.#source.current(scope);
    if (!found.ok || !found.value || ["policyVersion", "businessId", "appointmentTypeId", "credentialFingerprint", "timeZone"].some(
      key => found.value![key as keyof BookingCatalogueApproval] !== this.#config[key as keyof Binding])) return err({ kind: "unavailable" });
    return ok(found.value);
  }
}
