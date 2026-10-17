import { reconcileOutboundEffectCarryover } from "./postgres-outbound-effect-carryover.ts";
import { storedStandalonePolicy } from "./standalone-policy-record.ts";
import { reconcileFinancialEffectCarryover } from "./postgres-financial-effect-carryover.ts";
import { reconcileConfirmationResendCarryover } from "./postgres-confirmation-resend-carryover.ts";
import { reconcilePatientCorrectionCarryover } from "./postgres-patient-correction-carryover.ts";
import { reconcileVoiceCarryover } from "./postgres-voice-carryover.ts";
import { createHash } from "node:crypto";
import { reconcileNotificationCarryover } from "./postgres-notification-carryover.ts";
import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { CallPolicy, LocationScope } from "../core/model.ts";
import { ARCHIVE_SECTIONS } from "../portability/archive-envelope.ts";
import type { TenantConfigArchiveData } from "../portability/config-archive.ts";
import { mapConfig } from "../reference/config-archive-import.ts";
import type { ReferenceTenantImportReport } from "../reference/tenant-config-archive-import.ts";
import type Database from "./generated/Database.ts";

export type TargetImportRow = { archive_id: string; manifest_digest: string; receipt: ReferenceTenantImportReport;
  source_history: TenantConfigArchiveData };

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return !!left && !!right && left.tenantId === right.tenantId &&
    left.clinicId === right.clinicId && left.locationId === right.locationId;
}

export function receiptMatches(row: TargetImportRow | undefined, data: TenantConfigArchiveData): boolean {
  if (!row || !row.receipt || typeof row.receipt !== "object" || !data ||
      !data.sectionManifests || !Array.isArray(data.locations) ||
      row.archive_id !== data.archiveId ||
      row.manifest_digest !== data.manifestDigest || !isDeepStrictEqual(row.source_history, data)) return false;
  const receipt = row.receipt;
  if (receipt.status !== "staged" || receipt.archiveId !== data.archiveId ||
      receipt.manifestDigest !== data.manifestDigest || receipt.sourceTenantId !== data.sourceTenantId ||
      receipt.targetTenantId !== data.targetTenantId || receipt.sourceSchemaVersion !== data.sourceSchemaVersion ||
      receipt.sourceFenceVersion !== data.sourceFenceVersion ||
      typeof receipt.auditRef !== "string" || !receipt.auditRef.trim() ||
      receipt.bookingEnabled !== false || receipt.automationEnabled !== false || receipt.writesStopped !== true ||
      !isDeepStrictEqual(receipt.omittedCalls, data.omittedCalls) ||
      !receipt.recordCounts || !receipt.sectionDigests ||
      Object.keys(receipt.recordCounts).length !== ARCHIVE_SECTIONS.length ||
      Object.keys(receipt.sectionDigests).length !== ARCHIVE_SECTIONS.length ||
      !Array.isArray(receipt.locations) || receipt.locations.length !== data.locations.length) return false;
  for (const section of ARCHIVE_SECTIONS) {
    const manifest = data.sectionManifests[section];
    if (!manifest || receipt.recordCounts[section] !== manifest.recordCount ||
        receipt.sectionDigests[section] !== manifest.sha256) return false;
  }
  return data.locations.every((location, index) => {
    const reported = receipt.locations[index];
    return !!reported && sameScope(reported.sourceScope, location.sourceScope) &&
      sameScope(reported.targetScope, location.targetScope) &&
      reported.policyVersions === location.policies.length &&
      reported.publishedKnowledgeVersions === location.knowledge.length &&
      reported.omittedTextCalls === location.omittedTextCalls;
  });
}

type PolicyRow = { version: number; policy: unknown; setting_kind: string;
  previous_cancellation_enabled: boolean | null;
  previous_rescheduling_enabled: boolean | null;
  previous_staffed_destination_ref: string | null;
  previous_after_hours_mode: string | null; changed_by: string | null;
  previous_booking_enabled: boolean | null; changed_at: Date | null };
type AutomationRow = { version: number; enabled: boolean; changed_by: string | null;
  previous_enabled: boolean | null; changed_at: Date | null };

