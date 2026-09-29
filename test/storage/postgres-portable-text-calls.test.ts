import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import type { Result } from "../../src/core/model.ts";
import { decodeTenantConfigArchive } from "../../src/portability/config-archive.ts";
import { createStandaloneTextComposition } from "../../src/standalone/text-composition.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { buildPostgresConfigArchive, buildPostgresFencedTenantConfigArchive,
  buildPostgresTenantConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { comparePostgresConfigArchiveSource } from "../../src/storage/postgres-config-archive-drift.ts";
import { comparePostgresFencedTenantArchiveSource } from "../../src/storage/postgres-fenced-archive-compare.ts";
import { PostgresPortabilityFence } from "../../src/storage/postgres-portability-fence.ts";
import { PostgresTenantConfigArchiveImporter } from "../../src/storage/postgres-tenant-config-import.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const db = connectPostgres(databaseUrl);
after(async () => { await db.destroy(); });

function value<T, E>(result: Result<T, E>): T {
  assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.error));
  return result.value;
}

test("E2E-127 text: completed strict calls permit fenced config import without call history", async () => {
  const suffix = randomUUID().slice(0, 8);
  const scope = { tenantId: `portable-text-${suffix}`, clinicId: "clinic", locationId: "frontdesk" };
  const targetScope = { ...scope, tenantId: `buyer-text-${suffix}` };
  const now = "2026-10-01T00:00:00Z";
  const app = createStandaloneTextComposition(db);
  const sourceAuthority = { authorizeAndRecord: async () => ok({ requestRef: `source-audit-${suffix}` }) };
  const request = { scope, targetScope, timeZone: "Australia/Sydney", mappingProvenance: "reviewed",
    actorRef: "source-admin", archiveId: `baseline-${suffix}`, createdAt: now };
  const begin = async (privateText: string) => {
    const callId = randomUUID();
    value(await app.reception.startCall(callId, scope, now));
    const state = value(await app.reception.checkAvailability(scope,
      { callId, turnId: randomUUID(), text: privateText, quality: "clear", at: now },
      "2026-10-02", "2026-10-02", now));
    assert.ok(state.pendingPresentationId);
    return { callId, presentationId: state.pendingPresentationId };
  };
  const finish = async (call: { callId: string; presentationId: string }) => {
    const state = value(await app.reception.completeTextPresentation(scope, call.callId, call.presentationId, now));
    assert.equal(state.terminal?.reason, "textCompleted");
  };

  const privateCanary = `caller-private-${suffix}`;
  const first = await begin(privateCanary);
  await finish(first);
  const baseline = value(await buildPostgresConfigArchive(db, request, sourceAuthority));
  const baselineData = value(await decodeTenantConfigArchive(baseline, targetScope.tenantId));
  assert.equal(baselineData.omittedCalls.notRetained, 1);
  assert.equal(baselineData.sectionManifests.calls.recordCount, 1);
  assert.equal(baselineData.locations[0]?.omittedTextCalls, 1);
  const archiveText = Buffer.from(baseline.manifestBytes).toString("utf8");
  assert.equal(archiveText.includes(first.callId) || archiveText.includes(privateCanary), false);

  const second = await begin(`another-private-${suffix}`);
  assert.deepEqual(await buildPostgresConfigArchive(db, { ...request, archiveId: `active-${suffix}` }, sourceAuthority),
    { ok: false, error: { kind: "callsRequireRetention" } });
  const fence = new PostgresPortabilityFence(db);
  const fenceAuthority = { authorizeAndRecord: async () => ok({ requestRef: `freeze-${suffix}` }) };
  assert.deepEqual(await fence.freeze({ tenantId: scope.tenantId, actorRef: "source-admin", reason: "cutoverFreeze" },
    fenceAuthority), { ok: false, error: { kind: "callsRequireRetention" } });
  await finish(second);

  const drift = value(await comparePostgresConfigArchiveSource(db, baseline,
    { ...request, archiveId: `comparison-${suffix}` }, sourceAuthority));
  assert.deepEqual(drift.changed, ["omittedCalls", "calls"]);
  const frozen = value(await fence.freeze({ tenantId: scope.tenantId, actorRef: "source-admin",
    reason: "cutoverFreeze" }, fenceAuthority));
  assert.equal(frozen.frozen, true);
  const finalRequest = { sourceTenantId: scope.tenantId, expectedFenceVersion: frozen.version,
    archiveId: `final-${suffix}`, actorRef: "source-admin", createdAt: now,
    locations: [{ sourceScope: scope, targetScope, timeZone: "Australia/Sydney", mappingProvenance: "reviewed" }] };
  const finalArchive = value(await buildPostgresFencedTenantConfigArchive(db, finalRequest, sourceAuthority));
  const finalData = value(await decodeTenantConfigArchive(finalArchive, targetScope.tenantId));
  assert.equal(finalData.omittedCalls.notRetained, 2);
  assert.equal(finalData.sectionManifests.calls.recordCount, 1);
  assert.equal(finalData.locations[0]?.omittedTextCalls, 2);
  const comparison = value(await comparePostgresFencedTenantArchiveSource(db, finalArchive,
    { ...finalRequest, archiveId: `fenced-check-${suffix}` }, sourceAuthority));
  assert.deepEqual(comparison.changed, []);

  const importer = new PostgresTenantConfigArchiveImporter(db, () => now);
  const targetAuthority = { authorizeAndRecord: async () => ok({ auditRef: `target-audit-${suffix}` }) };
  const mapper = { mapRef: () => "disabled" };
  const preflight = value(await importer.preflight(finalArchive, targetScope.tenantId,
    "buyer-admin", targetAuthority, mapper));
  assert.equal(preflight.omittedCalls.notRetained, 2);
  assert.equal(preflight.locations[0]?.omittedTextCalls, 2);
  const receipt = value(await importer.stage(finalArchive, targetScope.tenantId,
    "buyer-admin", targetAuthority, mapper));
  assert.equal(receipt.omittedCalls.notRetained, 2);
  assert.equal(receipt.recordCounts.calls, 1);
  assert.equal(receipt.locations[0]?.omittedTextCalls, 2);
  const recovered = value(await importer.read(targetScope.tenantId, "buyer-admin", targetAuthority));
  assert.equal(recovered?.sourceHistory.omittedCalls.notRetained, 2);
  assert.equal(recovered?.sourceHistory.locations[0]?.omittedTextCalls, 2);
  const targetCalls = await sql<{ count: string }>`select count(*)::text as count from calls
    where tenant_id = ${targetScope.tenantId}`.execute(db);
  assert.equal(targetCalls.rows[0]?.count, "0");
  assert.equal(Buffer.from(finalArchive.manifestBytes).toString("utf8").includes(privateCanary), false);
});

