import assert from "node:assert/strict";
import test, { after } from "node:test";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { createEmbeddedTextComposition } from "../../src/reference/embedded-composition.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresKnowledgeCatalogue } from "../../src/storage/postgres-knowledge-catalogue.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { buildPostgresTenantConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { PostgresTenantConfigArchiveImporter } from "../../src/storage/postgres-tenant-config-import.ts";
import { PostgresPortabilityFence } from "../../src/storage/postgres-portability-fence.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

test("configuration archive persists native target state, source history, and replay across importer restarts", async () => {
  const source = { tenantId: "durable-import-source", clinicId: "clinic", locationId: "a" };
  const sourceB = { ...source, locationId: "b" };
  const target = { tenantId: "durable-import-target", clinicId: "buyer-clinic", locationId: "a" };
  const targetB = { ...target, locationId: "b" };
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "requestOnly", async () => ok(true));
  assert.equal((await policy.changeBookingEnabled(source, "0", true, "source-admin")).ok, true);
  assert.equal((await policy.changeBookingEnabled(sourceB, "0", false, "source-admin")).ok, true);
  assert.equal((await policy.changeAutomationEnabled(source, "0", true, "source-admin")).ok, true);
  const knowledge = new PostgresKnowledgeCatalogue(db);
  for (const [scope, ref] of [[source, "parking-a"], [sourceB, "parking-b"]] as const) {
    assert.equal((await knowledge.saveDraft(scope, ref, "0", "source-owner", `Directions for ${ref}`,
      "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "source-admin")).ok, true);
    assert.equal((await knowledge.approve(scope, ref, "1", "source-admin")).ok, true);
  }
  const exported = await buildPostgresTenantConfigArchive(db, {
    archiveMode: "unsafeReference",
    sourceTenantId: source.tenantId, archiveId: "durable-archive-1", actorRef: "source-admin",
    createdAt: "2026-09-28T22:00:00Z", locations: [
      { sourceScope: source, targetScope: target, timeZone: "Australia/Sydney", mappingProvenance: "reviewed-a" },
      { sourceScope: sourceB, targetScope: targetB, timeZone: "Australia/Sydney", mappingProvenance: "reviewed-b" },
    ],
  }, { authorizeAndRecord: async () => ok({ requestRef: "source-export-audit" }) });
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  let audits = 0;
  const authority = { authorizeAndRecord: async () => ok({ auditRef: `buyer-audit-${++audits}` }) };
  const mapper = { mapRef: (kind: string, ref: string) => `buyer:${kind}:${ref}` };
  const importer = new PostgresTenantConfigArchiveImporter(db, () => "2026-09-28T22:05:00Z");
  const before = await importer.preflight(exported.value, target.tenantId, "buyer-admin", authority, mapper);
  assert.equal(before.ok && before.value.status, "ready");
  assert.equal((await sql<{ count: string }>`select count(*)::text as count from tenant_config_imports
    where target_tenant_id = ${target.tenantId}`.execute(db)).rows[0]?.count, "0");
  const staged = await importer.stage(exported.value, target.tenantId, "buyer-admin", authority, mapper);
  assert.equal(staged.ok, true);
  if (!staged.ok) return;
  assert.equal(staged.value.status, "staged");
  assert.deepEqual(staged.value.locations.map(row => row.importedPolicyVersion).sort(), ["1", "2"]);
  for (const scope of [target, targetB]) {
    const current = await policy.read(scope);
    assert.equal(current.ok, true);
    if (current.ok) {
      assert.equal(current.value.bookingEnabled, false);
      assert.equal(current.value.automationEnabled, false);
      assert.equal(current.value.automationVersion, "2");
      assert.equal(current.value.capabilities.book, "unavailable");
      assert.equal(current.value.staffDestination.kind, "owner");
      if (current.value.staffDestination.kind === "owner") {
        assert.equal(current.value.staffDestination.ownerRef.startsWith("buyer:staffOwner:"), true);
      }
    }
    const stop = await new PostgresLedger(db, undefined, undefined, "unsafeReference").readWriteStop(scope);
    assert.equal(stop.ok && stop.value.stopped, true);
  }
  const bookingHistory = await policy.listBookingChanges(target);
  assert.equal(bookingHistory.ok, true);
  if (bookingHistory.ok) assert.deepEqual(bookingHistory.value.entries.map(row => [row.version, row.enabled]),
    [["1", true], ["2", false]]);
  const automationHistory = await policy.listAutomationChanges(target);
  assert.equal(automationHistory.ok, true);
  if (automationHistory.ok) assert.deepEqual(automationHistory.value.entries.map(row => [row.version, row.enabled]),
    [["1", true], ["2", false]]);
  const importedKnowledge = await knowledge.readKnowledge(target, ["parking-a"]);
  assert.equal(importedKnowledge.ok && importedKnowledge.value[0]?.approvedText, "Directions for parking-a");
  const reception = createEmbeddedTextComposition(new PostgresLedger(db, undefined, undefined, "unsafeReference"), policy,
    new ReferenceClinicHost([], []), undefined, undefined, undefined, knowledge);
  const started = await reception.startCall("durable-import-call", target, "2026-09-28T22:06:00Z");
  assert.equal(started.ok, true);
  if (started.ok) assert.deepEqual(started.value.policy.knowledgeSnapshot, [{ sourceRef: "parking-a", version: "2" }]);
  const answered = await reception.answer(target, { callId: "durable-import-call", turnId: "parking",
    text: "Where do I park?", quality: "clear", at: "2026-09-28T22:06:00Z" },
  ["parking-a"], "Directions for parking-a", "2026-09-28T22:06:00Z");
  assert.equal(answered.ok, true);
  if (answered.ok) assert.equal(answered.value.callerMessages.at(-1), "Directions for parking-a");

  const restarted = new PostgresTenantConfigArchiveImporter(db);
  const retained = await restarted.read(target.tenantId, "buyer-admin", authority);
  assert.equal(retained.ok && retained.value?.sourceHistory.locations.length, 2);
  if (retained.ok && retained.value) {
    assert.equal(retained.value.receipt.manifestDigest, staged.value.manifestDigest);
    assert.equal(retained.value.sourceHistory.clinics[0]?.automation.length, 2);
    assert.deepEqual(retained.value.sourceHistory.locations.map(row => row.knowledge.length), [1, 1]);
  }
  const replay = await restarted.stage(exported.value, target.tenantId, "buyer-admin", authority, mapper);
  assert.deepEqual(replay, staged);
  const occupied = await restarted.stage({ ...exported.value, manifestBytes: Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(exported.value.manifestBytes).toString()), archiveId: "durable-archive-2" })) },
  target.tenantId, "buyer-admin", authority, mapper);
  assert.deepEqual(occupied, { ok: false, error: { kind: "targetOccupied" } });
  const denied = await restarted.read(target.tenantId, "stranger", { authorizeAndRecord: async () =>
    ({ ok: false as const, error: { kind: "denied" as const } }) });
  assert.deepEqual(denied, { ok: false, error: { kind: "denied" } });
  assert.equal(audits >= 4, true);
});

