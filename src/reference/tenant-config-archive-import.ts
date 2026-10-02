import { createHash } from "node:crypto";
import { MemoryLedger } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { ArchiveEnvelope, ArchiveSection } from "../portability/archive-envelope.ts";
import { decodeTenantConfigArchive } from "../portability/config-archive.ts";
import type { ConfigArchiveData, TenantConfigArchiveData } from "../portability/config-archive.ts";
import { mapConfig } from "./config-archive-import.ts";
import type { MappedConfig, ReferenceImportFailure, ReferenceImportMapper, ReferenceImportMapping } from "./config-archive-import.ts";
import { MemoryKnowledgeCatalogue } from "./knowledge-catalogue.ts";
import { MemoryPolicyStore } from "./policy-store.ts";
import type { ImportedReferenceClinicAutomation, ImportedReferenceLocationPolicy } from "./policy-store.ts";

export type ReferenceTenantImportAuthority = Readonly<{
  authorizeAndRecord(actorRef: string, targetTenantId: string): Promise<Result<Readonly<{ auditRef: string }>,
    Readonly<{ kind: "denied" | "auditFailure" }>>>;
}>;

export type ReferenceTenantImportFailure = ReferenceImportFailure | Readonly<{ kind: "invalidMapping" }>;

export type TenantImportMapping = ReferenceImportMapping & Readonly<{
  sourceScope: LocationScope;
  targetScope: LocationScope;
}>;

export type TenantImportLocation = Readonly<{
  sourceScope: LocationScope;
  targetScope: LocationScope;
  omittedTextCalls?: number;
  policyVersions: number;
  publishedKnowledgeVersions: number;
  importedPolicyVersion?: string;
}>;

export type ReferenceTenantImportReport = Readonly<{
  archiveId: string;
  manifestDigest: string;
  auditRef: string;
  sourceTenantId: string;
  targetTenantId: string;
  sourceSchemaVersion: string;
  sourceFenceVersion?: number;
  recordCounts: Readonly<Record<ArchiveSection, number>>;
  sectionDigests: Readonly<Record<ArchiveSection, string>>;
  omittedCalls: TenantConfigArchiveData["omittedCalls"];
  locations: readonly TenantImportLocation[];
  mappings: readonly TenantImportMapping[];
  status: "ready" | "alreadyStaged" | "staged";
  bookingEnabled: false;
  automationEnabled: false;
  writesStopped: true;
}>;

export type StagedReferenceTenantConfiguration = Readonly<{
  receipt: ReferenceTenantImportReport;
  sourceHistory: TenantConfigArchiveData;
  policy: MemoryPolicyStore;
  knowledge: MemoryKnowledgeCatalogue;
  ledger: MemoryLedger;
}>;

type PreparedLocation = Readonly<{
  sourceScope: LocationScope;
  targetScope: LocationScope;
  source: TenantConfigArchiveData["locations"][number];
  mapped: MappedConfig;
}>;

type PreparedTenant = Readonly<{
  locations: readonly PreparedLocation[];
  clinics: readonly ImportedReferenceClinicAutomation[];
  knowledge: MemoryKnowledgeCatalogue;
  mappings: readonly TenantImportMapping[];
}>;

