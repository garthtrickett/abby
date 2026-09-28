import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result, StaffDestination } from "../core/model.ts";
import { ARCHIVE_SECTIONS } from "../portability/archive-envelope.ts";
import type { ArchiveEnvelope, ArchiveSection } from "../portability/archive-envelope.ts";
import type Database from "./generated/Database.ts";

export type ConfigArchiveRequest = Readonly<{
  scope: LocationScope;
  targetScope: LocationScope;
  timeZone: string;
  mappingProvenance: string;
  archiveId: string;
  actorRef: string;
  createdAt: string;
}>;

export type ConfigArchiveAuthority = Readonly<{
  /** The host must authorize and durably audit this request before any source data is read. */
  authorizeAndRecord(request: ConfigArchiveRequest): Promise<Result<Readonly<{ requestRef: string }>, Readonly<{ kind: "denied" | "auditFailure" }>>>;
}>;

export type ConfigArchiveFailure = Readonly<{
  kind: "invalidConfig" | "denied" | "auditFailure" | "scopeIncomplete" | "callsRequireRetention" |
    "storageCorrupt" | "storageFailure" | "tooLarge";
}>;

type SettingRow = { version: number; policy: unknown; changed_by: string | null; previous_booking_enabled: boolean | null; changed_at: Date | null };
type AutomationRow = { version: number; enabled: boolean; changed_by: string | null; previous_enabled: boolean | null; changed_at: Date | null };
type StopRow = { version: number; stopped: boolean; actor_ref: string; reason: string; changed_at: Date };
type KnowledgeRow = { source_ref: string; version: number; status: string; owner_ref: string; answer_text: string;
  effective_from: Date; effective_until: Date; actor_ref: string; changed_at: Date };
type RecordData = Record<string, unknown> & { recordVersion: 1; recordId: string; sourceTenantId: string };

class ExportAbort extends Error {
  readonly kind: ConfigArchiveFailure["kind"];
  constructor(kind: ConfigArchiveFailure["kind"]) { super(kind); this.kind = kind; }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function destination(value: unknown): StaffDestination {
  const row = object(value);
  if (row?.kind === "owner" && validRef(row.ownerRef)) return { kind: "owner", ownerRef: row.ownerRef };
  if (row?.kind === "queue" && validRef(row.queueRef)) return { kind: "queue", queueRef: row.queueRef };
  throw new ExportAbort("storageCorrupt");
}

/** Export only known policy fields; extra JSONB keys never cross the archive boundary. */
function policyFields(value: unknown, scope: LocationScope, version: number): Record<string, unknown> {
  const row = object(value);
  const storedScope = object(row?.scope);
  const caps = object(row?.capabilities);
  if (!row || !storedScope || storedScope.tenantId !== scope.tenantId || storedScope.clinicId !== scope.clinicId ||
      storedScope.locationId !== scope.locationId || row.policyVersion !== String(version) ||
      typeof row.bookingEnabled !== "boolean" || !caps) throw new ExportAbort("storageCorrupt");
  const capabilities: Record<string, string> = {};
  for (const name of ["book", "cancel", "reschedule", "intake", "transfer"]) {
    if (caps[name] !== "execute" && caps[name] !== "requestOnly" && caps[name] !== "unavailable") throw new ExportAbort("storageCorrupt");
    capabilities[name] = caps[name];
  }
  const policy: Record<string, unknown> = { policyVersion: row.policyVersion, bookingEnabled: row.bookingEnabled, capabilities,
    staffDestination: destination(row.staffDestination), operatorQueue: destination(row.operatorQueue) };
  if (row.transferDestinationRef !== undefined) {
    if (!validRef(row.transferDestinationRef)) throw new ExportAbort("storageCorrupt");
    policy.transferDestinationRef = row.transferDestinationRef;
  }
  if (row.staffedIntervals !== undefined) {
    if (!Array.isArray(row.staffedIntervals) || row.staffedIntervals.some(item => {
      const interval = object(item);
      return !interval || typeof interval.startsAt !== "string" || typeof interval.endsAt !== "string" ||
        !Number.isFinite(Date.parse(interval.startsAt)) || !Number.isFinite(Date.parse(interval.endsAt));
    })) throw new ExportAbort("storageCorrupt");
    policy.staffedIntervals = row.staffedIntervals.map(item => ({ startsAt: item.startsAt, endsAt: item.endsAt }));
  }
  if (row.greeting !== undefined) {
    const greeting = object(row.greeting);
    const greetingScope = object(greeting?.scope);
    if (!greeting || !greetingScope || greetingScope.tenantId !== scope.tenantId || greetingScope.clinicId !== scope.clinicId ||
        greetingScope.locationId !== scope.locationId || greeting.approved !== true ||
        !validRef(greeting.version) || !validRef(greeting.ownerRef) ||
        typeof greeting.approvedText !== "string" || !greeting.approvedText.trim()) throw new ExportAbort("storageCorrupt");
    policy.greeting = { version: greeting.version, ownerRef: greeting.ownerRef, approvedText: greeting.approvedText, approved: true };
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

function validRequest(request: ConfigArchiveRequest): boolean {
  const source = request?.scope;
  const target = request?.targetScope;
  if (!source || !target || ![source.tenantId, source.clinicId, source.locationId,
    target.tenantId, target.clinicId, target.locationId, request.archiveId, request.actorRef, request.mappingProvenance].every(validRef)) return false;
  if (typeof request.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(request.createdAt) ||
      !Number.isFinite(Date.parse(request.createdAt))) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: request.timeZone }); }
  catch { return false; }
  return true;
}

