import { sql } from "kysely";
import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type Database from "./generated/Database.ts";

export type PortabilityFenceAction = "freeze" | "release";
export type PortabilityFenceRequest = Readonly<{
  tenantId: string;
  actorRef: string;
  reason: string;
  expectedVersion?: number;
}>;
export type PortabilityFenceAuthority = Readonly<{
  /** Authorize and durably audit before reading or changing source state. */
  authorizeAndRecord(action: PortabilityFenceAction, request: PortabilityFenceRequest):
    Promise<Result<Readonly<{ requestRef: string }>, Readonly<{ kind: "denied" | "auditFailure" }>>>;
}>;
export type PortabilityFenceStatus = Readonly<{
  tenantId: string;
  version: number;
  frozen: boolean;
  lastRequestRef: string | null;
}>;
export type PortabilityFenceFailure = Readonly<{
  kind: "invalidRequest" | "denied" | "auditFailure" | "callsRequireRetention" |
    "unresolvedWork" | "alreadyFrozen" | "notFrozen" | "versionConflict" | "staleRequest" | "storageFailure";
}>;

type FenceRow = { tenant_id: string; version: number; frozen: boolean; last_request_ref: string | null };
type EventRow = { kind: PortabilityFenceAction; version: number };

function validRef(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validRequest(action: PortabilityFenceAction, request: PortabilityFenceRequest): boolean {
  return !!request && validRef(request.tenantId) && validRef(request.actorRef) &&
    typeof request.reason === "string" && !!request.reason.trim() && request.reason.length <= 1000 &&
    !/[\u0000-\u001f\u007f]/.test(request.reason) &&
    (action === "freeze" ? request.expectedVersion === undefined :
      Number.isSafeInteger(request.expectedVersion) && Number(request.expectedVersion) >= 1);
}

function status(row: FenceRow): PortabilityFenceStatus {
  return { tenantId: row.tenant_id, version: row.version, frozen: row.frozen, lastRequestRef: row.last_request_ref };
}

/** The SQL write guard and this service use the same tenant-scoped advisory lock. */
export class PostgresPortabilityFence {
  private readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) { this.db = db; }

  async read(tenantId: string): Promise<Result<PortabilityFenceStatus, PortabilityFenceFailure>> {
    if (!validRef(tenantId)) return err({ kind: "invalidRequest" });
    try {
      const result = await sql<FenceRow>`select tenant_id, version, frozen, last_request_ref
        from tenant_portability_fences where tenant_id = ${tenantId}`.execute(this.db);
      const row = result.rows[0];
      return ok(row ? status(row) : { tenantId, version: 0, frozen: false, lastRequestRef: null });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async freeze(request: PortabilityFenceRequest, authority: PortabilityFenceAuthority):
    Promise<Result<PortabilityFenceStatus, PortabilityFenceFailure>> {
    return this.change("freeze", request, authority);
  }

  async release(request: PortabilityFenceRequest, authority: PortabilityFenceAuthority):
    Promise<Result<PortabilityFenceStatus, PortabilityFenceFailure>> {
    return this.change("release", request, authority);
  }

  private async change(action: PortabilityFenceAction, request: PortabilityFenceRequest, authority: PortabilityFenceAuthority):
    Promise<Result<PortabilityFenceStatus, PortabilityFenceFailure>> {
    if (!validRequest(action, request) || !authority || typeof authority.authorizeAndRecord !== "function") {
      return err({ kind: "invalidRequest" });
    }
    let approved: Awaited<ReturnType<PortabilityFenceAuthority["authorizeAndRecord"]>>;
    try { approved = await authority.authorizeAndRecord(action, request); }
    catch { return err({ kind: "auditFailure" }); }
    if (!approved || typeof approved !== "object" || typeof approved.ok !== "boolean") return err({ kind: "auditFailure" });
    if (!approved.ok) return err({ kind: approved.error?.kind === "denied" ? "denied" : "auditFailure" });
    const requestRef = approved.value?.requestRef;
    if (!validRef(requestRef)) return err({ kind: "auditFailure" });
    try {
      return await this.db.transaction().setIsolationLevel("read committed").execute(async trx => {
        await sql`select pg_advisory_xact_lock(172934501, hashtext(${request.tenantId}))`.execute(trx);
        let current = (await sql<FenceRow>`select tenant_id, version, frozen, last_request_ref
          from tenant_portability_fences where tenant_id = ${request.tenantId} for update`.execute(trx)).rows[0];
        if (current && (!Number.isSafeInteger(current.version) || current.version < 0)) return err({ kind: "storageFailure" });
        const earlier = (await sql<EventRow>`select kind, version from tenant_portability_fence_events
          where tenant_id = ${request.tenantId} and request_ref = ${requestRef}`.execute(trx)).rows[0];
        if (earlier) {
          if (earlier.kind === action && current?.last_request_ref === requestRef &&
              current.version === earlier.version && current.frozen === (action === "freeze")) return ok(status(current));
          return err({ kind: "staleRequest" });
        }
        if (action === "freeze") {
          if (current?.frozen) return err({ kind: "alreadyFrozen" });
          const pending = await sql<{ has_calls: boolean; has_pending: boolean; has_inflight: boolean }>`select
            exists(select 1 from calls where tenant_id = ${request.tenantId}) as has_calls,
            exists(select 1 from pending_location_calls where tenant_id = ${request.tenantId}) as has_pending,
            exists(select 1 from clinic_write_stop_inflight where tenant_id = ${request.tenantId}) as has_inflight`.execute(trx);
          const observed = pending.rows[0];
          if (!observed) throw new Error("portability preflight unavailable");
          if (observed.has_calls || observed.has_pending) return err({ kind: "callsRequireRetention" });
          if (observed.has_inflight) return err({ kind: "unresolvedWork" });
          if (!current) {
            const inserted = await sql<FenceRow>`insert into tenant_portability_fences (tenant_id)
              values (${request.tenantId}) returning tenant_id, version, frozen, last_request_ref`.execute(trx);
            current = inserted.rows[0];
          }
        } else {
          if (!current?.frozen) return err({ kind: "notFrozen" });
          if (current.version !== request.expectedVersion) return err({ kind: "versionConflict" });
        }
        if (!current) throw new Error("portability fence row missing");
        const nextVersion = current.version + 1;
        if (!Number.isSafeInteger(nextVersion)) throw new Error("portability fence version overflow");
        const changed = await sql<FenceRow>`update tenant_portability_fences set version = ${nextVersion},
          frozen = ${action === "freeze"}, last_request_ref = ${requestRef}, changed_at = clock_timestamp()
          where tenant_id = ${request.tenantId}
          returning tenant_id, version, frozen, last_request_ref`.execute(trx);
        const next = changed.rows[0];
        if (!next) throw new Error("portability fence update missing");
        await sql`insert into tenant_portability_fence_events (tenant_id, version, kind, request_ref, actor_ref, reason, changed_at)
          values (${request.tenantId}, ${nextVersion}, ${action}, ${requestRef}, ${request.actorRef}, ${request.reason}, clock_timestamp())`.execute(trx);
        return ok(status(next));
      });
    } catch { return err({ kind: "storageFailure" }); }
  }
}