function validRef(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function prepare(data: TenantConfigArchiveData, mapper: ReferenceImportMapper):
  Result<PreparedTenant, ReferenceTenantImportFailure> {
  const sourceToTargetClinic = new Map<string, string>();
  const targetToSourceClinic = new Map<string, string>();
  const locations: PreparedLocation[] = [];
  const mappings: TenantImportMapping[] = [];
  const clinics = new Map<string, ImportedReferenceClinicAutomation>();
  for (const location of data.locations) {
    const sourceClinicId = location.sourceScope.clinicId;
    const targetClinicId = location.targetScope.clinicId;
    if ((sourceToTargetClinic.has(sourceClinicId) && sourceToTargetClinic.get(sourceClinicId) !== targetClinicId) ||
        (targetToSourceClinic.has(targetClinicId) && targetToSourceClinic.get(targetClinicId) !== sourceClinicId)) {
      return err({ kind: "invalidMapping" });
    }
    sourceToTargetClinic.set(sourceClinicId, targetClinicId);
    targetToSourceClinic.set(targetClinicId, sourceClinicId);
    const clinic = data.clinics.find(entry => entry.sourceClinicId === sourceClinicId);
    if (!clinic) return err({ kind: "invalidConfigArchive" });
    const scoped: ConfigArchiveData = { archiveId: data.archiveId, manifestDigest: data.manifestDigest,
      createdAt: data.createdAt, sourceSchemaVersion: data.sourceSchemaVersion,
      sectionManifests: data.sectionManifests, omittedCalls: data.omittedCalls,
      ...(location.omittedTextCalls === undefined ? {} : { omittedTextCalls: location.omittedTextCalls }),
      sourceScope: location.sourceScope, targetScope: location.targetScope,
      timeZone: location.timeZone, mappingProvenance: location.mappingProvenance,
      policies: location.policies, automation: clinic.automation, writeStops: clinic.writeStops,
      knowledge: location.knowledge };
    const mapped = mapConfig(scoped, location.targetScope, mapper);
    if (!mapped.ok) return mapped;
    locations.push({ sourceScope: location.sourceScope, targetScope: location.targetScope, source: location, mapped: mapped.value });
    mappings.push(...mapped.value.mappings.map(decision => ({ ...decision,
      sourceScope: location.sourceScope, targetScope: location.targetScope })));
    if (!clinics.has(sourceClinicId)) {
      const head = clinic.automation.find(row => row.isHead);
      clinics.set(sourceClinicId, { scope: location.targetScope, history: mapped.value.automationHistory,
        sourceVersion: head?.version ?? 0, sourceEnabled: head?.enabled ?? false });
    }
  }
  try {
    const knowledge = MemoryKnowledgeCatalogue.fromPublishedHistory(locations.flatMap(location => location.mapped.knowledgeEntries));
    return ok({ locations, clinics: [...clinics.values()], knowledge, mappings });
  } catch { return err({ kind: "invalidConfigArchive" }); }
}

function report(data: TenantConfigArchiveData, auditRef: string, prepared: PreparedTenant,
                status: ReferenceTenantImportReport["status"], importedVersions?: ReadonlyMap<string, string>):
  ReferenceTenantImportReport {
  return { archiveId: data.archiveId, manifestDigest: data.manifestDigest, auditRef,
    sourceTenantId: data.sourceTenantId, targetTenantId: data.targetTenantId,
    sourceSchemaVersion: data.sourceSchemaVersion,
    ...(data.sourceFenceVersion === undefined ? {} : { sourceFenceVersion: data.sourceFenceVersion }),
    recordCounts: { locations: data.sectionManifests.locations.recordCount,
      settings: data.sectionManifests.settings.recordCount, knowledge: data.sectionManifests.knowledge.recordCount,
      calls: data.sectionManifests.calls.recordCount, staffWork: 0 },
    sectionDigests: { locations: data.sectionManifests.locations.sha256,
      settings: data.sectionManifests.settings.sha256, knowledge: data.sectionManifests.knowledge.sha256,
      calls: data.sectionManifests.calls.sha256, staffWork: data.sectionManifests.staffWork.sha256 },
    omittedCalls: data.omittedCalls,
    locations: prepared.locations.map(location => ({ sourceScope: location.sourceScope,
      targetScope: location.targetScope, policyVersions: location.source.policies.length,
      publishedKnowledgeVersions: location.source.knowledge.length,
      ...(location.source.omittedTextCalls === undefined ? {} : { omittedTextCalls: location.source.omittedTextCalls }),
      ...(importedVersions?.has(JSON.stringify(location.targetScope))
        ? { importedPolicyVersion: importedVersions.get(JSON.stringify(location.targetScope))! } : {}) })),
    mappings: prepared.mappings, status, bookingEnabled: false, automationEnabled: false, writesStopped: true };
}

/** Stages all target locations together in one native reference-host configuration. */
export class ReferenceTenantConfigArchiveImporter {
  private readonly byArchive = new Map<string, Readonly<{ digest: string; staged: StagedReferenceTenantConfiguration }>>();
  private readonly byTenant = new Map<string, string>();
  private readonly clock: () => string;
  constructor(clock: () => string = () => new Date().toISOString()) { this.clock = clock; }

  private async inspect(input: ArchiveEnvelope, targetTenantId: string, actorRef: string,
                        authority: ReferenceTenantImportAuthority, mapper: ReferenceImportMapper):
    Promise<Result<Readonly<{ data: TenantConfigArchiveData; auditRef: string; key: string;
      existing?: StagedReferenceTenantConfiguration }>, ReferenceTenantImportFailure>> {
    if (!validRef(targetTenantId) || !validRef(actorRef) || !authority ||
        typeof authority.authorizeAndRecord !== "function" || !mapper || typeof mapper.mapRef !== "function") {
      return err({ kind: "invalidRequest" });
    }
    let authorized: Awaited<ReturnType<ReferenceTenantImportAuthority["authorizeAndRecord"]>>;
    try { authorized = await authority.authorizeAndRecord(actorRef, targetTenantId); }
    catch { return err({ kind: "auditFailure" }); }
    if (!authorized.ok) return err({ kind: authorized.error.kind });
    if (!validRef(authorized.value.auditRef)) return err({ kind: "auditFailure" });
    const decoded = await decodeTenantConfigArchive(input, targetTenantId);
    if (!decoded.ok) return decoded;
    const data = decoded.value;
    const key = JSON.stringify([targetTenantId, data.archiveId]);
    const existing = this.byArchive.get(key);
    if (existing) return existing.digest === data.manifestDigest
      ? ok({ data, auditRef: authorized.value.auditRef, key, existing: existing.staged })
      : err({ kind: "archiveConflict" });
    if (this.byTenant.has(targetTenantId)) return err({ kind: "targetOccupied" });
    return ok({ data, auditRef: authorized.value.auditRef, key });
  }

  async preflight(input: ArchiveEnvelope, targetTenantId: string, actorRef: string,
                  authority: ReferenceTenantImportAuthority, mapper: ReferenceImportMapper):
    Promise<Result<ReferenceTenantImportReport, ReferenceTenantImportFailure>> {
    const inspected = await this.inspect(input, targetTenantId, actorRef, authority, mapper);
    if (!inspected.ok) return inspected;
    const { data, auditRef, existing } = inspected.value;
    if (existing) return ok({ ...existing.receipt, auditRef, status: "alreadyStaged" });
    const prepared = prepare(data, mapper);
    if (!prepared.ok) return prepared;
    return ok(report(data, auditRef, prepared.value, "ready"));
  }

  async stage(input: ArchiveEnvelope, targetTenantId: string, actorRef: string,
              authority: ReferenceTenantImportAuthority, mapper: ReferenceImportMapper):
    Promise<Result<StagedReferenceTenantConfiguration, ReferenceTenantImportFailure>> {
    const inspected = await this.inspect(input, targetTenantId, actorRef, authority, mapper);
    if (!inspected.ok) return inspected;
    const { data, auditRef, key, existing } = inspected.value;
    if (existing) return ok(existing);
    const prepared = prepare(data, mapper);
    if (!prepared.ok) return prepared;
    let importedAt: string;
    try { importedAt = this.clock(); }
    catch { return err({ kind: "invalidRequest" }); }
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(importedAt) ||
        !Number.isFinite(Date.parse(importedAt))) return err({ kind: "invalidRequest" });
    const importActorRef = `import:${createHash("sha256").update(data.archiveId).digest("hex").slice(0, 32)}`;
    let policy: MemoryPolicyStore;
    try {
      const locations: ImportedReferenceLocationPolicy[] = prepared.value.locations.map(location => ({
        scope: location.targetScope, policy: location.mapped.policy,
        bookingHistory: location.mapped.bookingHistory,
        afterHoursHistory: location.mapped.afterHoursHistory,
        urgentHistory: location.mapped.urgentHistory,
        staffScheduleHistory: location.mapped.staffScheduleHistory,
        greetingHistory: location.mapped.greetingHistory,
        cancellationHistory: location.mapped.cancellationHistory, reschedulingHistory: location.mapped.reschedulingHistory }));
      policy = MemoryPolicyStore.fromImportedMany(locations, prepared.value.clinics, importActorRef, importedAt);
    } catch { return err({ kind: "invalidConfigArchive" }); }
    const ledger = new MemoryLedger();
    for (const clinic of prepared.value.clinics) {
      const stopped = await ledger.stopWrites(clinic.scope, importActorRef, "Imported configuration awaiting target readiness");
      if (!stopped.ok || !stopped.value.stopped) return err({ kind: "invalidConfigArchive" });
    }
    const importedVersions = new Map<string, string>();
    for (const location of prepared.value.locations) {
      const effective = await policy.read(location.targetScope);
      if (!effective.ok || effective.value.bookingEnabled || effective.value.automationEnabled ||
          effective.value.capabilities.book !== "unavailable") return err({ kind: "invalidConfigArchive" });
      importedVersions.set(JSON.stringify(location.targetScope), effective.value.policyVersion);
    }
    const receipt = report(data, auditRef, prepared.value, "staged", importedVersions);
    const staged = { receipt, sourceHistory: data, policy, knowledge: prepared.value.knowledge, ledger };
    const concurrent = this.byArchive.get(key);
    if (concurrent) return concurrent.digest === data.manifestDigest ? ok(concurrent.staged) : err({ kind: "archiveConflict" });
    if (this.byTenant.has(targetTenantId)) return err({ kind: "targetOccupied" });
    this.byArchive.set(key, { digest: data.manifestDigest, staged });
    this.byTenant.set(targetTenantId, key);
    return ok(staged);
  }
}
