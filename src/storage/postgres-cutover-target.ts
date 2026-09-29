import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { LocationScope } from "../core/model.ts";
import type { TenantConfigArchiveData } from "../portability/config-archive.ts";
import { mapConfig } from "../reference/config-archive-import.ts";
import type { ReferenceTenantImportReport } from "../reference/tenant-config-archive-import.ts";
import type Database from "./generated/Database.ts";

export type TargetImportRow = { archive_id: string; manifest_digest: string; receipt: ReferenceTenantImportReport;
  source_history: TenantConfigArchiveData };

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

export function receiptMatches(row: TargetImportRow | undefined, data: TenantConfigArchiveData): boolean {
  return !!row && row.archive_id === data.archiveId && row.manifest_digest === data.manifestDigest &&
    row.receipt.status === "staged" && row.receipt.sourceTenantId === data.sourceTenantId &&
    row.receipt.targetTenantId === data.targetTenantId && row.receipt.sourceFenceVersion === data.sourceFenceVersion &&
    row.receipt.locations.length === data.locations.length && isDeepStrictEqual(row.source_history, data);
}

type PolicyRow = { version: number; policy: unknown; changed_by: string | null;
  previous_booking_enabled: boolean | null; changed_at: Date | null };
type AutomationRow = { version: number; enabled: boolean; changed_by: string | null;
  previous_enabled: boolean | null; changed_at: Date | null };
type KnowledgeRow = { source_ref: string; version: number; status: string; owner_ref: string;
  answer_text: string; effective_from: Date; effective_until: Date; actor_ref: string; changed_at: Date };
type KnowledgeHead = { source_ref: string; version: number; effective_version: number | null };

function sameInstant(actual: Date | null, expected: string | null): boolean {
  return expected === null ? actual === null : actual instanceof Date && actual.toISOString() === expected;
}

function importActor(archiveId: string): string {
  return `import:${createHash("sha256").update(archiveId).digest("hex").slice(0, 32)}`;
}

