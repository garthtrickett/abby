import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import type { Result } from "../../src/core/model.ts";
import { decodeTenantConfigArchive } from "../../src/portability/config-archive.ts";
import { createStandaloneTextComposition } from "../../src/standalone/text-composition.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { buildPostgresConfigArchive, buildPostgresFencedTenantConfigArchive } from "../../src/storage/postgres-config-archive.ts";
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
  assert.equal(baselineData.sectionManifests.calls.recordCount, 0);
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
  assert.deepEqual(drift.changed, ["omittedCalls"]);
  const frozen = value(await fence.freeze({ tenantId: scope.tenantId, actorRef: "source-admin",
    reason: "cutoverFreeze" }, fenceAuthority));
  assert.equal(frozen.frozen, true);
  const finalRequest = { sourceTenantId: scope.tenantId, expectedFenceVersion: frozen.version,
    archiveId: `final-${suffix}`, actorRef: "source-admin", createdAt: now,
    locations: [{ sourceScope: scope, targetScope, timeZone: "Australia/Sydney", mappingProvenance: "reviewed" }] };
  const finalArchive = value(await buildPostgresFencedTenantConfigArchive(db, finalRequest, sourceAuthority));
  const finalData = value(await decodeTenantConfigArchive(finalArchive, targetScope.tenantId));
  assert.equal(finalData.omittedCalls.notRetained, 2);
  assert.equal(finalData.sectionManifests.calls.recordCount, 0);
  const comparison = value(await comparePostgresFencedTenantArchiveSource(db, finalArchive,
    { ...finalRequest, archiveId: `fenced-check-${suffix}` }, sourceAuthority));
  assert.deepEqual(comparison.changed, []);

  const importer = new PostgresTenantConfigArchiveImporter(db, () => now);
  const targetAuthority = { authorizeAndRecord: async () => ok({ auditRef: `target-audit-${suffix}` }) };
  const mapper = { mapRef: () => "disabled" };
  const preflight = value(await importer.preflight(finalArchive, targetScope.tenantId,
    "buyer-admin", targetAuthority, mapper));
  assert.equal(preflight.omittedCalls.notRetained, 2);
  const receipt = value(await importer.stage(finalArchive, targetScope.tenantId,
    "buyer-admin", targetAuthority, mapper));
  assert.equal(receipt.omittedCalls.notRetained, 2);
  assert.equal(receipt.recordCounts.calls, 0);
  const recovered = value(await importer.read(targetScope.tenantId, "buyer-admin", targetAuthority));
  assert.equal(recovered?.sourceHistory.omittedCalls.notRetained, 2);
  const targetCalls = await sql<{ count: string }>`select count(*)::text as count from calls
    where tenant_id = ${targetScope.tenantId}`.execute(db);
  assert.equal(targetCalls.rows[0]?.count, "0");
  assert.equal(Buffer.from(finalArchive.manifestBytes).toString("utf8").includes(privateCanary), false);
});
