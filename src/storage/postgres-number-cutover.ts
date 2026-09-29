import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";
import { validCandidateNames } from "../core/pending-location.ts";
import { err, ok } from "../core/model.ts";
import { PHONE_NORMALIZATION_VERSION } from "../cliniko/phone-number.ts";
import type { Result } from "../core/model.ts";
import type { ArchiveEnvelope } from "../portability/archive-envelope.ts";
import { decodeTenantConfigArchive } from "../portability/config-archive.ts";
import type { TenantConfigArchiveData } from "../portability/config-archive.ts";
import type { ClinicIdentity, ClinicIdentityFailure, ClinicNumberRoutingHost } from "../reference/clinic-number-routing.ts";
import type Database from "./generated/Database.ts";
import { receiptMatches, targetReady } from "./postgres-cutover-target.ts";
import type { TargetImportRow } from "./postgres-cutover-target.ts";
import { comparePostgresFencedTenantArchiveSource } from "./postgres-fenced-archive-compare.ts";
import type { TenantConfigArchiveAuthority, TenantConfigArchiveRequest } from "./postgres-config-archive.ts";

export type NumberAssignment = Readonly<{ tenantId: string; clinicId: string;
  candidateLocationIds: readonly string[];
  candidateNames?: readonly Readonly<{ locationId: string; spokenName: string }>[] }>;
export type CutoverAction = "stage" | "publish" | "discard" | "beginRollback" | "finishRollback";
export type CutoverCommand = Readonly<{ accountRef: string; dialedNumber: string; actorRef: string }>;
export type TargetPhoneIndexPlan = Readonly<{ countryCallingCode: string; maxAgeMs: number }>;
export type CutoverAuthority = Readonly<{
  authorizeAndRecord(action: CutoverAction, command: CutoverCommand):
    Promise<Result<Readonly<{ auditRef: string }>, Readonly<{ kind: "denied" | "auditFailure" }>>>;
}>;
export type CutoverState = "staged" | "published" | "rollbackPendingRelease" | "rolledBack";
export type CutoverStatus = Readonly<{ state: CutoverState; routeVersion: number; activeTenantId: string;
  sourceTenantId: string; targetTenantId: string; sourceFenceVersion: number;
  archiveId: string; manifestDigest: string }>;
export type CutoverFailure = Readonly<{ kind: "invalidRequest" | "denied" | "auditFailure" |
  "invalidArchive" | "sourceDrift" | "sourceFenceChanged" | "routeConflict" | "targetNotReady" |
  "targetPhoneIndexNotReady" | "targetImportMismatch" | "notStaged" | "invalidTransition" | "storageFailure" }>;

type RouteRow = { version: number; assignment: unknown };
type PlanRow = { source_tenant_id: string; target_tenant_id: string; source_fence_version: number;
  archive_id: string; manifest_digest: string; source_schema_version: string;
  source_assignment: unknown; target_assignment: unknown; staged_route_version: number;
  published_route_version: number | null; state: CutoverState;
  phone_index_country_calling_code: string | null; phone_index_max_age_ms: number | null };

function validRef(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validPhoneIndexPlan(value: unknown): value is TargetPhoneIndexPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Partial<TargetPhoneIndexPlan>;
  return typeof plan.countryCallingCode === "string" && /^[1-9][0-9]{0,2}$/.test(plan.countryCallingCode) &&
    typeof plan.maxAgeMs === "number" && Number.isSafeInteger(plan.maxAgeMs) &&
    plan.maxAgeMs >= 1 && plan.maxAgeMs <= 3_600_000;
}

