import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { ArchiveEnvelope } from "../portability/archive-envelope.ts";
import type { ConfigArchiveData, TenantConfigArchiveData } from "../portability/config-archive.ts";
import { mapConfig } from "../reference/config-archive-import.ts";
import type { ReferenceImportMapper } from "../reference/config-archive-import.ts";
import { ReferenceTenantConfigArchiveImporter } from "../reference/tenant-config-archive-import.ts";
import type { ReferenceTenantImportAuthority, ReferenceTenantImportFailure, ReferenceTenantImportReport,
  StagedReferenceTenantConfiguration } from "../reference/tenant-config-archive-import.ts";
import type Database from "./generated/Database.ts";

export type PostgresTenantImportFailure = ReferenceTenantImportFailure | Readonly<{ kind: "storageFailure" }>;
type RegistryRow = { archive_id: string; manifest_digest: string; receipt: ReferenceTenantImportReport;
  source_history: TenantConfigArchiveData };

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

function validInstant(value: string): boolean {
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function importActor(archiveId: string): string {
  return `import:${createHash("sha256").update(archiveId).digest("hex").slice(0, 32)}`;
}

async function existing(db: Kysely<Database> | Transaction<Database>, tenantId: string): Promise<RegistryRow | undefined> {
  return (await sql<RegistryRow>`select archive_id, manifest_digest, receipt, source_history
    from tenant_config_imports where target_tenant_id = ${tenantId}`.execute(db)).rows[0];
}

async function occupied(db: Kysely<Database> | Transaction<Database>, tenantId: string): Promise<boolean> {
  const result = await sql<{ occupied: boolean }>`select (
    exists(select 1 from tenant_portability_fences where tenant_id = ${tenantId}) or
    exists(select 1 from clinic_settings where tenant_id = ${tenantId}) or
    exists(select 1 from clinic_automation where tenant_id = ${tenantId}) or
    exists(select 1 from clinic_knowledge_heads where tenant_id = ${tenantId}) or
    exists(select 1 from clinic_write_stop where tenant_id = ${tenantId}) or
    exists(select 1 from calls where tenant_id = ${tenantId}) or
    exists(select 1 from pending_location_calls where tenant_id = ${tenantId})
  ) as occupied`.execute(db);
  if (!result.rows[0]) throw new Error("target occupancy unavailable");
  return result.rows[0].occupied;
}

function replayMapper(staged: StagedReferenceTenantConfiguration): ReferenceImportMapper {
  return { mapRef: (kind, sourceRef, sourceScope, targetScope) => {
    const matches = staged.receipt.mappings.filter(row => row.kind === kind && row.sourceRef === sourceRef &&
      sameScope(row.sourceScope, sourceScope) && sameScope(row.targetScope, targetScope));
    return matches.length === 1 ? matches[0]!.targetRef : null;
  } };
}

async function writeLocation(trx: Transaction<Database>, location: TenantConfigArchiveData["locations"][number],
                             clinic: TenantConfigArchiveData["clinics"][number], mapper: ReferenceImportMapper,
                             actorRef: string, importedAt: string): Promise<void> {
  const scope = location.targetScope;
  const scoped: Pick<ConfigArchiveData, "sourceScope" | "policies" | "automation" | "knowledge"> = {
    sourceScope: location.sourceScope, policies: location.policies, automation: clinic.automation,
    knowledge: location.knowledge };
  const mapped = mapConfig(scoped, scope, mapper);
  if (!mapped.ok) throw new Error("validated mapping changed");
  const policyRows = mapped.value.policyRows.length ? mapped.value.policyRows : [
    { version: 0, isHead: true, policy: mapped.value.policy, changedBy: null,
      previousBookingEnabled: null, changedAt: null }];
  for (const row of policyRows) {
    await sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy,
      changed_by, previous_booking_enabled, changed_at) values
      (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, ${row.version},
       ${JSON.stringify(row.policy)}::jsonb, ${row.changedBy}, ${row.previousBookingEnabled},
       ${row.changedAt}::timestamptz)`.execute(trx);
  }
  const head = policyRows.find(row => row.isHead)!;
  if (head.policy.bookingEnabled) {
    const next = { ...head.policy, policyVersion: String(head.version + 1), bookingEnabled: false,
      capabilities: { ...head.policy.capabilities, book: "unavailable" as const } };
    await sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy,
      changed_by, previous_booking_enabled, changed_at) values
      (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, ${head.version + 1},
       ${JSON.stringify(next)}::jsonb, ${actorRef}, true, ${importedAt}::timestamptz)`.execute(trx);
  }
  const bySource = new Map<string, typeof mapped.value.knowledgeEntries[number][]>();
  for (const entry of mapped.value.knowledgeEntries) {
    const entries = bySource.get(entry.sourceRef) ?? [];
    entries.push(entry);
    bySource.set(entry.sourceRef, entries);
  }
  for (const [sourceRef, entries] of bySource) {
    const last = entries.reduce((current, entry) => Number(entry.version) > Number(current.version) ? entry : current);
    await sql`insert into clinic_knowledge_heads (tenant_id, clinic_id, location_id, source_ref, version, effective_version)
      values (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, ${sourceRef}, ${Number(last.version)},
      ${last.status === "approved" ? Number(last.version) : null})`.execute(trx);
    for (const entry of entries) {
      await sql`insert into clinic_knowledge_events (tenant_id, clinic_id, location_id, source_ref, version,
        status, owner_ref, answer_text, effective_from, effective_until, actor_ref, changed_at) values
        (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, ${sourceRef}, ${Number(entry.version)},
         ${entry.status}, ${entry.ownerRef}, ${entry.text}, ${entry.effectiveFrom}::timestamptz,
         ${entry.effectiveUntil}::timestamptz, ${entry.actorRef}, ${entry.changedAt}::timestamptz)`.execute(trx);
    }
  }
}

