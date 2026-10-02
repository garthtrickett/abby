import { createHash } from "node:crypto";
import { MemoryLedger } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { CallPolicy, LocationScope, Result, StaffDestination } from "../core/model.ts";
import type { AfterHoursSettingAuditEntry, AutomationSettingAuditEntry, BookingSettingAuditEntry, GreetingSettingAuditEntry, StaffScheduleSettingAuditEntry, UrgentSettingAuditEntry } from "../core/host.ts";
import type { ArchiveEnvelope } from "../portability/archive-envelope.ts";
import { decodeConfigArchive } from "../portability/config-archive.ts";
import type { ConfigArchiveData, ConfigArchiveDecodeFailure } from "../portability/config-archive.ts";
import { MemoryKnowledgeCatalogue } from "./knowledge-catalogue.ts";
import type { KnowledgeEntry } from "./knowledge-catalogue.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "./policy-store.ts";

export type ImportRefKind = "staffOwner" | "operatorQueue" | "transferDestination" | "knowledgeOwner" | "greetingOwner" | "afterHoursOwner" | "urgentOwner" | "scheduleOwner";
export type ReferenceImportMapper = Readonly<{
  mapRef(kind: ImportRefKind, sourceRef: string, sourceScope: LocationScope, targetScope: LocationScope): string | null;
}>;

export type ReferenceImportAuthority = Readonly<{
  /** The embedding host decides who may inspect and stage this archive, then records the attempt. */
  authorizeAndRecord(actorRef: string, targetScope: LocationScope): Promise<Result<Readonly<{ auditRef: string }>, Readonly<{ kind: "denied" | "auditFailure" }>>>;
}>;

export type ReferenceImportFailure = ConfigArchiveDecodeFailure | Readonly<{
  kind: "invalidRequest" | "denied" | "auditFailure" | "unmappedRef" | "targetOccupied" | "archiveConflict" | "invalidConfigArchive";
}>;

export type ReferenceImportMapping = Readonly<{ kind: ImportRefKind; sourceRef: string; targetRef: string }>;

export type ReferenceConfigPreflight = Readonly<{
  archiveId: string;
  manifestDigest: string;
  auditRef: string;
  sourceScope: LocationScope;
  targetScope: LocationScope;
  sourceSchemaVersion: string;
  sourceFenceVersion?: number;
  recordCounts: Readonly<{ locations: 1; settings: number; knowledge: number; calls: number; staffWork: 0 }>;
  omittedCalls: ConfigArchiveData["omittedCalls"];
  omittedTextCalls?: number;
  mappings: readonly ReferenceImportMapping[];
  status: "ready" | "alreadyStaged";
  plannedBookingEnabled: false;
  plannedAutomationEnabled: false;
  plannedWritesStopped: true;
}>;

export type ReferenceImportReceipt = Readonly<{
  archiveId: string;
  manifestDigest: string;
  auditRef: string;
  sourceScope: LocationScope;
  targetScope: LocationScope;
  sourceSchemaVersion: string;
  sourceFenceVersion?: number;
  policyVersions: number;
  automationVersions: number;
  writeStopVersions: number;
  publishedKnowledgeVersions: number;
  omittedCalls: ConfigArchiveData["omittedCalls"];
  omittedTextCalls?: number;
  mappings: readonly ReferenceImportMapping[];
  importedPolicyVersion: string;
  automationEnabled: false;
  bookingEnabled: false;
  writesStopped: true;
}>;

export type StagedReferenceConfiguration = Readonly<{
  receipt: ReferenceImportReceipt;
  sourceHistory: ConfigArchiveData;
  policy: MemoryPolicyStore;
  knowledge: MemoryKnowledgeCatalogue;
  ledger: MemoryLedger;
}>;

class UnmappedRef extends Error {}