/** Source adapter for an unused one-location tenant. It fails closed if any call history exists. */
export async function buildPostgresConfigArchive(db: Kysely<Database>, request: ConfigArchiveRequest, authority: ConfigArchiveAuthority):
  Promise<Result<ArchiveEnvelope, ConfigArchiveFailure>> {
  if (!validRequest(request) || !authority || typeof authority.authorizeAndRecord !== "function") return err({ kind: "invalidConfig" });
  let authorization: Awaited<ReturnType<ConfigArchiveAuthority["authorizeAndRecord"]>>;
  try { authorization = await authority.authorizeAndRecord(request); }
  catch { return err({ kind: "auditFailure" }); }
  if (!authorization.ok) return err({ kind: authorization.error.kind });
  if (!validRef(authorization.value.requestRef)) return err({ kind: "auditFailure" });
  const scope = request.scope;
  try {
    const snapshot = await db.transaction().setIsolationLevel("repeatable read").execute(async trx => {
      const migration = await sql<{ name: string }>`select name from kysely_migration order by name desc limit 1`.execute(trx);
      const schemaVersion = migration.rows[0]?.name;
      if (!validRef(schemaVersion)) throw new ExportAbort("storageCorrupt");
      const otherLocation = await sql<{ found: number }>`select 1 as found from (
        select clinic_id, location_id from clinic_settings where tenant_id = ${scope.tenantId}
        union select clinic_id, location_id from clinic_knowledge_events where tenant_id = ${scope.tenantId}
        union select clinic_id, location_id from calls where tenant_id = ${scope.tenantId}
      ) as locations where clinic_id <> ${scope.clinicId} or location_id <> ${scope.locationId} limit 1`.execute(trx);
      const otherClinic = await sql<{ found: number }>`select 1 as found from (
        select clinic_id from clinic_automation where tenant_id = ${scope.tenantId}
        union select clinic_id from clinic_write_stop where tenant_id = ${scope.tenantId}
      ) as clinics where clinic_id <> ${scope.clinicId} limit 1`.execute(trx);
      if (otherLocation.rows.length || otherClinic.rows.length) throw new ExportAbort("scopeIncomplete");
      const calls = await sql<{ found: number }>`select 1 as found from calls where tenant_id = ${scope.tenantId} limit 1`.execute(trx);
      const pending = await sql<{ found: number }>`select 1 as found from pending_location_calls where tenant_id = ${scope.tenantId} limit 1`.execute(trx);
      if (calls.rows.length || pending.rows.length) throw new ExportAbort("callsRequireRetention");
      const settings = await sql<SettingRow>`select version, policy, changed_by, previous_booking_enabled, changed_at
        from clinic_settings where tenant_id = ${scope.tenantId} and clinic_id = ${scope.clinicId} and location_id = ${scope.locationId}
        order by version`.execute(trx);
      const automation = await sql<AutomationRow>`select version, enabled, changed_by, previous_enabled, changed_at
        from clinic_automation where tenant_id = ${scope.tenantId} and clinic_id = ${scope.clinicId} order by version`.execute(trx);
      const stops = await sql<StopRow>`select version, stopped, actor_ref, reason, changed_at from clinic_write_stop_events
        where tenant_id = ${scope.tenantId} and clinic_id = ${scope.clinicId} order by version`.execute(trx);
      const knowledge = await sql<KnowledgeRow>`select source_ref, version, status, owner_ref, answer_text, effective_from,
        effective_until, actor_ref, changed_at from clinic_knowledge_events
        where tenant_id = ${scope.tenantId} and clinic_id = ${scope.clinicId} and location_id = ${scope.locationId}
        and status in ('approved', 'revoked') order by source_ref, version`.execute(trx);
      return { schemaVersion, settings: settings.rows, automation: automation.rows, stops: stops.rows, knowledge: knowledge.rows };
    });
    const sourceTenantId = scope.tenantId;
    const common = (recordId: string) => ({ recordVersion: 1 as const, recordId, sourceTenantId });
    const locations: RecordData[] = [{ ...common(recordId("location", JSON.stringify([scope.clinicId, scope.locationId]), 1)),
      sourceClinicId: scope.clinicId, sourceLocationId: scope.locationId, targetScope: request.targetScope,
      timeZone: request.timeZone, mappingProvenance: request.mappingProvenance }];
    const settings: RecordData[] = [
      ...snapshot.settings.map(row => ({ ...common(recordId("policy", JSON.stringify([scope.clinicId, scope.locationId]), row.version)),
        sourceClinicId: scope.clinicId, sourceLocationId: scope.locationId, kind: "locationPolicy",
        version: row.version, isHead: row === snapshot.settings.at(-1), policy: policyFields(row.policy, scope, row.version),
        changedBy: row.changed_by, previousBookingEnabled: row.previous_booking_enabled, changedAt: instant(row.changed_at) })),
      ...snapshot.automation.map(row => ({ ...common(recordId("automation", scope.clinicId, row.version)),
        sourceClinicId: scope.clinicId, kind: "clinicAutomation", version: row.version, isHead: row === snapshot.automation.at(-1), enabled: row.enabled,
        changedBy: row.changed_by, previousEnabled: row.previous_enabled, changedAt: instant(row.changed_at) })),
      ...snapshot.stops.map(row => ({ ...common(recordId("writeStop", scope.clinicId, row.version)),
        sourceClinicId: scope.clinicId, kind: "writeStop", version: row.version, isHead: row === snapshot.stops.at(-1), stopped: row.stopped,
        actorRef: row.actor_ref, reasonDigest: createHash("sha256").update(row.reason).digest("hex"), changedAt: requiredInstant(row.changed_at) })),
    ];
    const latestKnowledge = new Map(snapshot.knowledge.map(row => [row.source_ref, row.version]));
    const knowledge: RecordData[] = snapshot.knowledge.map(row => {
      if (!validRef(row.source_ref) || !validRef(row.owner_ref) || !validRef(row.actor_ref) ||
          !Number.isSafeInteger(row.version) || row.version < 1 ||
          (row.status !== "approved" && row.status !== "revoked") || typeof row.answer_text !== "string") throw new ExportAbort("storageCorrupt");
      return { ...common(recordId("knowledge", JSON.stringify([scope.clinicId, scope.locationId, row.source_ref]), row.version)),
        sourceClinicId: scope.clinicId, sourceLocationId: scope.locationId, sourceRef: row.source_ref,
        version: row.version, status: row.status, isPublishedHead: latestKnowledge.get(row.source_ref) === row.version,
        ownerRef: row.owner_ref, actorRef: row.actor_ref,
        effectiveFrom: requiredInstant(row.effective_from), effectiveUntil: requiredInstant(row.effective_until), changedAt: requiredInstant(row.changed_at),
        contentDigest: createHash("sha256").update(row.answer_text).digest("hex"), approvedText: row.answer_text };
    });
    const records: Record<ArchiveSection, readonly RecordData[]> = { locations, settings, knowledge, calls: [], staffWork: [] };
    const bytes = Object.fromEntries(ARCHIVE_SECTIONS.map(name => [name, sectionBytes(records[name])])) as Record<ArchiveSection, Buffer>;
    const manifest = { archiveVersion: 1, archiveId: request.archiveId, createdAt: request.createdAt,
      sourceSystem: "abby-postgres", sourceSchemaVersion: snapshot.schemaVersion, sourceTenantId,
      exportRequestRef: authorization.value.requestRef, omittedCalls: { retentionExpired: 0, consentDenied: 0, notRetained: 0, activeCall: 0 },
      locationMappings: [{ sourceScope: scope, targetScope: request.targetScope, provenance: request.mappingProvenance }],
      sections: Object.fromEntries(ARCHIVE_SECTIONS.map(name => [name, { version: 1, recordCount: records[name].length,
        byteCount: bytes[name].byteLength, sha256: createHash("sha256").update(bytes[name]).digest("hex") }])) };
    const section = (name: ArchiveSection) => async function* () { yield bytes[name]; };
    return ok({ manifestBytes: Buffer.from(JSON.stringify(manifest)), sections: { locations: section("locations"),
      settings: section("settings"), knowledge: section("knowledge"), calls: section("calls"), staffWork: section("staffWork") } });
  } catch (cause) {
    return err({ kind: cause instanceof ExportAbort ? cause.kind : "storageFailure" });
  }
}
