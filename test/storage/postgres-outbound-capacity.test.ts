import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresOutboundCapacity } from "../../src/storage/postgres-outbound-capacity.ts";
import { outboundCapacityOwnerBinding } from "../../src/core/outbound-capacity.ts";
import { PostgresPortabilityFence } from "../../src/storage/postgres-portability-fence.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { buildPostgresTenantConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { PostgresTenantConfigArchiveImporter } from "../../src/storage/postgres-tenant-config-import.ts";
import { decodeTenantConfigArchive } from "../../src/portability/config-archive.ts";
import { validStaffWorkHistoryManifest } from "../../src/portability/staff-work-history.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { down } from "../../src/storage/migrations/051_outbound_capacity.ts";
import type Database from "../../src/storage/generated/Database.ts";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const scope = () => ({ tenantId: `capacity-${randomUUID()}`, clinicId: "clinic", locationId: "location" });
const binding = () => outboundCapacityOwnerBinding(randomUUID())!;
function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T { assert.ok(r.ok, JSON.stringify(r)); return r.value; }
const authority = { authorizeAndRecord: async () => ok({ requestRef: `capacity-export-${randomUUID()}` }) };
const imports = { authorizeAndRecord: async () => ok({ auditRef: `capacity-import-${randomUUID()}` }) };
const mapper = { mapRef: () => "disabled" };

