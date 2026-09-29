import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { CallPolicy, LocationScope, Result, StaffDestination, StaffedInterval } from "../core/model.ts";
import { materializeVerifiedArchive } from "./archive-envelope.ts";
import type { ArchiveEnvelope, ArchiveEnvelopeFailure, ArchiveSection, ArchiveSectionManifest } from "./archive-envelope.ts";

export type ConfigArchiveData = Readonly<{
  archiveId: string;
  manifestDigest: string;
  createdAt: string;
  sourceSchemaVersion: string;
  sourceFenceVersion?: number;
  sectionManifests: Readonly<Record<ArchiveSection, ArchiveSectionManifest>>;
  sourceScope: LocationScope;
  targetScope: LocationScope;
  timeZone: string;
  mappingProvenance: string;
  policies: readonly Readonly<{ version: number; isHead: boolean; policy: CallPolicy; changedBy: string | null;
    previousBookingEnabled: boolean | null; changedAt: string | null }>[];
  automation: readonly Readonly<{ version: number; isHead: boolean; enabled: boolean; changedBy: string | null;
    previousEnabled: boolean | null; changedAt: string | null }>[];
  writeStops: readonly Readonly<{ version: number; isHead: boolean; stopped: boolean; actorRef: string;
    reasonDigest: string; changedAt: string }>[];
  knowledge: readonly PortablePublishedKnowledge[];
}>;

export type TenantConfigArchiveData = Readonly<{
  archiveId: string;
  manifestDigest: string;
  createdAt: string;
  sourceSchemaVersion: string;
  sourceFenceVersion?: number;
  sectionManifests: Readonly<Record<ArchiveSection, ArchiveSectionManifest>>;
  sourceTenantId: string;
  targetTenantId: string;
  locations: readonly Readonly<{
    sourceScope: LocationScope;
    targetScope: LocationScope;
    timeZone: string;
    mappingProvenance: string;
    policies: ConfigArchiveData["policies"];
    knowledge: readonly PortablePublishedKnowledge[];
  }>[];
  clinics: readonly Readonly<{
    sourceClinicId: string;
    automation: ConfigArchiveData["automation"];
    writeStops: ConfigArchiveData["writeStops"];
  }>[];
}>;

export type PortablePublishedKnowledge = Readonly<{
  scope: LocationScope;
  sourceRef: string;
  version: string;
  status: "approved" | "revoked";
  ownerRef: string;
  text: string;
  effectiveFrom: string;
  effectiveUntil: string;
  actorRef: string;
  changedAt: string;
}>;

export type ConfigArchiveDecodeFailure = ArchiveEnvelopeFailure | Readonly<{ kind: "invalidConfigArchive"; section?: ArchiveSection }>;

class InvalidConfigArchive extends Error {
  readonly section?: ArchiveSection;
  constructor(section?: ArchiveSection) { super("invalid config archive"); if (section) this.section = section; }
}

function object(value: unknown, section: ArchiveSection): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidConfigArchive(section);
  return value as Record<string, unknown>;
}

function ref(value: unknown, section: ArchiveSection): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new InvalidConfigArchive(section);
  return value;
}

function integer(value: unknown, section: ArchiveSection, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new InvalidConfigArchive(section);
  return Number(value);
}

function flag(value: unknown, section: ArchiveSection): boolean {
  if (typeof value !== "boolean") throw new InvalidConfigArchive(section);
  return value;
}

function instant(value: unknown, section: ArchiveSection): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value))) throw new InvalidConfigArchive(section);
  return value;
}

function optionalInstant(value: unknown, section: ArchiveSection): string | null {
  return value === null ? null : instant(value, section);
}

function optionalRef(value: unknown, section: ArchiveSection): string | null {
  return value === null ? null : ref(value, section);
}

function scope(value: unknown, section: ArchiveSection): LocationScope {
  const row = object(value, section);
  return { tenantId: ref(row.tenantId, section), clinicId: ref(row.clinicId, section), locationId: ref(row.locationId, section) };
}

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

