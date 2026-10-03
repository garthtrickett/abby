import { readVoiceCarryover } from "./postgres-voice-carryover.ts";
import { validClinicIntakeArchiveHistory } from "../portability/clinic-intake-history.ts";
import { readNotificationCarryover } from "./postgres-notification-carryover.ts";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result, StaffDestination } from "../core/model.ts";
import { validAfterHoursSetting } from "../core/after-hours-policy.ts";
import { validGreetingShape } from "../core/greeting.ts";
import { validUrgentResponseShape } from "../core/urgent-response.ts";
import { validApprovedStaffSchedule } from "../core/staff-schedule.ts";
import { ARCHIVE_SECTIONS } from "../portability/archive-envelope.ts";
import type { ArchiveEnvelope, ArchiveSection } from "../portability/archive-envelope.ts";
import type Database from "./generated/Database.ts";
import { validWriteStopReason } from "./operational-reasons.ts";
import { scanPortableTextCalls } from "./portable-text-call-scan.ts";

export type ConfigArchiveRequest = Readonly<{
  scope: LocationScope;
  targetScope: LocationScope;
  timeZone: string;
  mappingProvenance: string;
  archiveId: string;
  actorRef: string;
  createdAt: string;
  /** Rich reference fixtures must opt in; production defaults to the minimal standalone contract. */
  archiveMode?: "standaloneMinimal" | "unsafeReference";
}>;

export type TenantConfigLocationMapping = Readonly<{
  sourceScope: LocationScope;
  targetScope: LocationScope;
  timeZone: string;
  mappingProvenance: string;
}>;

export type TenantConfigArchiveRequest = Readonly<{
  sourceTenantId: string;
  locations: readonly TenantConfigLocationMapping[];
  archiveId: string;
  actorRef: string;
  createdAt: string;
  archiveMode?: "standaloneMinimal" | "unsafeReference";
  /** A final cutover export names the exact frozen source version. */
  expectedFenceVersion?: number;
}>;

export type TenantConfigArchiveAuthority = Readonly<{
  authorizeAndRecord(request: TenantConfigArchiveRequest): Promise<Result<Readonly<{ requestRef: string }>, Readonly<{ kind: "denied" | "auditFailure" }>>>;
}>;

export type ConfigArchiveAuthority = Readonly<{
  /** The host must authorize and durably audit this request before any source data is read. */
  authorizeAndRecord(request: ConfigArchiveRequest): Promise<Result<Readonly<{ requestRef: string }>, Readonly<{ kind: "denied" | "auditFailure" }>>>;
}>;

export type ConfigArchiveFailure = Readonly<{
  kind: "invalidConfig" | "denied" | "auditFailure" | "scopeIncomplete" | "callsRequireRetention" |
    "unresolvedWork" | "fenceMismatch" | "storageCorrupt" | "storageFailure" | "tooLarge";
}>;

type SettingRow = { clinic_id: string; location_id: string; version: number; policy: unknown;
  setting_kind: string; previous_after_hours_mode: string | null;
  previous_cancellation_enabled: boolean | null;
  previous_rescheduling_enabled: boolean | null;
  previous_staffed_destination_ref: string | null;
  changed_by: string | null; previous_booking_enabled: boolean | null; changed_at: Date | null };
type AutomationRow = { clinic_id: string; version: number; enabled: boolean; changed_by: string | null; previous_enabled: boolean | null; changed_at: Date | null };
type StopRow = { clinic_id: string; version: number; stopped: boolean; actor_ref: string; reason: string; changed_at: Date };
type KnowledgeRow = { clinic_id: string; location_id: string; source_ref: string; version: number; status: string; owner_ref: string; answer_text: string;
  effective_from: Date; effective_until: Date; actor_ref: string; changed_at: Date };
type RecordData = Record<string, unknown> & { recordVersion: 1 | 2; recordId: string; sourceTenantId: string };

