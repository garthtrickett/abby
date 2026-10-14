import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { OwnerFileClassPolicy } from "./owner-file-class-policy.ts";
import type { ClassApproval } from "./owner-file-class-policy.ts";
import type { ClassAttendancePermission } from "./cliniko-class-booking-host.ts";
import type { ClassCancellationPermission } from "./cliniko-class-cancellation-host.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";

export type ClassServiceConfig = Readonly<{
  approvalPath: string; practitionerId: string; appointmentTypeId: string;
  bookPermission: ClassAttendancePermission; cancelPermission: ClassCancellationPermission;
  cancellationApprovalPath?: string;
}>;
export type PublicClassService = Readonly<{
  className: string; practitionerName: string; locationName: string; serviceRef: string; durationMinutes: number;
}>;
export type ClassServiceItem = Readonly<{ config: ClassServiceConfig; approval: ClassApproval; public: PublicClassService; label: string }>;
export type ClassServices = Readonly<{ version: string; expiresAt: string; items: readonly ClassServiceItem[] }>;
type Config = Readonly<{ scope: LocationScope; policyVersion: string; businessId: string; apiKey: string; recallTypeId: string; timeZone: string;
  directory: AdminDirectory; clock: () => string; services: readonly ClassServiceConfig[] }>;
type Failure = Readonly<{ kind: "classServicesUnavailable" }>;
const unavailable = (): Result<ClassServices, Failure> => err({ kind: "classServicesUnavailable" });
export const classServiceName = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[’]/g, "'").replace(/[,.!?]/g, " ").replace(/\s+/g, " ").trim();

/** Complete public approval read. No patient/provider IO, implicit first service,
 * skipped invalid entries, or authority derived from an OTP or a class name. */
export async function readClassServices(c: Config, signal: AbortSignal): Promise<Result<ClassServices, Failure>> {
  try {
    if (signal.aborted || !Array.isArray(c.services) || c.services.length < 1 || c.services.length > 32) return unavailable();
    const work = async () => {
      const rows = await Promise.all(c.services.map(async service => {
        if (!service || typeof service.bookPermission?.allows !== "function" || typeof service.cancelPermission?.allows !== "function") return undefined;
        const policy = await OwnerFileClassPolicy.capture({ path: service.approvalPath, scope: c.scope, policyVersion: c.policyVersion, businessId: c.businessId,
          practitionerId: service.practitionerId, appointmentTypeId: service.appointmentTypeId, credentialFingerprint: clinikoCredentialFingerprint(c.apiKey),
          recallTypeId: c.recallTypeId, timeZone: c.timeZone, directory: c.directory, clock: c.clock });
        const approval = policy.ok ? await policy.value.current(c.scope) : undefined;
        if (!policy.ok || !approval?.ok || signal.aborted) return undefined;
        const a = approval.value;
        return { policy: policy.value, item: { config: service, approval: a,
          public: { className: a.className, practitionerName: a.practitionerName, locationName: a.locationName, serviceRef: a.serviceRef, durationMinutes: a.durationMinutes },
          label: `${a.className} with ${a.practitionerName} for ${a.durationMinutes} minutes at ${a.locationName}` } satisfies ClassServiceItem };
      }));
      if (rows.some(row => !row)) return undefined;
      const complete = rows as NonNullable<typeof rows[number]>[];
      const unique = (key: (item: ClassServiceItem) => string) => new Set(complete.map(row => key(row.item))).size === complete.length;
      if (!unique(item => item.public.serviceRef) || !unique(item => `${item.config.practitionerId}:${item.config.appointmentTypeId}`) ||
          !unique(item => classServiceName(item.label)) || complete.some(row => row.item.label.length > 400)) return undefined;
      const again = await Promise.all(complete.map(async row => {
        const current = await row.policy.current(c.scope);
        return current.ok && JSON.stringify(current.value) === JSON.stringify(row.item.approval);
      }));
      if (again.some(current => !current) || signal.aborted) return undefined;
      const items = complete.map(row => row.item), expiresAt = new Date(Math.min(...items.map(item => Date.parse(item.approval.effectiveUntil)))).toISOString();
      return { items, expiresAt, version: createHash("sha256").update(JSON.stringify(items.map(item => item.approval))).digest("hex") };
    };
    const found = await awaitUntilAbort(work(), signal);
    return found && !signal.aborted ? ok(found) : unavailable();
  } catch { return unavailable(); }
}