function destination(value: unknown): StaffDestination {
  const row = object(value, "settings");
  if (row.kind === "owner") return { kind: "owner", ownerRef: ref(row.ownerRef, "settings") };
  if (row.kind === "queue") return { kind: "queue", queueRef: ref(row.queueRef, "settings") };
  throw new InvalidConfigArchive("settings");
}

function policy(value: unknown, sourceScope: LocationScope, version: number): CallPolicy {
  const row = object(value, "settings");
  const caps = object(row.capabilities, "settings");
  const modes = ["execute", "requestOnly", "unavailable"];
  const capability = (name: string) => {
    if (!modes.includes(caps[name] as string)) throw new InvalidConfigArchive("settings");
    return caps[name] as CallPolicy["capabilities"]["book"];
  };
  if (row.policyVersion !== String(version)) throw new InvalidConfigArchive("settings");
  const result: CallPolicy = { scope: sourceScope, policyVersion: String(version), automationVersion: "0", automationEnabled: false,
    bookingEnabled: flag(row.bookingEnabled, "settings"),
    capabilities: { book: capability("book"), cancel: capability("cancel"), reschedule: capability("reschedule"),
      intake: capability("intake"), transfer: capability("transfer") },
    staffDestination: destination(row.staffDestination), operatorQueue: destination(row.operatorQueue),
    ...(row.transferDestinationRef === undefined ? {} : { transferDestinationRef: ref(row.transferDestinationRef, "settings") }) };
  if (row.staffedIntervals !== undefined) {
    if (!Array.isArray(row.staffedIntervals)) throw new InvalidConfigArchive("settings");
    const intervals: StaffedInterval[] = row.staffedIntervals.map(value => {
      const item = object(value, "settings");
      return { startsAt: instant(item.startsAt, "settings"), endsAt: instant(item.endsAt, "settings") };
    });
    for (const item of intervals) if (Date.parse(item.endsAt) <= Date.parse(item.startsAt)) throw new InvalidConfigArchive("settings");
    return { ...result, staffedIntervals: intervals, ...(row.greeting === undefined ? {} : { greeting: greeting(row.greeting, sourceScope) }) };
  }
  return { ...result, ...(row.greeting === undefined ? {} : { greeting: greeting(row.greeting, sourceScope) }) };
}

function greeting(value: unknown, sourceScope: LocationScope): NonNullable<CallPolicy["greeting"]> {
  const row = object(value, "settings");
  if (row.approved !== true || typeof row.approvedText !== "string" || !row.approvedText.trim() || row.approvedText.length > 2_000) {
    throw new InvalidConfigArchive("settings");
  }
  return { scope: sourceScope, version: ref(row.version, "settings"), ownerRef: ref(row.ownerRef, "settings"),
    approvedText: row.approvedText, approved: true };
}

function expectedId(prefix: string, key: string, version: number): string {
  return `${prefix}:${createHash("sha256").update(key).digest("hex")}:${String(version).padStart(12, "0")}`;
}

function lines(bytes: Uint8Array, section: ArchiveSection): Record<string, unknown>[] {
  if (bytes.byteLength === 0) return [];
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.slice(0, -1).split("\n").map(line => object(JSON.parse(line), section));
  } catch { throw new InvalidConfigArchive(section); }
}

function assertHeads<T extends { version: number; isHead: boolean }>(records: readonly T[], section: ArchiveSection, firstVersion: number): void {
  const versions = new Set<number>();
  for (const row of records) {
    if (versions.has(row.version)) throw new InvalidConfigArchive(section);
    versions.add(row.version);
  }
  if (records.filter(row => row.isHead).length !== (records.length ? 1 : 0)) throw new InvalidConfigArchive(section);
  if (records.length > 0 && records.find(row => row.isHead)!.version !== records.reduce((max, row) => Math.max(max, row.version), 0)) {
    throw new InvalidConfigArchive(section);
  }
  for (let version = firstVersion; version < firstVersion + records.length; version += 1) {
    if (!versions.has(version)) throw new InvalidConfigArchive(section);
  }
}