async function writeClinic(trx: Transaction<Database>, scope: LocationScope,
                           clinic: TenantConfigArchiveData["clinics"][number], actorRef: string, importedAt: string): Promise<void> {
  const automation = clinic.automation.length ? clinic.automation : [
    { version: 0, isHead: true, enabled: false, changedBy: null, previousEnabled: null, changedAt: null }];
  for (const row of automation) {
    await sql`insert into clinic_automation (tenant_id, clinic_id, version, enabled,
      changed_by, previous_enabled, changed_at) values
      (${scope.tenantId}, ${scope.clinicId}, ${row.version}, ${row.enabled},
       ${row.changedBy}, ${row.previousEnabled}, ${row.changedAt}::timestamptz)`.execute(trx);
  }
  const head = automation.find(row => row.isHead)!;
  if (head.enabled) {
    await sql`insert into clinic_automation (tenant_id, clinic_id, version, enabled,
      changed_by, previous_enabled, changed_at) values
      (${scope.tenantId}, ${scope.clinicId}, ${head.version + 1}, false,
       ${actorRef}, true, ${importedAt}::timestamptz)`.execute(trx);
  }
  const reason = "Imported configuration awaiting target readiness";
  await sql`insert into clinic_write_stop (tenant_id, clinic_id, version, stopped, actor_ref, reason, changed_at)
    values (${scope.tenantId}, ${scope.clinicId}, 1, true, ${actorRef}, ${reason}, ${importedAt}::timestamptz)`.execute(trx);
  await sql`insert into clinic_write_stop_events (tenant_id, clinic_id, version, stopped, actor_ref, reason, changed_at)
    values (${scope.tenantId}, ${scope.clinicId}, 1, true, ${actorRef}, ${reason}, ${importedAt}::timestamptz)`.execute(trx);
}

/** Persists a validated configuration-only import and its source history as one tenant transaction. */
export class PostgresTenantConfigArchiveImporter {
  private readonly db: Kysely<Database>;
  private readonly clock: () => string;
  constructor(db: Kysely<Database>, clock: () => string = () => new Date().toISOString()) {
    this.db = db;
    this.clock = clock;
  }

