import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { readOwnerJson } from "../shared/owner-json.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { validAdminAccount } from "./identity/magic-link.ts";
import type { AdminAccount, AdminDirectory } from "./identity/magic-link.ts";
import type { PatientOperation, VerificationPolicyGate } from "./transient-patient-proof.ts";

export type CallerPolicyFailure = Readonly<{ kind: "callerPolicyUnavailable" }>;
export type CallerVerificationApproval = Readonly<{
  scope: LocationScope; revision: string; approverRef: string; approvedAt: string;
  effectiveFrom: string; effectiveUntil: string; approved: boolean; enabled: boolean;
  method: "emailOtp"; maxAnswers: 3; lifetimeSeconds: 300;
  sharedNumbers: "deny"; representatives: "deny"; patientPermission: "independentClinicHost";
  operations: readonly PatientOperation[];
}>;
const operations: readonly PatientOperation[] = ["appointments.read", "appointments.book", "appointments.cancel", "appointments.reschedule"];
const opaque = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function instant(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : undefined;
}
function approval(value: unknown, scope: LocationScope): CallerVerificationApproval | undefined {
  const row = record(value), bound = record(row?.scope);
  const keys = "approved,approvedAt,approverRef,effectiveFrom,effectiveUntil,enabled,lifetimeSeconds,maxAnswers,method,operations,patientPermission,representatives,revision,scope,sharedNumbers";
  if (!row || Object.keys(row).sort().join(",") !== keys || !bound || Object.keys(bound).sort().join(",") !== "clinicId,locationId,tenantId" ||
      ![bound.tenantId, bound.clinicId, bound.locationId, row.revision, row.approverRef].every(opaque) ||
      !sameScope(bound as LocationScope, scope) || typeof row.approved !== "boolean" || typeof row.enabled !== "boolean" ||
      row.method !== "emailOtp" || row.maxAnswers !== 3 || row.lifetimeSeconds !== 300 || row.sharedNumbers !== "deny" ||
      row.representatives !== "deny" || row.patientPermission !== "independentClinicHost" ||
      !Array.isArray(row.operations) || !row.operations.length || row.operations.length > 4 ||
      row.operations.some(value => !operations.includes(value)) || new Set(row.operations).size !== row.operations.length) return undefined;
  const at = instant(row.approvedAt), from = instant(row.effectiveFrom), until = instant(row.effectiveUntil);
  if (at === undefined || from === undefined || until === undefined || at > from || from >= until) return undefined;
  return row as unknown as CallerVerificationApproval;
}
type Config = Readonly<{ path: string; scope: LocationScope; policyVersion: string; operation: PatientOperation;
  directory: AdminDirectory; clock?: () => string }>;

/** One call captures one operator-owned approval and current administrator membership.
 * It approves a verification method/operation only, never patient authority or caller/write activation. */
export class OwnerFileCallerPolicy implements VerificationPolicyGate {
  readonly #config: Config;
  readonly #approvalHash: string;
  readonly #membershipHash: string;
  private constructor(config: Config, captured: CallerVerificationApproval, account: AdminAccount) {
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) });
    this.#approvalHash = hash(captured); this.#membershipHash = hash(account);
  }

  get operation(): PatientOperation { return this.#config.operation; }

  static async capture(config: Config): Promise<Result<OwnerFileCallerPolicy, CallerPolicyFailure>> {
    try {
      if (!opaque(config.policyVersion) || !operations.includes(config.operation) || !config.directory ||
          typeof config.directory.findByRef !== "function" || (config.clock !== undefined && typeof config.clock !== "function")) {
        return err({ kind: "callerPolicyUnavailable" });
      }
      const captured = approval(await readOwnerJson(config.path, 8192), config.scope);
      if (!captured) return err({ kind: "callerPolicyUnavailable" });
      const found = await config.directory.findByRef(captured.approverRef);
      if (!found.ok || !found.value || !validAdminAccount(found.value) || found.value.actor.role !== "clinicAdmin" ||
          found.value.actor.actorRef !== captured.approverRef || !sameScope(found.value.actor.scope, config.scope)) return err({ kind: "callerPolicyUnavailable" });
      const again = approval(await readOwnerJson(config.path, 8192), config.scope);
      if (!again || hash(again) !== hash(captured)) return err({ kind: "callerPolicyUnavailable" });
      return ok(new OwnerFileCallerPolicy(config, captured, found.value));
    } catch { return err({ kind: "callerPolicyUnavailable" }); }
  }

  async current(scope: LocationScope): ReturnType<VerificationPolicyGate["current"]> {
    const config = this.#config;
    const denied = () => ok({ scope: config.scope, enabled: false, version: config.policyVersion });
    try {
      if (!sameScope(scope, config.scope)) return denied();
      const current = approval(await readOwnerJson(config.path, 8192), config.scope);
      if (!current || hash(current) !== this.#approvalHash) return denied();
      const found = await config.directory.findByRef(current.approverRef);
      if (!found.ok || !found.value || !validAdminAccount(found.value) || found.value.actor.role !== "clinicAdmin" ||
          !sameScope(found.value.actor.scope, config.scope) || hash(found.value) !== this.#membershipHash) return denied();
      const again = approval(await readOwnerJson(config.path, 8192), config.scope);
      const now = instant((config.clock ?? (() => new Date().toISOString()))());
      if (!again || hash(again) !== this.#approvalHash || now === undefined || now < Date.parse(current.effectiveFrom) ||
          now >= Date.parse(current.effectiveUntil) || !current.approved || !current.enabled || !current.operations.includes(config.operation)) return denied();
      return ok({ scope: config.scope, enabled: true, version: config.policyVersion });
    } catch { return err({ kind: "unavailable" }); }
  }
}