function assignment(value: unknown): NumberAssignment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Partial<NumberAssignment>;
  if (!validRef(item.tenantId) || !validRef(item.clinicId) ||
      !Array.isArray(item.candidateLocationIds) || item.candidateLocationIds.length < 1 ||
      item.candidateLocationIds.length > 32 || !item.candidateLocationIds.every(validRef) ||
      new Set(item.candidateLocationIds).size !== item.candidateLocationIds.length ||
      (item.candidateLocationIds.length > 1 && !validCandidateNames(item.candidateLocationIds, item.candidateNames))) {
    return undefined;
  }
  return { tenantId: item.tenantId, clinicId: item.clinicId,
    candidateLocationIds: [...item.candidateLocationIds],
    ...(item.candidateLocationIds.length > 1 ? { candidateNames: item.candidateNames! } : {}) };
}

function sameAssignment(left: NumberAssignment, right: NumberAssignment): boolean {
  return isDeepStrictEqual(left, right);
}

function targetAssignment(source: NumberAssignment, data: TenantConfigArchiveData): NumberAssignment | undefined {
  if (source.tenantId !== data.sourceTenantId) return undefined;
  const targets = source.candidateLocationIds.map(locationId => data.locations.find(location =>
    location.sourceScope.tenantId === source.tenantId && location.sourceScope.clinicId === source.clinicId &&
    location.sourceScope.locationId === locationId)?.targetScope);
  if (targets.some(scope => !scope) || new Set(targets.map(scope => scope!.clinicId)).size !== 1) return undefined;
  const candidateLocationIds = targets.map(scope => scope!.locationId);
  const candidateNames = source.candidateNames?.map((item, index) =>
    ({ locationId: candidateLocationIds[index]!, spokenName: item.spokenName }));
  return assignment({ tenantId: data.targetTenantId, clinicId: targets[0]!.clinicId,
    candidateLocationIds, ...(candidateNames ? { candidateNames } : {}) });
}

async function lockTenants(trx: Transaction<Database>, tenantIds: readonly string[]): Promise<void> {
  for (const tenantId of [...new Set(tenantIds)].sort()) {
    await sql`select pg_advisory_xact_lock(172934501, hashtext(${tenantId}))`.execute(trx);
  }
}

async function route(trx: Transaction<Database>, command: CutoverCommand): Promise<RouteRow | undefined> {
  return (await sql<RouteRow>`select version, assignment from number_routes
    where account_ref = ${command.accountRef} and dialed_number = ${command.dialedNumber} for update`.execute(trx)).rows[0];
}

async function plan(trx: Transaction<Database>, command: CutoverCommand): Promise<PlanRow | undefined> {
  return (await sql<PlanRow>`select source_tenant_id, target_tenant_id, source_fence_version,
    archive_id, manifest_digest, source_schema_version, source_assignment, target_assignment,
    staged_route_version, published_route_version, state, phone_index_country_calling_code,
    phone_index_max_age_ms from number_cutovers
    where account_ref = ${command.accountRef} and dialed_number = ${command.dialedNumber} for update`.execute(trx)).rows[0];
}

async function targetPhoneIndexReady(trx: Transaction<Database>, target: NumberAssignment,
                                     plan: TargetPhoneIndexPlan): Promise<boolean> {
  // Refresh and disconnect take the exclusive clinic lock. Hold its shared form
  // through route publication so an index cannot be cleared during this check.
  await sql`select pg_advisory_xact_lock_shared(hashtext(${target.tenantId}),
    hashtext(${target.clinicId}))`.execute(trx);
  const connection = (await sql<{ enabled: boolean }>`select enabled from patient_phone_clinic_status
    where tenant_id = ${target.tenantId} and clinic_id = ${target.clinicId} for share`.execute(trx)).rows[0];
  if (connection?.enabled === false) return false;
  const head = (await sql<{ generation: number; completed_at: Date; country_calling_code: string | null;
    normalization_version: number | null }>`select generation, completed_at, country_calling_code, normalization_version
    from patient_phone_sync where tenant_id = ${target.tenantId} and clinic_id = ${target.clinicId}
    for share`.execute(trx)).rows[0];
  if (!head || !Number.isSafeInteger(head.generation) || head.generation < 1 ||
      head.country_calling_code !== plan.countryCallingCode ||
      head.normalization_version !== PHONE_NORMALIZATION_VERSION ||
      !(head.completed_at instanceof Date) || !Number.isFinite(head.completed_at.getTime())) return false;
  const now = (await sql<{ current_time: Date }>`select clock_timestamp() as current_time`.execute(trx)).rows[0]?.current_time;
  const ageMs = now instanceof Date ? now.getTime() - head.completed_at.getTime() : NaN;
  return Number.isFinite(ageMs) && ageMs >= -60_000 && ageMs <= plan.maxAgeMs;
}

