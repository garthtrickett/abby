import { validFinancialEffectHistory } from "../portability/financial-effect-history.ts";
import { writeFinancialEffectCarryover, reconcileFinancialEffectCarryover } from "./postgres-financial-effect-carryover.ts";
import { writeConfirmationResendCarryover, reconcileConfirmationResendCarryover } from "./postgres-confirmation-resend-carryover.ts";
import { validConfirmationResendArchiveHistory } from "../portability/confirmation-resend-history.ts";
import { validPatientCorrectionArchiveHistory } from "../portability/patient-correction-history.ts";
import { writePatientCorrectionCarryover } from "./postgres-patient-correction-carryover.ts";
import { validVoiceArchiveHistory } from "../portability/voice-history.ts";
import { writeVoiceCarryover } from "./postgres-voice-carryover.ts";
import { validClinicIntakeArchiveHistory } from "../portability/clinic-intake-history.ts";
import { validNotificationArchiveHistory } from "../portability/notification-history.ts";
import { writeNotificationCarryover } from "./postgres-notification-carryover.ts";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";
import { err, ok } from "../core/model.ts";
import type { CallPolicy, LocationScope, Result } from "../core/model.ts";
import type { ArchiveEnvelope } from "../portability/archive-envelope.ts";
import { decodeTenantConfigArchive } from "../portability/config-archive.ts";
import type { ConfigArchiveData, TenantConfigArchiveData } from "../portability/config-archive.ts";
import { mapConfig } from "../reference/config-archive-import.ts";
import type { ReferenceImportMapper } from "../reference/config-archive-import.ts";
import { ReferenceTenantConfigArchiveImporter } from "../reference/tenant-config-archive-import.ts";
import type { ReferenceTenantImportAuthority, ReferenceTenantImportFailure, ReferenceTenantImportReport,
  StagedReferenceTenantConfiguration } from "../reference/tenant-config-archive-import.ts";
import type Database from "./generated/Database.ts";

export type PostgresTenantImportFailure = ReferenceTenantImportFailure | Readonly<{ kind: "storageFailure" }>;
type ImportMode = "standaloneMinimal" | "unsafeReference";
type RegistryRow = { archive_id: string; manifest_digest: string; receipt: ReferenceTenantImportReport;
  source_history: TenantConfigArchiveData };

function minimalHistory(data: TenantConfigArchiveData): boolean {
  return Array.isArray(data?.clinics) && data.clinics.every(clinic => validClinicIntakeArchiveHistory(clinic.clinicIntake) && validPatientCorrectionArchiveHistory(clinic.clinicPatientCorrections) && validNotificationArchiveHistory(clinic.clinicNotifications) && validVoiceArchiveHistory(clinic.clinicVoice)) &&
    Array.isArray(data?.locations) && data.locations.length > 0 && data.locations.every(location =>
    validConfirmationResendArchiveHistory(location.confirmationResends) && validFinancialEffectHistory(location.financialEffects) &&
    Array.isArray(location.policies) && location.policies.length > 0 &&
    location.policies.every((row: ConfigArchiveData["policies"][number]) => row.storageShape === "standaloneMinimal") &&
    Array.isArray(location.knowledge) && location.knowledge.length === 0);
}

function storedPolicy(scope: LocationScope, version: number, policy: CallPolicy):
  Readonly<{ scope: LocationScope; policyVersion: string; bookingEnabled: boolean; cancellationEnabled: boolean; reschedulingEnabled: boolean;
    afterHoursMode: NonNullable<CallPolicy["afterHoursMode"]>; afterHoursInfo?: NonNullable<CallPolicy["afterHoursInfo"]>;
    urgentResponse?: NonNullable<CallPolicy["urgentResponse"]>;
    staffSchedule?: NonNullable<CallPolicy["staffSchedule"]>;
    transferDestinationRef?: string;
    greeting: NonNullable<CallPolicy["greeting"]> | null }> {
  return { scope: { ...scope }, policyVersion: String(version), bookingEnabled: policy.bookingEnabled,
    cancellationEnabled: policy.cancellationEnabled ?? false, reschedulingEnabled: policy.reschedulingEnabled ?? false,
    afterHoursMode: policy.afterHoursMode ?? "staffRequest",
    ...(policy.afterHoursInfo ? { afterHoursInfo: policy.afterHoursInfo } : {}),
    ...(policy.urgentResponse ? { urgentResponse: policy.urgentResponse } : {}),
    ...(policy.staffSchedule ? { staffSchedule: policy.staffSchedule } : {}),
    ...(policy.transferDestinationRef === undefined ? {} : { transferDestinationRef: policy.transferDestinationRef }),
    greeting: policy.greeting ?? null };
}

