import type { BookingPractitionerPreference } from "../core/booking-practitioner-preference.ts";
import { eligibleServicePractitioners } from "./service-practitioner-preference.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { validClinikoId } from "./appointment-change-authority.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { approvalInstant, approvalRef, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";
import { OwnerFileServiceCatalogue } from "./owner-file-service-catalogue.ts";
import { validRosterSearchPlan } from "../cliniko/roster-calendar.ts";
import type { RosterSearchPlan } from "../cliniko/roster-calendar.ts";

export type BookingApproval = ClinicApproval & Readonly<{
  policyVersion: string; businessId: string; practitionerId: string; appointmentTypeId: string;
  credentialFingerprint: string; recallTypeId: string; timeZone: string; writeContract: "bestEffort";
  notificationOwner: "cliniko"; serviceRef: string; bookingPolicyVersion: string;
  durationMinutes: number; minNoticeMinutes: number; maxAdvanceDays: number; offerTtlSeconds: number;
  /** Independently approved extent of a complete search. Existing approvals retain seven days. */
  availabilityPlan?: Readonly<{ mode: "online"; maxSearchDays: number }> | RosterSearchPlan;
}>;
export type BookingPolicyBinding = Pick<BookingApproval, "scope" | "policyVersion" | "businessId" | "practitionerId" |
  "appointmentTypeId" | "credentialFingerprint" | "recallTypeId" | "timeZone">;
export type BookingServiceBinding = Readonly<{ catalogue: OwnerFileServiceCatalogue; serviceRef: string; preference?: BookingPractitionerPreference }>;
type Config = BookingPolicyBinding & Readonly<{ path: string; directory: AdminDirectory; clock?: () => string; serviceBinding?: BookingServiceBinding }>;
type Failure = Readonly<{ kind: "bookingPolicyUnavailable" }>;
function decode(value: unknown, scope: LocationScope): BookingApproval | undefined {
  const common = decodeClinicApproval(value, scope, [...clinicApprovalKeys, "policyVersion", "businessId", "practitionerId", "appointmentTypeId",
    "credentialFingerprint", "recallTypeId", "timeZone", "writeContract", "notificationOwner", "serviceRef", "bookingPolicyVersion",
    "durationMinutes", "minNoticeMinutes", "maxAdvanceDays", "offerTtlSeconds",
    ...(value && typeof value === "object" && Object.hasOwn(value, "availabilityPlan") ? ["availabilityPlan"] : [])]);
  if (!common) return undefined;
  const row = value as Record<string, unknown>;
  const integer = (key: string, min: number, max: number) => Number.isSafeInteger(row[key]) && Number(row[key]) >= min && Number(row[key]) <= max;
  if (![row.policyVersion, row.serviceRef, row.bookingPolicyVersion].every(approvalRef) ||
      ![row.businessId, row.practitionerId, row.appointmentTypeId, row.recallTypeId].every(id => typeof id === "string" && validClinikoId(id)) ||
      typeof row.credentialFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(row.credentialFingerprint) ||
      typeof row.timeZone !== "string" || row.timeZone.length > 128 || row.writeContract !== "bestEffort" || row.notificationOwner !== "cliniko" ||
      !integer("durationMinutes", 1, 480) || !integer("minNoticeMinutes", 1, 10080) || !integer("maxAdvanceDays", 1, 90) ||
      !integer("offerTtlSeconds", 15, 300) || Number(row.minNoticeMinutes) >= Number(row.maxAdvanceDays) * 1440) return undefined;
  try { new Intl.DateTimeFormat("en", { timeZone: row.timeZone }); } catch { return undefined; }
  if (row.availabilityPlan !== undefined) {
    const plan = row.availabilityPlan;
    if (!validRosterSearchPlan(plan) && (!plan || typeof plan !== "object" || Array.isArray(plan) ||
        Object.keys(plan).sort().join(",") !== "maxSearchDays,mode" ||
        !("mode" in plan) || plan.mode !== "online" || !("maxSearchDays" in plan) ||
        !Number.isSafeInteger(plan.maxSearchDays) || Number(plan.maxSearchDays) < 1 || Number(plan.maxSearchDays) > 90)) return undefined;
  }
  return row as unknown as BookingApproval;
}

/** Public clinic approval only. Patient permission, fee charging and staff receipt are separate. */
export class OwnerFileBookingPolicy {
  readonly #config: Config;
  readonly #source: OwnerFileClinicApproval<BookingApproval>;
  private constructor(config: Config, source: OwnerFileClinicApproval<BookingApproval>) {
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) }); this.#source = source;
  }
  static async capture(incoming: Config): Promise<Result<OwnerFileBookingPolicy, Failure>> {
    const config = Object.freeze({ ...incoming, scope: Object.freeze({ ...incoming.scope }),
      ...(incoming.serviceBinding ? { serviceBinding: Object.freeze({ ...incoming.serviceBinding, ...(incoming.serviceBinding.preference ? { preference: Object.freeze({ ...incoming.serviceBinding.preference }) } : {}) }) } : {}) });
    const source = await OwnerFileClinicApproval.capture({ ...config, decode });
    if (!source.ok) return err({ kind: "bookingPolicyUnavailable" });
    const policy = new OwnerFileBookingPolicy(config, source.value);
    return (await policy.current(config.scope)).ok ? ok(policy) : err({ kind: "bookingPolicyUnavailable" });
  }
  binding(): BookingPolicyBinding {
    const { scope, policyVersion, businessId, practitionerId, appointmentTypeId, credentialFingerprint, recallTypeId, timeZone } = this.#config;
    return { scope: { ...scope }, policyVersion, businessId, practitionerId, appointmentTypeId, credentialFingerprint, recallTypeId, timeZone };
  }
  async current(scope: LocationScope): Promise<Result<BookingApproval, Failure>> {
    const parent = this.#config.serviceBinding;
    if (parent && !(parent.catalogue instanceof OwnerFileServiceCatalogue)) return err({ kind: "bookingPolicyUnavailable" });
    // These are independent public approval sources. Keep each source's exact
    // before/after file and current-membership checks; overlap only their reads.
    // Operation-bound patient verifier and member searches remain serialized.
    const [found, current] = await Promise.all([this.#source.current(scope), parent?.catalogue.current(scope)]);
    const binding = this.binding();
    if (!found.ok || !found.value || Object.entries(binding).some(([key, value]) => key !== "scope" && found.value![key as keyof BookingApproval] !== value))
      return err({ kind: "bookingPolicyUnavailable" });
    if (parent) {
      const row = current?.ok && current.value.services.find(service => service.serviceRef === parent.serviceRef);
      if (!current?.ok || !row || current.value.policyVersion !== found.value.policyVersion || current.value.businessId !== found.value.businessId ||
          current.value.credentialFingerprint !== found.value.credentialFingerprint || current.value.timeZone !== found.value.timeZone ||
          row.serviceRef !== found.value.serviceRef || row.appointmentTypeId !== found.value.appointmentTypeId || row.durationMinutes !== found.value.durationMinutes ||
          row.searchDays > (found.value.availabilityPlan?.maxSearchDays ?? 7) ||
          !eligibleServicePractitioners(row.practitioners, parent.preference).some(member => member.practitionerId === found.value!.practitionerId)) return err({ kind: "bookingPolicyUnavailable" });
    }
    return ok(found.value);
  }
  static allows(approval: BookingApproval, startsAt: string, now: string): boolean {
    const start = approvalInstant(startsAt), at = approvalInstant(now);
    return start !== undefined && at !== undefined && start - at >= approval.minNoticeMinutes * 60_000 &&
      start - at <= approval.maxAdvanceDays * 86_400_000 && at >= Date.parse(approval.effectiveFrom) && at < Date.parse(approval.effectiveUntil);
  }
}