  async read(targetTenantId: string, actorRef: string, authority: ReferenceTenantImportAuthority):
    Promise<Result<Readonly<{ receipt: ReferenceTenantImportReport;
      sourceHistory: TenantConfigArchiveData }> | null, PostgresTenantImportFailure>> {
    if (typeof targetTenantId !== "string" || !targetTenantId.trim() || targetTenantId.length > 256 ||
        typeof actorRef !== "string" || !actorRef.trim() || actorRef.length > 256 ||
        !authority || typeof authority.authorizeAndRecord !== "function") {
      return err({ kind: "invalidRequest" });
    }
    try {
      const approved = await authority.authorizeAndRecord(actorRef, targetTenantId);
      if (!approved.ok) return err({ kind: approved.error.kind });
      if (typeof approved.value.auditRef !== "string" || !approved.value.auditRef.trim()) return err({ kind: "auditFailure" });
    } catch { return err({ kind: "auditFailure" }); }
    try {
      const row = await existing(this.db, targetTenantId);
      return ok(row ? { receipt: row.receipt, sourceHistory: row.source_history } : null);
    } catch { return err({ kind: "storageFailure" }); }
  }

  async preflight(input: ArchiveEnvelope, targetTenantId: string, actorRef: string,
                  authority: ReferenceTenantImportAuthority, mapper: ReferenceImportMapper):
    Promise<Result<ReferenceTenantImportReport, PostgresTenantImportFailure>> {
    const validated = await new ReferenceTenantConfigArchiveImporter().preflight(input, targetTenantId,
      actorRef, authority, mapper);
    if (!validated.ok) return validated;
    try {
      const row = await existing(this.db, targetTenantId);
      if (row) return row.archive_id === validated.value.archiveId && row.manifest_digest === validated.value.manifestDigest
        ? ok({ ...row.receipt, status: "alreadyStaged" })
        : err({ kind: row.archive_id === validated.value.archiveId ? "archiveConflict" : "targetOccupied" });
      if (await occupied(this.db, targetTenantId)) return err({ kind: "targetOccupied" });
      return validated;
    } catch { return err({ kind: "storageFailure" }); }
  }

  async stage(input: ArchiveEnvelope, targetTenantId: string, actorRef: string,
              authority: ReferenceTenantImportAuthority, mapper: ReferenceImportMapper):
    Promise<Result<ReferenceTenantImportReport, PostgresTenantImportFailure>> {
    let importedAt: string;
    try { importedAt = this.clock(); }
    catch { return err({ kind: "invalidRequest" }); }
    if (!validInstant(importedAt)) return err({ kind: "invalidRequest" });
    const validated = await new ReferenceTenantConfigArchiveImporter(() => importedAt).stage(input, targetTenantId,
      actorRef, authority, mapper);
    if (!validated.ok) return validated;
    const staged = validated.value;
    const data = staged.sourceHistory;
    try {
      return await this.db.transaction().setIsolationLevel("read committed").execute(async trx => {
        await sql`select pg_advisory_xact_lock(172934501, hashtext(${targetTenantId}))`.execute(trx);
        const row = await existing(trx, targetTenantId);
        if (row) return row.archive_id === data.archiveId && row.manifest_digest === data.manifestDigest
          ? ok(row.receipt)
          : err({ kind: row.archive_id === data.archiveId ? "archiveConflict" : "targetOccupied" });
        if (await occupied(trx, targetTenantId)) return err({ kind: "targetOccupied" });
        const actor = importActor(data.archiveId);
        const mapperFromReceipt = replayMapper(staged);
        for (const location of data.locations) {
          const clinic = data.clinics.find(item => item.sourceClinicId === location.sourceScope.clinicId);
          if (!clinic) throw new Error("validated clinic absent");
          await writeLocation(trx, location, clinic, mapperFromReceipt, actor, importedAt);
        }
        for (const clinic of data.clinics) {
          const location = data.locations.find(item => item.sourceScope.clinicId === clinic.sourceClinicId);
          if (!location) throw new Error("validated location absent");
          await writeClinic(trx, location.targetScope, clinic, actor, importedAt);
        }
        await sql`insert into tenant_config_imports (target_tenant_id, archive_id, manifest_digest, receipt, source_history)
          values (${targetTenantId}, ${data.archiveId}, ${data.manifestDigest},
          ${JSON.stringify(staged.receipt)}::jsonb, ${JSON.stringify(data)}::jsonb)`.execute(trx);
        return ok(staged.receipt);
      });
    } catch { return err({ kind: "storageFailure" }); }
  }
}