function validRef(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function scopeKey(scope: LocationScope): string {
  return JSON.stringify([scope.tenantId, scope.clinicId, scope.locationId]);
}

function mappedRef(mapper: ReferenceImportMapper, kind: ImportRefKind, sourceRef: string, source: LocationScope, target: LocationScope): string {
  const mapped = mapper.mapRef(kind, sourceRef, source, target);
  if (!validRef(mapped)) throw new UnmappedRef();
  return mapped;
}

function mappedDestination(mapper: ReferenceImportMapper, source: StaffDestination, sourceScope: LocationScope, targetScope: LocationScope,
                           role: "staffOwner" | "operatorQueue"): StaffDestination {
  if (source.kind === "owner") return { kind: "owner", ownerRef: mappedRef(mapper, role, source.ownerRef, sourceScope, targetScope) };
  return { kind: "queue", queueRef: mappedRef(mapper, role, source.queueRef, sourceScope, targetScope) };
}

function mapImportedPolicy(source: CallPolicy, mapper: ReferenceImportMapper, sourceScope: LocationScope, targetScope: LocationScope): CallPolicy {
  const restricted = (mode: CallPolicy["capabilities"]["book"]) => mode === "unavailable" ? "unavailable" as const : "requestOnly" as const;
  return { ...structuredClone(source), scope: structuredClone(targetScope), automationEnabled: false,
    capabilities: { book: "unavailable", cancel: restricted(source.capabilities.cancel),
      reschedule: restricted(source.capabilities.reschedule), intake: restricted(source.capabilities.intake),
      transfer: restricted(source.capabilities.transfer) },
    staffDestination: mappedDestination(mapper, source.staffDestination, sourceScope, targetScope, "staffOwner"),
    operatorQueue: mappedDestination(mapper, source.operatorQueue, sourceScope, targetScope, "operatorQueue"),
    ...(source.transferDestinationRef === undefined ? {} : { transferDestinationRef:
      mappedRef(mapper, "transferDestination", source.transferDestinationRef, sourceScope, targetScope) }),
    ...(source.staffSchedule === undefined ? {} : { staffSchedule: { ...source.staffSchedule, scope: structuredClone(targetScope),
      ownerRef: mappedRef(mapper, "scheduleOwner", source.staffSchedule.ownerRef, sourceScope, targetScope) } }),
    ...(source.greeting === undefined ? {} : { greeting: { ...source.greeting, scope: structuredClone(targetScope),
      ownerRef: mappedRef(mapper, "greetingOwner", source.greeting.ownerRef, sourceScope, targetScope) } }),
    ...(source.afterHoursInfo === undefined ? {} : { afterHoursInfo: { ...source.afterHoursInfo,
      scope: structuredClone(targetScope),
      ownerRef: mappedRef(mapper, "afterHoursOwner", source.afterHoursInfo.ownerRef, sourceScope, targetScope) } }),
    ...(source.urgentResponse === undefined ? {} : { urgentResponse: { ...source.urgentResponse,
      scope: structuredClone(targetScope),
      ownerRef: mappedRef(mapper, "urgentOwner", source.urgentResponse.ownerRef, sourceScope, targetScope) } }),
  };
}

function bookingAudit(data: Pick<ConfigArchiveData, "policies">): BookingSettingAuditEntry[] {
  return data.policies.filter(row => row.version > 0 && (row.settingKind ?? "booking") === "booking").map(row => {
    const metadata = [row.changedBy, row.previousBookingEnabled, row.changedAt];
    if (metadata.every(value => value === null)) return { version: String(row.version), enabled: row.policy.bookingEnabled, provenance: "legacyUnattributed" };
    if (!row.changedBy || row.previousBookingEnabled === null || !row.changedAt) throw new Error("invalid booking audit");
    return { version: String(row.version), enabled: row.policy.bookingEnabled, provenance: "recorded",
      actorRef: row.changedBy, previousEnabled: row.previousBookingEnabled, changedAt: row.changedAt };
  });
}

function afterHoursAudit(data: Pick<ConfigArchiveData, "policies">): AfterHoursSettingAuditEntry[] {
  return data.policies.filter(row => row.version > 0 && row.settingKind === "afterHours").map(row => {
    if (!row.changedBy || !row.changedAt || !row.previousAfterHoursMode) throw new Error("invalid after-hours audit");
    return { version: String(row.version), mode: row.policy.afterHoursMode ?? "staffRequest",
      previousMode: row.previousAfterHoursMode,
      ...(row.policy.afterHoursInfo ? { infoVersion: row.policy.afterHoursInfo.version } : {}),
      actorRef: row.changedBy, changedAt: row.changedAt };
  });
}

function urgentAudit(data: Pick<ConfigArchiveData, "policies">): UrgentSettingAuditEntry[] {
  const ordered = [...data.policies].sort((left, right) => left.version - right.version);
  return ordered.filter(row => row.version > 0 && row.settingKind === "urgent").map(row => {
    const previous = ordered.find(item => item.version === row.version - 1);
    if (!previous || !row.changedBy || !row.changedAt) throw new Error("invalid urgent audit");
    return { version: String(row.version), enabled: row.policy.urgentResponse !== undefined,
      previousEnabled: previous.policy.urgentResponse !== undefined,
      ...(row.policy.urgentResponse ? { scriptVersion: row.policy.urgentResponse.version } : {}),
      actorRef: row.changedBy, changedAt: row.changedAt };
  });
}

function staffScheduleAudit(data: Pick<ConfigArchiveData, "policies">): StaffScheduleSettingAuditEntry[] {
  const ordered = [...data.policies].sort((left, right) => left.version - right.version);
  return ordered.filter(row => row.version > 0 && row.settingKind === "staffSchedule").map(row => {
    const previous = ordered.find(item => item.version === row.version - 1);
    if (!previous || !row.changedBy || !row.changedAt) throw new Error("invalid staff schedule audit");
    return { version: String(row.version), enabled: row.policy.staffSchedule !== undefined,
      previousEnabled: previous.policy.staffSchedule !== undefined,
      ...(row.policy.staffSchedule ? { scheduleVersion: row.policy.staffSchedule.version } : {}),
      actorRef: row.changedBy, changedAt: row.changedAt };
  });
}

function greetingAudit(data: Pick<ConfigArchiveData, "policies">): GreetingSettingAuditEntry[] {
  const ordered = [...data.policies].sort((left, right) => left.version - right.version);
  return ordered.filter(row => row.version > 0 && row.settingKind === "greeting").map(row => {
    const previous = ordered.find(item => item.version === row.version - 1);
    if (!previous || !row.changedBy || !row.changedAt) throw new Error("invalid greeting audit");
    return { version: String(row.version), enabled: row.policy.greeting !== undefined,
      previousEnabled: previous.policy.greeting !== undefined,
      ...(row.policy.greeting ? { greetingVersion: row.policy.greeting.version } : {}),
      actorRef: row.changedBy, changedAt: row.changedAt };
  });
}

function automationAudit(data: Pick<ConfigArchiveData, "automation">): AutomationSettingAuditEntry[] {
  return data.automation.filter(row => row.version > 0).map(row => {
    if (!row.changedBy || row.previousEnabled === null || !row.changedAt) throw new Error("invalid automation audit");
    return { version: String(row.version), enabled: row.enabled, previousEnabled: row.previousEnabled,
      actorRef: row.changedBy, changedAt: row.changedAt };
  });
}

export type MappedConfig = Readonly<{
  policy: CallPolicy;
  policyRows: readonly Readonly<{ version: number; isHead: boolean; policy: CallPolicy; changedBy: string | null;
    previousBookingEnabled: boolean | null; changedAt: string | null;
    settingKind?: "booking" | "afterHours" | "urgent" | "staffSchedule" | "greeting"; previousAfterHoursMode?: CallPolicy["afterHoursMode"] | null }>[];
  bookingHistory: readonly BookingSettingAuditEntry[];
  afterHoursHistory: readonly AfterHoursSettingAuditEntry[];
  urgentHistory: readonly UrgentSettingAuditEntry[];
  staffScheduleHistory: readonly StaffScheduleSettingAuditEntry[];
  greetingHistory: readonly GreetingSettingAuditEntry[];
  automationHistory: readonly AutomationSettingAuditEntry[];
  knowledge: MemoryKnowledgeCatalogue;
  knowledgeEntries: readonly KnowledgeEntry[];
  mappings: readonly ReferenceImportMapping[];
}>;

export function mapConfig(data: Pick<ConfigArchiveData, "sourceScope" | "policies" | "automation" | "knowledge">,
                          targetScope: LocationScope, mapper: ReferenceImportMapper):
  Result<MappedConfig, ReferenceImportFailure> {
  const decisions = new Map<string, ReferenceImportMapping>();
  const recordingMapper: ReferenceImportMapper = { mapRef: (kind, sourceRef, source, target) => {
    const key = JSON.stringify([kind, sourceRef]);
    const previous = decisions.get(key);
    if (previous) return previous.targetRef;
    let targetRef: string | null;
    try { targetRef = mapper.mapRef(kind, sourceRef, source, target); }
    catch { throw new UnmappedRef(); }
    if (!validRef(targetRef)) throw new UnmappedRef();
    decisions.set(key, { kind, sourceRef, targetRef });
    return targetRef;
  } };
  try {
    const policyRows = data.policies.map(row => ({ ...row,
      policy: mapImportedPolicy(row.policy, recordingMapper, data.sourceScope, targetScope) }));
    const policy = policyRows.find(row => row.isHead)?.policy ??
      mapImportedPolicy(referenceDefaultPolicy(data.sourceScope), recordingMapper, data.sourceScope, targetScope);
    const bookingHistory = bookingAudit(data);
    const afterHoursHistory = afterHoursAudit(data);
    const urgentHistory = urgentAudit(data);
    const staffScheduleHistory = staffScheduleAudit(data);
    const greetingHistory = greetingAudit(data);
    const automationHistory = automationAudit(data);
    const knowledgeEntries = data.knowledge.map(entry => ({ ...entry,
      scope: structuredClone(targetScope), ownerRef: mappedRef(recordingMapper, "knowledgeOwner", entry.ownerRef, data.sourceScope, targetScope) }));
    const knowledge = MemoryKnowledgeCatalogue.fromPublishedHistory(knowledgeEntries);
    return ok({ policy, policyRows, bookingHistory, afterHoursHistory, urgentHistory, staffScheduleHistory, greetingHistory, automationHistory,
      knowledge, knowledgeEntries, mappings: [...decisions.values()] });
  } catch (cause) {
    return err({ kind: cause instanceof UnmappedRef ? "unmappedRef" : "invalidConfigArchive" });
  }
}

function preflightReport(data: ConfigArchiveData, auditRef: string, mappings: readonly ReferenceImportMapping[],
                         status: ReferenceConfigPreflight["status"]): ReferenceConfigPreflight {
  return { archiveId: data.archiveId, manifestDigest: data.manifestDigest, auditRef,
    sourceScope: data.sourceScope, targetScope: data.targetScope, sourceSchemaVersion: data.sourceSchemaVersion,
    ...(data.sourceFenceVersion === undefined ? {} : { sourceFenceVersion: data.sourceFenceVersion }),
    recordCounts: { locations: 1, settings: data.policies.length + data.automation.length + data.writeStops.length,
      knowledge: data.knowledge.length, calls: data.sectionManifests.calls.recordCount, staffWork: 0 },
    omittedCalls: data.omittedCalls,
    ...(data.omittedTextCalls === undefined ? {} : { omittedTextCalls: data.omittedTextCalls }),
    mappings, status,
    plannedBookingEnabled: false, plannedAutomationEnabled: false, plannedWritesStopped: true };
}

/** Stages a source configuration in native reference stores; it does not publish a phone route. */
export class ReferenceConfigArchiveImporter {
  private readonly byArchive = new Map<string, Readonly<{ digest: string; staged: StagedReferenceConfiguration }>>();
  private readonly byTarget = new Map<string, string>();
  private readonly clock: () => string;

  constructor(clock: () => string = () => new Date().toISOString()) { this.clock = clock; }

  private async inspect(input: ArchiveEnvelope, targetScope: LocationScope, actorRef: string,
                        authority: ReferenceImportAuthority, mapper: ReferenceImportMapper):
    Promise<Result<Readonly<{ data: ConfigArchiveData; key: string; auditRef: string;
      existing?: StagedReferenceConfiguration }>, ReferenceImportFailure>> {
    if (!validRef(actorRef) || !targetScope || ![targetScope.tenantId, targetScope.clinicId, targetScope.locationId].every(validRef) ||
        !authority || typeof authority.authorizeAndRecord !== "function" || !mapper || typeof mapper.mapRef !== "function") {
      return err({ kind: "invalidRequest" });
    }
    let authorized: Awaited<ReturnType<ReferenceImportAuthority["authorizeAndRecord"]>>;
    try { authorized = await authority.authorizeAndRecord(actorRef, targetScope); }
    catch { return err({ kind: "auditFailure" }); }
    if (!authorized.ok) return err({ kind: authorized.error.kind });
    if (!validRef(authorized.value.auditRef)) return err({ kind: "auditFailure" });
    const decoded = await decodeConfigArchive(input, targetScope);
    if (!decoded.ok) return decoded;
    const data = decoded.value;
    const key = JSON.stringify([targetScope.tenantId, data.archiveId]);
    const existing = this.byArchive.get(key);
    if (existing) return existing.digest === data.manifestDigest
      ? ok({ data, key, auditRef: authorized.value.auditRef, existing: existing.staged })
      : err({ kind: "archiveConflict" });
    if (this.byTarget.has(scopeKey(targetScope))) return err({ kind: "targetOccupied" });
    return ok({ data, key, auditRef: authorized.value.auditRef });
  }

  /** Validates an archive and its host mapping without changing target configuration. */
  async preflight(input: ArchiveEnvelope, targetScope: LocationScope, actorRef: string,
                  authority: ReferenceImportAuthority, mapper: ReferenceImportMapper):
    Promise<Result<ReferenceConfigPreflight, ReferenceImportFailure>> {
    const inspected = await this.inspect(input, targetScope, actorRef, authority, mapper);
    if (!inspected.ok) return inspected;
    const { data, auditRef, existing } = inspected.value;
    if (existing) return ok(preflightReport(data, auditRef, existing.receipt.mappings, "alreadyStaged"));
    const mapped = mapConfig(data, targetScope, mapper);
    if (!mapped.ok) return mapped;
    return ok(preflightReport(data, auditRef, mapped.value.mappings, "ready"));
  }

  async stage(input: ArchiveEnvelope, targetScope: LocationScope, actorRef: string,
              authority: ReferenceImportAuthority, mapper: ReferenceImportMapper):
    Promise<Result<StagedReferenceConfiguration, ReferenceImportFailure>> {
    const inspected = await this.inspect(input, targetScope, actorRef, authority, mapper);
    if (!inspected.ok) return inspected;
    const { data, key, auditRef, existing } = inspected.value;
    if (existing) return ok(existing);
    const mapped = mapConfig(data, targetScope, mapper);
    if (!mapped.ok) return mapped;
    let importedAt: string;
    try { importedAt = this.clock(); }
    catch { return err({ kind: "invalidRequest" }); }
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(importedAt) || !Number.isFinite(Date.parse(importedAt))) {
      return err({ kind: "invalidRequest" });
    }
    const importActorRef = `import:${createHash("sha256").update(data.archiveId).digest("hex").slice(0, 32)}`;
    const automationHead = data.automation.find(row => row.isHead);
    const policy = MemoryPolicyStore.fromImported(targetScope, mapped.value.policy, mapped.value.bookingHistory,
      mapped.value.afterHoursHistory,
      mapped.value.automationHistory, automationHead?.version ?? 0, automationHead?.enabled ?? false, importActorRef, importedAt,
      mapped.value.urgentHistory, mapped.value.staffScheduleHistory, mapped.value.greetingHistory);
    const knowledge = mapped.value.knowledge;
    const ledger = new MemoryLedger();
    const stop = await ledger.stopWrites(targetScope, importActorRef, "Imported configuration awaiting target readiness");
    if (!stop.ok || !stop.value.stopped) return err({ kind: "invalidConfigArchive" });
    const effective = await policy.read(targetScope);
    if (!effective.ok || effective.value.bookingEnabled || effective.value.automationEnabled) return err({ kind: "invalidConfigArchive" });
    const receipt: ReferenceImportReceipt = { archiveId: data.archiveId, manifestDigest: data.manifestDigest,
      auditRef, sourceScope: data.sourceScope, targetScope: structuredClone(targetScope),
      sourceSchemaVersion: data.sourceSchemaVersion,
      ...(data.sourceFenceVersion === undefined ? {} : { sourceFenceVersion: data.sourceFenceVersion }),
      policyVersions: data.policies.length,
      automationVersions: data.automation.length, writeStopVersions: data.writeStops.length,
      publishedKnowledgeVersions: data.knowledge.length, omittedCalls: data.omittedCalls,
      ...(data.omittedTextCalls === undefined ? {} : { omittedTextCalls: data.omittedTextCalls }),
      mappings: mapped.value.mappings,
      importedPolicyVersion: effective.value.policyVersion,
      automationEnabled: false, bookingEnabled: false, writesStopped: true };
    const staged = { receipt, sourceHistory: data, policy, knowledge, ledger };
    const concurrent = this.byArchive.get(key);
    if (concurrent) return concurrent.digest === data.manifestDigest ? ok(concurrent.staged) : err({ kind: "archiveConflict" });
    if (this.byTarget.has(scopeKey(targetScope))) return err({ kind: "targetOccupied" });
    this.byArchive.set(key, { digest: data.manifestDigest, staged });
    this.byTarget.set(scopeKey(targetScope), key);
    return ok(staged);
  }
}