type MutableLocation = {
  sourceScope: LocationScope;
  targetScope: LocationScope;
  timeZone: string;
  mappingProvenance: string;
  policies: ConfigArchiveData["policies"][number][];
  knowledge: PortablePublishedKnowledge[];
};

type MutableClinic = {
  sourceClinicId: string;
  automation: ConfigArchiveData["automation"][number][];
  writeStops: ConfigArchiveData["writeStops"][number][];
};

function locationKey(scope: LocationScope): string {
  return JSON.stringify([scope.clinicId, scope.locationId]);
}

/** Verifies one tenant archive and validates every configuration record before import. */
export async function decodeTenantConfigArchive(input: ArchiveEnvelope, expectedTargetTenantId: string):
  Promise<Result<TenantConfigArchiveData, ConfigArchiveDecodeFailure>> {
  if (typeof expectedTargetTenantId !== "string" || !expectedTargetTenantId.trim() ||
      expectedTargetTenantId.length > 256 || /[\u0000-\u001f\u007f]/.test(expectedTargetTenantId)) {
    return err({ kind: "invalidConfigArchive", section: "locations" });
  }
  const materialized = await materializeVerifiedArchive(input);
  if (!materialized.ok) return materialized;
  const { verified, sections, manifestBytes } = materialized.value;
  try {
    if (verified.manifest.sourceSystem !== "abby-postgres" || verified.manifest.sections.calls.recordCount !== 0 ||
        verified.manifest.sections.staffWork.recordCount !== 0) throw new InvalidConfigArchive();
    const metadata = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)), "locations");
    ref(metadata.exportRequestRef, "locations");
    const omissions = object(metadata.omittedCalls, "calls");
    if (["retentionExpired", "consentDenied", "notRetained", "activeCall"].some(name => omissions[name] !== 0)) {
      throw new InvalidConfigArchive("calls");
    }
    const locationRows = lines(sections.locations, "locations");
    if (locationRows.length < 1 || locationRows.length > 16) throw new InvalidConfigArchive("locations");
    const declared = metadata.locationMappings;
    if (!Array.isArray(declared) || declared.length !== locationRows.length) throw new InvalidConfigArchive("locations");
    const declaredMappings = new Map<string, Readonly<{ source: LocationScope; target: LocationScope; provenance: string }>>();
    for (const candidate of declared) {
      const row = object(candidate, "locations");
      const source = scope(row.sourceScope, "locations");
      const target = scope(row.targetScope, "locations");
      const provenance = ref(row.provenance, "locations");
      const key = locationKey(source);
      if (source.tenantId !== verified.manifest.sourceTenantId || target.tenantId !== expectedTargetTenantId ||
          declaredMappings.has(key)) throw new InvalidConfigArchive("locations");
      declaredMappings.set(key, { source, target, provenance });
    }
    const locations = new Map<string, MutableLocation>();
    const targetScopes = new Set<string>();
    const clinics = new Map<string, MutableClinic>();
    for (const row of locationRows) {
      const sourceScope = { tenantId: verified.manifest.sourceTenantId,
        clinicId: ref(row.sourceClinicId, "locations"), locationId: ref(row.sourceLocationId, "locations") };
      const key = locationKey(sourceScope);
      const targetScope = scope(row.targetScope, "locations");
      const timeZone = ref(row.timeZone, "locations");
      try { new Intl.DateTimeFormat("en", { timeZone }); }
      catch { throw new InvalidConfigArchive("locations"); }
      const mappingProvenance = ref(row.mappingProvenance, "locations");
      const declaredMapping = declaredMappings.get(key);
      const targetKey = JSON.stringify([targetScope.tenantId, targetScope.clinicId, targetScope.locationId]);
      if (locations.has(key) || targetScopes.has(targetKey) || targetScope.tenantId !== expectedTargetTenantId ||
          row.recordId !== expectedId("location", key, 1) || !declaredMapping ||
          !sameScope(declaredMapping.source, sourceScope) || !sameScope(declaredMapping.target, targetScope) ||
          declaredMapping.provenance !== mappingProvenance) throw new InvalidConfigArchive("locations");
      locations.set(key, { sourceScope, targetScope, timeZone, mappingProvenance, policies: [], knowledge: [] });
      targetScopes.add(targetKey);
      if (!clinics.has(sourceScope.clinicId)) clinics.set(sourceScope.clinicId,
        { sourceClinicId: sourceScope.clinicId, automation: [], writeStops: [] });
    }
    if (locations.size !== declaredMappings.size) throw new InvalidConfigArchive("locations");

    for (const row of lines(sections.settings, "settings")) {
      const version = integer(row.version, "settings", row.kind === "writeStop" ? 1 : 0);
      const sourceClinicId = ref(row.sourceClinicId, "settings");
      const clinic = clinics.get(sourceClinicId);
      if (!clinic) throw new InvalidConfigArchive("settings");
      const isHead = flag(row.isHead, "settings");
      if (row.kind === "locationPolicy") {
        const sourceLocationId = ref(row.sourceLocationId, "settings");
        const location = locations.get(JSON.stringify([sourceClinicId, sourceLocationId]));
        if (!location || row.recordId !== expectedId("policy", locationKey(location.sourceScope), version)) {
          throw new InvalidConfigArchive("settings");
        }
        location.policies.push({ version, isHead, policy: policy(row.policy, location.sourceScope, version),
          changedBy: optionalRef(row.changedBy, "settings"),
          previousBookingEnabled: row.previousBookingEnabled === null ? null : flag(row.previousBookingEnabled, "settings"),
          changedAt: optionalInstant(row.changedAt, "settings") });
      } else if (row.kind === "clinicAutomation") {
        if (row.recordId !== expectedId("automation", sourceClinicId, version)) throw new InvalidConfigArchive("settings");
        clinic.automation.push({ version, isHead, enabled: flag(row.enabled, "settings"),
          changedBy: optionalRef(row.changedBy, "settings"),
          previousEnabled: row.previousEnabled === null ? null : flag(row.previousEnabled, "settings"),
          changedAt: optionalInstant(row.changedAt, "settings") });
      } else if (row.kind === "writeStop") {
        if (row.recordId !== expectedId("writeStop", sourceClinicId, version) ||
            typeof row.reasonDigest !== "string" || !/^[a-f0-9]{64}$/.test(row.reasonDigest)) {
          throw new InvalidConfigArchive("settings");
        }
        clinic.writeStops.push({ version, isHead, stopped: flag(row.stopped, "settings"),
          actorRef: ref(row.actorRef, "settings"), reasonDigest: row.reasonDigest,
          changedAt: instant(row.changedAt, "settings") });
      } else throw new InvalidConfigArchive("settings");
    }
    for (const location of locations.values()) assertHeads(location.policies, "settings", 0);
    for (const clinic of clinics.values()) {
      assertHeads(clinic.automation, "settings", 0);
      assertHeads(clinic.writeStops, "settings", 1);
    }

    const publishedHeads = new Map<string, number>();
    const sourceVersions = new Map<string, Set<number>>();
    for (const row of lines(sections.knowledge, "knowledge")) {
      const sourceClinicId = ref(row.sourceClinicId, "knowledge");
      const sourceLocationId = ref(row.sourceLocationId, "knowledge");
      const location = locations.get(JSON.stringify([sourceClinicId, sourceLocationId]));
      const sourceRef = ref(row.sourceRef, "knowledge");
      const version = integer(row.version, "knowledge", 1);
      const sourceKey = JSON.stringify([sourceClinicId, sourceLocationId, sourceRef]);
      if (!location || row.recordId !== expectedId("knowledge", sourceKey, version) ||
          (row.status !== "approved" && row.status !== "revoked") || typeof row.approvedText !== "string" ||
          !row.approvedText.trim() || row.approvedText.length > 2_000 ||
          row.contentDigest !== createHash("sha256").update(row.approvedText).digest("hex")) {
        throw new InvalidConfigArchive("knowledge");
      }
      const used = sourceVersions.get(sourceKey) ?? new Set<number>();
      if (used.has(version)) throw new InvalidConfigArchive("knowledge");
      used.add(version);
      sourceVersions.set(sourceKey, used);
      if (flag(row.isPublishedHead, "knowledge")) {
        if (publishedHeads.has(sourceKey)) throw new InvalidConfigArchive("knowledge");
        publishedHeads.set(sourceKey, version);
      }
      const effectiveFrom = instant(row.effectiveFrom, "knowledge");
      const effectiveUntil = instant(row.effectiveUntil, "knowledge");
      if (Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) throw new InvalidConfigArchive("knowledge");
      location.knowledge.push({ scope: location.sourceScope, sourceRef, version: String(version), status: row.status,
        ownerRef: ref(row.ownerRef, "knowledge"), text: row.approvedText, actorRef: ref(row.actorRef, "knowledge"),
        effectiveFrom, effectiveUntil, changedAt: instant(row.changedAt, "knowledge") });
    }
    for (const [sourceKey, versions] of sourceVersions) {
      if (publishedHeads.get(sourceKey) !== [...versions].reduce((max, version) => Math.max(max, version), 0)) {
        throw new InvalidConfigArchive("knowledge");
      }
    }
    return ok({ archiveId: verified.manifest.archiveId, manifestDigest: verified.manifestDigest,
      createdAt: verified.manifest.createdAt, sourceSchemaVersion: verified.manifest.sourceSchemaVersion,
      ...(verified.manifest.sourceFenceVersion === undefined ? {} : { sourceFenceVersion: verified.manifest.sourceFenceVersion }),
      sectionManifests: verified.manifest.sections, sourceTenantId: verified.manifest.sourceTenantId,
      targetTenantId: expectedTargetTenantId, locations: [...locations.values()], clinics: [...clinics.values()] });
  } catch (cause) {
    return err({ kind: "invalidConfigArchive", ...(cause instanceof InvalidConfigArchive && cause.section ? { section: cause.section } : {}) });
  }
}

