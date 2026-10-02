import { validClinicIntakeArchiveHistory } from "./clinic-intake-history.ts";
import type { ClinicIntakeArchiveRow } from "./clinic-intake-history.ts";
import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { AfterHoursMode, ApprovedAfterHoursInfo, ApprovedStaffSchedule, ApprovedUrgentResponse, CallPolicy, LocationScope, Result, StaffDestination, StaffedInterval } from "../core/model.ts";
import { validAfterHoursSetting } from "../core/after-hours-policy.ts";
import { validGreetingShape } from "../core/greeting.ts";
import { expandStaffSchedule, validStaffScheduleApproval } from "../core/staff-schedule.ts";
import { validUrgentResponseShape } from "../core/urgent-response.ts";
import { materializeVerifiedArchive } from "./archive-envelope.ts";
import type { ArchiveEnvelope, ArchiveEnvelopeFailure, ArchiveSection, ArchiveSectionManifest } from "./archive-envelope.ts";

export type ConfigArchiveData = Readonly<{
  archiveId: string;
  manifestDigest: string;
  createdAt: string;
  sourceSchemaVersion: string;
  sourceFenceVersion?: number;
  sectionManifests: Readonly<Record<ArchiveSection, ArchiveSectionManifest>>;
  omittedCalls: OmittedCalls;
  /** Present in archive v2; v1 has only a tenant-wide omission total. */
  omittedTextCalls?: number;
  sourceScope: LocationScope;
  targetScope: LocationScope;
  timeZone: string;
  mappingProvenance: string;
  policies: readonly Readonly<{ version: number; isHead: boolean; storageShape: "standaloneMinimal" | "unsafeReference";
    policy: CallPolicy; changedBy: string | null;
    previousBookingEnabled: boolean | null; changedAt: string | null;
    /** Absent on archives written before location settings had distinct audit kinds. */
    settingKind?: "booking" | "afterHours" | "urgent" | "staffSchedule" | "greeting" | "cancellation" | "rescheduling";
    previousCancellationEnabled?: boolean | null;
    previousReschedulingEnabled?: boolean | null;
    previousAfterHoursMode?: AfterHoursMode | null }>[];
  automation: readonly Readonly<{ version: number; isHead: boolean; enabled: boolean; changedBy: string | null;
    previousEnabled: boolean | null; changedAt: string | null }>[];
  /** Absent in legacy archives: clinic version zero, disabled, with no audit history. */
  clinicIntake?: readonly ClinicIntakeArchiveRow[];
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
  omittedCalls: OmittedCalls;
  sourceTenantId: string;
  targetTenantId: string;
  locations: readonly Readonly<{
    sourceScope: LocationScope;
    targetScope: LocationScope;
    timeZone: string;
    mappingProvenance: string;
    /** Present in archive v2; absent for legacy v1 imports. */
    omittedTextCalls?: number;
    policies: ConfigArchiveData["policies"];
    knowledge: readonly PortablePublishedKnowledge[];
  }>[];
  clinics: readonly Readonly<{
    sourceClinicId: string;
    automation: ConfigArchiveData["automation"];
    clinicIntake?: readonly ClinicIntakeArchiveRow[];
    writeStops: ConfigArchiveData["writeStops"];
  }>[];
}>;