test("real concurrent final place stays held across fresh owners until trusted release; released IDs never acquire again", async () => {
  const owner = scope(), key = binding(), refs = Array.from({ length: 16 }, () => randomUUID());
  const results = await Promise.all(refs.map(ref => new PostgresOutboundCapacity(db, owner, key).acquireOnce(ref, 1)));
  assert.equal(results.filter(r => r.ok && r.value.kind === "acquired").length, 1);
  assert.equal(results.filter(r => r.ok && r.value.kind === "full").length, 15);
  const ref = refs[results.findIndex(r => r.ok && r.value.kind === "acquired")]!;
  const cold = new PostgresOutboundCapacity(db, owner, key);
  assert.deepEqual(value(await cold.acquireOnce(ref, 1)), { kind: "alreadyUsed" });
  assert.deepEqual(value(await cold.acquireOnce(randomUUID(), 1)), { kind: "full" });
  assert.deepEqual(value(await cold.releaseOnce(ref)), { released: true });
  assert.deepEqual(value(await cold.releaseOnce(ref)), { released: false });
  assert.deepEqual(value(await cold.acquireOnce(ref, 1)), { kind: "alreadyUsed" });
  assert.deepEqual(value(await cold.acquireOnce(randomUUID(), 1)), { kind: "acquired" });
  for (const bad of ["private-patient", "provider-private-call"]) assert.deepEqual(await cold.acquireOnce(bad, 1), { ok: false, error: { kind: "invalidInput" } });
  for (const maximum of [0, -1, 1001, 1.2, NaN]) assert.equal((await cold.acquireOnce(randomUUID(), maximum)).ok, false);
  const rows = (await sql<Record<string, unknown>>`select * from outbound_capacity_allocations where tenant_id = ${owner.tenantId}`.execute(db)).rows;
  assert.deepEqual(Object.keys(rows[0]!).sort(), ["acquired_at", "allocation_ref", "clinic_id", "location_id", "owner_binding", "released_at", "tenant_id"]);
  await assert.rejects(() => db.transaction().execute(trx => down<Database>(trx)), /capacity history/);
});
test("capacity counts stable campaign occupancy across location/policy changes and respects actual freeze", async () => {
  const owner = scope(), key = binding(), ref = randomUUID(), a = new PostgresOutboundCapacity(db, owner, key);
  value(await a.acquireOnce(ref, 2)); value(await a.acquireOnce(randomUUID(), 2));
  const other = new PostgresOutboundCapacity(db, { ...owner, locationId: "other" }, key);
  assert.deepEqual(value(await other.acquireOnce(randomUUID(), 1)), { kind: "full" });
  assert.deepEqual(await other.releaseOnce(ref), { ok: false, error: { kind: "bindingMismatch" } });
  assert.deepEqual(await new PostgresOutboundCapacity(db, owner, binding()).releaseOnce(ref), { ok: false, error: { kind: "bindingMismatch" } });
  value(await new PostgresPortabilityFence(db).freeze({ tenantId: owner.tenantId, actorRef: "fixture-owner", reason: "cutoverFreeze" }, authority));
  assert.deepEqual(await a.acquireOnce(randomUUID(), 3), { ok: false, error: { kind: "storageFailure" } });
  assert.deepEqual(await a.releaseOnce(ref), { ok: false, error: { kind: "storageFailure" } });
});
test("held and released capacity survive actual export/import/remap; missing imported occupancy cannot open a new place", async () => {
  const source = scope(), target = scope(), next = scope(), key = binding(), held = randomUUID(), released = randomUUID();
  value(await new PostgresPolicyStore(db, referenceDefaultPolicy).changeBookingEnabled(source, "0", true, "fixture-owner"));
  const original = new PostgresOutboundCapacity(db, source, key);
  value(await original.acquireOnce(held, 2)); value(await original.acquireOnce(released, 2)); value(await original.releaseOnce(released));
  const archive = value(await buildPostgresTenantConfigArchive(db, { sourceTenantId: source.tenantId,
    archiveId: `capacity-archive-${randomUUID()}`, actorRef: "fixture-owner", createdAt: new Date().toISOString(),
    locations: [{ sourceScope: source, targetScope: target, timeZone: "UTC", mappingProvenance: "fixture-reviewed" }] }, authority));
  const decoded = value(await decodeTenantConfigArchive(archive, target.tenantId));
  assert.equal(validStaffWorkHistoryManifest(decoded), true); assert.equal(decoded.locations[0]!.outboundCapacity!.length, 2);
  const importer = new PostgresTenantConfigArchiveImporter(db);
  assert.equal(value(await importer.stage(archive, target.tenantId, "fixture-owner", imports, mapper)).status, "staged");
  const restored = new PostgresOutboundCapacity(db, target, key);
  assert.deepEqual(value(await restored.acquireOnce(randomUUID(), 1)), { kind: "full" });
  assert.deepEqual(value(await restored.acquireOnce(released, 2)), { kind: "alreadyUsed" });
  // A trusted release may advance held imported state without losing origin.
  assert.deepEqual(value(await restored.releaseOnce(held)), { released: true });
  const second = value(await buildPostgresTenantConfigArchive(db, { sourceTenantId: target.tenantId,
    archiveId: `capacity-second-${randomUUID()}`, actorRef: "fixture-owner", createdAt: new Date().toISOString(),
    locations: [{ sourceScope: target, targetScope: next, timeZone: "UTC", mappingProvenance: "fixture-second" }] }, authority));
  const data = value(await decodeTenantConfigArchive(second, next.tenantId));
  assert.deepEqual(data.locations[0]!.outboundCapacity![0]!.originScope, source);
  assert.equal(value(await importer.stage(second, next.tenantId, "fixture-owner", imports, mapper)).status, "staged");
  await sql`delete from outbound_capacity_allocations where tenant_id = ${target.tenantId} and allocation_ref = ${held}::uuid`.execute(db);
  assert.deepEqual(await restored.acquireOnce(randomUUID(), 1), { ok: false, error: { kind: "storageFailure" } });
  assert.equal((await importer.stage(archive, target.tenantId, "fixture-owner", imports, mapper)).ok, false);
  assert.equal(validStaffWorkHistoryManifest({ ...decoded, locations: decoded.locations.map(l => ({ ...l, outboundCapacity: [] })) }), false);
});
test("capacity SQL and unfiltered backup carry no private provider/recipient/patient context", async () => {
  const owner = scope(); value(await new PostgresOutboundCapacity(db, owner, binding()).acquireOnce(randomUUID(), 1));
  const values = ["private-patient", "private@example.invalid", "provider-private-call", "+61400000000", "cliniko:patient:21"];
  assert.deepEqual(await scanPatientDataCanaries(db, values.map((value, i) => ({ label: `capacity_${i}`, value }))), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
  for (const value of values) assert.equal(dump.includes(value), false);
});