/** The one-location importer retains its original typed view and rejects tenant-wide archives. */
export async function decodeConfigArchive(input: ArchiveEnvelope, expectedTargetScope: LocationScope):
  Promise<Result<ConfigArchiveData, ConfigArchiveDecodeFailure>> {
  if (!expectedTargetScope || typeof expectedTargetScope !== "object") {
    return err({ kind: "invalidConfigArchive", section: "locations" });
  }
  const decoded = await decodeTenantConfigArchive(input, expectedTargetScope.tenantId);
  if (!decoded.ok) return decoded;
  const data = decoded.value;
  const location = data.locations[0];
  if (data.locations.length !== 1 || data.clinics.length !== 1 || !location ||
      !sameScope(location.targetScope, expectedTargetScope)) return err({ kind: "invalidConfigArchive", section: "locations" });
  const clinic = data.clinics[0]!;
  return ok({ archiveId: data.archiveId, manifestDigest: data.manifestDigest, createdAt: data.createdAt,
    sourceSchemaVersion: data.sourceSchemaVersion,
    ...(data.sourceFenceVersion === undefined ? {} : { sourceFenceVersion: data.sourceFenceVersion }),
    sectionManifests: data.sectionManifests,
    sourceScope: location.sourceScope, targetScope: location.targetScope, timeZone: location.timeZone,
    mappingProvenance: location.mappingProvenance, policies: location.policies, automation: clinic.automation,
    writeStops: clinic.writeStops, knowledge: location.knowledge });
}
