import assert from "node:assert/strict";
import test, { after } from "node:test";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import type { StaffItem } from "../../src/core/model.ts";
import { ClinicPolicyRouter } from "../../src/reference/clinic-number-routing.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { buildPostgresFencedTenantConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { PostgresKnowledgeCatalogue } from "../../src/storage/postgres-knowledge-catalogue.ts";
import { PostgresConfigNumberCutover, PostgresNumberRoutingHost } from "../../src/storage/postgres-number-cutover.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { PostgresPortabilityFence } from "../../src/storage/postgres-portability-fence.ts";
import { PostgresTenantConfigArchiveImporter } from "../../src/storage/postgres-tenant-config-import.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

test("shared-number cutover stages, publishes once, and rolls back without losing target staff work", async () => {
  const sourceA = { tenantId: "route-cutover-source", clinicId: "source-clinic", locationId: "a" };
  const sourceB = { ...sourceA, locationId: "b" };
  const targetA = { tenantId: "route-cutover-target", clinicId: "target-clinic", locationId: "alpha" };
  const targetB = { ...targetA, locationId: "beta" };
  const accountRef = "route-cutover-account";
  const dialedNumber = "+6125550195";
  const original = { tenantId: sourceA.tenantId, clinicId: sourceA.clinicId,
    candidateLocationIds: ["a", "b"], candidateNames: [
      { locationId: "a", spokenName: "Main Street" }, { locationId: "b", spokenName: "Northside" }] };
  await sql`insert into number_routes (account_ref, dialed_number, version, assignment)
    values (${accountRef}, ${dialedNumber}, 1, ${JSON.stringify(original)}::jsonb)`.execute(db);
  const routeHost = new PostgresNumberRoutingHost(db);
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "requestOnly", async () => ok(true), true, "unsafeReference");
  const router = new ClinicPolicyRouter(routeHost, policy);
  const initial = await router.identify(accountRef, dialedNumber);
  assert.equal(initial.ok && initial.value.tenantId, sourceA.tenantId);
  assert.equal(initial.ok && initial.value.routeVersion, "1");
  assert.equal((await policy.changeBookingEnabled(sourceA, "0", true, "source-admin")).ok, true);
  assert.equal((await policy.changeBookingEnabled(sourceB, "0", false, "source-admin")).ok, true);
  const knowledge = new PostgresKnowledgeCatalogue(db);
  assert.equal((await knowledge.saveDraft(sourceA, "parking", "0", "source-owner", "Parking is behind the clinic.",
    "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "source-admin")).ok, true);
  assert.equal((await knowledge.approve(sourceA, "parking", "1", "source-admin")).ok, true);
  const fence = new PostgresPortabilityFence(db);
  const fenceAuthority = { authorizeAndRecord: async (action: string) =>
    ok({ requestRef: `route-cutover-fence-${action}` }) };
  const frozen = await fence.freeze({ tenantId: sourceA.tenantId, actorRef: "source-admin",
    reason: "cutoverFreeze" }, fenceAuthority);
  assert.equal(frozen.ok && frozen.value.version === 1, true);
  const exportRequest = { sourceTenantId: sourceA.tenantId, archiveId: "route-cutover-archive",
    archiveMode: "unsafeReference" as const,
    actorRef: "source-admin", createdAt: "2026-09-29T00:00:00Z", expectedFenceVersion: 1,
    locations: [
      { sourceScope: sourceA, targetScope: targetA, timeZone: "Australia/Sydney", mappingProvenance: "reviewed-a" },
      { sourceScope: sourceB, targetScope: targetB, timeZone: "Australia/Sydney", mappingProvenance: "reviewed-b" },
    ] };
  let exportAudits = 0;
  const exportAuthority = { authorizeAndRecord: async () => ok({ requestRef: `route-cutover-export-${++exportAudits}` }) };
  const archive = await buildPostgresFencedTenantConfigArchive(db, exportRequest, exportAuthority);
  assert.equal(archive.ok, true);
  if (!archive.ok) return;
  const mapper = { mapRef: (kind: string, ref: string) => `target:${kind}:${ref}` };
  const importAuthority = { authorizeAndRecord: async () => ok({ auditRef: "route-cutover-import-audit" }) };
  const imported = await new PostgresTenantConfigArchiveImporter(db, undefined, "unsafeReference").stage(archive.value,
    targetA.tenantId, "target-admin", importAuthority, mapper);
  assert.equal(imported.ok && imported.value.sourceFenceVersion, 1);
  const cutover = new PostgresConfigNumberCutover(db);
  let routeAudits = 0;
  const routeAuthority = { authorizeAndRecord: async (action: string) =>
    ok({ auditRef: `route-cutover-${action}-${++routeAudits}` }) };
  const command = { accountRef, dialedNumber, actorRef: "route-admin" };
  const wrongRouteVersion = await cutover.stage({ ...command, expectedRouteVersion: 2, baseline: archive.value,
    comparison: { ...exportRequest, archiveId: "route-cutover-wrong-route-compare" } },
  routeAuthority, exportAuthority);
  assert.deepEqual(wrongRouteVersion, { ok: false, error: { kind: "routeConflict" } });
  const staged = await cutover.stage({ ...command, expectedRouteVersion: 1, baseline: archive.value,
    comparison: { ...exportRequest, archiveId: "route-cutover-compare" } }, routeAuthority, exportAuthority);
  assert.equal(staged.ok && staged.value.state === "staged" && staged.value.activeTenantId === sourceA.tenantId, true);
  const restaged = await new PostgresConfigNumberCutover(db).stage({ ...command, expectedRouteVersion: 1,
    baseline: archive.value, comparison: { ...exportRequest, archiveId: "route-cutover-replay-compare" } },
  routeAuthority, exportAuthority);
  assert.deepEqual(restaged, staged);
  const beforePublish = await routeHost.identifyCall(accountRef, dialedNumber);
  assert.equal(beforePublish.ok && beforePublish.value.tenantId, sourceA.tenantId);
  await sql`update clinic_knowledge_events set answer_text = 'Tampered target knowledge'
    where tenant_id = ${targetA.tenantId} and clinic_id = ${targetA.clinicId}
    and location_id = ${targetA.locationId} and source_ref = 'parking' and version = 2`.execute(db);
  assert.deepEqual(await cutover.publish(command, routeAuthority),
    { ok: false, error: { kind: "targetNotReady" } });
  const afterTamper = await routeHost.identifyCall(accountRef, dialedNumber);
  assert.equal(afterTamper.ok && afterTamper.value.tenantId, sourceA.tenantId);
  await sql`update clinic_knowledge_events set answer_text = 'Parking is behind the clinic.'
    where tenant_id = ${targetA.tenantId} and clinic_id = ${targetA.clinicId}
    and location_id = ${targetA.locationId} and source_ref = 'parking' and version = 2`.execute(db);
  const [published, concurrentPublish] = await Promise.all([
    cutover.publish(command, routeAuthority), new PostgresConfigNumberCutover(db).publish(command, routeAuthority)]);
  assert.equal(published.ok && published.value.state === "published" && published.value.routeVersion === 2, true);
  assert.deepEqual(concurrentPublish, published);
  const replay = await new PostgresConfigNumberCutover(db).publish(command, routeAuthority);
  assert.deepEqual(replay, published);
  const targetRoute = await router.identify(accountRef, dialedNumber);
  assert.equal(targetRoute.ok && targetRoute.value.tenantId, targetA.tenantId);
  if (targetRoute.ok) {
    assert.deepEqual(targetRoute.value.candidateLocationIds, ["alpha", "beta"]);
    assert.equal(targetRoute.value.candidateNames?.[0]?.spokenName, "Main Street");
    assert.equal(targetRoute.value.routeVersion, "2");
    const selected = await router.resolveSelected(accountRef, dialedNumber,
      { tenantId: targetA.tenantId, clinicId: targetA.clinicId, locationId: "alpha", routeVersion: "2" });
    assert.equal(selected.ok && selected.value.bookingEnabled, false);
    if (selected.ok) {
      const ledger = new PostgresLedger(db, undefined, undefined, "unsafeReference");
      assert.equal((await ledger.start("route-cutover-target-call", selected.value)).ok, true);
      const staff: StaffItem = { key: "route-cutover-staff-item", scope: targetA, reason: "callerRequested",
        destination: selected.value.staffDestination, dueAt: "2026-09-29T00:30:00Z", status: "requested" };
      await sql`insert into staff_items (task_key, call_id, tenant_id, status, payload)
        values (${staff.key}, ${"route-cutover-target-call"}, ${targetA.tenantId},
        ${staff.status}, ${JSON.stringify(staff)}::jsonb)`.execute(db);
      const beforeRollback = await ledger.listStaffItems(targetA);
      assert.equal(beforeRollback.ok && beforeRollback.value[0]?.taskKey, staff.key);
    }
  }
  const blocked = await fence.release({ tenantId: sourceA.tenantId, actorRef: "source-admin",
    reason: "cutoverRelease", expectedVersion: 1 }, fenceAuthority);
  assert.deepEqual(blocked, { ok: false, error: { kind: "routeOwnedByTarget" } });
  await assert.rejects(sql`update tenant_portability_fences set frozen = false
    where tenant_id = ${sourceA.tenantId}`.execute(db));
  const pending = await cutover.beginRollback(command, routeAuthority);
  assert.equal(pending.ok && pending.value.state === "rollbackPendingRelease" &&
    pending.value.activeTenantId === targetA.tenantId, true);
  assert.deepEqual(await cutover.finishRollback(command, routeAuthority),
    { ok: false, error: { kind: "sourceFenceChanged" } });
  const released = await fence.release({ tenantId: sourceA.tenantId, actorRef: "source-admin",
    reason: "cutoverRelease", expectedVersion: 1 }, fenceAuthority);
  assert.equal(released.ok && released.value.version === 2 && !released.value.frozen, true);
  const beforeFinish = await routeHost.identifyCall(accountRef, dialedNumber);
  assert.equal(beforeFinish.ok && beforeFinish.value.tenantId, targetA.tenantId);
  const rolledBack = await new PostgresConfigNumberCutover(db).finishRollback(command, routeAuthority);
  assert.equal(rolledBack.ok && rolledBack.value.state === "rolledBack" && rolledBack.value.routeVersion === 3, true);
  assert.deepEqual(await cutover.finishRollback(command, routeAuthority), rolledBack);
  const restored = await routeHost.identifyCall(accountRef, dialedNumber);
  assert.equal(restored.ok && restored.value.tenantId, sourceA.tenantId);
  assert.equal(restored.ok && restored.value.routeVersion, "3");
  const retainedWork = await new PostgresLedger(db, undefined, undefined, "unsafeReference").listStaffItems(targetA);
  assert.equal(retainedWork.ok && retainedWork.value[0]?.taskKey, "route-cutover-staff-item");
  const events = await sql<{ kind: string }>`select kind from number_route_events
    where account_ref = ${accountRef} and dialed_number = ${dialedNumber} order by event_id`.execute(db);
  assert.deepEqual(events.rows.map(row => row.kind), ["stage", "publish", "beginRollback", "finishRollback"]);
});

test("release after stage prevents publication while the source route remains authoritative", async () => {
  const source = { tenantId: "route-stale-source", clinicId: "source-clinic", locationId: "location" };
  const target = { tenantId: "route-stale-target", clinicId: "target-clinic", locationId: "location" };
  const accountRef = "route-stale-account";
  const dialedNumber = "+6125550196";
  await sql`insert into number_routes (account_ref, dialed_number, version, assignment)
    values (${accountRef}, ${dialedNumber}, 1,
      ${JSON.stringify({ tenantId: source.tenantId, clinicId: source.clinicId, candidateLocationIds: ["location"] })}::jsonb)`.execute(db);
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, undefined, undefined, true, "unsafeReference");
  assert.equal((await policy.changeBookingEnabled(source, "0", false, "source-admin")).ok, true);
  let fenceAudits = 0;
  const fenceAuthority = { authorizeAndRecord: async () => ok({ requestRef: `route-stale-fence-${++fenceAudits}` }) };
  const fence = new PostgresPortabilityFence(db);
  assert.equal((await fence.freeze({ tenantId: source.tenantId, actorRef: "source-admin",
    reason: "cutoverFreeze" }, fenceAuthority)).ok, true);
  const request = { sourceTenantId: source.tenantId, archiveId: "route-stale-archive", actorRef: "source-admin",
    archiveMode: "unsafeReference" as const,
    createdAt: "2026-09-29T00:00:00Z", expectedFenceVersion: 1, locations: [
      { sourceScope: source, targetScope: target, timeZone: "UTC", mappingProvenance: "reviewed" }] };
  let exportAudits = 0;
  const exportAuthority = { authorizeAndRecord: async () => ok({ requestRef: `route-stale-export-${++exportAudits}` }) };
  const archive = await buildPostgresFencedTenantConfigArchive(db, request, exportAuthority);
  assert.equal(archive.ok, true);
  if (!archive.ok) return;
  const imported = await new PostgresTenantConfigArchiveImporter(db, undefined, "unsafeReference").stage(archive.value,
    target.tenantId, "target-admin", { authorizeAndRecord: async () => ok({ auditRef: "route-stale-import" }) },
    { mapRef: (kind, ref) => `target:${kind}:${ref}` });
  assert.equal(imported.ok, true);
  let routeAudits = 0;
  const routeAuthority = { authorizeAndRecord: async (action: string) =>
    ok({ auditRef: `route-stale-${action}-${++routeAudits}` }) };
  const command = { accountRef, dialedNumber, actorRef: "route-admin" };
  const cutover = new PostgresConfigNumberCutover(db);
  assert.equal((await cutover.stage({ ...command, expectedRouteVersion: 1, baseline: archive.value,
    comparison: { ...request, archiveId: "route-stale-compare" } }, routeAuthority, exportAuthority)).ok, true);
  assert.equal((await fence.release({ tenantId: source.tenantId, actorRef: "source-admin",
    reason: "cutoverRelease", expectedVersion: 1 }, fenceAuthority)).ok, true);
  assert.deepEqual(await cutover.publish(command, routeAuthority),
    { ok: false, error: { kind: "sourceFenceChanged" } });
  const active = await new PostgresNumberRoutingHost(db).identifyCall(accountRef, dialedNumber);
  assert.equal(active.ok && active.value.tenantId, source.tenantId);
  assert.equal(active.ok && active.value.routeVersion, "1");
  assert.equal((await cutover.discard(command, routeAuthority)).ok, true);
});