async function frozenAt(trx: Transaction<Database>, tenantId: string, version: number): Promise<boolean> {
  const row = (await sql<{ frozen: boolean; version: number }>`select frozen, version from tenant_portability_fences
    where tenant_id = ${tenantId} for share`.execute(trx)).rows[0];
  return !!row && row.frozen && row.version === version;
}

async function schemaAt(trx: Transaction<Database>, version: string): Promise<boolean> {
  const row = (await sql<{ name: string }>`select name from kysely_migration order by name desc limit 1`.execute(trx)).rows[0];
  return row?.name === version;
}

function status(current: RouteRow, cutover: PlanRow): CutoverStatus | undefined {
  const active = assignment(current.assignment);
  if (!active) return undefined;
  return { state: cutover.state, routeVersion: current.version, activeTenantId: active.tenantId,
    sourceTenantId: cutover.source_tenant_id, targetTenantId: cutover.target_tenant_id,
    sourceFenceVersion: cutover.source_fence_version, archiveId: cutover.archive_id,
    manifestDigest: cutover.manifest_digest };
}

async function event(trx: Transaction<Database>, command: CutoverCommand, action: CutoverAction,
                     routeVersion: number, auditRef: string): Promise<void> {
  await sql`insert into number_route_events (account_ref, dialed_number, kind, route_version, actor_ref, audit_ref)
    values (${command.accountRef}, ${command.dialedNumber}, ${action}, ${routeVersion},
      ${command.actorRef}, ${auditRef})`.execute(trx);
}

/** Reference host number directory backed by one durable row per dialed number. */
export class PostgresNumberRoutingHost implements ClinicNumberRoutingHost {
  private readonly db: Kysely<Database>;
  constructor(db: Kysely<Database>) { this.db = db; }

  async identifyCall(accountRef: string, dialedNumber: string): Promise<Result<ClinicIdentity, ClinicIdentityFailure>> {
    if (!validRef(accountRef) || !validRef(dialedNumber)) return err({ kind: "unavailable" });
    try {
      const row = (await sql<RouteRow>`select version, assignment from number_routes
        where account_ref = ${accountRef} and dialed_number = ${dialedNumber}`.execute(this.db)).rows[0];
      if (!row) return err({ kind: "unknownNumber" });
      const assigned = assignment(row.assignment);
      if (!assigned || !Number.isSafeInteger(row.version) || row.version < 1) return err({ kind: "unavailable" });
      return ok({ accountRef, dialedNumber, ...assigned, routeVersion: String(row.version) });
    } catch { return err({ kind: "unavailable" }); }
  }
}

/** Synthetic configuration-only number switch; an acquiring host replaces this directory. */
export class PostgresConfigNumberCutover {
  private readonly db: Kysely<Database>;
  constructor(db: Kysely<Database>) { this.db = db; }

  private async authorize(action: CutoverAction, command: CutoverCommand, authority: CutoverAuthority):
    Promise<Result<string, CutoverFailure>> {
    if (!command || ![command.accountRef, command.dialedNumber, command.actorRef].every(validRef) ||
        !authority || typeof authority.authorizeAndRecord !== "function") return err({ kind: "invalidRequest" });
    try {
      const approved = await authority.authorizeAndRecord(action, command);
      if (!approved.ok) return err({ kind: approved.error.kind });
      return validRef(approved.value.auditRef) ? ok(approved.value.auditRef) : err({ kind: "auditFailure" });
    } catch { return err({ kind: "auditFailure" }); }
  }