class ExportAbort extends Error {
  readonly kind: ConfigArchiveFailure["kind"];
  constructor(kind: ConfigArchiveFailure["kind"]) { super(kind); this.kind = kind; }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validRef(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function destination(value: unknown): StaffDestination {
  const row = object(value);
  if (row?.kind === "owner" && validRef(row.ownerRef)) return { kind: "owner", ownerRef: row.ownerRef };
  if (row?.kind === "queue" && validRef(row.queueRef)) return { kind: "queue", queueRef: row.queueRef };
  throw new ExportAbort("storageCorrupt");
}

function afterHoursFields(row: Record<string, unknown>, scope: LocationScope): Record<string, unknown> {
  const mode = row.afterHoursMode ?? "staffRequest";
  if (!validAfterHoursSetting(mode, row.afterHoursInfo, scope)) throw new ExportAbort("storageCorrupt");
  const info = object(row.afterHoursInfo);
  return { afterHoursMode: mode,
    ...(info ? { afterHoursInfo: { version: info.version, ownerRef: info.ownerRef,
      approvedText: info.approvedText, approved: true } } : {}) };
}

function urgentFields(row: Record<string, unknown>, scope: LocationScope): Record<string, unknown> {
  if (row.urgentResponse === undefined) return {};
  if (!validUrgentResponseShape(row.urgentResponse, scope)) throw new ExportAbort("storageCorrupt");
  const response = row.urgentResponse;
  return { urgentResponse: { version: response.version, ownerRef: response.ownerRef,
    approvedText: response.approvedText, approved: true,
    effectiveFrom: response.effectiveFrom, effectiveUntil: response.effectiveUntil } };
}

function staffScheduleFields(row: Record<string, unknown>, scope: LocationScope): Record<string, unknown> {
  if (row.staffSchedule === undefined) return {};
  if (!validApprovedStaffSchedule(row.staffSchedule, scope)) throw new ExportAbort("storageCorrupt");
  const schedule = row.staffSchedule;
  return { staffSchedule: { version: schedule.version, ownerRef: schedule.ownerRef, approved: true,
    effectiveFrom: schedule.effectiveFrom, effectiveUntil: schedule.effectiveUntil,
    timeZone: schedule.timeZone, weekly: schedule.weekly.map(window => ({ weekday: window.weekday,
      startMinute: window.startMinute, endMinute: window.endMinute })), closedDates: [...schedule.closedDates] } };
}

function greetingFields(row: Record<string, unknown>, scope: LocationScope): Record<string, unknown> {
  if (row.greeting === undefined || row.greeting === null) return {};
  if (!validGreetingShape(row.greeting, scope)) throw new ExportAbort("storageCorrupt");
  const greeting = row.greeting;
  return { greeting: { version: greeting.version, ownerRef: greeting.ownerRef,
    approvedText: greeting.approvedText, approved: true,
    ...(greeting.effectiveFrom === undefined ? {} : { effectiveFrom: greeting.effectiveFrom,
      effectiveUntil: greeting.effectiveUntil }) } };
}

/** Export only known policy fields; extra JSONB keys never cross the archive boundary. */
function policyFields(value: unknown, scope: LocationScope, version: number,
                      mode: "standaloneMinimal" | "unsafeReference"): Record<string, unknown> {
  const row = object(value);
  const storedScope = object(row?.scope);
  if (mode === "standaloneMinimal") {
    if (!row || !storedScope || !["bookingEnabled", "policyVersion", "scope"].every(field => Object.hasOwn(row, field)) ||
        Object.keys(row).some(field => !["bookingEnabled", "cancellationEnabled", "reschedulingEnabled", "policyVersion", "scope", "afterHoursMode",
          "afterHoursInfo", "urgentResponse", "staffSchedule", "greeting", "transferDestinationRef"].includes(field)) ||
        Object.keys(storedScope).sort().join(",") !== "clinicId,locationId,tenantId" ||
        storedScope.tenantId !== scope.tenantId || storedScope.clinicId !== scope.clinicId ||
        storedScope.locationId !== scope.locationId || row.policyVersion !== String(version) ||
        typeof row.bookingEnabled !== "boolean" ||
        (row.cancellationEnabled !== undefined && typeof row.cancellationEnabled !== "boolean") ||
        (row.reschedulingEnabled !== undefined && typeof row.reschedulingEnabled !== "boolean") ||
        (row.transferDestinationRef !== undefined && !validRef(row.transferDestinationRef))) throw new ExportAbort("storageCorrupt");
    return { shape: "standaloneMinimal", policyVersion: row.policyVersion, bookingEnabled: row.bookingEnabled,
      cancellationEnabled: row.cancellationEnabled ?? false, reschedulingEnabled: row.reschedulingEnabled ?? false,
      ...afterHoursFields(row, scope), ...urgentFields(row, scope), ...staffScheduleFields(row, scope),
      ...greetingFields(row, scope), ...(row.transferDestinationRef === undefined ? {} : { transferDestinationRef: row.transferDestinationRef }) };
  }
  const caps = object(row?.capabilities);
  if (!row || !storedScope || storedScope.tenantId !== scope.tenantId || storedScope.clinicId !== scope.clinicId ||
      storedScope.locationId !== scope.locationId || row.policyVersion !== String(version) ||
      typeof row.bookingEnabled !== "boolean" || !caps ||
      (row.cancellationEnabled !== undefined && typeof row.cancellationEnabled !== "boolean") ||
        (row.reschedulingEnabled !== undefined && typeof row.reschedulingEnabled !== "boolean")) throw new ExportAbort("storageCorrupt");
  const capabilities: Record<string, string> = {};
  for (const name of ["book", "cancel", "reschedule", "intake", "transfer"]) {
    if (caps[name] !== "execute" && caps[name] !== "requestOnly" && caps[name] !== "unavailable") throw new ExportAbort("storageCorrupt");
    capabilities[name] = caps[name];
  }
  const policy: Record<string, unknown> = { policyVersion: row.policyVersion, bookingEnabled: row.bookingEnabled, capabilities,
    cancellationEnabled: row.cancellationEnabled ?? false, reschedulingEnabled: row.reschedulingEnabled ?? false,
    staffDestination: destination(row.staffDestination), operatorQueue: destination(row.operatorQueue),
    ...afterHoursFields(row, scope), ...urgentFields(row, scope), ...staffScheduleFields(row, scope),
    ...greetingFields(row, scope) };
  if (row.transferDestinationRef !== undefined) {
    if (!validRef(row.transferDestinationRef)) throw new ExportAbort("storageCorrupt");
    policy.transferDestinationRef = row.transferDestinationRef;
  }
  const coverage = object(row.staffedCoverage);
  let coverageBounds: Readonly<{ start: number; end: number }> | undefined;
  if (row.staffedCoverage !== undefined) {
    if (!coverage || typeof coverage.startsAt !== "string" || typeof coverage.endsAt !== "string") throw new ExportAbort("storageCorrupt");
    const start = Date.parse(coverage.startsAt);
    const end = Date.parse(coverage.endsAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 72 * 60 * 60 * 1_000) {
      throw new ExportAbort("storageCorrupt");
    }
    coverageBounds = { start, end };
    policy.staffedCoverage = { startsAt: coverage.startsAt, endsAt: coverage.endsAt };
  }
  if (row.staffedIntervals !== undefined) {
    if (!Array.isArray(row.staffedIntervals) || row.staffedIntervals.length > 512 || row.staffedIntervals.some(item => {
      const interval = object(item);
      return !interval || typeof interval.startsAt !== "string" || typeof interval.endsAt !== "string" ||
        !Number.isFinite(Date.parse(interval.startsAt)) || !Number.isFinite(Date.parse(interval.endsAt)) ||
        Date.parse(interval.startsAt) >= Date.parse(interval.endsAt) ||
        (coverageBounds !== undefined && (Date.parse(interval.startsAt) < coverageBounds.start ||
          Date.parse(interval.endsAt) > coverageBounds.end));
    })) throw new ExportAbort("storageCorrupt");
    policy.staffedIntervals = row.staffedIntervals.map(item => ({ startsAt: item.startsAt, endsAt: item.endsAt }));
  }
  return policy;
}

function instant(value: Date | null): string | null {
  if (value === null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new ExportAbort("storageCorrupt");
  return value.toISOString();
}

function requiredInstant(value: Date): string {
  const result = instant(value);
  if (result === null) throw new ExportAbort("storageCorrupt");
  return result;
}

function recordId(prefix: string, key: string, version: number): string {
  return `${prefix}:${createHash("sha256").update(key).digest("hex")}:${String(version).padStart(12, "0")}`;
}

function sectionBytes(records: readonly RecordData[]): Buffer {
  const ordered = [...records].sort((a, b) => Buffer.compare(Buffer.from(a.recordId), Buffer.from(b.recordId)));
  const bytes = Buffer.from(ordered.map(row => `${JSON.stringify(row)}\n`).join(""), "utf8");
  if (bytes.byteLength > 64 * 1024 * 1024) throw new ExportAbort("tooLarge");
  return bytes;
}

export function validConfigArchiveRequest(request: ConfigArchiveRequest): boolean {
  if (!request?.scope || !request.targetScope) return false;
  return validTenantConfigArchiveRequest({ sourceTenantId: request.scope.tenantId,
    locations: [{ sourceScope: request.scope, targetScope: request.targetScope,
      timeZone: request.timeZone, mappingProvenance: request.mappingProvenance }],
    archiveId: request.archiveId, actorRef: request.actorRef, createdAt: request.createdAt,
    ...(request.archiveMode === undefined ? {} : { archiveMode: request.archiveMode }) });
}

function mappingKey(scope: LocationScope): string {
  return JSON.stringify([scope.clinicId, scope.locationId]);
}

export function validTenantConfigArchiveRequest(request: TenantConfigArchiveRequest): boolean {
  if (!request || ![request.sourceTenantId, request.archiveId, request.actorRef].every(validRef) ||
      (request.archiveMode !== undefined && request.archiveMode !== "standaloneMinimal" && request.archiveMode !== "unsafeReference") ||
      typeof request.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(request.createdAt) ||
      !Number.isFinite(Date.parse(request.createdAt)) ||
      (request.expectedFenceVersion !== undefined &&
        (!Number.isSafeInteger(request.expectedFenceVersion) || request.expectedFenceVersion < 1)) ||
      !Array.isArray(request.locations) ||
      request.locations.length < 1 || request.locations.length > 16) return false;
  const sources = new Set<string>();
  const targets = new Set<string>();
  let targetTenantId: string | undefined;
  for (const mapping of request.locations) {
    if (!mapping?.sourceScope || !mapping.targetScope || mapping.sourceScope.tenantId !== request.sourceTenantId ||
        ![mapping.sourceScope.clinicId, mapping.sourceScope.locationId, mapping.targetScope.tenantId,
          mapping.targetScope.clinicId, mapping.targetScope.locationId, mapping.mappingProvenance].every(validRef) ||
        typeof mapping.timeZone !== "string" || !mapping.timeZone.trim()) return false;
    if (targetTenantId !== undefined && mapping.targetScope.tenantId !== targetTenantId) return false;
    targetTenantId = mapping.targetScope.tenantId;
    try { new Intl.DateTimeFormat("en", { timeZone: mapping.timeZone }); }
    catch { return false; }
    const source = mappingKey(mapping.sourceScope);
    const target = JSON.stringify([mapping.targetScope.tenantId, mapping.targetScope.clinicId, mapping.targetScope.locationId]);
    if (sources.has(source) || targets.has(target)) return false;
    sources.add(source);
    targets.add(target);
  }
  return true;
}

/** One repeatable-read snapshot covers every mapped location in the tenant. */
async function buildTenantAuthorized(db: Kysely<Database>, request: TenantConfigArchiveRequest, requestRef: string):
  Promise<Result<ArchiveEnvelope, ConfigArchiveFailure>> {
  const sourceTenantId = request.sourceTenantId;
  const mode = request.archiveMode ?? "standaloneMinimal";
  const mappings = [...request.locations].sort((a, b) => Buffer.compare(Buffer.from(mappingKey(a.sourceScope)), Buffer.from(mappingKey(b.sourceScope))));
  const byLocation = new Map(mappings.map(mapping => [mappingKey(mapping.sourceScope), mapping]));
  const clinics = new Set(mappings.map(mapping => mapping.sourceScope.clinicId));
  try {
    const snapshot = await db.transaction().setIsolationLevel("repeatable read").execute(async trx => {
      // Serialize a final snapshot with release; stale repeatable-read snapshots fail closed.
      if (request.expectedFenceVersion !== undefined) {
        await sql`select pg_advisory_xact_lock_shared(172934501, hashtext(${sourceTenantId}))`.execute(trx);
        const fence = await sql<{ version: number; frozen: boolean }>`select version, frozen
          from tenant_portability_fences where tenant_id = ${sourceTenantId} for share`.execute(trx);
        if (!fence.rows[0]?.frozen || fence.rows[0].version !== request.expectedFenceVersion) {
          throw new ExportAbort("fenceMismatch");
        }
      }
      const migration = await sql<{ name: string }>`select name from kysely_migration order by name desc limit 1`.execute(trx);
      const schemaVersion = migration.rows[0]?.name;
      if (!validRef(schemaVersion)) throw new ExportAbort("storageCorrupt");
      const pending = await sql<{ found: number }>`select 1 as found from pending_location_calls where tenant_id = ${sourceTenantId} limit 1`.execute(trx);
      const inflight = await sql<{ found: number }>`select 1 as found from clinic_write_stop_inflight
        where tenant_id = ${sourceTenantId} limit 1`.execute(trx);
      if (pending.rows.length) throw new ExportAbort("callsRequireRetention");
      if (inflight.rows.length) throw new ExportAbort("unresolvedWork");
      const callScan = await scanPortableTextCalls(trx, sourceTenantId);
      if (!callScan.ok) throw new ExportAbort(callScan.error.kind);
      if (mode !== "standaloneMinimal" && callScan.value.count > 0) throw new ExportAbort("callsRequireRetention");
      if ([...callScan.value.locationKeys].some(key => !byLocation.has(key))) throw new ExportAbort("scopeIncomplete");
      const observedLocations = await sql<{ clinic_id: string; location_id: string }>`select clinic_id, location_id from clinic_settings
        where tenant_id = ${sourceTenantId} union select clinic_id, location_id from clinic_knowledge_events
        where tenant_id = ${sourceTenantId}`.execute(trx);
      const observedClinics = await sql<{ clinic_id: string }>`select clinic_id from clinic_automation where tenant_id = ${sourceTenantId}
        union select clinic_id from clinic_intake_settings where tenant_id = ${sourceTenantId}
        union select clinic_id from clinic_notification_settings where tenant_id = ${sourceTenantId}
        union select clinic_id from clinic_voice_settings where tenant_id = ${sourceTenantId}
        union select clinic_id from clinic_write_stop where tenant_id = ${sourceTenantId}
        union select clinic_id from clinic_write_stop_events where tenant_id = ${sourceTenantId}`.execute(trx);
      if (observedLocations.rows.some(row => !byLocation.has(JSON.stringify([row.clinic_id, row.location_id]))) ||
          observedClinics.rows.some(row => !clinics.has(row.clinic_id))) throw new ExportAbort("scopeIncomplete");
      const settings = await sql<SettingRow>`select clinic_id, location_id, version, policy, setting_kind,
        previous_after_hours_mode, previous_cancellation_enabled, previous_rescheduling_enabled, previous_staffed_destination_ref, changed_by, previous_booking_enabled, changed_at
        from clinic_settings where tenant_id = ${sourceTenantId} order by clinic_id, location_id, version`.execute(trx);
      const automation = await sql<AutomationRow>`select clinic_id, version, enabled, changed_by, previous_enabled, changed_at
        from clinic_automation where tenant_id = ${sourceTenantId} order by clinic_id, version`.execute(trx);
      const clinicIntake = await sql<AutomationRow>`select clinic_id, version, enabled, changed_by, previous_enabled, changed_at
        from clinic_intake_settings where tenant_id = ${sourceTenantId} order by clinic_id, version`.execute(trx);
      let clinicNotifications: Awaited<ReturnType<typeof readNotificationCarryover>>;
      try { clinicNotifications = await readNotificationCarryover(trx, sourceTenantId); }
      catch { throw new ExportAbort("storageCorrupt"); }
      const stops = await sql<StopRow>`select clinic_id, version, stopped, actor_ref, reason, changed_at
        from clinic_write_stop_events where tenant_id = ${sourceTenantId} order by clinic_id, version`.execute(trx);
      let clinicVoice: Awaited<ReturnType<typeof readVoiceCarryover>>;
      try { clinicVoice = await readVoiceCarryover(trx, sourceTenantId); }
      catch { throw new ExportAbort("storageCorrupt"); }
      if (mode === "standaloneMinimal") {
        const anyKnowledge = await sql<{ found: number }>`select 1 as found from clinic_knowledge_heads
          where tenant_id = ${sourceTenantId} limit 1`.execute(trx);
        const anyEvents = await sql<{ found: number }>`select 1 as found from clinic_knowledge_events
          where tenant_id = ${sourceTenantId} limit 1`.execute(trx);
        if (anyKnowledge.rows.length || anyEvents.rows.length ||
            stops.rows.some(row => !validWriteStopReason(row.stopped, row.reason))) {
          throw new ExportAbort("storageCorrupt");
        }
      }
      const knowledge = mode === "standaloneMinimal" ? [] :
        (await sql<KnowledgeRow>`select clinic_id, location_id, source_ref, version, status, owner_ref, answer_text,
          effective_from, effective_until, actor_ref, changed_at from clinic_knowledge_events
          where tenant_id = ${sourceTenantId} and status in ('approved', 'revoked')
          order by clinic_id, location_id, source_ref, version`.execute(trx)).rows;
      return { schemaVersion, settings: settings.rows, automation: automation.rows, clinicIntake: clinicIntake.rows, clinicNotifications, clinicVoice, stops: stops.rows,
        knowledge, omittedTextCalls: callScan.value.count,
        omittedTextCallsByLocation: callScan.value.countsByLocation,
        sourceFenceVersion: request.expectedFenceVersion };
    });
    const common = (recordId: string) => ({ recordVersion: 1 as const, recordId, sourceTenantId });
    const locations: RecordData[] = mappings.map(mapping => ({
      ...common(recordId("location", mappingKey(mapping.sourceScope), 1)),
      sourceClinicId: mapping.sourceScope.clinicId, sourceLocationId: mapping.sourceScope.locationId,
      targetScope: mapping.targetScope, timeZone: mapping.timeZone, mappingProvenance: mapping.mappingProvenance,
    }));
    const settingsRows = [...snapshot.settings];
    if (mode === "standaloneMinimal") {
      for (const mapping of mappings) {
        if (settingsRows.some(row => row.clinic_id === mapping.sourceScope.clinicId &&
            row.location_id === mapping.sourceScope.locationId)) continue;
        settingsRows.push({ clinic_id: mapping.sourceScope.clinicId, location_id: mapping.sourceScope.locationId,
          version: 0, policy: { scope: mapping.sourceScope, policyVersion: "0", bookingEnabled: false },
          setting_kind: "booking", previous_after_hours_mode: null, previous_cancellation_enabled: null, previous_rescheduling_enabled: null,
          previous_staffed_destination_ref: null,
          changed_by: null, previous_booking_enabled: null, changed_at: null });
      }
    }
    const policyHeads = new Map<string, number>();
    for (const row of settingsRows) policyHeads.set(JSON.stringify([row.clinic_id, row.location_id]), row.version);
    const automationHeads = new Map<string, number>();
    for (const row of snapshot.automation) automationHeads.set(row.clinic_id, row.version);
    const intakeHeads = new Map(snapshot.clinicIntake.map(row => [row.clinic_id, row.version]));
    for (const clinicId of new Set(snapshot.clinicIntake.map(row => row.clinic_id))) {
      const history = snapshot.clinicIntake.filter(row => row.clinic_id === clinicId).map(row => ({ version: row.version,
        isHead: intakeHeads.get(clinicId) === row.version, enabled: row.enabled,
        changedBy: row.changed_by, previousEnabled: row.previous_enabled, changedAt: instant(row.changed_at) }));
      if (!validClinicIntakeArchiveHistory(history)) throw new ExportAbort("storageCorrupt");
    }
    const stopHeads = new Map<string, number>();
    for (const row of snapshot.stops) stopHeads.set(row.clinic_id, row.version);
    const settings: RecordData[] = [
      ...settingsRows.map(row => {
        const mapping = byLocation.get(JSON.stringify([row.clinic_id, row.location_id]));
        if (!mapping) throw new ExportAbort("scopeIncomplete");
        return { ...common(recordId("policy", mappingKey(mapping.sourceScope), row.version)),
          sourceClinicId: row.clinic_id, sourceLocationId: row.location_id, kind: "locationPolicy", version: row.version,
          isHead: policyHeads.get(mappingKey(mapping.sourceScope)) === row.version,
          policy: policyFields(row.policy, mapping.sourceScope, row.version, mode),
          changedBy: row.changed_by, previousBookingEnabled: row.previous_booking_enabled,
          settingKind: row.setting_kind, previousAfterHoursMode: row.previous_after_hours_mode,
          previousCancellationEnabled: row.previous_cancellation_enabled,
          previousReschedulingEnabled: row.previous_rescheduling_enabled,
          previousStaffedDestinationRef: row.previous_staffed_destination_ref,
          changedAt: instant(row.changed_at) };
      }),
      ...snapshot.automation.map(row => ({ ...common(recordId("automation", row.clinic_id, row.version)),
        sourceClinicId: row.clinic_id, kind: "clinicAutomation", version: row.version,
        isHead: automationHeads.get(row.clinic_id) === row.version, enabled: row.enabled,
        changedBy: row.changed_by, previousEnabled: row.previous_enabled, changedAt: instant(row.changed_at) })),
      ...snapshot.clinicIntake.map(row => ({ ...common(recordId("intake", row.clinic_id, row.version)),
        sourceClinicId: row.clinic_id, kind: "clinicIntake", version: row.version,
        isHead: intakeHeads.get(row.clinic_id) === row.version, enabled: row.enabled,
        changedBy: row.changed_by, previousEnabled: row.previous_enabled, changedAt: instant(row.changed_at) })),
      ...snapshot.clinicNotifications.map(row => ({ ...common(recordId("notifications", row.sourceClinicId, row.version)),
        kind: "clinicNotifications", ...row })),
      ...snapshot.clinicVoice.map(row => ({ ...common(recordId("voice", row.sourceClinicId, row.version)),
        kind: "clinicVoice", ...row })),
      ...snapshot.stops.map(row => ({ ...common(recordId("writeStop", row.clinic_id, row.version)),
        sourceClinicId: row.clinic_id, kind: "writeStop", version: row.version,
        isHead: stopHeads.get(row.clinic_id) === row.version, stopped: row.stopped,
        actorRef: row.actor_ref, reasonDigest: createHash("sha256").update(row.reason).digest("hex"),
        changedAt: requiredInstant(row.changed_at) })),
    ];
    const knowledgeKey = (row: KnowledgeRow) => JSON.stringify([row.clinic_id, row.location_id, row.source_ref]);
    const latestKnowledge = new Map(snapshot.knowledge.map(row => [knowledgeKey(row), row.version]));
    const knowledge: RecordData[] = snapshot.knowledge.map(row => {
      if (!byLocation.has(JSON.stringify([row.clinic_id, row.location_id]))) throw new ExportAbort("scopeIncomplete");
      if (!validRef(row.source_ref) || !validRef(row.owner_ref) || !validRef(row.actor_ref) ||
          !Number.isSafeInteger(row.version) || row.version < 1 ||
          (row.status !== "approved" && row.status !== "revoked") || typeof row.answer_text !== "string") throw new ExportAbort("storageCorrupt");
      return { ...common(recordId("knowledge", knowledgeKey(row), row.version)),
        sourceClinicId: row.clinic_id, sourceLocationId: row.location_id, sourceRef: row.source_ref,
        version: row.version, status: row.status, isPublishedHead: latestKnowledge.get(knowledgeKey(row)) === row.version,
        ownerRef: row.owner_ref, actorRef: row.actor_ref,
        effectiveFrom: requiredInstant(row.effective_from), effectiveUntil: requiredInstant(row.effective_until),
        changedAt: requiredInstant(row.changed_at),
        contentDigest: createHash("sha256").update(row.answer_text).digest("hex"), approvedText: row.answer_text };
    });
    const calls: RecordData[] = mappings.flatMap(mapping => {
      const key = mappingKey(mapping.sourceScope);
      const count = snapshot.omittedTextCallsByLocation.get(key) ?? 0;
      return count === 0 ? [] : [{ ...common(recordId("omittedTextCalls", key, 1)), recordVersion: 2 as const,
        kind: "omittedTextCallCount", sourceClinicId: mapping.sourceScope.clinicId,
        sourceLocationId: mapping.sourceScope.locationId, notRetained: count }];
    });
    const records: Record<ArchiveSection, readonly RecordData[]> = { locations, settings, knowledge, calls, staffWork: [] };
    const bytes = Object.fromEntries(ARCHIVE_SECTIONS.map(name => [name, sectionBytes(records[name])])) as Record<ArchiveSection, Buffer>;
    const manifest = { archiveVersion: 2, archiveId: request.archiveId, createdAt: request.createdAt,
      sourceSystem: "abby-postgres", sourceSchemaVersion: snapshot.schemaVersion, sourceTenantId,
      ...(snapshot.sourceFenceVersion === undefined ? {} : { sourceFenceVersion: snapshot.sourceFenceVersion }),
      exportRequestRef: requestRef, omittedCalls: { retentionExpired: 0, consentDenied: 0,
        notRetained: snapshot.omittedTextCalls, activeCall: 0 },
      locationMappings: mappings.map(mapping => ({ sourceScope: mapping.sourceScope,
        targetScope: mapping.targetScope, provenance: mapping.mappingProvenance })),
      sections: Object.fromEntries(ARCHIVE_SECTIONS.map(name => [name, { version: name === "calls" ? 2 : 1,
        recordCount: records[name].length,
        byteCount: bytes[name].byteLength, sha256: createHash("sha256").update(bytes[name]).digest("hex") }])) };
    const section = (name: ArchiveSection) => async function* () { yield bytes[name]; };
    return ok({ manifestBytes: Buffer.from(JSON.stringify(manifest)), sections: { locations: section("locations"),
      settings: section("settings"), knowledge: section("knowledge"), calls: section("calls"), staffWork: section("staffWork") } });
  } catch (cause) {
    return err({ kind: cause instanceof ExportAbort ? cause.kind : "storageFailure" });
  }
}

/** Source adapter for one location; refuses to omit another location in the tenant. */
export async function buildPostgresConfigArchive(db: Kysely<Database>, request: ConfigArchiveRequest, authority: ConfigArchiveAuthority):
  Promise<Result<ArchiveEnvelope, ConfigArchiveFailure>> {
  if (!validConfigArchiveRequest(request) || !authority || typeof authority.authorizeAndRecord !== "function") return err({ kind: "invalidConfig" });
  let authorization: Awaited<ReturnType<ConfigArchiveAuthority["authorizeAndRecord"]>>;
  try { authorization = await authority.authorizeAndRecord(request); }
  catch { return err({ kind: "auditFailure" }); }
  if (!authorization.ok) return err({ kind: authorization.error.kind });
  if (!validRef(authorization.value.requestRef)) return err({ kind: "auditFailure" });
  return buildTenantAuthorized(db, { sourceTenantId: request.scope.tenantId,
    locations: [{ sourceScope: request.scope, targetScope: request.targetScope,
      timeZone: request.timeZone, mappingProvenance: request.mappingProvenance }],
    archiveId: request.archiveId, actorRef: request.actorRef, createdAt: request.createdAt,
    ...(request.archiveMode === undefined ? {} : { archiveMode: request.archiveMode }) }, authorization.value.requestRef);
}

/** Exports all explicitly mapped locations from one consistent tenant snapshot. */
export async function buildPostgresTenantConfigArchive(db: Kysely<Database>, request: TenantConfigArchiveRequest,
                                                       authority: TenantConfigArchiveAuthority):
  Promise<Result<ArchiveEnvelope, ConfigArchiveFailure>> {
  if (!validTenantConfigArchiveRequest(request) || !authority || typeof authority.authorizeAndRecord !== "function") return err({ kind: "invalidConfig" });
  let authorization: Awaited<ReturnType<TenantConfigArchiveAuthority["authorizeAndRecord"]>>;
  try { authorization = await authority.authorizeAndRecord(request); }
  catch { return err({ kind: "auditFailure" }); }
  if (!authorization.ok) return err({ kind: authorization.error.kind });
  if (!validRef(authorization.value.requestRef)) return err({ kind: "auditFailure" });
  return buildTenantAuthorized(db, request, authorization.value.requestRef);
}

/** Final snapshot: fails unless the source remains frozen at the named fence version. */
export async function buildPostgresFencedTenantConfigArchive(db: Kysely<Database>,
  request: TenantConfigArchiveRequest & Readonly<{ expectedFenceVersion: number }>,
  authority: TenantConfigArchiveAuthority): Promise<Result<ArchiveEnvelope, ConfigArchiveFailure>> {
  if (!Number.isSafeInteger(request?.expectedFenceVersion) || request.expectedFenceVersion < 1) {
    return err({ kind: "invalidConfig" });
  }
  return buildPostgresTenantConfigArchive(db, request, authority);
}