function samePolicy(actual: unknown, expected: CallPolicy, sourceMinimal = false): boolean {
  // A verified minimal source may be stored by a standalone target without the
  // reference host's synthetic capabilities. Match its exact existing storage
  // projection; extra fields and unapproved values still fail. Preserve the
  // full representation for an embedded target importing that same source.
  if (sourceMinimal && isDeepStrictEqual(actual, storedStandalonePolicy(expected.scope, Number(expected.policyVersion), expected))) return true;
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const policy = actual as Record<string, unknown>;
  if (policy.cancellationEnabled !== undefined && typeof policy.cancellationEnabled !== "boolean") return false;
  if (policy.reschedulingEnabled !== undefined && typeof policy.reschedulingEnabled !== "boolean") return false;
  return isDeepStrictEqual({ ...policy, cancellationEnabled: policy.cancellationEnabled ?? false, reschedulingEnabled: policy.reschedulingEnabled ?? false },
    { ...expected, cancellationEnabled: expected.cancellationEnabled ?? false, reschedulingEnabled: expected.reschedulingEnabled ?? false });
}
type KnowledgeRow = { source_ref: string; version: number; status: string; owner_ref: string;
  answer_text: string; effective_from: Date; effective_until: Date; actor_ref: string; changed_at: Date };
type KnowledgeHead = { source_ref: string; version: number; effective_version: number | null };
type TargetTotals = { policies: string; automation: string; clinicIntake: string; clinicPatientCorrections: string; clinicNotifications: string; clinicVoice: string; knowledgeEvents: string;
  knowledgeHeads: string; writeStops: string; writeStopEvents: string };

function sameInstant(actual: Date | null, expected: string | null): boolean {
  return expected === null ? actual === null : actual instanceof Date && actual.toISOString() === expected;
}

function importActor(archiveId: string): string {
  return `import:${createHash("sha256").update(archiveId).digest("hex").slice(0, 32)}`;
}

