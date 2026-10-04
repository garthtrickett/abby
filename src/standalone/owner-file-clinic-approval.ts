import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { readOwnerJson } from "../shared/owner-json.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { validAdminAccount } from "./identity/magic-link.ts";
import type { AdminAccount, AdminDirectory } from "./identity/magic-link.ts";

export type ClinicApproval = Readonly<{
  scope: LocationScope; revision: string; approverRef: string; approvedAt: string;
  effectiveFrom: string; effectiveUntil: string; approved: boolean; enabled: boolean;
}>;
export type ClinicApprovalFailure = Readonly<{ kind: "unavailable" }>;
export const approvalRef = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
export function approvalInstant(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : undefined;
}
export function decodeClinicApproval(value: unknown, scope: LocationScope, keys: readonly string[]): ClinicApproval | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>, bound = row.scope as Record<string, unknown> | undefined;
  if (Object.keys(row).sort().join(",") !== [...keys].sort().join(",") || !bound || typeof bound !== "object" ||
      Object.keys(bound).sort().join(",") !== "clinicId,locationId,tenantId" ||
      ![bound.tenantId, bound.clinicId, bound.locationId, row.revision, row.approverRef].every(approvalRef) ||
      !sameScope(bound as LocationScope, scope) || typeof row.approved !== "boolean" || typeof row.enabled !== "boolean") return undefined;
  const at = approvalInstant(row.approvedAt), from = approvalInstant(row.effectiveFrom), until = approvalInstant(row.effectiveUntil);
  return at !== undefined && from !== undefined && until !== undefined && at <= from && from < until ? row as unknown as ClinicApproval : undefined;
}
export const clinicApprovalKeys = ["scope", "revision", "approverRef", "approvedAt", "effectiveFrom", "effectiveUntil", "approved", "enabled"] as const;
type Config<Value> = Readonly<{ path: string; scope: LocationScope; directory: AdminDirectory;
  decode: (value: unknown, scope: LocationScope) => Value | undefined; clock?: () => string }>;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Current owner-provisioned approval/membership, shared by method and cancellation policy decoders. */
export class OwnerFileClinicApproval<Value extends ClinicApproval> {
  readonly #config: Config<Value>;
  readonly #approvalHash: string;
  readonly #membershipHash: string;
  private constructor(config: Config<Value>, captured: Value, account: AdminAccount) {
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) });
    this.#approvalHash = hash(captured); this.#membershipHash = hash(account);
  }
  static async capture<Value extends ClinicApproval>(config: Config<Value>): Promise<Result<OwnerFileClinicApproval<Value>, ClinicApprovalFailure>> {
    try {
      if (typeof config.decode !== "function" || typeof config.directory?.findByRef !== "function" ||
          (config.clock !== undefined && typeof config.clock !== "function")) return err({ kind: "unavailable" });
      const captured = config.decode(await readOwnerJson(config.path, 8192), config.scope);
      if (!captured) return err({ kind: "unavailable" });
      const found = await config.directory.findByRef(captured.approverRef);
      if (!found.ok || !found.value || !validAdminAccount(found.value) || found.value.actor.role !== "clinicAdmin" ||
          found.value.actor.actorRef !== captured.approverRef || !sameScope(found.value.actor.scope, config.scope)) return err({ kind: "unavailable" });
      const again = config.decode(await readOwnerJson(config.path, 8192), config.scope);
      if (!again || hash(again) !== hash(captured)) return err({ kind: "unavailable" });
      return ok(new OwnerFileClinicApproval(config, captured, found.value));
    } catch { return err({ kind: "unavailable" }); }
  }
  async current(scope: LocationScope): Promise<Result<Value | undefined, ClinicApprovalFailure>> {
    const config = this.#config;
    try {
      if (!sameScope(scope, config.scope)) return ok(undefined);
      const current = config.decode(await readOwnerJson(config.path, 8192), config.scope);
      if (!current || hash(current) !== this.#approvalHash) return ok(undefined);
      const found = await config.directory.findByRef(current.approverRef);
      if (!found.ok || !found.value || !validAdminAccount(found.value) || found.value.actor.role !== "clinicAdmin" ||
          !sameScope(found.value.actor.scope, config.scope) || hash(found.value) !== this.#membershipHash) return ok(undefined);
      const again = config.decode(await readOwnerJson(config.path, 8192), config.scope);
      const now = approvalInstant((config.clock ?? (() => new Date().toISOString()))());
      if (!again || hash(again) !== this.#approvalHash || now === undefined || now < Date.parse(current.effectiveFrom) ||
          now >= Date.parse(current.effectiveUntil) || !current.approved || !current.enabled) return ok(undefined);
      return ok(current);
    } catch { return err({ kind: "unavailable" }); }
  }
}