test("concurrent stage is one durable import and pre-existing target data blocks a second archive", async () => {
  const source = { tenantId: "durable-race-source", clinicId: "clinic", locationId: "location" };
  const target = { tenantId: "durable-race-target", clinicId: "buyer", locationId: "location" };
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy);
  assert.equal((await policy.changeBookingEnabled(source, "0", false, "source-admin")).ok, true);
  const request = { sourceTenantId: source.tenantId, archiveId: "durable-race-archive", actorRef: "source-admin",
    archiveMode: "unsafeReference" as const,
    createdAt: "2026-09-28T22:00:00Z", locations: [
      { sourceScope: source, targetScope: target, timeZone: "UTC", mappingProvenance: "reviewed" },
    ] };
  const exported = await buildPostgresTenantConfigArchive(db, request,
    { authorizeAndRecord: async () => ok({ requestRef: "durable-race-export-audit" }) });
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  const authority = { authorizeAndRecord: async () => ok({ auditRef: "durable-race-import-audit" }) };
  const mapper = { mapRef: (kind: string, ref: string) => `buyer:${kind}:${ref}` };
  const results = await Promise.all([0, 1].map(() => new PostgresTenantConfigArchiveImporter(db,
    () => "2026-09-28T22:05:00Z").stage(exported.value, target.tenantId, "buyer-admin", authority, mapper)));
  const first = results[0]!;
  const second = results[1]!;
  assert.equal(first.ok && second.ok, true);
  assert.deepEqual(first, second);
  const registry = await sql<{ count: string }>`select count(*)::text as count from tenant_config_imports
    where target_tenant_id = ${target.tenantId}`.execute(db);
  assert.equal(registry.rows[0]?.count, "1");
  const rows = await sql<{ count: string }>`select count(*)::text as count from clinic_settings
    where tenant_id = ${target.tenantId}`.execute(db);
  assert.equal(rows.rows[0]?.count, "2");
  const frozen = await new PostgresPortabilityFence(db).freeze({ tenantId: target.tenantId,
    actorRef: "buyer-admin", reason: "Protect imported target" },
  { authorizeAndRecord: async () => ok({ requestRef: "durable-import-freeze-audit" }) });
  assert.equal(frozen.ok && frozen.value.frozen, true);
  await assert.rejects(sql`update tenant_config_imports set archive_id = 'tampered'
    where target_tenant_id = ${target.tenantId}`.execute(db));

  const occupied = { tenantId: "durable-occupied-target", clinicId: "buyer", locationId: "location" };
  assert.equal((await policy.changeBookingEnabled(occupied, "0", false, "buyer-admin")).ok, true);
  const occupiedArchive = await buildPostgresTenantConfigArchive(db, {
    ...request, archiveId: "durable-occupied-archive", locations: [
      { ...request.locations[0]!, targetScope: occupied },
    ],
  }, { authorizeAndRecord: async () => ok({ requestRef: "durable-occupied-export-audit" }) });
  assert.equal(occupiedArchive.ok, true);
  if (!occupiedArchive.ok) return;
  const importer = new PostgresTenantConfigArchiveImporter(db);
  assert.deepEqual(await importer.stage(occupiedArchive.value, occupied.tenantId, "buyer-admin", authority, mapper),
    { ok: false, error: { kind: "targetOccupied" } });
  assert.equal((await importer.read(occupied.tenantId, "buyer-admin", authority)).ok, true);
  const stillOne = await sql<{ count: string }>`select count(*)::text as count from clinic_settings
    where tenant_id = ${occupied.tenantId}`.execute(db);
  assert.equal(stillOne.rows[0]?.count, "2");
});