/** Reconciles native target rows against the durable import, under the target tenant lock. */
export async function targetReady(trx: Transaction<Database>, data: TenantConfigArchiveData,
                                  registry: TargetImportRow): Promise<boolean> {
  if (!receiptMatches(registry, data) || !await reconcileConfirmationResendCarryover(trx, data) || !await reconcileFinancialEffectCarryover(trx, data) || !await reconcileOutboundEffectCarryover(trx, data)) return false;
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
  const expectedTotals = { policies: 0, automation: 0, clinicIntake: 0, clinicPatientCorrections: 0, clinicNotifications: 0, clinicVoice: 0, knowledgeEvents: 0, knowledgeHeads: 0,
    writeStops: 0, writeStopEvents: 0 };
  for (const location of data.locations) {
    const clinic = data.clinics.find(item => item.sourceClinicId === location.sourceScope.clinicId);
    if (!clinic) return false;
    const mapped = mapConfig({ sourceScope: location.sourceScope, policies: location.policies,
      automation: clinic.automation, knowledge: location.knowledge }, location.targetScope, mappedRefs);
    if (!mapped.ok) return false;
    const expectedRows = mapped.value.policyRows.length ? mapped.value.policyRows : [
      { version: 0, isHead: true, storageShape: "unsafeReference" as const, policy: mapped.value.policy, changedBy: null,
        previousBookingEnabled: null, changedAt: null }];
    const actualPolicies = (await sql<PolicyRow>`select version, policy, setting_kind,
      previous_after_hours_mode, previous_cancellation_enabled, previous_rescheduling_enabled, previous_staffed_destination_ref, changed_by, previous_booking_enabled, changed_at
      from clinic_settings where tenant_id = ${data.targetTenantId} and clinic_id = ${location.targetScope.clinicId}
      and location_id = ${location.targetScope.locationId} order by version`.execute(trx)).rows;
    const head = expectedRows.find(row => row.isHead)!;
    if (actualPolicies.length !== expectedRows.length + Number(head.policy.bookingEnabled) +
        Number(head.policy.cancellationEnabled === true) + Number(head.policy.reschedulingEnabled === true)) return false;
    expectedTotals.policies += actualPolicies.length;
    for (const [index, expected] of expectedRows.entries()) {
      const actual = actualPolicies[index];
      if (!actual || actual.version !== expected.version || !samePolicy(actual.policy, expected.policy, expected.storageShape === "standaloneMinimal") ||
          actual.setting_kind !== (expected.settingKind ?? "booking") ||
          actual.previous_after_hours_mode !== (expected.previousAfterHoursMode ?? null) ||
          actual.previous_cancellation_enabled !== (expected.previousCancellationEnabled ?? null) ||
          actual.previous_rescheduling_enabled !== (expected.previousReschedulingEnabled ?? null) ||
          actual.previous_staffed_destination_ref !== (expected.previousStaffedDestinationRef ?? null) ||
          actual.changed_by !== expected.changedBy ||
          actual.previous_booking_enabled !== expected.previousBookingEnabled ||
          !sameInstant(actual.changed_at, expected.changedAt)) return false;
    }
    let current = head.policy;
    let version = head.version;
    let extraIndex = expectedRows.length;
    if (current.bookingEnabled) {
      const actual = actualPolicies[extraIndex++]!;
      const disabled: CallPolicy = { ...current, policyVersion: String(++version), bookingEnabled: false,
        capabilities: { ...current.capabilities, book: "unavailable" } };
      if (actual.version !== version || !samePolicy(actual.policy, disabled, head.storageShape === "standaloneMinimal") ||
          actual.setting_kind !== "booking" || actual.previous_after_hours_mode !== null ||
          actual.previous_cancellation_enabled !== null || actual.previous_rescheduling_enabled !== null || actual.previous_staffed_destination_ref !== null ||
          actual.changed_by !== actor || actual.previous_booking_enabled !== true ||
          !(actual.changed_at instanceof Date)) return false;
      current = disabled;
    }
    if (current.cancellationEnabled === true) {
      const actual = actualPolicies[extraIndex++]!;
      const disabled: CallPolicy = { ...current, policyVersion: String(++version), cancellationEnabled: false,
        capabilities: { ...current.capabilities, cancel: "unavailable" } };
      if (actual.version !== version || !samePolicy(actual.policy, disabled, head.storageShape === "standaloneMinimal") ||
          actual.setting_kind !== "cancellation" || actual.previous_after_hours_mode !== null ||
          actual.previous_booking_enabled !== null || actual.previous_cancellation_enabled !== true ||
          actual.previous_rescheduling_enabled !== null || actual.previous_staffed_destination_ref !== null ||
          actual.changed_by !== actor || !(actual.changed_at instanceof Date)) return false;
      current = disabled;
    }
    if (current.reschedulingEnabled === true) {
      const actual = actualPolicies[extraIndex++]!;
      const disabled: CallPolicy = { ...current, policyVersion: String(++version), reschedulingEnabled: false,
        capabilities: { ...current.capabilities, reschedule: "unavailable" } };
      if (actual.version !== version || !samePolicy(actual.policy, disabled, head.storageShape === "standaloneMinimal") ||
          actual.setting_kind !== "rescheduling" || actual.previous_after_hours_mode !== null ||
          actual.previous_booking_enabled !== null || actual.previous_rescheduling_enabled !== true ||
          actual.previous_cancellation_enabled !== null || actual.previous_staffed_destination_ref !== null ||
          actual.changed_by !== actor || !(actual.changed_at instanceof Date)) return false;
      current = disabled;
    }
    const actualKnowledge = (await sql<KnowledgeRow>`select source_ref, version, status, owner_ref, answer_text,
      effective_from, effective_until, actor_ref, changed_at from clinic_knowledge_events
      where tenant_id = ${data.targetTenantId} and clinic_id = ${location.targetScope.clinicId}
      and location_id = ${location.targetScope.locationId} order by source_ref, version`.execute(trx)).rows;
    const expectedKnowledge = new Map(mapped.value.knowledgeEntries.map(entry =>
      [JSON.stringify([entry.sourceRef, Number(entry.version)]), entry] as const));
    if (actualKnowledge.length !== expectedKnowledge.size) return false;
    expectedTotals.knowledgeEvents += actualKnowledge.length;
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
    expectedTotals.knowledgeHeads += heads.length;
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
    expectedTotals.automation += actualRows.length;
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
    const expectedIntake = clinic.clinicIntake?.length ? clinic.clinicIntake : [
      { version: 0, isHead: true, enabled: false, changedBy: null, previousEnabled: null, changedAt: null }];
    const intakeHead = expectedIntake.find(row => row.isHead)!;
    const actualIntake = (await sql<AutomationRow>`select version, enabled, changed_by, previous_enabled, changed_at
      from clinic_intake_settings where tenant_id = ${data.targetTenantId} and clinic_id = ${location.targetScope.clinicId}
      order by version`.execute(trx)).rows;
    if (actualIntake.length !== expectedIntake.length + Number(intakeHead.enabled)) return false;
    expectedTotals.clinicIntake += actualIntake.length;
    for (const [index, expected] of expectedIntake.entries()) {
      const actual = actualIntake[index];
      if (!actual || actual.version !== expected.version || actual.enabled !== expected.enabled ||
          actual.changed_by !== expected.changedBy || actual.previous_enabled !== expected.previousEnabled ||
          !sameInstant(actual.changed_at, expected.changedAt)) return false;
    }
    if (intakeHead.enabled) {
      const actual = actualIntake.at(-1)!;
      if (actual.version !== intakeHead.version + 1 || actual.enabled || actual.changed_by !== actor ||
          actual.previous_enabled !== true || !(actual.changed_at instanceof Date) ||
          !Number.isFinite(actual.changed_at.getTime())) return false;
    }
    const stop = (await sql<{ version: number; stopped: boolean; actor_ref: string; reason: string;
      changed_at: Date }>`select version, stopped, actor_ref, reason, changed_at
      from clinic_write_stop where tenant_id = ${data.targetTenantId} and clinic_id = ${location.targetScope.clinicId}`.execute(trx)).rows[0];
    if (!stop || stop.version !== 1 || !stop.stopped || stop.actor_ref !== actor ||
        !["cutover", "Imported configuration awaiting target readiness"].includes(stop.reason) ||
        !(stop.changed_at instanceof Date) || !Number.isFinite(stop.changed_at.getTime())) return false;
    const correctionRows = await reconcilePatientCorrectionCarryover(trx, location.targetScope, clinic.clinicPatientCorrections,
      actor, stop.changed_at.toISOString());
    if (correctionRows === undefined) return false;
    expectedTotals.clinicPatientCorrections += correctionRows;
    const notificationRows = await reconcileNotificationCarryover(trx, location.targetScope, clinic.clinicNotifications,
      actor, stop.changed_at.toISOString());
    if (notificationRows === undefined) return false;
    expectedTotals.clinicNotifications += notificationRows;
    const voiceRows = await reconcileVoiceCarryover(trx, { tenantId: location.targetScope.tenantId, clinicId: location.targetScope.clinicId },
      clinic.clinicVoice, actor, new Date(stop.changed_at).toISOString());
    if (voiceRows === undefined) return false;
    expectedTotals.clinicVoice += voiceRows;
    expectedTotals.writeStops += 1;
    const stopEvents = (await sql<{ version: number; stopped: boolean; actor_ref: string; reason: string;
      changed_at: Date }>`select version, stopped, actor_ref, reason, changed_at
      from clinic_write_stop_events where tenant_id = ${data.targetTenantId}
      and clinic_id = ${location.targetScope.clinicId} order by version`.execute(trx)).rows;
    if (stopEvents.length !== 1 || stopEvents[0]!.version !== stop.version ||
        stopEvents[0]!.stopped !== stop.stopped || stopEvents[0]!.actor_ref !== stop.actor_ref ||
        stopEvents[0]!.reason !== stop.reason ||
        !sameInstant(stopEvents[0]!.changed_at, stop.changed_at.toISOString())) return false;
    expectedTotals.writeStopEvents += 1;
  }
  // Scope-level checks above cannot see rows added under an unlisted target clinic or location.
  // Count the entire tenant before number publication so those rows cannot escape reconciliation.
  const totals = (await sql<TargetTotals>`select
    (select count(*)::text from clinic_settings where tenant_id = ${data.targetTenantId}) as policies,
    (select count(*)::text from clinic_automation where tenant_id = ${data.targetTenantId}) as automation,
    (select count(*)::text from clinic_intake_settings where tenant_id = ${data.targetTenantId}) as "clinicIntake",
    (select count(*)::text from clinic_patient_correction_settings where tenant_id = ${data.targetTenantId}) as "clinicPatientCorrections",
    (select count(*)::text from clinic_notification_settings where tenant_id = ${data.targetTenantId}) as "clinicNotifications",
    (select count(*)::text from clinic_voice_settings where tenant_id = ${data.targetTenantId}) as "clinicVoice",
    (select count(*)::text from clinic_knowledge_events where tenant_id = ${data.targetTenantId}) as "knowledgeEvents",
    (select count(*)::text from clinic_knowledge_heads where tenant_id = ${data.targetTenantId}) as "knowledgeHeads",
    (select count(*)::text from clinic_write_stop where tenant_id = ${data.targetTenantId}) as "writeStops",
    (select count(*)::text from clinic_write_stop_events where tenant_id = ${data.targetTenantId}) as "writeStopEvents"`.execute(trx)).rows[0];
  return !!totals && (Object.keys(expectedTotals) as (keyof TargetTotals)[]).every(key =>
    totals[key] === String(expectedTotals[key]));
}
