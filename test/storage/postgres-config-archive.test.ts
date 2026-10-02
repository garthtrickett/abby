import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { verifyArchiveEnvelope } from "../../src/portability/archive-envelope.ts";
import { decodeConfigArchive, decodeTenantConfigArchive } from "../../src/portability/config-archive.ts";
import type { ArchiveEnvelope, ArchiveSection } from "../../src/portability/archive-envelope.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { PostgresKnowledgeCatalogue } from "../../src/storage/postgres-knowledge-catalogue.ts";
import { ReferenceConfigArchiveImporter } from "../../src/reference/config-archive-import.ts";
import { ReferenceTenantConfigArchiveImporter } from "../../src/reference/tenant-config-archive-import.ts";
import { createEmbeddedTextComposition } from "../../src/reference/embedded-composition.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { buildPostgresConfigArchive, buildPostgresTenantConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { comparePostgresConfigArchiveSource } from "../../src/storage/postgres-config-archive-drift.ts";
import type { ConfigArchiveAuthority, ConfigArchiveRequest, TenantConfigArchiveRequest } from "../../src/storage/postgres-config-archive.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

async function records(archive: ArchiveEnvelope, section: ArchiveSection): Promise<Record<string, unknown>[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of archive.sections[section]()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("PostgreSQL config archive takes a consistent scoped snapshot with an allowlisted policy", async () => {
  const scope = { tenantId: "archive-config-tenant", clinicId: "archive-clinic", locationId: "archive-location" };
  const request: ConfigArchiveRequest = { scope, targetScope: { tenantId: "buyer", clinicId: "target-clinic", locationId: "target-location" },
    archiveMode: "unsafeReference",
    timeZone: "Australia/Sydney", mappingProvenance: "buyer-reviewed-map-1", archiveId: "config-archive-1",
    actorRef: "archive-admin", createdAt: "2026-09-28T22:00:00Z" };
  const authority: ConfigArchiveAuthority = { authorizeAndRecord: async () => ok({ requestRef: "audited-request-1" }) };
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "requestOnly", async () => ok(true), true, "unsafeReference");
  assert.equal((await policy.changeBookingEnabled(scope, "0", true, "archive-admin")).ok, true);
  assert.equal((await policy.changeBookingEnabled(scope, "1", false, "archive-admin")).ok, true);
  assert.equal((await policy.changeBookingEnabled(scope, "2", true, "archive-admin")).ok, true);
  assert.equal((await policy.changeAutomationEnabled(scope, "0", true, "archive-admin")).ok, true);
  const catalogue = new PostgresKnowledgeCatalogue(db, "unsafeReference");
  const draft = await catalogue.saveDraft(scope, "parking", "0", "clinic-owner", "Parking is behind the clinic.",
    "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "archive-admin");
  assert.equal(draft.ok, true);
  assert.equal((await catalogue.approve(scope, "parking", "1", "archive-admin")).ok, true);
  assert.equal((await catalogue.saveDraft(scope, "parking", "2", "clinic-owner", "Parking is near the entrance.",
    "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "archive-admin")).ok, true);
  assert.equal((await catalogue.approve(scope, "parking", "3", "archive-admin")).ok, true);
  await sql`update clinic_settings set policy = jsonb_set(policy || jsonb_build_object('apiKey', ${"secret-canary-never-export"}::text,
    'staffedCoverage', jsonb_build_object('startsAt', '2026-09-28T22:00:00.000Z', 'endsAt', '2026-09-28T23:00:00.000Z'),
    'staffedIntervals', jsonb_build_array(jsonb_build_object('startsAt', '2026-09-28T22:10:00.000Z',
      'endsAt', '2026-09-28T22:20:00.000Z')),
    'staffSchedule', jsonb_build_object('scope', policy->'scope', 'version', 'hours-v1',
      'ownerRef', 'hours-owner', 'approved', true,
      'effectiveFrom', '2026-09-01T00:00:00.000Z', 'effectiveUntil', '2027-09-01T00:00:00.000Z',
      'timeZone', 'Australia/Sydney',
      'weekly', jsonb_build_array(jsonb_build_object('weekday', 1, 'startMinute', 1140, 'endMinute', 1260)),
      'closedDates', jsonb_build_array())),
    '{capabilities,cancel}', '"execute"'::jsonb)
    where tenant_id = ${scope.tenantId} and clinic_id = ${scope.clinicId} and location_id = ${scope.locationId}`.execute(db);

  const result = await buildPostgresConfigArchive(db, request, authority);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const verified = await verifyArchiveEnvelope(result.value);
  assert.equal(verified.ok, true);
  const locations = await records(result.value, "locations");
  const settings = await records(result.value, "settings");
  const knowledge = await records(result.value, "knowledge");
  assert.equal(locations.length, 1);
  assert.equal((locations[0]?.targetScope as { locationId: string }).locationId, "target-location");
  assert.equal(settings.some(row => row.kind === "locationPolicy" && (row.policy as { bookingEnabled: boolean }).bookingEnabled), true);
  assert.equal(settings.filter(row => row.kind === "locationPolicy" && row.isHead).length, 1);
  assert.deepEqual((settings.find(row => row.kind === "locationPolicy" && row.isHead)?.policy as Record<string, unknown>).staffedCoverage,
    { startsAt: "2026-09-28T22:00:00.000Z", endsAt: "2026-09-28T23:00:00.000Z" });
  assert.equal(((settings.find(row => row.kind === "locationPolicy" && row.isHead)?.policy as Record<string, unknown>).staffSchedule as Record<string, unknown>).ownerRef,
    "hours-owner");
  assert.equal(settings.filter(row => row.kind === "clinicAutomation" && row.isHead).length, 1);
  assert.deepEqual(knowledge.map(row => row.status), ["approved", "approved"]);
  assert.deepEqual(knowledge.map(row => row.version), [2, 4]);
  assert.equal(knowledge[0]?.approvedText, "Parking is behind the clinic.");
  assert.equal(knowledge[1]?.isPublishedHead, true);
  assert.deepEqual(await records(result.value, "calls"), []);
  assert.deepEqual(await records(result.value, "staffWork"), []);
  const sectionText = (await Promise.all(["locations", "settings", "knowledge", "calls", "staffWork"].map(async name =>
    JSON.stringify(await records(result.value, name as ArchiveSection))))).join(" ");
  assert.equal(Buffer.from(result.value.manifestBytes).toString().includes("secret-canary-never-export"), false);
  assert.equal(sectionText.includes("secret-canary-never-export"), false);

  const importer = new ReferenceConfigArchiveImporter(() => "2026-09-28T22:05:00Z");
  const importAuthority = { authorizeAndRecord: async () => ok({ auditRef: "buyer-audit-1" }) };
  const mapper = { mapRef: (kind: string, sourceRef: string) => `buyer:${kind}:${sourceRef}` };
  const preflight = await importer.preflight(result.value, request.targetScope, "buyer-admin", importAuthority, mapper);
  assert.equal(preflight.ok, true);
  if (!preflight.ok) return;
  assert.equal(preflight.value.status, "ready");
  assert.deepEqual(preflight.value.recordCounts, { locations: 1, settings: 6, knowledge: 2, calls: 0, staffWork: 0 });
  assert.equal(preflight.value.mappings.some(row => row.kind === "knowledgeOwner" && row.sourceRef === "clinic-owner" &&
    row.targetRef === "buyer:knowledgeOwner:clinic-owner"), true);
  assert.equal(preflight.value.plannedBookingEnabled, false);
  assert.equal(JSON.stringify(preflight.value).includes("secret-canary-never-export"), false);
  const preflightOnly = new ReferenceConfigArchiveImporter(() => "2026-09-28T22:05:00Z");
  assert.equal((await preflightOnly.preflight(result.value, request.targetScope, "buyer-admin", importAuthority, mapper)).ok, true);
  const alternateManifest = { ...JSON.parse(Buffer.from(result.value.manifestBytes).toString()), archiveId: "config-archive-after-preflight" };
  const afterDryRun = await preflightOnly.stage({ ...result.value, manifestBytes: Buffer.from(JSON.stringify(alternateManifest)) },
    request.targetScope, "buyer-admin", importAuthority, mapper);
  assert.equal(afterDryRun.ok, true);
  const staged = await importer.stage(result.value, request.targetScope, "buyer-admin", importAuthority, mapper);
  assert.equal(staged.ok, true);
  if (!staged.ok) return;
  assert.deepEqual({ policy: staged.value.receipt.policyVersions, automation: staged.value.receipt.automationVersions,
    knowledge: staged.value.receipt.publishedKnowledgeVersions }, { policy: 4, automation: 2, knowledge: 2 });
  const importedPolicy = await staged.value.policy.read(request.targetScope);
  assert.equal(importedPolicy.ok, true);
  if (!importedPolicy.ok) return;
  assert.equal(importedPolicy.value.bookingEnabled, false);
  assert.equal(importedPolicy.value.automationEnabled, false);
  assert.equal(importedPolicy.value.capabilities.book, "unavailable");
  assert.equal(importedPolicy.value.cancellationEnabled, false);
  assert.equal(importedPolicy.value.capabilities.cancel, "unavailable");
  assert.equal(importedPolicy.value.policyVersion, "4");
  assert.deepEqual(importedPolicy.value.staffedCoverage,
    { startsAt: "2026-09-28T22:00:00.000Z", endsAt: "2026-09-28T23:00:00.000Z" });
  assert.deepEqual(importedPolicy.value.staffedIntervals,
    [{ startsAt: "2026-09-28T22:10:00.000Z", endsAt: "2026-09-28T22:20:00.000Z" }]);
  assert.deepEqual(importedPolicy.value.staffSchedule?.scope, request.targetScope);
  assert.equal(importedPolicy.value.staffSchedule?.ownerRef, "buyer:scheduleOwner:hours-owner");
  assert.equal(importedPolicy.value.automationVersion, "2");
  const targetStop = await staged.value.ledger.readWriteStop(request.targetScope);
  assert.equal(targetStop.ok && targetStop.value.stopped, true);
  const importedKnowledge = await staged.value.knowledge.readKnowledge(request.targetScope, ["parking"]);
  assert.equal(importedKnowledge.ok, true);
  if (importedKnowledge.ok) assert.deepEqual(importedKnowledge.value.map(entry => entry.approvedText), ["Parking is near the entrance."]);
  const nextDraft = await staged.value.knowledge.saveDraft(request.targetScope, "parking", "4", "buyer:knowledgeOwner:clinic-owner",
    "Parking has moved again.", "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "buyer-admin");
  assert.equal(nextDraft.ok && nextDraft.value.version, "5");
  const host = new ReferenceClinicHost([], []);
  const reception = createEmbeddedTextComposition(staged.value.ledger, staged.value.policy, host, undefined, undefined, undefined, staged.value.knowledge);
  const started = await reception.startCall("imported-reference-call", request.targetScope, "2026-09-28T22:06:00Z");
  assert.equal(started.ok, true);
  if (started.ok) assert.deepEqual(started.value.policy.knowledgeSnapshot, [{ sourceRef: "parking", version: "4" }]);
  const answer = await reception.answer(request.targetScope,
    { callId: "imported-reference-call", turnId: "parking-answer", text: "Where can I park?", quality: "clear", at: "2026-09-28T22:06:00Z" },
    ["parking"], "Parking is near the entrance.", "2026-09-28T22:06:00Z");
  assert.equal(answer.ok, true);
  if (answer.ok) assert.equal(answer.value.callerMessages.at(-1), "Parking is near the entrance.");
  const replay = await importer.stage(result.value, request.targetScope, "buyer-admin", importAuthority, mapper);
  assert.equal(replay.ok && replay.value === staged.value, true);
  const replayPreflight = await importer.preflight(result.value, request.targetScope, "buyer-admin", importAuthority,
    { mapRef: () => null });
  assert.equal(replayPreflight.ok && replayPreflight.value.status === "alreadyStaged", true);
  if (replayPreflight.ok) assert.deepEqual(replayPreflight.value.mappings, staged.value.receipt.mappings);
  const mappingImporter = new ReferenceConfigArchiveImporter(() => "2026-09-28T22:05:00Z");
  const failedPreflight = await mappingImporter.preflight(result.value, request.targetScope, "buyer-admin", importAuthority,
    { mapRef: (kind: string, sourceRef: string) => kind === "operatorQueue" ? null : `buyer:${kind}:${sourceRef}` });
  assert.deepEqual(failedPreflight, { ok: false, error: { kind: "unmappedRef" } });
  const unmapped = await mappingImporter.stage(result.value, request.targetScope, "buyer-admin", importAuthority,
    { mapRef: (kind: string, sourceRef: string) => kind === "operatorQueue" ? null : `buyer:${kind}:${sourceRef}` });
  assert.deepEqual(unmapped, { ok: false, error: { kind: "unmappedRef" } });
  const afterMappingFix = await mappingImporter.stage(result.value, request.targetScope, "buyer-admin", importAuthority, mapper);
  assert.equal(afterMappingFix.ok, true);
  const concurrentImporter = new ReferenceConfigArchiveImporter(() => "2026-09-28T22:05:00Z");
  const concurrent = await Promise.all([
    concurrentImporter.stage(result.value, request.targetScope, "buyer-admin", importAuthority, mapper),
    concurrentImporter.stage(result.value, request.targetScope, "buyer-admin", importAuthority, mapper),
  ]);
  assert.equal(concurrent.every(item => item.ok), true);
  if (concurrent[0]?.ok && concurrent[1]?.ok) assert.equal(concurrent[0].value, concurrent[1].value);
  const changedManifest = JSON.parse(Buffer.from(result.value.manifestBytes).toString());
  changedManifest.createdAt = "2026-09-28T22:00:01Z";
  const conflicting = await importer.stage({ ...result.value, manifestBytes: Buffer.from(JSON.stringify(changedManifest)) },
    request.targetScope, "buyer-admin", importAuthority, mapper);
  assert.deepEqual(conflicting, { ok: false, error: { kind: "archiveConflict" } });
  const occupied = await importer.stage({ ...result.value, manifestBytes: Buffer.from(JSON.stringify({ ...changedManifest,
    archiveId: "config-archive-other" })) }, request.targetScope, "buyer-admin", importAuthority, mapper);
  assert.deepEqual(occupied, { ok: false, error: { kind: "targetOccupied" } });

  const altered = await Promise.all(["locations", "settings", "knowledge", "calls", "staffWork"].map(async name => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.value.sections[name as ArchiveSection]()) chunks.push(chunk);
    return [name, Buffer.concat(chunks)] as const;
  }));
  const bytes = Object.fromEntries(altered) as Record<ArchiveSection, Buffer>;
  const alteredSettings = Buffer.from(bytes.settings.toString().replace('"bookingEnabled":true', '"bookingEnabled":"yes"'));
  assert.notDeepEqual(alteredSettings, bytes.settings);
  bytes.settings = alteredSettings;
  const alteredManifest = JSON.parse(Buffer.from(result.value.manifestBytes).toString());
  alteredManifest.sections.settings.byteCount = alteredSettings.byteLength;
  alteredManifest.sections.settings.sha256 = createHash("sha256").update(alteredSettings).digest("hex");
  const tampered = { manifestBytes: Buffer.from(JSON.stringify(alteredManifest)), sections: {
    locations: async function* () { yield bytes.locations; }, settings: async function* () { yield bytes.settings; },
    knowledge: async function* () { yield bytes.knowledge; }, calls: async function* () { yield bytes.calls; },
    staffWork: async function* () { yield bytes.staffWork; },
  } };
  const rejectedSemantics = await new ReferenceConfigArchiveImporter().stage(tampered, request.targetScope,
    "buyer-admin", importAuthority, mapper);
  assert.equal(rejectedSemantics.ok, false);
  if (!rejectedSemantics.ok) assert.equal(rejectedSemantics.error.kind, "invalidConfigArchive");
  const sourceSettings = Buffer.from(altered.find(([name]) => name === "settings")![1]);
  const withoutVersion = sourceSettings.toString().trimEnd().split("\n").map(line => JSON.parse(line))
    .filter(row => row.kind !== "locationPolicy" || row.version !== 1);
  const missingBytes = Buffer.from(withoutVersion.map(row => `${JSON.stringify(row)}\n`).join(""));
  const missingManifest = JSON.parse(Buffer.from(result.value.manifestBytes).toString());
  missingManifest.sections.settings.recordCount = withoutVersion.length;
  missingManifest.sections.settings.byteCount = missingBytes.byteLength;
  missingManifest.sections.settings.sha256 = createHash("sha256").update(missingBytes).digest("hex");
  const missingSequence = await new ReferenceConfigArchiveImporter().stage({
    manifestBytes: Buffer.from(JSON.stringify(missingManifest)),
    sections: { ...result.value.sections, settings: async function* () { yield missingBytes; } },
  }, request.targetScope, "buyer-admin", importAuthority, mapper);
  assert.equal(missingSequence.ok, false);
  if (!missingSequence.ok) assert.equal(missingSequence.error.kind, "invalidConfigArchive");

  const call = await new PostgresLedger(db, undefined, undefined, "unsafeReference").start("archive-existing-call", referenceDefaultPolicy(scope));
  assert.equal(call.ok, true);
  const rejected = await buildPostgresConfigArchive(db, { ...request, archiveId: "config-archive-2" }, authority);
  assert.deepEqual(rejected, { ok: false, error: { kind: "callsRequireRetention" } });
});

test("config archive denies a request before reading settings", async () => {
  const scope = { tenantId: "archive-denied-tenant", clinicId: "clinic", locationId: "location" };
  const request: ConfigArchiveRequest = { scope, targetScope: scope, timeZone: "UTC", mappingProvenance: "map",
    archiveId: "denied-archive", actorRef: "unauthorized", createdAt: "2026-09-28T22:00:00Z" };
  const result = await buildPostgresConfigArchive(db, request, { authorizeAndRecord: async () => ({ ok: false, error: { kind: "denied" } }) });
  assert.deepEqual(result, { ok: false, error: { kind: "denied" } });
});

test("a pristine PostgreSQL source stages a disabled standalone default with writes stopped", async () => {
  const sourceScope = { tenantId: "archive-pristine-tenant", clinicId: "clinic", locationId: "location" };
  const targetScope = { tenantId: "buyer-pristine", clinicId: "clinic", locationId: "location" };
  const archive = await buildPostgresConfigArchive(db, { scope: sourceScope, targetScope, timeZone: "UTC",
    mappingProvenance: "reviewed-pristine", archiveId: "pristine-archive", actorRef: "archive-admin",
    createdAt: "2026-09-28T22:00:00Z" }, { authorizeAndRecord: async () => ok({ requestRef: "pristine-export-audit" }) });
  assert.equal(archive.ok, true);
  if (!archive.ok) return;
  const staged = await new ReferenceConfigArchiveImporter().stage(archive.value, targetScope, "buyer-admin",
    { authorizeAndRecord: async () => ok({ auditRef: "pristine-import-audit" }) },
    { mapRef: (kind, sourceRef) => `buyer:${kind}:${sourceRef}` });
  assert.equal(staged.ok, true);
  if (!staged.ok) return;
  assert.equal(staged.value.receipt.policyVersions, 1);
  assert.equal(staged.value.receipt.automationVersions, 0);
  const policy = await staged.value.policy.read(targetScope);
  assert.equal(policy.ok, true);
  if (policy.ok) {
    assert.equal(policy.value.bookingEnabled, false);
    assert.equal(policy.value.automationEnabled, false);
    assert.equal(policy.value.capabilities.book, "unavailable");
    assert.deepEqual(Object.values(policy.value.capabilities), Array(5).fill("unavailable"));
    assert.equal(policy.value.greeting, undefined);
  }
  const stop = await staged.value.ledger.readWriteStop(targetScope);
  assert.equal(stop.ok && stop.value.stopped, true);
});

test("config archive refuses to omit another location in the source tenant", async () => {
  const scope = { tenantId: "archive-multilocation-tenant", clinicId: "clinic", locationId: "location-a" };
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "requestOnly", undefined, true, "unsafeReference");
  assert.equal((await policy.changeBookingEnabled(scope, "0", true, "archive-admin")).ok, true);
  assert.equal((await policy.changeBookingEnabled({ ...scope, locationId: "location-b" }, "0", true, "archive-admin")).ok, true);
  const request: ConfigArchiveRequest = { scope, targetScope: scope, timeZone: "UTC", mappingProvenance: "map",
    archiveId: "partial-archive", actorRef: "archive-admin", createdAt: "2026-09-28T22:00:00Z" };
  const result = await buildPostgresConfigArchive(db, request, { authorizeAndRecord: async () => ok({ requestRef: "audited-partial" }) });
  assert.deepEqual(result, { ok: false, error: { kind: "scopeIncomplete" } });
});

test("configuration snapshot comparison detects setting and knowledge drift before cutover", async () => {
  const scope = { tenantId: "archive-drift-tenant", clinicId: "clinic", locationId: "location" };
  const targetScope = { tenantId: "archive-drift-buyer", clinicId: "clinic", locationId: "location" };
  const request: ConfigArchiveRequest = { scope, targetScope, timeZone: "UTC", mappingProvenance: "reviewed-drift-map",
    archiveMode: "unsafeReference",
    archiveId: "drift-baseline", actorRef: "archive-admin", createdAt: "2026-09-28T22:00:00Z" };
  let audited = 0;
  const authority: ConfigArchiveAuthority = { authorizeAndRecord: async () => ok({ requestRef: `drift-audit-${++audited}` }) };
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "requestOnly", undefined, true, "unsafeReference");
  assert.equal((await policy.changeBookingEnabled(scope, "0", true, "archive-admin")).ok, true);
  const baseline = await buildPostgresConfigArchive(db, request, authority);
  assert.equal(baseline.ok, true);
  if (!baseline.ok) return;
  const comparison = { ...request, archiveId: "drift-check-1", createdAt: "2026-09-28T22:05:00Z" };
  const unchanged = await comparePostgresConfigArchiveSource(db, baseline.value, comparison, authority);
  assert.equal(unchanged.ok, true);
  if (unchanged.ok) {
    assert.equal(unchanged.value.kind, "unchanged");
    assert.deepEqual(unchanged.value.changed, []);
    assert.notEqual(unchanged.value.baselineManifestDigest, unchanged.value.comparisonManifestDigest);
  }
  assert.equal(audited, 2);
  const reused = await comparePostgresConfigArchiveSource(db, baseline.value, request, authority);
  assert.deepEqual(reused, { ok: false, error: { kind: "archiveIdReused" } });
  const mismatched = await comparePostgresConfigArchiveSource(db, baseline.value,
    { ...comparison, archiveId: "drift-check-wrong-map", mappingProvenance: "unreviewed" }, authority);
  assert.deepEqual(mismatched, { ok: false, error: { kind: "baselineMismatch" } });
  assert.equal((await policy.changeBookingEnabled(scope, "1", false, "archive-admin")).ok, true);
  const changedSettings = await comparePostgresConfigArchiveSource(db, baseline.value,
    { ...comparison, archiveId: "drift-check-2" }, authority);
  assert.equal(changedSettings.ok, true);
  if (changedSettings.ok) assert.deepEqual(changedSettings.value.changed, ["settings"]);
  const catalogue = new PostgresKnowledgeCatalogue(db, "unsafeReference");
  assert.equal((await catalogue.saveDraft(scope, "arrival", "0", "clinic-owner", "Please arrive early.",
    "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "archive-admin")).ok, true);
  assert.equal((await catalogue.approve(scope, "arrival", "1", "archive-admin")).ok, true);
  const changedBoth = await comparePostgresConfigArchiveSource(db, baseline.value,
    { ...comparison, archiveId: "drift-check-3" }, authority);
  assert.equal(changedBoth.ok, true);
  if (changedBoth.ok) assert.deepEqual(changedBoth.value.changed, ["settings", "knowledge"]);
  assert.equal((await new PostgresLedger(db, undefined, undefined, "unsafeReference").start("archive-drift-call", referenceDefaultPolicy(scope))).ok, true);
  const ineligible = await comparePostgresConfigArchiveSource(db, baseline.value,
    { ...comparison, archiveId: "drift-check-4" }, authority);
  assert.deepEqual(ineligible, { ok: false, error: { kind: "callsRequireRetention" } });
});

test("one PostgreSQL snapshot exports every mapped location and refuses a partial tenant", async () => {
  const tenantId = "archive-two-locations-tenant";
  const first = { tenantId, clinicId: "clinic", locationId: "a" };
  const second = { tenantId, clinicId: "clinic", locationId: "b" };
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "requestOnly", async () => ok(true), true, "unsafeReference");
  assert.equal((await policy.changeBookingEnabled(first, "0", true, "archive-admin")).ok, true);
  assert.equal((await policy.changeBookingEnabled(second, "0", false, "archive-admin")).ok, true);
  assert.equal((await policy.changeAutomationEnabled(first, "0", true, "archive-admin")).ok, true);
  const knowledge = new PostgresKnowledgeCatalogue(db, "unsafeReference");
  for (const [scope, sourceRef] of [[first, "parking-a"], [second, "parking-b"]] as const) {
    assert.equal((await knowledge.saveDraft(scope, sourceRef, "0", "clinic-owner", `Directions for ${sourceRef}`,
      "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "archive-admin")).ok, true);
    assert.equal((await knowledge.approve(scope, sourceRef, "1", "archive-admin")).ok, true);
  }
  const request: TenantConfigArchiveRequest = { sourceTenantId: tenantId, archiveId: "two-location-archive",
    archiveMode: "unsafeReference",
    actorRef: "archive-admin", createdAt: "2026-09-28T22:00:00Z", locations: [
      { sourceScope: second, targetScope: { tenantId: "buyer-two", clinicId: "clinic", locationId: "b" },
        timeZone: "Australia/Melbourne", mappingProvenance: "reviewed-b" },
      { sourceScope: first, targetScope: { tenantId: "buyer-two", clinicId: "clinic", locationId: "a" },
        timeZone: "Australia/Sydney", mappingProvenance: "reviewed-a" },
    ] };
  let audited = 0;
  const authority = { authorizeAndRecord: async () => { audited += 1; return ok({ requestRef: `two-location-audit-${audited}` }); } };
  const exported = await buildPostgresTenantConfigArchive(db, request, authority);
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  assert.equal((await verifyArchiveEnvelope(exported.value)).ok, true);
  const decoded = await decodeTenantConfigArchive(exported.value, "buyer-two");
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    assert.equal(decoded.value.locations.length, 2);
    assert.equal(decoded.value.clinics.length, 1);
    assert.deepEqual(decoded.value.locations.map(location => [location.sourceScope.locationId,
      location.policies.length, location.knowledge.length]).sort(), [["a", 2, 1], ["b", 2, 1]]);
    assert.equal(decoded.value.clinics[0]?.automation.length, 2);
  }
  const importer = new ReferenceTenantConfigArchiveImporter(() => "2026-09-28T22:05:00Z");
  const importAuthority = { authorizeAndRecord: async () => ok({ auditRef: "buyer-two-import-audit" }) };
  const mapper = { mapRef: (kind: string, sourceRef: string) => `buyer-two:${kind}:${sourceRef}` };
  const preflight = await importer.preflight(exported.value, "buyer-two", "buyer-admin", importAuthority, mapper);
  assert.equal(preflight.ok, true);
  if (preflight.ok) {
    assert.equal(preflight.value.status, "ready");
    assert.deepEqual(preflight.value.recordCounts, { locations: 2, settings: 6, knowledge: 2, calls: 0, staffWork: 0 });
    assert.equal(preflight.value.sectionDigests.settings,
      JSON.parse(Buffer.from(exported.value.manifestBytes).toString()).sections.settings.sha256);
    assert.deepEqual(preflight.value.omittedCalls,
      { retentionExpired: 0, consentDenied: 0, notRetained: 0, activeCall: 0 });
    assert.equal(preflight.value.locations.length, 2);
    assert.equal(preflight.value.mappings.filter(row => row.kind === "knowledgeOwner").length, 2);
  }
  const preflightOnly = new ReferenceTenantConfigArchiveImporter(() => "2026-09-28T22:05:00Z");
  assert.equal((await preflightOnly.preflight(exported.value, "buyer-two", "buyer-admin", importAuthority, mapper)).ok, true);
  const replacementManifest = { ...JSON.parse(Buffer.from(exported.value.manifestBytes).toString()),
    archiveId: "different-archive-after-tenant-preflight" };
  const afterDryRun = await preflightOnly.stage({ ...exported.value,
    manifestBytes: Buffer.from(JSON.stringify(replacementManifest)) }, "buyer-two", "buyer-admin", importAuthority, mapper);
  assert.equal(afterDryRun.ok, true);
  const staged = await importer.stage(exported.value, "buyer-two", "buyer-admin", importAuthority, mapper);
  assert.equal(staged.ok, true);
  if (staged.ok) {
    assert.equal(staged.value.receipt.status, "staged");
    assert.deepEqual(staged.value.receipt.locations.map(row => row.importedPolicyVersion).sort(), ["1", "2"]);
    for (const targetScope of request.locations.map(row => row.targetScope)) {
      const targetPolicy = await staged.value.policy.read(targetScope);
      assert.equal(targetPolicy.ok, true);
      if (targetPolicy.ok) {
        assert.equal(targetPolicy.value.bookingEnabled, false);
        assert.equal(targetPolicy.value.automationEnabled, false);
        assert.equal(targetPolicy.value.automationVersion, "2");
        assert.equal(targetPolicy.value.capabilities.book, "unavailable");
      }
      const stopped = await staged.value.ledger.readWriteStop(targetScope);
      assert.equal(stopped.ok && stopped.value.stopped, true);
    }
    const firstKnowledge = await staged.value.knowledge.readKnowledge(request.locations[1]!.targetScope, ["parking-a"]);
    const secondKnowledge = await staged.value.knowledge.readKnowledge(request.locations[0]!.targetScope, ["parking-b"]);
    assert.equal(firstKnowledge.ok && firstKnowledge.value.length, 1);
    assert.equal(secondKnowledge.ok && secondKnowledge.value.length, 1);
    const reception = createEmbeddedTextComposition(staged.value.ledger, staged.value.policy,
      new ReferenceClinicHost([], []), undefined, undefined, undefined, staged.value.knowledge);
    for (const [targetScope, sourceRef, answer] of [
      [request.locations[1]!.targetScope, "parking-a", "Directions for parking-a"],
      [request.locations[0]!.targetScope, "parking-b", "Directions for parking-b"],
    ] as const) {
      const callId = `tenant-import-${targetScope.locationId}`;
      const started = await reception.startCall(callId, targetScope, "2026-09-28T22:06:00Z");
      assert.equal(started.ok, true);
      if (started.ok) assert.deepEqual(started.value.policy.knowledgeSnapshot, [{ sourceRef, version: "2" }]);
      const answered = await reception.answer(targetScope,
        { callId, turnId: `parking-${targetScope.locationId}`, text: "Where do I park?", quality: "clear", at: "2026-09-28T22:06:00Z" },
        [sourceRef], answer, "2026-09-28T22:06:00Z");
      assert.equal(answered.ok, true);
      if (answered.ok) assert.equal(answered.value.callerMessages.at(-1), answer);
    }
    const sharedChange = await staged.value.policy.changeAutomationEnabled(request.locations[1]!.targetScope,
      "2", false, "buyer-admin");
    assert.equal(sharedChange.ok, true);
    const otherLocation = await staged.value.policy.read(request.locations[0]!.targetScope);
    assert.equal(otherLocation.ok && otherLocation.value.automationVersion, "3");
    const replay = await importer.stage(exported.value, "buyer-two", "buyer-admin", importAuthority, mapper);
    assert.equal(replay.ok && replay.value === staged.value, true);
    const replayPreflight = await importer.preflight(exported.value, "buyer-two", "buyer-admin", importAuthority,
      { mapRef: () => null });
    assert.equal(replayPreflight.ok && replayPreflight.value.status === "alreadyStaged", true);
    const changedManifest = { ...JSON.parse(Buffer.from(exported.value.manifestBytes).toString()),
      createdAt: "2026-09-28T22:00:01Z" };
    const conflict = await importer.stage({ ...exported.value, manifestBytes: Buffer.from(JSON.stringify(changedManifest)) },
      "buyer-two", "buyer-admin", importAuthority, mapper);
    assert.deepEqual(conflict, { ok: false, error: { kind: "archiveConflict" } });
    const occupied = await importer.stage({ ...exported.value, manifestBytes: Buffer.from(JSON.stringify({ ...changedManifest,
      archiveId: "other-two-location-archive" })) }, "buyer-two", "buyer-admin", importAuthority, mapper);
    assert.deepEqual(occupied, { ok: false, error: { kind: "targetOccupied" } });
  }
  const mappingImporter = new ReferenceTenantConfigArchiveImporter();
  const missingOwner = await mappingImporter.preflight(exported.value, "buyer-two",
    "buyer-admin", importAuthority, { mapRef: (kind, sourceRef) => kind === "knowledgeOwner" ? null : `buyer-two:${kind}:${sourceRef}` });
  assert.deepEqual(missingOwner, { ok: false, error: { kind: "unmappedRef" } });
  const blankDestination = await mappingImporter.preflight(exported.value, "buyer-two",
    "buyer-admin", importAuthority, { mapRef: (kind, sourceRef) => kind === "operatorQueue" ? " " : `buyer-two:${kind}:${sourceRef}` });
  assert.deepEqual(blankDestination, { ok: false, error: { kind: "unmappedRef" } });
  assert.equal((await mappingImporter.stage(exported.value, "buyer-two", "buyer-admin", importAuthority, mapper)).ok, true);
  const singleLocationDecoder = await decodeConfigArchive(exported.value, request.locations[0]!.targetScope);
  assert.deepEqual(singleLocationDecoder, { ok: false, error: { kind: "invalidConfigArchive", section: "locations" } });
  const wrongTargetTenant = await decodeTenantConfigArchive(exported.value, "other-buyer");
  assert.deepEqual(wrongTargetTenant, { ok: false, error: { kind: "invalidConfigArchive", section: "locations" } });
  const locations = await records(exported.value, "locations");
  const settings = await records(exported.value, "settings");
  const published = await records(exported.value, "knowledge");
  assert.deepEqual(locations.map(row => row.sourceLocationId), ["a", "b"]);
  assert.deepEqual(settings.filter(row => row.kind === "locationPolicy" && row.isHead)
    .map(row => row.sourceLocationId).sort(), ["a", "b"]);
  assert.equal(settings.filter(row => row.kind === "clinicAutomation" && row.isHead).length, 1);
  assert.deepEqual(published.map(row => row.sourceLocationId).sort(), ["a", "b"]);
  const manifest = JSON.parse(Buffer.from(exported.value.manifestBytes).toString());
  assert.deepEqual(manifest.locationMappings.map((row: { sourceScope: { locationId: string } }) => row.sourceScope.locationId), ["a", "b"]);
  const missingMapping = { ...manifest, locationMappings: manifest.locationMappings.slice(0, 1) };
  const missingMappingResult = await decodeTenantConfigArchive({ ...exported.value,
    manifestBytes: Buffer.from(JSON.stringify(missingMapping)) }, "buyer-two");
  assert.deepEqual(missingMappingResult, { ok: false, error: { kind: "invalidConfigArchive", section: "locations" } });
  const alteredRows = settings.map(row => ({ ...row }));
  const crossed = alteredRows.find(row => row.kind === "locationPolicy" && row.sourceLocationId === "b");
  assert.ok(crossed);
  crossed.sourceLocationId = "unmapped";
  const alteredSettings = Buffer.from(alteredRows.map(row => `${JSON.stringify(row)}\n`).join(""));
  const alteredManifest = JSON.parse(Buffer.from(exported.value.manifestBytes).toString());
  alteredManifest.sections.settings.byteCount = alteredSettings.byteLength;
  alteredManifest.sections.settings.sha256 = createHash("sha256").update(alteredSettings).digest("hex");
  const crossedArchive = { manifestBytes: Buffer.from(JSON.stringify(alteredManifest)), sections: {
    ...exported.value.sections, settings: async function* () { yield alteredSettings; },
  } };
  assert.equal((await verifyArchiveEnvelope(crossedArchive)).ok, true);
  assert.deepEqual(await decodeTenantConfigArchive(crossedArchive, "buyer-two"),
    { ok: false, error: { kind: "invalidConfigArchive", section: "settings" } });
  const partial = await buildPostgresTenantConfigArchive(db, { ...request, archiveId: "partial-two-location-archive",
    locations: request.locations.slice(0, 1) }, authority);
  assert.deepEqual(partial, { ok: false, error: { kind: "scopeIncomplete" } });
  const duplicateTarget = await buildPostgresTenantConfigArchive(db, { ...request, archiveId: "duplicate-target-archive",
    locations: [request.locations[0]!, { ...request.locations[1]!, targetScope: request.locations[0]!.targetScope }] }, authority);
  assert.deepEqual(duplicateTarget, { ok: false, error: { kind: "invalidConfig" } });
  const splitTargetTenant = await buildPostgresTenantConfigArchive(db, { ...request, archiveId: "split-target-archive",
    locations: [request.locations[0]!, { ...request.locations[1]!, targetScope: { ...request.locations[1]!.targetScope, tenantId: "other-buyer" } }] }, authority);
  assert.deepEqual(splitTargetTenant, { ok: false, error: { kind: "invalidConfig" } });
  const missingTimeZone = await buildPostgresTenantConfigArchive(db, { ...request, archiveId: "missing-zone-archive",
    locations: [request.locations[0]!, { ...request.locations[1]!, timeZone: "" }] }, authority);
  assert.deepEqual(missingTimeZone, { ok: false, error: { kind: "invalidConfig" } });
  assert.equal(audited, 2);
  const splitClinicArchive = await buildPostgresTenantConfigArchive(db, { ...request,
    archiveId: "split-clinic-archive", locations: [
      { ...request.locations[0]!, targetScope: { ...request.locations[0]!.targetScope, clinicId: "other-clinic" } },
      request.locations[1]!,
    ] }, authority);
  assert.equal(splitClinicArchive.ok, true);
  if (splitClinicArchive.ok) {
    const splitImport = await new ReferenceTenantConfigArchiveImporter().preflight(splitClinicArchive.value,
      "buyer-two", "buyer-admin", importAuthority, mapper);
    assert.deepEqual(splitImport, { ok: false, error: { kind: "invalidMapping" } });
  }
});
