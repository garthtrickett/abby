import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { verifyArchiveEnvelope } from "../../src/portability/archive-envelope.ts";
import type { ArchiveEnvelope, ArchiveSection } from "../../src/portability/archive-envelope.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { PostgresKnowledgeCatalogue } from "../../src/storage/postgres-knowledge-catalogue.ts";
import { ReferenceConfigArchiveImporter } from "../../src/reference/config-archive-import.ts";
import { createEmbeddedTextComposition } from "../../src/reference/embedded-composition.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { buildPostgresConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { comparePostgresConfigArchiveSource } from "../../src/storage/postgres-config-archive-drift.ts";
import type { ConfigArchiveAuthority, ConfigArchiveRequest } from "../../src/storage/postgres-config-archive.ts";

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
    timeZone: "Australia/Sydney", mappingProvenance: "buyer-reviewed-map-1", archiveId: "config-archive-1",
    actorRef: "archive-admin", createdAt: "2026-09-28T22:00:00Z" };
  const authority: ConfigArchiveAuthority = { authorizeAndRecord: async () => ok({ requestRef: "audited-request-1" }) };
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "requestOnly", async () => ok(true));
  assert.equal((await policy.changeBookingEnabled(scope, "0", true, "archive-admin")).ok, true);
  assert.equal((await policy.changeBookingEnabled(scope, "1", false, "archive-admin")).ok, true);
  assert.equal((await policy.changeBookingEnabled(scope, "2", true, "archive-admin")).ok, true);
  assert.equal((await policy.changeAutomationEnabled(scope, "0", true, "archive-admin")).ok, true);
  const catalogue = new PostgresKnowledgeCatalogue(db);
  const draft = await catalogue.saveDraft(scope, "parking", "0", "clinic-owner", "Parking is behind the clinic.",
    "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "archive-admin");
  assert.equal(draft.ok, true);
  assert.equal((await catalogue.approve(scope, "parking", "1", "archive-admin")).ok, true);
  assert.equal((await catalogue.saveDraft(scope, "parking", "2", "clinic-owner", "Parking is near the entrance.",
    "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "archive-admin")).ok, true);
  assert.equal((await catalogue.approve(scope, "parking", "3", "archive-admin")).ok, true);
  await sql`update clinic_settings set policy = jsonb_set(policy || jsonb_build_object('apiKey', ${"secret-canary-never-export"}::text),
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
  assert.equal(importedPolicy.value.capabilities.cancel, "requestOnly");
  assert.equal(importedPolicy.value.policyVersion, "4");
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

  const call = await new PostgresLedger(db).start("archive-existing-call", referenceDefaultPolicy(scope));
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

test("a pristine PostgreSQL source stages the reference default with writes stopped", async () => {
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
  assert.equal(staged.value.receipt.policyVersions, 0);
  assert.equal(staged.value.receipt.automationVersions, 0);
  const policy = await staged.value.policy.read(targetScope);
  assert.equal(policy.ok, true);
  if (policy.ok) {
    assert.equal(policy.value.bookingEnabled, false);
    assert.equal(policy.value.automationEnabled, false);
    assert.equal(policy.value.capabilities.book, "unavailable");
  }
  const stop = await staged.value.ledger.readWriteStop(targetScope);
  assert.equal(stop.ok && stop.value.stopped, true);
});

test("config archive refuses to omit another location in the source tenant", async () => {
  const scope = { tenantId: "archive-multilocation-tenant", clinicId: "clinic", locationId: "location-a" };
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "requestOnly");
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
    archiveId: "drift-baseline", actorRef: "archive-admin", createdAt: "2026-09-28T22:00:00Z" };
  let audited = 0;
  const authority: ConfigArchiveAuthority = { authorizeAndRecord: async () => ok({ requestRef: `drift-audit-${++audited}` }) };
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "requestOnly");
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
  const catalogue = new PostgresKnowledgeCatalogue(db);
  assert.equal((await catalogue.saveDraft(scope, "arrival", "0", "clinic-owner", "Please arrive early.",
    "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "archive-admin")).ok, true);
  assert.equal((await catalogue.approve(scope, "arrival", "1", "archive-admin")).ok, true);
  const changedBoth = await comparePostgresConfigArchiveSource(db, baseline.value,
    { ...comparison, archiveId: "drift-check-3" }, authority);
  assert.equal(changedBoth.ok, true);
  if (changedBoth.ok) assert.deepEqual(changedBoth.value.changed, ["settings", "knowledge"]);
  assert.equal((await new PostgresLedger(db).start("archive-drift-call", referenceDefaultPolicy(scope))).ok, true);
  const ineligible = await comparePostgresConfigArchiveSource(db, baseline.value,
    { ...comparison, archiveId: "drift-check-4" }, authority);
  assert.deepEqual(ineligible, { ok: false, error: { kind: "callsRequireRetention" } });
});