/** Public route refs require reviewed host mapping even when patient work is unavailable. */
function minimalMapper(mapper: ReferenceImportMapper): ReferenceImportMapper {
  return { mapRef: (kind, ref, source, target) => kind === "transferDestination" ? mapper.mapRef(kind, ref, source, target) : "disabled" };
}

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
    exists(select 1 from confirmation_resend_journal where tenant_id = ${tenantId}) or
    exists(select 1 from financial_effect_barriers where tenant_id = ${tenantId}) or
    exists(select 1 from clinic_settings where tenant_id = ${tenantId}) or
    exists(select 1 from clinic_automation where tenant_id = ${tenantId}) or
    exists(select 1 from clinic_intake_settings where tenant_id = ${tenantId}) or
    exists(select 1 from clinic_patient_correction_settings where tenant_id = ${tenantId}) or
    exists(select 1 from clinic_notification_settings where tenant_id = ${tenantId}) or
    exists(select 1 from clinic_voice_settings where tenant_id = ${tenantId}) or
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
                             actorRef: string, importedAt: string, mode: ImportMode): Promise<void> {
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
    const value = mode === "standaloneMinimal" ? storedPolicy(scope, row.version, row.policy) : row.policy;
    await sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy,
      setting_kind, previous_after_hours_mode, previous_cancellation_enabled, previous_rescheduling_enabled, previous_staffed_destination_ref, changed_by, previous_booking_enabled, changed_at) values
      (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, ${row.version},
       ${JSON.stringify(value)}::jsonb, ${row.settingKind ?? "booking"}, ${row.previousAfterHoursMode ?? null}, ${row.previousCancellationEnabled ?? null}, ${row.previousReschedulingEnabled ?? null},
       ${row.previousStaffedDestinationRef ?? null}, ${row.changedBy}, ${row.previousBookingEnabled},
       ${row.changedAt}::timestamptz)`.execute(trx);
  }
  const head = policyRows.find(row => row.isHead)!;
  let current = head.policy;
  let currentVersion = head.version;
  if (head.policy.bookingEnabled) {
    const next = mode === "standaloneMinimal" ? storedPolicy(scope, head.version + 1,
      { ...head.policy, bookingEnabled: false }) :
      { ...head.policy, policyVersion: String(head.version + 1), bookingEnabled: false,
        capabilities: { ...head.policy.capabilities, book: "unavailable" as const } };
    await sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy,
      changed_by, previous_booking_enabled, changed_at) values
      (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, ${head.version + 1},
       ${JSON.stringify(next)}::jsonb, ${actorRef}, true, ${importedAt}::timestamptz)`.execute(trx);
    current = { ...head.policy, policyVersion: String(head.version + 1), bookingEnabled: false,
      capabilities: { ...head.policy.capabilities, book: "unavailable" } };
    currentVersion += 1;
  }
  if (current.cancellationEnabled === true) {
    const disabled: CallPolicy = { ...current, policyVersion: String(currentVersion + 1), cancellationEnabled: false,
      capabilities: { ...current.capabilities, cancel: "unavailable" } };
    const value = mode === "standaloneMinimal" ? storedPolicy(scope, currentVersion + 1, disabled) : disabled;
    await sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy,
      setting_kind, changed_by, previous_cancellation_enabled, changed_at) values
      (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, ${currentVersion + 1},
       ${JSON.stringify(value)}::jsonb, 'cancellation', ${actorRef}, true, ${importedAt}::timestamptz)`.execute(trx);
    current = disabled;
    currentVersion += 1;
  }
  if (current.reschedulingEnabled === true) {
    const disabled: CallPolicy = { ...current, policyVersion: String(currentVersion + 1), reschedulingEnabled: false,
      capabilities: { ...current.capabilities, reschedule: "unavailable" } };
    const value = mode === "standaloneMinimal" ? storedPolicy(scope, currentVersion + 1, disabled) : disabled;
    await sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy,
      setting_kind, changed_by, previous_rescheduling_enabled, changed_at) values
      (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, ${currentVersion + 1},
       ${JSON.stringify(value)}::jsonb, 'rescheduling', ${actorRef}, true, ${importedAt}::timestamptz)`.execute(trx);
    current = disabled;
    currentVersion += 1;
  }
  if (mode === "standaloneMinimal" && mapped.value.knowledgeEntries.length) throw new Error("minimal import contains knowledge");
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
                           clinic: TenantConfigArchiveData["clinics"][number], actorRef: string, importedAt: string,
                           mode: ImportMode): Promise<void> {
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
  const intake = clinic.clinicIntake?.length ? clinic.clinicIntake : [
    { version: 0, isHead: true, enabled: false, changedBy: null, previousEnabled: null, changedAt: null }];
  for (const row of intake) {
    await sql`insert into clinic_intake_settings (tenant_id, clinic_id, version, enabled,
      changed_by, previous_enabled, changed_at) values
      (${scope.tenantId}, ${scope.clinicId}, ${row.version}, ${row.enabled},
       ${row.changedBy}, ${row.previousEnabled}, ${row.changedAt}::timestamptz)`.execute(trx);
  }
  const intakeHead = intake.find(row => row.isHead)!;
  if (intakeHead.enabled) {
    await sql`insert into clinic_intake_settings (tenant_id, clinic_id, version, enabled,
      changed_by, previous_enabled, changed_at) values
      (${scope.tenantId}, ${scope.clinicId}, ${intakeHead.version + 1}, false,
       ${actorRef}, true, ${importedAt}::timestamptz)`.execute(trx);
  }
  const reason = mode === "standaloneMinimal" ? "cutover" : "Imported configuration awaiting target readiness";
  await writePatientCorrectionCarryover(trx, scope, clinic.clinicPatientCorrections, actorRef, importedAt);
  await writeNotificationCarryover(trx, scope, clinic.clinicNotifications, actorRef, importedAt);
  await writeVoiceCarryover(trx, { tenantId: scope.tenantId, clinicId: scope.clinicId }, clinic.clinicVoice, actorRef, importedAt);
  await sql`insert into clinic_write_stop (tenant_id, clinic_id, version, stopped, actor_ref, reason, changed_at)
    values (${scope.tenantId}, ${scope.clinicId}, 1, true, ${actorRef}, ${reason}, ${importedAt}::timestamptz)`.execute(trx);
  await sql`insert into clinic_write_stop_events (tenant_id, clinic_id, version, stopped, actor_ref, reason, changed_at)
    values (${scope.tenantId}, ${scope.clinicId}, 1, true, ${actorRef}, ${reason}, ${importedAt}::timestamptz)`.execute(trx);
}