export type OmittedCalls = Readonly<{
  retentionExpired: 0;
  consentDenied: 0;
  notRetained: number;
  activeCall: 0;
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

function afterHoursInfo(value: unknown, sourceScope: LocationScope): ApprovedAfterHoursInfo {
  const row = object(value, "settings");
  if (Object.keys(row).sort().join(",") !== "approved,approvedText,ownerRef,version") {
    throw new InvalidConfigArchive("settings");
  }
  const info = { scope: sourceScope, version: ref(row.version, "settings"),
    ownerRef: ref(row.ownerRef, "settings"), approvedText: row.approvedText, approved: row.approved };
  if (!validAfterHoursSetting("approvedInfoAndRequest", info, sourceScope)) throw new InvalidConfigArchive("settings");
  return info as ApprovedAfterHoursInfo;
}

function afterHoursFields(row: Record<string, unknown>, sourceScope: LocationScope):
  Pick<CallPolicy, "afterHoursMode" | "afterHoursInfo"> {
  const mode = row.afterHoursMode ?? "staffRequest";
  const info = row.afterHoursInfo === undefined ? undefined : afterHoursInfo(row.afterHoursInfo, sourceScope);
  if (!validAfterHoursSetting(mode, info, sourceScope)) throw new InvalidConfigArchive("settings");
  return { afterHoursMode: mode as AfterHoursMode, ...(info ? { afterHoursInfo: info } : {}) };
}

function urgentFields(row: Record<string, unknown>, sourceScope: LocationScope):
  Pick<CallPolicy, "urgentResponse"> {
  if (row.urgentResponse === undefined) return {};
  const value = object(row.urgentResponse, "settings");
  if (Object.keys(value).sort().join(",") !==
      "approved,approvedText,effectiveFrom,effectiveUntil,ownerRef,version") throw new InvalidConfigArchive("settings");
  const response = { ...value, scope: sourceScope };
  if (!validUrgentResponseShape(response, sourceScope)) throw new InvalidConfigArchive("settings");
  return { urgentResponse: response as ApprovedUrgentResponse };
}

function policy(value: unknown, sourceScope: LocationScope, version: number): CallPolicy {
  const row = object(value, "settings");
  if (row.shape === "standaloneMinimal") {
    if (!["bookingEnabled", "policyVersion", "shape"].every(field => Object.hasOwn(row, field)) ||
        Object.keys(row).some(field => !["bookingEnabled", "cancellationEnabled", "reschedulingEnabled", "policyVersion", "shape", "afterHoursMode",
          "afterHoursInfo", "urgentResponse", "staffSchedule", "greeting"].includes(field)) ||
        row.policyVersion !== String(version)) throw new InvalidConfigArchive("settings");
    return { scope: sourceScope, policyVersion: String(version), automationVersion: "0", automationEnabled: false,
      bookingEnabled: flag(row.bookingEnabled, "settings"),
      cancellationEnabled: row.cancellationEnabled === undefined ? false : flag(row.cancellationEnabled, "settings"),
    reschedulingEnabled: row.reschedulingEnabled === undefined ? false : flag(row.reschedulingEnabled, "settings"),
      ...afterHoursFields(row, sourceScope), ...urgentFields(row, sourceScope),
      ...(row.staffSchedule === undefined ? {} : { staffSchedule: approvedStaffSchedule(row.staffSchedule, sourceScope) }),
      ...(row.greeting === undefined ? {} : { greeting: greeting(row.greeting, sourceScope) }),
      capabilities: { book: "unavailable", cancel: "unavailable", reschedule: "unavailable", intake: "unavailable", transfer: "unavailable" },
      staffDestination: { kind: "queue", queueRef: "disabled" }, operatorQueue: { kind: "queue", queueRef: "disabled" } };
  }
  const caps = object(row.capabilities, "settings");
  const modes = ["execute", "requestOnly", "unavailable"];
  const capability = (name: string) => {
    if (!modes.includes(caps[name] as string)) throw new InvalidConfigArchive("settings");
    return caps[name] as CallPolicy["capabilities"]["book"];
  };
  if (row.policyVersion !== String(version)) throw new InvalidConfigArchive("settings");
  const result: CallPolicy = { scope: sourceScope, policyVersion: String(version), automationVersion: "0", automationEnabled: false,
    bookingEnabled: flag(row.bookingEnabled, "settings"),
    cancellationEnabled: row.cancellationEnabled === undefined ? false : flag(row.cancellationEnabled, "settings"),
    reschedulingEnabled: row.reschedulingEnabled === undefined ? false : flag(row.reschedulingEnabled, "settings"),
    ...afterHoursFields(row, sourceScope), ...urgentFields(row, sourceScope),
    capabilities: { book: capability("book"), cancel: capability("cancel"), reschedule: capability("reschedule"),
      intake: capability("intake"), transfer: capability("transfer") },
    staffDestination: destination(row.staffDestination), operatorQueue: destination(row.operatorQueue),
    ...(row.staffSchedule === undefined ? {} : { staffSchedule: approvedStaffSchedule(row.staffSchedule, sourceScope) }),
    ...(row.transferDestinationRef === undefined ? {} : { transferDestinationRef: ref(row.transferDestinationRef, "settings") }) };
  if (row.staffedCoverage !== undefined) {
    const coverage = object(row.staffedCoverage, "settings");
    const startsAt = instant(coverage.startsAt, "settings");
    const endsAt = instant(coverage.endsAt, "settings");
    if (Date.parse(endsAt) <= Date.parse(startsAt) || Date.parse(endsAt) - Date.parse(startsAt) > 72 * 60 * 60 * 1_000) {
      throw new InvalidConfigArchive("settings");
    }
    return policyWithStaffing({ ...result, staffedCoverage: { startsAt, endsAt } }, row, sourceScope);
  }
  return policyWithStaffing(result, row, sourceScope);
}

function policyWithStaffing(result: CallPolicy, row: Record<string, unknown>, sourceScope: LocationScope): CallPolicy {
  if (row.staffedIntervals !== undefined) {
    if (!Array.isArray(row.staffedIntervals) || row.staffedIntervals.length > 512) throw new InvalidConfigArchive("settings");
    const intervals: StaffedInterval[] = row.staffedIntervals.map(value => {
      const item = object(value, "settings");
      return { startsAt: instant(item.startsAt, "settings"), endsAt: instant(item.endsAt, "settings") };
    });
    for (const item of intervals) {
      if (Date.parse(item.endsAt) <= Date.parse(item.startsAt) ||
          (result.staffedCoverage && (Date.parse(item.startsAt) < Date.parse(result.staffedCoverage.startsAt) ||
            Date.parse(item.endsAt) > Date.parse(result.staffedCoverage.endsAt)))) throw new InvalidConfigArchive("settings");
    }
    return { ...result, staffedIntervals: intervals, ...(row.greeting === undefined ? {} : { greeting: greeting(row.greeting, sourceScope) }) };
  }
  return { ...result, ...(row.greeting === undefined ? {} : { greeting: greeting(row.greeting, sourceScope) }) };
}

function approvedStaffSchedule(value: unknown, scope: LocationScope): ApprovedStaffSchedule {
  const row = object(value, "settings");
  if (Object.keys(row).sort().join(",") !== "approved,closedDates,effectiveFrom,effectiveUntil,ownerRef,timeZone,version,weekly" ||
      row.approved !== true || typeof row.timeZone !== "string" ||
      !Array.isArray(row.weekly) || row.weekly.length > 168 ||
      !Array.isArray(row.closedDates) || row.closedDates.length > 90 ||
      !row.closedDates.every(date => typeof date === "string")) throw new InvalidConfigArchive("settings");
  const schedule: ApprovedStaffSchedule = { scope, version: ref(row.version, "settings"),
    ownerRef: ref(row.ownerRef, "settings"), approved: true,
    effectiveFrom: instant(row.effectiveFrom, "settings"), effectiveUntil: instant(row.effectiveUntil, "settings"),
    timeZone: row.timeZone,
    weekly: row.weekly.map(value => {
      const window = object(value, "settings");
      if (Object.keys(window).sort().join(",") !== "endMinute,startMinute,weekday") throw new InvalidConfigArchive("settings");
      return { weekday: integer(window.weekday, "settings"), startMinute: integer(window.startMinute, "settings"),
        endMinute: integer(window.endMinute, "settings") };
    }), closedDates: [...row.closedDates] };
  if (!validStaffScheduleApproval(schedule, scope) ||
      !expandStaffSchedule(schedule, "2026-01-01T00:00:00.000Z", "2026-01-01T00:01:00.000Z").ok) {
    throw new InvalidConfigArchive("settings");
  }
  return schedule;
}

function greeting(value: unknown, sourceScope: LocationScope): NonNullable<CallPolicy["greeting"]> {
  const row = object(value, "settings");
  const result = { ...row, scope: sourceScope };
  if (!validGreetingShape(result, sourceScope)) throw new InvalidConfigArchive("settings");
  return result;
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
  omittedTextCalls?: number;
  policies: ConfigArchiveData["policies"][number][];
  knowledge: PortablePublishedKnowledge[];
};

type MutableClinic = {
  sourceClinicId: string;
  automation: ConfigArchiveData["automation"][number][];
  clinicIntake: ConfigArchiveData["automation"][number][];
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
    if (verified.manifest.sourceSystem !== "abby-postgres" ||
        (verified.manifest.archiveVersion === 1 && verified.manifest.sections.calls.recordCount !== 0) ||
        verified.manifest.sections.staffWork.recordCount !== 0) throw new InvalidConfigArchive();
    const metadata = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)), "locations");
    ref(metadata.exportRequestRef, "locations");
    const omissions = object(metadata.omittedCalls, "calls");
    if (Object.keys(omissions).sort().join(",") !== "activeCall,consentDenied,notRetained,retentionExpired" ||
        omissions.retentionExpired !== 0 || omissions.consentDenied !== 0 || omissions.activeCall !== 0) {
      throw new InvalidConfigArchive("calls");
    }
    const omittedCalls: OmittedCalls = { retentionExpired: 0, consentDenied: 0,
      notRetained: integer(omissions.notRetained, "calls"), activeCall: 0 };
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
        { sourceClinicId: sourceScope.clinicId, automation: [], clinicIntake: [], writeStops: [] });
    }
    if (locations.size !== declaredMappings.size) throw new InvalidConfigArchive("locations");

    if (verified.manifest.archiveVersion === 2) {
      const counts = new Map<string, number>();
      let total = 0;
      for (const row of lines(sections.calls, "calls")) {
        if (Object.keys(row).sort().join(",") !==
            "kind,notRetained,recordId,recordVersion,sourceClinicId,sourceLocationId,sourceTenantId" ||
            row.kind !== "omittedTextCallCount") throw new InvalidConfigArchive("calls");
        const key = JSON.stringify([ref(row.sourceClinicId, "calls"), ref(row.sourceLocationId, "calls")]);
        const count = integer(row.notRetained, "calls", 1);
        if (!locations.has(key) || counts.has(key) || row.recordId !== expectedId("omittedTextCalls", key, 1)) {
          throw new InvalidConfigArchive("calls");
        }
        counts.set(key, count);
        total += count;
        if (!Number.isSafeInteger(total)) throw new InvalidConfigArchive("calls");
      }
      if (total !== omittedCalls.notRetained) throw new InvalidConfigArchive("calls");
      for (const [key, location] of locations) location.omittedTextCalls = counts.get(key) ?? 0;
    }

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
        const rawPolicy = object(row.policy, "settings");
        const settingKind = row.settingKind === undefined ? "booking" : row.settingKind;
        if (settingKind !== "booking" && settingKind !== "afterHours" && settingKind !== "urgent" &&
            settingKind !== "staffSchedule" && settingKind !== "greeting" && settingKind !== "cancellation" && settingKind !== "rescheduling") throw new InvalidConfigArchive("settings");
        const previousCancellationEnabled = row.previousCancellationEnabled === undefined || row.previousCancellationEnabled === null
          ? null : flag(row.previousCancellationEnabled, "settings");
        const previousReschedulingEnabled = row.previousReschedulingEnabled === undefined || row.previousReschedulingEnabled === null
          ? null : flag(row.previousReschedulingEnabled, "settings");
        const previousAfterHoursMode = row.previousAfterHoursMode === undefined || row.previousAfterHoursMode === null
          ? null : row.previousAfterHoursMode;
        if (previousAfterHoursMode !== null && previousAfterHoursMode !== "staffRequest" &&
            previousAfterHoursMode !== "approvedInfoAndRequest") throw new InvalidConfigArchive("settings");
        const previousBookingEnabled = row.previousBookingEnabled === null ? null : flag(row.previousBookingEnabled, "settings");
        const changedBy = optionalRef(row.changedBy, "settings");
        const changedAt = optionalInstant(row.changedAt, "settings");
        if (settingKind === "cancellation"
          ? version === 0 || previousCancellationEnabled === null || typeof rawPolicy.cancellationEnabled !== "boolean" ||
            previousBookingEnabled !== null || previousAfterHoursMode !== null || changedBy === null || changedAt === null
          : previousCancellationEnabled !== null) throw new InvalidConfigArchive("settings");
        if (settingKind === "rescheduling"
          ? version === 0 || previousReschedulingEnabled === null || typeof rawPolicy.reschedulingEnabled !== "boolean" ||
            previousBookingEnabled !== null || previousAfterHoursMode !== null || changedBy === null || changedAt === null
          : previousReschedulingEnabled !== null) throw new InvalidConfigArchive("settings");
        if ((settingKind === "urgent" || settingKind === "staffSchedule" || settingKind === "greeting") &&
            (version === 0 || previousAfterHoursMode !== null ||
            previousBookingEnabled !== null || changedBy === null || changedAt === null) ||
            settingKind === "afterHours" && (version === 0 || previousAfterHoursMode === null ||
            previousBookingEnabled !== null || changedBy === null || changedAt === null) ||
            settingKind === "booking" && previousAfterHoursMode !== null) throw new InvalidConfigArchive("settings");
        location.policies.push({ version, isHead,
          storageShape: rawPolicy.shape === "standaloneMinimal" ? "standaloneMinimal" : "unsafeReference",
          policy: policy(rawPolicy, location.sourceScope, version),
          changedBy, previousBookingEnabled, changedAt,
          settingKind, previousAfterHoursMode, previousCancellationEnabled, previousReschedulingEnabled });
      } else if (row.kind === "clinicAutomation") {
        if (row.recordId !== expectedId("automation", sourceClinicId, version)) throw new InvalidConfigArchive("settings");
        clinic.automation.push({ version, isHead, enabled: flag(row.enabled, "settings"),
          changedBy: optionalRef(row.changedBy, "settings"),
          previousEnabled: row.previousEnabled === null ? null : flag(row.previousEnabled, "settings"),
          changedAt: optionalInstant(row.changedAt, "settings") });
      } else if (row.kind === "clinicIntake") {
        const fields = ["recordVersion", "recordId", "sourceTenantId", "sourceClinicId", "kind", "version",
          "isHead", "enabled", "changedBy", "previousEnabled", "changedAt"];
        if (Object.keys(row).sort().join(",") !== fields.sort().join(",") ||
            row.recordId !== expectedId("intake", sourceClinicId, version)) throw new InvalidConfigArchive("settings");
        clinic.clinicIntake.push({ version, isHead, enabled: flag(row.enabled, "settings"),
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
    for (const location of locations.values()) {
      assertHeads(location.policies, "settings", 0);
      const ordered = [...location.policies].sort((left, right) => left.version - right.version);
      for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1]!;
        const current = ordered[index]!;
        if (current.settingKind !== "cancellation" && current.policy.cancellationEnabled !== previous.policy.cancellationEnabled) {
          throw new InvalidConfigArchive("settings");
        }
        if (current.settingKind !== "rescheduling" && current.policy.reschedulingEnabled !== previous.policy.reschedulingEnabled) {
          throw new InvalidConfigArchive("settings");
        }
        if (current.settingKind === "cancellation") {
          const unchanged = { ...current.policy, policyVersion: previous.policy.policyVersion,
            cancellationEnabled: previous.policy.cancellationEnabled,
            capabilities: { ...current.policy.capabilities, cancel: previous.policy.capabilities.cancel } };
          if (current.previousCancellationEnabled !== previous.policy.cancellationEnabled ||
              JSON.stringify(unchanged) !== JSON.stringify(previous.policy)) throw new InvalidConfigArchive("settings");
        } else if (current.settingKind === "rescheduling") {
          const unchanged = { ...current.policy, policyVersion: previous.policy.policyVersion,
            reschedulingEnabled: previous.policy.reschedulingEnabled,
            capabilities: { ...current.policy.capabilities, reschedule: previous.policy.capabilities.reschedule } };
          if (current.previousReschedulingEnabled !== previous.policy.reschedulingEnabled ||
              JSON.stringify(unchanged) !== JSON.stringify(previous.policy)) throw new InvalidConfigArchive("settings");
        } else if (current.settingKind === "afterHours") {
          if (current.previousAfterHoursMode !== (previous.policy.afterHoursMode ?? "staffRequest") ||
              current.policy.bookingEnabled !== previous.policy.bookingEnabled ||
              JSON.stringify(current.policy.urgentResponse) !== JSON.stringify(previous.policy.urgentResponse) ||
              JSON.stringify(current.policy.staffSchedule) !== JSON.stringify(previous.policy.staffSchedule) ||
              JSON.stringify(current.policy.greeting) !== JSON.stringify(previous.policy.greeting))
            throw new InvalidConfigArchive("settings");
        } else if (current.settingKind === "urgent") {
          if (current.policy.bookingEnabled !== previous.policy.bookingEnabled ||
              current.policy.afterHoursMode !== previous.policy.afterHoursMode ||
              JSON.stringify(current.policy.afterHoursInfo) !== JSON.stringify(previous.policy.afterHoursInfo) ||
              JSON.stringify(current.policy.staffSchedule) !== JSON.stringify(previous.policy.staffSchedule) ||
              JSON.stringify(current.policy.greeting) !== JSON.stringify(previous.policy.greeting))
            throw new InvalidConfigArchive("settings");
        } else if (current.settingKind === "staffSchedule") {
          if (current.policy.bookingEnabled !== previous.policy.bookingEnabled ||
              current.policy.afterHoursMode !== previous.policy.afterHoursMode ||
              JSON.stringify(current.policy.afterHoursInfo) !== JSON.stringify(previous.policy.afterHoursInfo) ||
              JSON.stringify(current.policy.urgentResponse) !== JSON.stringify(previous.policy.urgentResponse) ||
              JSON.stringify(current.policy.greeting) !== JSON.stringify(previous.policy.greeting))
            throw new InvalidConfigArchive("settings");
        } else if (current.settingKind === "greeting") {
          if (current.policy.bookingEnabled !== previous.policy.bookingEnabled ||
              current.policy.afterHoursMode !== previous.policy.afterHoursMode ||
              JSON.stringify(current.policy.afterHoursInfo) !== JSON.stringify(previous.policy.afterHoursInfo) ||
              JSON.stringify(current.policy.urgentResponse) !== JSON.stringify(previous.policy.urgentResponse) ||
              JSON.stringify(current.policy.staffSchedule) !== JSON.stringify(previous.policy.staffSchedule))
            throw new InvalidConfigArchive("settings");
        } else if ((current.previousBookingEnabled !== null &&
                    current.previousBookingEnabled !== previous.policy.bookingEnabled) ||
                   current.policy.afterHoursMode !== previous.policy.afterHoursMode ||
                   JSON.stringify(current.policy.afterHoursInfo) !== JSON.stringify(previous.policy.afterHoursInfo) ||
                   JSON.stringify(current.policy.urgentResponse) !== JSON.stringify(previous.policy.urgentResponse) ||
                   JSON.stringify(current.policy.staffSchedule) !== JSON.stringify(previous.policy.staffSchedule) ||
                   JSON.stringify(current.policy.greeting) !== JSON.stringify(previous.policy.greeting)) {
          throw new InvalidConfigArchive("settings");
        }
      }
    }
    for (const clinic of clinics.values()) {
      assertHeads(clinic.automation, "settings", 0);
      if (!validClinicIntakeArchiveHistory(clinic.clinicIntake)) throw new InvalidConfigArchive("settings");
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
      targetTenantId: expectedTargetTenantId, omittedCalls,
      locations: [...locations.values()], clinics: [...clinics.values()] });
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
    sectionManifests: data.sectionManifests, omittedCalls: data.omittedCalls,
    ...(location.omittedTextCalls === undefined ? {} : { omittedTextCalls: location.omittedTextCalls }),
    sourceScope: location.sourceScope, targetScope: location.targetScope, timeZone: location.timeZone,
    mappingProvenance: location.mappingProvenance, policies: location.policies, automation: clinic.automation, clinicIntake: clinic.clinicIntake ?? [],
    writeStops: clinic.writeStops, knowledge: location.knowledge });
}