/** Reconciles native target rows against the durable import, under the target tenant lock. */
export async function targetReady(trx: Transaction<Database>, data: TenantConfigArchiveData,
                                  registry: TargetImportRow): Promise<boolean> {
  if (!receiptMatches(registry, data)) return false;
  const activity = await sql<{ calls: boolean; pending: boolean }>`select
    exists(select 1 from calls where tenant_id = ${data.targetTenantId}) as calls,
    exists(select 1 from pending_location_calls where tenant_id = ${data.targetTenantId}) as pending`.execute(trx);
  if (!activity.rows[0] || activity.rows[0].calls || activity.rows[0].pending) return false;
  const actor = importActor(data.archiveId);
  const mappedRefs = { mapRef: (kind: string, sourceRef: string, sourceScope: LocationScope, targetScope: LocationScope) => {
    const decisions = registry.receipt.mappings.filter(item => item.kind === kind && item.sourceRef === sourceRef &&
      sameScope(item.sourceScope, sourceScope) && sameScope(item.targetScope, targetScope));
    return decisions.length === 1 ? decisions[0]!.targetRef : null;
  } };
  for (const location of data.locations) {
    const clinic = data.clinics.find(item => item.sourceClinicId === location.sourceScope.clinicId);
    if (!clinic) return false;
    const mapped = mapConfig({ sourceScope: location.sourceScope, policies: location.policies,
      automation: clinic.automation, knowledge: location.knowledge }, location.targetScope, mappedRefs);
    if (!mapped.ok) return false;
    const expectedRows = mapped.value.policyRows.length ? mapped.value.policyRows : [
      { version: 0, isHead: true, policy: mapped.value.policy, changedBy: null,
        previousBookingEnabled: null, changedAt: null }];
    const actualPolicies = (await sql<PolicyRow>`select version, policy, changed_by, previous_booking_enabled, changed_at
      from clinic_settings where tenant_id = ${data.targetTenantId} and clinic_id = ${location.targetScope.clinicId}
      and location_id = ${location.targetScope.locationId} order by version`.execute(trx)).rows;
    const head = expectedRows.find(row => row.isHead)!;
    if (actualPolicies.length !== expectedRows.length + Number(head.policy.bookingEnabled)) return false;
    for (const [index, expected] of expectedRows.entries()) {
      const actual = actualPolicies[index];
      if (!actual || actual.version !== expected.version || !isDeepStrictEqual(actual.policy, expected.policy) ||
          actual.changed_by !== expected.changedBy ||
          actual.previous_booking_enabled !== expected.previousBookingEnabled ||
          !sameInstant(actual.changed_at, expected.changedAt)) return false;
    }
    if (head.policy.bookingEnabled) {
      const actual = actualPolicies.at(-1)!;
      const disabled = { ...head.policy, policyVersion: String(head.version + 1), bookingEnabled: false,
        capabilities: { ...head.policy.capabilities, book: "unavailable" } };
      if (actual.version !== head.version + 1 || !isDeepStrictEqual(actual.policy, disabled) ||
          actual.changed_by !== actor || actual.previous_booking_enabled !== true ||
          !(actual.changed_at instanceof Date)) return false;
    }
    const actualKnowledge = (await sql<KnowledgeRow>`select source_ref, version, status, owner_ref, answer_text,
      effective_from, effective_until, actor_ref, changed_at from clinic_knowledge_events
      where tenant_id = ${data.targetTenantId} and clinic_id = ${location.targetScope.clinicId}
      and location_id = ${location.targetScope.locationId} order by source_ref, version`.execute(trx)).rows;
    const expectedKnowledge = new Map(mapped.value.knowledgeEntries.map(entry =>
      [JSON.stringify([entry.sourceRef, Number(entry.version)]), entry] as const));
    if (actualKnowledge.length !== expectedKnowledge.size) return false;
    for (const actual of actualKnowledge) {
      const expected = expectedKnowledge.get(JSON.stringify([actual.source_ref, actual.version]));
      if (!expected ||
          actual.status !== expected.status || actual.owner_ref !== expected.ownerRef ||
          actual.answer_text !== expected.text || actual.actor_ref !== expected.actorRef ||
          !sameInstant(actual.effective_from, expected.effectiveFrom) ||
          !sameInstant(actual.effective_until, expected.effectiveUntil) ||
          !sameInstant(actual.changed_at, expected.changedAt)) return false;
    }
    const heads = (await sql<KnowledgeHead>`select source_ref, version, effective_version from clinic_knowledge_heads
      where tenant_id = ${data.targetTenantId} and clinic_id = ${location.targetScope.clinicId}
      and location_id = ${location.targetScope.locationId} order by source_ref`.execute(trx)).rows;
    const sourceHeads = new Map<string, typeof mapped.value.knowledgeEntries[number]>();
    for (const entry of mapped.value.knowledgeEntries) {
      const current = sourceHeads.get(entry.sourceRef);
      if (!current || Number(entry.version) > Number(current.version)) sourceHeads.set(entry.sourceRef, entry);
    }
    if (heads.length !== sourceHeads.size) return false;
    for (const actual of heads) {
      const latest = sourceHeads.get(actual.source_ref);
      if (!latest || actual.version !== Number(latest.version) ||
          actual.effective_version !== (latest.status === "approved" ? Number(latest.version) : null)) return false;
    }
  }
  for (const clinic of data.clinics) {
    const location = data.locations.find(item => item.sourceScope.clinicId === clinic.sourceClinicId);
    if (!location) return false;
    const expectedRows = clinic.automation.length ? clinic.automation : [
      { version: 0, isHead: true, enabled: false, changedBy: null, previousEnabled: null, changedAt: null }];
    const head = expectedRows.find(row => row.isHead)!;
    const actualRows = (await sql<AutomationRow>`select version, enabled, changed_by, previous_enabled, changed_at
      from clinic_automation where tenant_id = ${data.targetTenantId} and clinic_id = ${location.targetScope.clinicId}
      order by version`.execute(trx)).rows;
    if (actualRows.length !== expectedRows.length + Number(head.enabled)) return false;
    for (const [index, expected] of expectedRows.entries()) {
      const actual = actualRows[index];
      if (!actual || actual.version !== expected.version || actual.enabled !== expected.enabled ||
          actual.changed_by !== expected.changedBy || actual.previous_enabled !== expected.previousEnabled ||
          !sameInstant(actual.changed_at, expected.changedAt)) return false;
    }
    if (head.enabled) {
      const actual = actualRows.at(-1)!;
      if (actual.version !== head.version + 1 || actual.enabled || actual.changed_by !== actor ||
          actual.previous_enabled !== true || !(actual.changed_at instanceof Date)) return false;
    }
    const stop = (await sql<{ version: number; stopped: boolean; actor_ref: string }>`select version, stopped, actor_ref
      from clinic_write_stop where tenant_id = ${data.targetTenantId} and clinic_id = ${location.targetScope.clinicId}`.execute(trx)).rows[0];
    if (!stop || stop.version !== 1 || !stop.stopped || stop.actor_ref !== actor) return false;
  }
  return true;
}