test("E2E-164 two-location archive reconciles omitted calls by mapped location and rejects a forged count", async () => {
  const suffix = randomUUID().slice(0, 8);
  const sourceA = { tenantId: `omission-source-${suffix}`, clinicId: "clinic", locationId: "a" };
  const sourceB = { ...sourceA, locationId: "b" };
  const targetA = { ...sourceA, tenantId: `omission-target-${suffix}`, locationId: "alpha" };
  const targetB = { ...targetA, locationId: "beta" };
  const now = "2026-10-01T00:00:00Z";
  const app = createStandaloneTextComposition(db);
  const privateText = `caller-private-${suffix}`;
  const callIds: string[] = [];
  for (const [scope, count] of [[sourceA, 1], [sourceB, 2]] as const) {
    for (let index = 0; index < count; index += 1) {
      const callId = randomUUID();
      callIds.push(callId);
      value(await app.reception.startCall(callId, scope, now));
      const state = value(await app.reception.checkAvailability(scope,
        { callId, turnId: randomUUID(), text: privateText, quality: "clear", at: now },
        "2026-10-02", "2026-10-02", now));
      assert.ok(state.pendingPresentationId);
      const ended = value(await app.reception.completeTextPresentation(scope, callId,
        state.pendingPresentationId, now));
      assert.equal(ended.terminal?.reason, "textCompleted");
    }
  }
  const request = { sourceTenantId: sourceA.tenantId, archiveId: `omission-archive-${suffix}`,
    actorRef: "source-admin", createdAt: now,
    locations: [
      { sourceScope: sourceA, targetScope: targetA, timeZone: "Australia/Sydney", mappingProvenance: "reviewed-a" },
      { sourceScope: sourceB, targetScope: targetB, timeZone: "Australia/Sydney", mappingProvenance: "reviewed-b" },
    ] };
  const archive = value(await buildPostgresTenantConfigArchive(db, request,
    { authorizeAndRecord: async () => ok({ requestRef: `source-audit-${suffix}` }) }));
  assert.equal((JSON.parse(Buffer.from(archive.manifestBytes).toString("utf8")) as { archiveVersion: number })
    .archiveVersion, 2);
  const data = value(await decodeTenantConfigArchive(archive, targetA.tenantId));
  assert.equal(data.sectionManifests.calls.version, 2);
  assert.equal(data.sectionManifests.calls.recordCount, 2);
  assert.equal(data.omittedCalls.notRetained, 3);
  assert.deepEqual(Object.fromEntries(data.locations.map(location =>
    [location.sourceScope.locationId, location.omittedTextCalls])), { a: 1, b: 2 });
  const legacyManifest = JSON.parse(Buffer.from(archive.manifestBytes).toString("utf8")) as {
    archiveVersion: number; sections: { calls: { version: number; recordCount: number;
      byteCount: number; sha256: string } } };
  legacyManifest.archiveVersion = 1;
  legacyManifest.sections.calls = { version: 1, recordCount: 0, byteCount: 0,
    sha256: createHash("sha256").update("").digest("hex") };
  const legacy = { ...archive, manifestBytes: Buffer.from(JSON.stringify(legacyManifest)),
    sections: { ...archive.sections, calls: async function* () { yield new Uint8Array(); } } };
  const legacyData = value(await decodeTenantConfigArchive(legacy, targetA.tenantId));
  assert.equal(legacyData.omittedCalls.notRetained, 3);
  assert.ok(legacyData.locations.every(location => location.omittedTextCalls === undefined));
  const serialized = [Buffer.from(archive.manifestBytes)];
  for (const section of ["locations", "settings", "knowledge", "calls", "staffWork"] as const) {
    for await (const chunk of archive.sections[section]()) serialized.push(Buffer.from(chunk));
  }
  const archiveText = Buffer.concat(serialized).toString("utf8");
  assert.equal(archiveText.includes(privateText) || callIds.some(id => archiveText.includes(id)), false);

  const importer = new PostgresTenantConfigArchiveImporter(db, () => now);
  const authority = { authorizeAndRecord: async () => ok({ auditRef: `target-audit-${suffix}` }) };
  const mapper = { mapRef: () => "disabled" };
  const preflight = value(await importer.preflight(archive, targetA.tenantId, "buyer-admin", authority, mapper));
  assert.deepEqual(preflight.locations.map(location => location.omittedTextCalls), [1, 2]);
  const staged = value(await importer.stage(archive, targetA.tenantId, "buyer-admin", authority, mapper));
  assert.equal(staged.recordCounts.calls, 2);
  assert.deepEqual(staged.locations.map(location => location.omittedTextCalls), [1, 2]);
  const recovered = value(await importer.read(targetA.tenantId, "buyer-admin", authority));
  assert.deepEqual(recovered?.sourceHistory.locations.map(location => location.omittedTextCalls), [1, 2]);

  const callBytes: Uint8Array[] = [];
  for await (const chunk of archive.sections.calls()) callBytes.push(chunk);
  const forged = Buffer.from(Buffer.concat(callBytes).toString("utf8")
    .split("\n").filter(Boolean).map(line => {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.sourceLocationId === "b") row.notRetained = 1;
      return `${JSON.stringify(row)}\n`;
    }).join(""));
  const manifest = JSON.parse(Buffer.from(archive.manifestBytes).toString("utf8")) as {
    sections: { calls: { byteCount: number; sha256: string } } };
  manifest.sections.calls.byteCount = forged.byteLength;
  manifest.sections.calls.sha256 = createHash("sha256").update(forged).digest("hex");
  const tampered = { ...archive, manifestBytes: Buffer.from(JSON.stringify(manifest)),
    sections: { ...archive.sections, calls: async function* () { yield forged; } } };
  assert.deepEqual(await decodeTenantConfigArchive(tampered, targetA.tenantId),
    { ok: false, error: { kind: "invalidConfigArchive", section: "calls" } });
});
