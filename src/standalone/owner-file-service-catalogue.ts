import { normalizedSpokenName } from "../core/pending-location.ts";
import { validBookingServiceChoice } from "../core/booking-service-choice.ts";
import type { BookingServiceChoice } from "../core/booking-service-choice.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { validClinikoId } from "./appointment-change-authority.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { approvalRef, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";

export type ApprovedBookingService = Readonly<{ serviceRef: string; name: string; appointmentTypeName: string; appointmentTypeId: string;
  durationMinutes: number; visitKind: "initial" | "followUp"; searchDays: number;
  followUpRule: Readonly<{ returningRequired: boolean; newProblemRequiresInitial: boolean; maxMonthsSinceLastVisit: number | null }> | null;
  practitioners: readonly Readonly<{ practitionerId: string; name: string }>[] }>;
export type ServiceCatalogueApproval = ClinicApproval & Readonly<{ policyVersion: string; businessId: string; credentialFingerprint: string;
  timeZone: string; locationName: string; eligibilityBasis: "callerAttestation"; services: readonly ApprovedBookingService[] }>;
type Binding = Pick<ServiceCatalogueApproval, "scope" | "policyVersion" | "businessId" | "credentialFingerprint" | "timeZone">;
type Config = Binding & Readonly<{ path: string; directory: AdminDirectory; clock?: () => string }>;
const exact = (value: unknown, keys: string): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys;
const integer = (value: unknown, low: number, high: number) => Number.isSafeInteger(value) && Number(value) >= low && Number(value) <= high;
function decode(value: unknown, scope: LocationScope): ServiceCatalogueApproval | undefined {
  if (!decodeClinicApproval(value, scope, [...clinicApprovalKeys, "policyVersion", "businessId", "credentialFingerprint", "timeZone", "locationName", "eligibilityBasis", "services"])) return undefined;
  const row = value as ServiceCatalogueApproval;
  if (!approvalRef(row.policyVersion) || !validClinikoId(row.businessId) || !/^[a-f0-9]{64}$/.test(row.credentialFingerprint) ||
      !normalizedSpokenName(row.locationName) || row.eligibilityBasis !== "callerAttestation" || !Array.isArray(row.services) || row.services.length < 1 || row.services.length > 12) return undefined;
  try { new Intl.DateTimeFormat("en", { timeZone: row.timeZone }); } catch { return undefined; }
  const refs = new Set<string>(), types = new Set<string>(), choices = new Set<string>();
  for (const service of row.services) {
    if (!exact(service, "appointmentTypeId,appointmentTypeName,durationMinutes,followUpRule,name,practitioners,searchDays,serviceRef,visitKind") ||
        !approvalRef(service.serviceRef) || !validClinikoId(service.appointmentTypeId) || !normalizedSpokenName(service.name) || !normalizedSpokenName(service.appointmentTypeName) ||
        !integer(service.durationMinutes, 1, 480) || !integer(service.searchDays, 1, 7) || typeof service.visitKind !== "string" || !["initial", "followUp"].includes(service.visitKind) ||
        refs.has(service.serviceRef) || types.has(service.appointmentTypeId) || !Array.isArray(service.practitioners) || service.practitioners.length < 1 || service.practitioners.length > 3) return undefined;
    const key = JSON.stringify([normalizedSpokenName(service.name), service.visitKind, service.durationMinutes]);
    if (choices.has(key)) return undefined; refs.add(service.serviceRef); types.add(service.appointmentTypeId); choices.add(key);
    const rule = service.followUpRule;
    if (service.visitKind === "initial" ? rule !== null : !exact(rule, "maxMonthsSinceLastVisit,newProblemRequiresInitial,returningRequired") ||
      typeof rule.returningRequired !== "boolean" || typeof rule.newProblemRequiresInitial !== "boolean" ||
      rule.maxMonthsSinceLastVisit !== null && !integer(rule.maxMonthsSinceLastVisit, 0, 2400)) return undefined;
    const ids = new Set<string>(), names = new Set<string>();
    for (const member of service.practitioners) {
      if (!exact(member, "name,practitionerId") || !validClinikoId(member.practitionerId) || !normalizedSpokenName(member.name) ||
          normalizedSpokenName(member.name) === "any" || ids.has(member.practitionerId) || names.has(normalizedSpokenName(member.name)!)) return undefined;
      ids.add(member.practitionerId); names.add(normalizedSpokenName(member.name)!);
    }
  }
  return row;
}

/** One admitted location's exact type/duration catalogue. A selection grants no
 * patient proof, slot reservation, operation permission or clinician diagnosis. */
export class OwnerFileServiceCatalogue {
  readonly #config: Config;
  readonly #source: OwnerFileClinicApproval<ServiceCatalogueApproval>;
  private constructor(config: Config, source: OwnerFileClinicApproval<ServiceCatalogueApproval>) { this.#config = config; this.#source = source; }
  static async capture(incoming: Config) {
    const config = Object.freeze({ ...incoming, scope: Object.freeze({ ...incoming.scope }) });
    const source = await OwnerFileClinicApproval.capture({ ...config, decode });
    if (!source.ok) return source;
    const catalogue = new OwnerFileServiceCatalogue(config, source.value);
    return (await catalogue.current(config.scope)).ok ? ok(catalogue) : err({ kind: "unavailable" as const });
  }
  async current(scope: LocationScope): Promise<Result<ServiceCatalogueApproval, Readonly<{ kind: "unavailable" }>>> {
    const found = await this.#source.current(scope);
    if (!found.ok || !found.value || ["policyVersion", "businessId", "credentialFingerprint", "timeZone"].some(
      key => found.value![key as keyof ServiceCatalogueApproval] !== this.#config[key as keyof Binding])) return err({ kind: "unavailable" });
    return ok(found.value);
  }
  async select(scope: LocationScope, incoming: BookingServiceChoice) {
    const denied = () => err({ kind: "unavailable" as const });
    if (!validBookingServiceChoice(incoming)) return denied();
    const choice = Object.freeze({ ...incoming });
    const current = await this.current(scope); if (!current.ok) return denied();
    const service = current.value.services.find(item => normalizedSpokenName(item.name) === normalizedSpokenName(choice.name) &&
      item.durationMinutes === choice.durationMinutes && item.visitKind === choice.visitKind);
    if (!service) return denied();
    const rule = service.followUpRule;
    if (rule && (rule.returningRequired && choice.returningPatient !== true || rule.newProblemRequiresInitial && choice.newProblem !== false ||
      rule.maxMonthsSinceLastVisit !== null && (choice.monthsSinceLastVisit === undefined || choice.monthsSinceLastVisit > rule.maxMonthsSinceLastVisit))) return denied();
    return ok(structuredClone(service));
  }
}