/** Persists a validated configuration-only import and its source history as one tenant transaction. */
export class PostgresTenantConfigArchiveImporter {
  private readonly db: Kysely<Database>;
  private readonly clock: () => string;
  private readonly mode: ImportMode;
  constructor(db: Kysely<Database>, clock: () => string = () => new Date().toISOString(),
              mode: ImportMode = "standaloneMinimal") {
    this.db = db;
    this.clock = clock;
    this.mode = mode;
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
      if (row && this.mode === "standaloneMinimal" && !minimalHistory(row.source_history)) return err({ kind: "storageFailure" });
      return ok(row ? { receipt: row.receipt, sourceHistory: row.source_history } : null);
    } catch { return err({ kind: "storageFailure" }); }
  }

  async preflight(input: ArchiveEnvelope, targetTenantId: string, actorRef: string,
                  authority: ReferenceTenantImportAuthority, mapper: ReferenceImportMapper):
    Promise<Result<ReferenceTenantImportReport, PostgresTenantImportFailure>> {
    const validated = await new ReferenceTenantConfigArchiveImporter().preflight(input, targetTenantId,
      actorRef, authority, this.mode === "standaloneMinimal" ? minimalMapper(mapper) : mapper);
    if (!validated.ok) return validated;
    if (this.mode === "standaloneMinimal") {
      const decoded = await decodeTenantConfigArchive(input, targetTenantId);
      if (!decoded.ok) return decoded;
      if (decoded.value.manifestDigest !== validated.value.manifestDigest || !minimalHistory(decoded.value)) {
        return err({ kind: "invalidConfigArchive", section: "settings" });
      }
    }
    try {
      const row = await existing(this.db, targetTenantId);
      if (row && this.mode === "standaloneMinimal" && !minimalHistory(row.source_history)) return err({ kind: "storageFailure" });
      if (row && row.archive_id === validated.value.archiveId && row.manifest_digest === validated.value.manifestDigest &&
          (!await reconcileConfirmationResendCarryover(this.db, row.source_history) || !await reconcileFinancialEffectCarryover(this.db, row.source_history))) return err({ kind: "storageFailure" });
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
      actorRef, authority, this.mode === "standaloneMinimal" ? minimalMapper(mapper) : mapper);
    if (!validated.ok) return validated;
    const staged = validated.value;
    const data = staged.sourceHistory;
    if (this.mode === "standaloneMinimal" && !minimalHistory(data)) return err({ kind: "invalidConfigArchive", section: "settings" });
    try {
      return await this.db.transaction().setIsolationLevel("read committed").execute(async trx => {
        await sql`select pg_advisory_xact_lock(172934501, hashtext(${targetTenantId}))`.execute(trx);
        const row = await existing(trx, targetTenantId);
        if (row && this.mode === "standaloneMinimal" && !minimalHistory(row.source_history)) return err({ kind: "storageFailure" });
        if (row && row.archive_id === data.archiveId && row.manifest_digest === data.manifestDigest &&
            (!await reconcileConfirmationResendCarryover(trx, row.source_history) || !await reconcileFinancialEffectCarryover(trx, row.source_history))) return err({ kind: "storageFailure" });
        if (row) return row.archive_id === data.archiveId && row.manifest_digest === data.manifestDigest
          ? ok(row.receipt)
          : err({ kind: row.archive_id === data.archiveId ? "archiveConflict" : "targetOccupied" });
        if (await occupied(trx, targetTenantId)) return err({ kind: "targetOccupied" });
        const actor = importActor(data.archiveId);
        const mapperFromReceipt = replayMapper(staged);
        for (const location of data.locations) {
          const clinic = data.clinics.find(item => item.sourceClinicId === location.sourceScope.clinicId);
          if (!clinic) throw new Error("validated clinic absent");
          await writeLocation(trx, location, clinic, mapperFromReceipt, actor, importedAt, this.mode);
          await writeConfirmationResendCarryover(trx, location.targetScope, location.confirmationResends);
          await writeFinancialEffectCarryover(trx, location.targetScope, location.financialEffects);
        }
        for (const clinic of data.clinics) {
          const location = data.locations.find(item => item.sourceScope.clinicId === clinic.sourceClinicId);
          if (!location) throw new Error("validated location absent");
          await writeClinic(trx, location.targetScope, clinic, actor, importedAt, this.mode);
        }
        await sql`insert into tenant_config_imports (target_tenant_id, archive_id, manifest_digest, receipt, source_history)
          values (${targetTenantId}, ${data.archiveId}, ${data.manifestDigest},
          ${JSON.stringify(staged.receipt)}::jsonb, ${JSON.stringify(data)}::jsonb)`.execute(trx);
        return ok(staged.receipt);
      });
    } catch { return err({ kind: "storageFailure" }); }
  }
}
