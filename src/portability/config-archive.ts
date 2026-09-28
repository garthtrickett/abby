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

/** Semantic preflight for the current configuration-only source format. */
export async function decodeConfigArchive(input: ArchiveEnvelope, expectedTargetScope: LocationScope):
  Promise<Result<ConfigArchiveData, ConfigArchiveDecodeFailure>> {
  const materialized = await materializeVerifiedArchive(input);
  if (!materialized.ok) return materialized;
  const { verified, sections, manifestBytes } = materialized.value;
  try {
    if (verified.manifest.sourceSystem !== "abby-postgres" || verified.manifest.sections.calls.recordCount !== 0 ||
        verified.manifest.sections.staffWork.recordCount !== 0) throw new InvalidConfigArchive();
    const metadata = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)), "locations");
    if (ref(metadata.exportRequestRef, "locations").length === 0) throw new InvalidConfigArchive("locations");
    const omissions = object(metadata.omittedCalls, "calls");
    if (["retentionExpired", "consentDenied", "notRetained", "activeCall"].some(name => omissions[name] !== 0)) throw new InvalidConfigArchive("calls");
    const locationRows = lines(sections.locations, "locations");
    if (locationRows.length !== 1) throw new InvalidConfigArchive("locations");
    const location = locationRows[0]!;
    const sourceScope = { tenantId: verified.manifest.sourceTenantId,
      clinicId: ref(location.sourceClinicId, "locations"), locationId: ref(location.sourceLocationId, "locations") };
    const targetScope = scope(location.targetScope, "locations");
    if (!sameScope(targetScope, expectedTargetScope) || location.recordId !== expectedId("location", JSON.stringify([sourceScope.clinicId, sourceScope.locationId]), 1)) {
      throw new InvalidConfigArchive("locations");
    }
    const timeZone = ref(location.timeZone, "locations");
    try { new Intl.DateTimeFormat("en", { timeZone }); }
    catch { throw new InvalidConfigArchive("locations"); }
    const mappingProvenance = ref(location.mappingProvenance, "locations");
    const mappings = metadata.locationMappings;
    if (!Array.isArray(mappings) || mappings.length !== 1 ||
        !sameScope(scope(object(mappings[0], "locations").sourceScope, "locations"), sourceScope) ||
        !sameScope(scope(object(mappings[0], "locations").targetScope, "locations"), targetScope) ||
        object(mappings[0], "locations").provenance !== mappingProvenance) throw new InvalidConfigArchive("locations");

    const settings = lines(sections.settings, "settings");
    const policies: ConfigArchiveData["policies"][number][] = [];
    const automation: ConfigArchiveData["automation"][number][] = [];
    const writeStops: ConfigArchiveData["writeStops"][number][] = [];
    for (const row of settings) {
      const version = integer(row.version, "settings", row.kind === "writeStop" ? 1 : 0);
      const sourceClinicId = ref(row.sourceClinicId, "settings");
      if (sourceClinicId !== sourceScope.clinicId) throw new InvalidConfigArchive("settings");
      const isHead = flag(row.isHead, "settings");
      if (row.kind === "locationPolicy") {
        if (row.sourceLocationId !== sourceScope.locationId ||
            row.recordId !== expectedId("policy", JSON.stringify([sourceScope.clinicId, sourceScope.locationId]), version)) throw new InvalidConfigArchive("settings");
        policies.push({ version, isHead, policy: policy(row.policy, sourceScope, version),
          changedBy: optionalRef(row.changedBy, "settings"), previousBookingEnabled: row.previousBookingEnabled === null ? null : flag(row.previousBookingEnabled, "settings"),
          changedAt: optionalInstant(row.changedAt, "settings") });
      } else if (row.kind === "clinicAutomation") {
        if (row.recordId !== expectedId("automation", sourceScope.clinicId, version)) throw new InvalidConfigArchive("settings");
        automation.push({ version, isHead, enabled: flag(row.enabled, "settings"),
          changedBy: optionalRef(row.changedBy, "settings"), previousEnabled: row.previousEnabled === null ? null : flag(row.previousEnabled, "settings"),
          changedAt: optionalInstant(row.changedAt, "settings") });
      } else if (row.kind === "writeStop") {
        if (row.recordId !== expectedId("writeStop", sourceScope.clinicId, version) ||
            typeof row.reasonDigest !== "string" || !/^[a-f0-9]{64}$/.test(row.reasonDigest)) throw new InvalidConfigArchive("settings");
        writeStops.push({ version, isHead, stopped: flag(row.stopped, "settings"), actorRef: ref(row.actorRef, "settings"),
          reasonDigest: row.reasonDigest, changedAt: instant(row.changedAt, "settings") });
      } else throw new InvalidConfigArchive("settings");
    }
    assertHeads(policies, "settings", 0);
    assertHeads(automation, "settings", 0);
    assertHeads(writeStops, "settings", 1);

    const knowledge: PortablePublishedKnowledge[] = [];
    const publishedHeads = new Map<string, number>();
    const sourceVersions = new Map<string, Set<number>>();
    for (const row of lines(sections.knowledge, "knowledge")) {
      const sourceRef = ref(row.sourceRef, "knowledge");
      const version = integer(row.version, "knowledge", 1);
      if (row.sourceClinicId !== sourceScope.clinicId || row.sourceLocationId !== sourceScope.locationId ||
          row.recordId !== expectedId("knowledge", JSON.stringify([sourceScope.clinicId, sourceScope.locationId, sourceRef]), version) ||
          (row.status !== "approved" && row.status !== "revoked") || typeof row.approvedText !== "string" ||
          !row.approvedText.trim() || row.approvedText.length > 2_000 ||
          row.contentDigest !== createHash("sha256").update(row.approvedText).digest("hex")) throw new InvalidConfigArchive("knowledge");
      const used = sourceVersions.get(sourceRef) ?? new Set<number>();
      if (used.has(version)) throw new InvalidConfigArchive("knowledge");
      used.add(version);
      sourceVersions.set(sourceRef, used);
      if (flag(row.isPublishedHead, "knowledge")) {
        if (publishedHeads.has(sourceRef)) throw new InvalidConfigArchive("knowledge");
        publishedHeads.set(sourceRef, version);
      }
      const effectiveFrom = instant(row.effectiveFrom, "knowledge");
      const effectiveUntil = instant(row.effectiveUntil, "knowledge");
      if (Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) throw new InvalidConfigArchive("knowledge");
      knowledge.push({ scope: sourceScope, sourceRef, version: String(version), status: row.status,
        ownerRef: ref(row.ownerRef, "knowledge"), text: row.approvedText, actorRef: ref(row.actorRef, "knowledge"),
        effectiveFrom, effectiveUntil, changedAt: instant(row.changedAt, "knowledge") });
    }
    for (const [sourceRef, versions] of sourceVersions) {
      if (publishedHeads.get(sourceRef) !== [...versions].reduce((max, version) => Math.max(max, version), 0)) throw new InvalidConfigArchive("knowledge");
    }
    return ok({ archiveId: verified.manifest.archiveId, manifestDigest: verified.manifestDigest,
      createdAt: verified.manifest.createdAt, sourceSchemaVersion: verified.manifest.sourceSchemaVersion,
      sectionManifests: verified.manifest.sections,
      sourceScope, targetScope, timeZone, mappingProvenance, policies, automation, writeStops, knowledge });
  } catch (cause) {
    return err({ kind: "invalidConfigArchive", ...(cause instanceof InvalidConfigArchive && cause.section ? { section: cause.section } : {}) });
  }
}