  async stage(command: CutoverCommand & Readonly<{ expectedRouteVersion: number; baseline: ArchiveEnvelope;
    comparison: TenantConfigArchiveRequest & Readonly<{ expectedFenceVersion: number }>;
    targetPhoneIndex: TargetPhoneIndexPlan }>,
    authority: CutoverAuthority, exportAuthority: TenantConfigArchiveAuthority):
    Promise<Result<CutoverStatus, CutoverFailure>> {
    const approved = await this.authorize("stage", command, authority);
    if (!approved.ok) return approved;
    if (!Number.isSafeInteger(command.expectedRouteVersion) || command.expectedRouteVersion < 1 ||
        !command.baseline || !command.comparison || !validPhoneIndexPlan(command.targetPhoneIndex)) {
      return err({ kind: "invalidRequest" });
    }
    const comparison = await comparePostgresFencedTenantArchiveSource(this.db, command.baseline,
      command.comparison, exportAuthority);
    if (!comparison.ok) return err({ kind: comparison.error.kind === "fenceMismatch" ? "sourceFenceChanged" : "invalidArchive" });
    if (comparison.value.kind !== "unchanged") return err({ kind: "sourceDrift" });
    const targetTenantId = command.comparison.locations[0]!.targetScope.tenantId;
    const decoded = await decodeTenantConfigArchive(command.baseline, targetTenantId);
    if (!decoded.ok) return err({ kind: "invalidArchive" });
    const data = decoded.value;
    try {
      return await this.db.transaction().setIsolationLevel("read committed").execute(async trx => {
        await lockTenants(trx, [data.sourceTenantId, data.targetTenantId]);
        const current = await route(trx, command);
        if (!current) return err({ kind: "routeConflict" });
        const existing = await plan(trx, command);
        if (existing) return existing.archive_id === data.archiveId && existing.manifest_digest === data.manifestDigest &&
          existing.source_fence_version === data.sourceFenceVersion &&
          existing.phone_index_country_calling_code === command.targetPhoneIndex.countryCallingCode &&
          existing.phone_index_max_age_ms === command.targetPhoneIndex.maxAgeMs && status(current, existing)
          ? ok(status(current, existing)!) : err({ kind: "routeConflict" });
        if (current.version !== command.expectedRouteVersion) return err({ kind: "routeConflict" });
        const source = assignment(current.assignment);
        const target = source ? targetAssignment(source, data) : undefined;
        if (!source || !target) return err({ kind: "routeConflict" });
        if (!await frozenAt(trx, data.sourceTenantId, data.sourceFenceVersion!) ||
            !await schemaAt(trx, data.sourceSchemaVersion)) return err({ kind: "sourceFenceChanged" });
        const registry = (await sql<TargetImportRow>`select archive_id, manifest_digest, receipt, source_history
          from tenant_config_imports where target_tenant_id = ${data.targetTenantId}`.execute(trx)).rows[0];
        if (!receiptMatches(registry, data)) {
          return err({ kind: "targetImportMismatch" });
        }
        if (!await targetReady(trx, data, registry!)) return err({ kind: "targetNotReady" });
        await sql`insert into number_cutovers (account_ref, dialed_number, source_tenant_id, target_tenant_id,
          source_fence_version, archive_id, manifest_digest, source_schema_version, source_assignment,
          target_assignment, staged_route_version, phone_index_country_calling_code,
          phone_index_max_age_ms, state) values
          (${command.accountRef}, ${command.dialedNumber}, ${data.sourceTenantId}, ${data.targetTenantId},
           ${data.sourceFenceVersion}, ${data.archiveId}, ${data.manifestDigest}, ${data.sourceSchemaVersion},
           ${JSON.stringify(source)}::jsonb, ${JSON.stringify(target)}::jsonb, ${current.version},
           ${command.targetPhoneIndex.countryCallingCode}, ${command.targetPhoneIndex.maxAgeMs}, 'staged')`.execute(trx);
        await event(trx, command, "stage", current.version, approved.value);
        return ok({ state: "staged", routeVersion: current.version, activeTenantId: source.tenantId,
          sourceTenantId: data.sourceTenantId, targetTenantId: data.targetTenantId,
          sourceFenceVersion: data.sourceFenceVersion!, archiveId: data.archiveId,
          manifestDigest: data.manifestDigest });
      });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async publish(command: CutoverCommand, authority: CutoverAuthority): Promise<Result<CutoverStatus, CutoverFailure>> {
    return this.change("publish", command, authority);
  }

  async discard(command: CutoverCommand, authority: CutoverAuthority): Promise<Result<CutoverStatus, CutoverFailure>> {
    return this.change("discard", command, authority);
  }

  async beginRollback(command: CutoverCommand, authority: CutoverAuthority): Promise<Result<CutoverStatus, CutoverFailure>> {
    return this.change("beginRollback", command, authority);
  }

  async finishRollback(command: CutoverCommand, authority: CutoverAuthority): Promise<Result<CutoverStatus, CutoverFailure>> {
    return this.change("finishRollback", command, authority);
  }

  private async change(action: Exclude<CutoverAction, "stage">, command: CutoverCommand, authority: CutoverAuthority):
    Promise<Result<CutoverStatus, CutoverFailure>> {
    const approved = await this.authorize(action, command, authority);
    if (!approved.ok) return approved;
    try {
      return await this.db.transaction().setIsolationLevel("read committed").execute(async trx => {
        // Read the immutable plan first; lock ordering begins with tenant advisory locks.
        const found = (await sql<PlanRow>`select source_tenant_id, target_tenant_id, source_fence_version,
          archive_id, manifest_digest, source_schema_version, source_assignment, target_assignment,
          staged_route_version, published_route_version, state, phone_index_country_calling_code,
          phone_index_max_age_ms from number_cutovers
          where account_ref = ${command.accountRef} and dialed_number = ${command.dialedNumber}`.execute(trx)).rows[0];
        if (!found) return err({ kind: "notStaged" });
        await lockTenants(trx, [found.source_tenant_id, found.target_tenant_id]);
        const current = await route(trx, command);
        const staged = await plan(trx, command);
        if (!current || !staged || staged.archive_id !== found.archive_id ||
            staged.manifest_digest !== found.manifest_digest) return err({ kind: "routeConflict" });
        const source = assignment(staged.source_assignment);
        const target = assignment(staged.target_assignment);
        const active = assignment(current.assignment);
        if (!source || !target || !active) return err({ kind: "storageFailure" });
        if (action === "publish") {
          if (staged.state === "published" && current.version === staged.published_route_version &&
              sameAssignment(active, target)) return ok(status(current, staged)!);
          if (staged.state !== "staged" || current.version !== staged.staged_route_version ||
              !sameAssignment(active, source)) return err({ kind: "invalidTransition" });
          if (!await frozenAt(trx, staged.source_tenant_id, staged.source_fence_version) ||
              !await schemaAt(trx, staged.source_schema_version)) return err({ kind: "sourceFenceChanged" });
          const registry = (await sql<TargetImportRow>`select archive_id, manifest_digest, receipt, source_history
            from tenant_config_imports where target_tenant_id = ${staged.target_tenant_id}`.execute(trx)).rows[0];
          if (!registry || registry.archive_id !== staged.archive_id ||
              registry.manifest_digest !== staged.manifest_digest ||
              registry.receipt.sourceFenceVersion !== staged.source_fence_version) {
            return err({ kind: "targetImportMismatch" });
          }
          if (!await targetReady(trx, registry.source_history, registry)) return err({ kind: "targetNotReady" });
          const phonePlan = { countryCallingCode: staged.phone_index_country_calling_code,
            maxAgeMs: staged.phone_index_max_age_ms };
          if (!validPhoneIndexPlan(phonePlan) || !await targetPhoneIndexReady(trx, target, phonePlan)) {
            return err({ kind: "targetPhoneIndexNotReady" });
          }
          const next = current.version + 1;
          await sql`update number_routes set version = ${next}, assignment = ${JSON.stringify(target)}::jsonb
            where account_ref = ${command.accountRef} and dialed_number = ${command.dialedNumber}`.execute(trx);
          await sql`update number_cutovers set state = 'published', published_route_version = ${next},
            updated_at = clock_timestamp() where account_ref = ${command.accountRef}
            and dialed_number = ${command.dialedNumber}`.execute(trx);
          await event(trx, command, action, next, approved.value);
          return ok({ ...status(current, staged)!, state: "published", routeVersion: next, activeTenantId: target.tenantId });
        }
        if (action === "discard") {
          if (staged.state === "rolledBack" && staged.published_route_version === null &&
              sameAssignment(active, source)) return ok(status(current, staged)!);
          if (staged.state !== "staged" || current.version !== staged.staged_route_version ||
              !sameAssignment(active, source)) return err({ kind: "invalidTransition" });
          await sql`update number_cutovers set state = 'rolledBack', updated_at = clock_timestamp()
            where account_ref = ${command.accountRef} and dialed_number = ${command.dialedNumber}`.execute(trx);
          await event(trx, command, action, current.version, approved.value);
          return ok({ ...status(current, staged)!, state: "rolledBack" });
        }
        if (action === "beginRollback") {
          if (staged.state === "rollbackPendingRelease" && current.version === staged.published_route_version &&
              sameAssignment(active, target)) return ok(status(current, staged)!);
          if (staged.state !== "published" || current.version !== staged.published_route_version ||
              !sameAssignment(active, target)) return err({ kind: "invalidTransition" });
          if (!await frozenAt(trx, staged.source_tenant_id, staged.source_fence_version)) {
            return err({ kind: "sourceFenceChanged" });
          }
          await sql`update number_cutovers set state = 'rollbackPendingRelease', updated_at = clock_timestamp()
            where account_ref = ${command.accountRef} and dialed_number = ${command.dialedNumber}`.execute(trx);
          await event(trx, command, action, current.version, approved.value);
          return ok({ ...status(current, staged)!, state: "rollbackPendingRelease" });
        }
        if (staged.state === "rolledBack" && staged.published_route_version !== null &&
            current.version === staged.published_route_version + 1 && sameAssignment(active, source)) {
          return ok(status(current, staged)!);
        }
        if (staged.state !== "rollbackPendingRelease" || current.version !== staged.published_route_version ||
            !sameAssignment(active, target)) return err({ kind: "invalidTransition" });
        const sourceFence = (await sql<{ version: number; frozen: boolean }>`select version, frozen
          from tenant_portability_fences where tenant_id = ${staged.source_tenant_id} for share`.execute(trx)).rows[0];
        if (!sourceFence || sourceFence.frozen || sourceFence.version !== staged.source_fence_version + 1) {
          return err({ kind: "sourceFenceChanged" });
        }
        const next = current.version + 1;
        await sql`update number_routes set version = ${next}, assignment = ${JSON.stringify(source)}::jsonb
          where account_ref = ${command.accountRef} and dialed_number = ${command.dialedNumber}`.execute(trx);
        await sql`update number_cutovers set state = 'rolledBack', updated_at = clock_timestamp()
          where account_ref = ${command.accountRef} and dialed_number = ${command.dialedNumber}`.execute(trx);
        await event(trx, command, action, next, approved.value);
        return ok({ ...status(current, staged)!, state: "rolledBack", routeVersion: next,
          activeTenantId: source.tenantId });
      });
    } catch { return err({ kind: "storageFailure" }); }
  }
}
