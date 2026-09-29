import assert from "node:assert/strict";
import test, { after } from "node:test";
import { sql } from "kysely";
import { err, ok } from "../../src/core/model.ts";
import { pendingCallId } from "../../src/core/pending-location.ts";
import { decodeConfigArchive, decodeTenantConfigArchive } from "../../src/portability/config-archive.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { buildPostgresConfigArchive, buildPostgresTenantConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { comparePostgresConfigArchiveSource } from "../../src/storage/postgres-config-archive-drift.ts";
import { PostgresKnowledgeCatalogue } from "../../src/storage/postgres-knowledge-catalogue.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { PostgresPortabilityFence } from "../../src/storage/postgres-portability-fence.ts";
import type { PortabilityFenceAuthority } from "../../src/storage/postgres-portability-fence.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

function authority(requestRef: string): PortabilityFenceAuthority {
  return { authorizeAndRecord: async () => ok({ requestRef }) };
}

test("a denied freeze leaves no tenant fence row", async () => {
  const tenantId = "fence-denied-tenant";
  const fence = new PostgresPortabilityFence(db);
  const request = { tenantId, actorRef: "unauthorized", reason: "Attempted cutover" };
  assert.deepEqual(await fence.freeze(request, { authorizeAndRecord: async () => err({ kind: "denied" }) }),
    { ok: false, error: { kind: "denied" } });
  const rows = await sql<{ found: number }>`select 1 as found from tenant_portability_fences
    where tenant_id = ${tenantId}`.execute(db);
  assert.equal(rows.rows.length, 0);
});

test("an application role without fence-table writes is still guarded", async () => {
  const role = "abby_portability_writer_test";
  const tenantId = "fence-role-tenant";
  await sql.raw(`create role ${role} nologin`).execute(db);
  await sql.raw(`grant usage on schema public to ${role}`).execute(db);
  await sql.raw(`grant insert on clinic_settings to ${role}`).execute(db);
  const insertAsWriter = (locationId: string) => db.transaction().execute(async trx => {
    await sql.raw(`set local role ${role}`).execute(trx);
    const scope = { tenantId, clinicId: "clinic", locationId };
    await sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy)
      values (${tenantId}, 'clinic', ${locationId}, 0, ${JSON.stringify(referenceDefaultPolicy(scope))}::jsonb)`.execute(trx);
  });
  await insertAsWriter("before");
  assert.equal((await new PostgresPortabilityFence(db).freeze({ tenantId, actorRef: "export-admin",
    reason: "Role rehearsal" }, authority("role-freeze"))).ok, true);
  await assert.rejects(() => insertAsWriter("after"), (cause: unknown) =>
    !!cause && typeof cause === "object" && "code" in cause && cause.code === "P0001");
});

test("one tenant fence covers every mapped location in a two-location archive", async () => {
  const tenantId = "fence-two-location-tenant";
  const north = { tenantId, clinicId: "clinic", locationId: "north" };
  const south = { tenantId, clinicId: "clinic", locationId: "south" };
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy);
  assert.equal((await policy.changeBookingEnabled(north, "0", true, "clinic-admin")).ok, true);
  assert.equal((await policy.changeBookingEnabled(south, "0", true, "clinic-admin")).ok, true);
  assert.equal((await new PostgresPortabilityFence(db).freeze({ tenantId, actorRef: "export-admin",
    reason: "Two-location cutover" }, authority("two-location-freeze"))).ok, true);
  assert.equal((await policy.changeBookingEnabled(north, "1", false, "clinic-admin")).ok, false);
  assert.equal((await policy.changeBookingEnabled(south, "1", false, "clinic-admin")).ok, false);
  const exported = await buildPostgresTenantConfigArchive(db, { sourceTenantId: tenantId,
    locations: [north, south].map(sourceScope => ({ sourceScope,
      targetScope: { ...sourceScope, tenantId: "buyer-two-location" },
      timeZone: "Australia/Sydney", mappingProvenance: "reviewed-map" })),
    archiveId: "two-location-frozen", actorRef: "export-admin", createdAt: "2026-09-29T00:00:00Z",
  }, { authorizeAndRecord: async () => ok({ requestRef: "two-location-export" }) });
  assert.equal(exported.ok, true);
  if (exported.ok) {
    const decoded = await decodeTenantConfigArchive(exported.value, "buyer-two-location");
    assert.equal(decoded.ok, true);
    if (decoded.ok) assert.deepEqual(decoded.value.locations.map(location => location.sourceScope.locationId).sort(),
      ["north", "south"]);
  }
});

test("a durable fence keeps a configuration-only archive unchanged until an audited release", async () => {
  const scope = { tenantId: "fence-config-tenant", clinicId: "clinic", locationId: "location" };
  const targetScope = { tenantId: "buyer-fence", clinicId: "buyer-clinic", locationId: "buyer-location" };
  const request = { scope, targetScope, timeZone: "Australia/Sydney", mappingProvenance: "reviewed-map",
    archiveId: "fence-before", actorRef: "export-admin", createdAt: "2026-09-29T00:00:00Z" };
  const exportAuthority = { authorizeAndRecord: async () => ok({ requestRef: "export-audit" }) };
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy);
  const catalogue = new PostgresKnowledgeCatalogue(db);
  const fence = new PostgresPortabilityFence(db);
  const ledger = new PostgresLedger(db, undefined, undefined, "unsafeReference");
  assert.equal((await policy.changeBookingEnabled(scope, "0", true, "clinic-admin")).ok, true);
  const before = await buildPostgresConfigArchive(db, request, exportAuthority);
  assert.equal(before.ok, true);
  if (!before.ok) return;

  const freezeRequest = { tenantId: scope.tenantId, actorRef: "export-admin", reason: "Configuration cutover rehearsal" };
  const frozen = await fence.freeze(freezeRequest, authority("freeze-audit-1"));
  assert.deepEqual(frozen, { ok: true, value: { tenantId: scope.tenantId, version: 1, frozen: true,
    lastRequestRef: "freeze-audit-1" } });
  assert.deepEqual(await fence.freeze(freezeRequest, authority("freeze-audit-1")), frozen);
  assert.deepEqual(await fence.freeze(freezeRequest, authority("other-freeze")),
    { ok: false, error: { kind: "alreadyFrozen" } });
  assert.equal((await policy.changeBookingEnabled(scope, "1", false, "clinic-admin")).ok, false);
  assert.equal((await catalogue.saveDraft(scope, "parking", "0", "clinic-owner", "Parking is behind the clinic.",
    "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "clinic-admin")).ok, false);
  assert.deepEqual(await ledger.start("fence-new-call", referenceDefaultPolicy(scope)),
    { ok: false, error: { kind: "storageFailure" } });
  const key = { accountRef: "fence-account", providerCallRef: "fence-provider-call" };
  const pending = await ledger.reservePendingLocation(pendingCallId(key), {
    tenantId: scope.tenantId, clinicId: scope.clinicId, routeVersion: "route-1", candidateLocationIds: ["a", "b"],
    candidateNames: [{ locationId: "a", spokenName: "North" }, { locationId: "b", spokenName: "South" }],
  }, { key, dialedNumber: "+6125550100", acceptedAt: "2026-09-29T00:00:00Z", deadline: "2026-09-29T00:00:30Z" });
  assert.deepEqual(pending, { ok: false, error: { kind: "storageFailure" } });
  await assert.rejects(() => sql`update clinic_settings set changed_by = 'direct-write'
    where tenant_id = ${scope.tenantId}`.execute(db));
  let truncateFailure: unknown;
  try {
    await db.transaction().execute(async trx => {
      await sql`truncate clinic_settings`.execute(trx);
      throw new Error("truncate unexpectedly allowed");
    });
  } catch (cause) { truncateFailure = cause; }
  assert.ok(truncateFailure instanceof Error);
  assert.notEqual(truncateFailure.message, "truncate unexpectedly allowed");

  const baseline = await decodeConfigArchive(before.value, targetScope);
  assert.equal(baseline.ok, true);
  const compared = await comparePostgresConfigArchiveSource(db, before.value,
    { ...request, archiveId: "fence-after" }, exportAuthority);
  assert.equal(compared.ok, true);
  if (compared.ok) assert.deepEqual(compared.value.changed, []);
  const otherScope = { tenantId: "fence-other-tenant", clinicId: "clinic", locationId: "location" };
  assert.equal((await policy.changeBookingEnabled(otherScope, "0", true, "other-admin")).ok, true);

  assert.deepEqual(await fence.release({ ...freezeRequest, expectedVersion: 2 }, authority("release-stale")),
    { ok: false, error: { kind: "versionConflict" } });
  const released = await fence.release({ ...freezeRequest, expectedVersion: 1 }, authority("release-audit-1"));
  assert.deepEqual(released, { ok: true, value: { tenantId: scope.tenantId, version: 2, frozen: false,
    lastRequestRef: "release-audit-1" } });
  assert.deepEqual(await fence.release({ ...freezeRequest, expectedVersion: 1 }, authority("release-audit-1")), released);
  assert.deepEqual(await fence.freeze(freezeRequest, authority("freeze-audit-1")),
    { ok: false, error: { kind: "staleRequest" } });
  assert.equal((await policy.changeBookingEnabled(scope, "1", false, "clinic-admin")).ok, true);
  const drift = await comparePostgresConfigArchiveSource(db, before.value,
    { ...request, archiveId: "fence-post-release" }, exportAuthority);
  assert.equal(drift.ok, true);
  if (drift.ok) assert.deepEqual(drift.value.changed, ["settings"]);
  const events = await sql<{ version: number; kind: string; request_ref: string }>`select version, kind, request_ref
    from tenant_portability_fence_events where tenant_id = ${scope.tenantId} order by version`.execute(db);
  assert.deepEqual(events.rows, [
    { version: 1, kind: "freeze", request_ref: "freeze-audit-1" },
    { version: 2, kind: "release", request_ref: "release-audit-1" },
  ]);
});

test("call history makes a freeze fail before any fence state is changed", async () => {
  const scope = { tenantId: "fence-calls-tenant", clinicId: "clinic", locationId: "location" };
  const ledger = new PostgresLedger(db, undefined, undefined, "unsafeReference");
  assert.equal((await ledger.start("fence-existing-call", referenceDefaultPolicy(scope))).ok, true);
  const fence = new PostgresPortabilityFence(db);
  const result = await fence.freeze({ tenantId: scope.tenantId, actorRef: "export-admin", reason: "Archive rehearsal" },
    authority("blocked-freeze"));
  assert.deepEqual(result, { ok: false, error: { kind: "callsRequireRetention" } });
  assert.deepEqual(await fence.read(scope.tenantId), { ok: true, value: { tenantId: scope.tenantId, version: 0,
    frozen: false, lastRequestRef: null } });
  const events = await sql<{ found: number }>`select 1 as found from tenant_portability_fence_events
    where tenant_id = ${scope.tenantId}`.execute(db);
  assert.equal(events.rows.length, 0);
});

test("a pending shared-number route blocks freeze before location binding", async () => {
  const tenantId = "fence-pending-tenant";
  const key = { accountRef: "pending-account", providerCallRef: "pending-call" };
  const ledger = new PostgresLedger(db, undefined, undefined, "unsafeReference");
  const reserved = await ledger.reservePendingLocation(pendingCallId(key), {
    tenantId, clinicId: "clinic", routeVersion: "route-1", candidateLocationIds: ["a", "b"],
    candidateNames: [{ locationId: "a", spokenName: "North" }, { locationId: "b", spokenName: "South" }],
  }, { key, dialedNumber: "+6125550100", acceptedAt: "2026-09-29T00:00:00Z", deadline: "2026-09-29T00:00:30Z" });
  assert.equal(reserved.ok, true);
  const result = await new PostgresPortabilityFence(db).freeze({ tenantId, actorRef: "export-admin",
    reason: "Archive rehearsal" }, authority("pending-freeze"));
  assert.deepEqual(result, { ok: false, error: { kind: "callsRequireRetention" } });
});

test("orphaned in-flight write evidence also blocks a configuration-only freeze", async () => {
  const scope = { tenantId: "fence-inflight-tenant", clinicId: "clinic", locationId: "location" };
  const ledger = new PostgresLedger(db, undefined, undefined, "unsafeReference");
  assert.equal((await ledger.stopWrites(scope, "clinic-admin", "Incident review")).ok, true);
  await sql`insert into clinic_write_stop_inflight (tenant_id, clinic_id, stop_version, effect_id, call_id,
    action_key, status) values (${scope.tenantId}, ${scope.clinicId}, 1, 'orphan-effect', 'missing-call',
    'orphan-action', 'uncertain')`.execute(db);
  const result = await new PostgresPortabilityFence(db).freeze({ tenantId: scope.tenantId,
    actorRef: "export-admin", reason: "Archive rehearsal" }, authority("inflight-freeze"));
  assert.deepEqual(result, { ok: false, error: { kind: "unresolvedWork" } });
  const exported = await buildPostgresConfigArchive(db, { scope, targetScope: { ...scope, tenantId: "buyer-inflight" },
    timeZone: "UTC", mappingProvenance: "reviewed-map", archiveId: "inflight-archive", actorRef: "export-admin",
    createdAt: "2026-09-29T00:00:00Z" }, { authorizeAndRecord: async () => ok({ requestRef: "inflight-export" }) });
  assert.deepEqual(exported, { ok: false, error: { kind: "unresolvedWork" } });
});

test("freeze waits for an earlier tenant write and archives the committed setting", async () => {
  const scope = { tenantId: "fence-write-race-tenant", clinicId: "clinic", locationId: "location" };
  const fence = new PostgresPortabilityFence(db);
  let writerReady!: () => void;
  let releaseWriter!: () => void;
  const ready = new Promise<void>(resolve => { writerReady = resolve; });
  const hold = new Promise<void>(resolve => { releaseWriter = resolve; });
  const writer = db.transaction().execute(async trx => {
    const policy = referenceDefaultPolicy(scope);
    await sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy)
      values (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, 0, ${JSON.stringify(policy)}::jsonb)`.execute(trx);
    writerReady();
    await hold;
  });
  await Promise.race([ready, writer.then(() => { throw new Error("writer ended before signaling"); })]);
  let authorized!: () => void;
  const started = new Promise<void>(resolve => { authorized = resolve; });
  const freezing = fence.freeze({ tenantId: scope.tenantId, actorRef: "export-admin", reason: "Race rehearsal" },
    { authorizeAndRecord: async () => { authorized(); return ok({ requestRef: "race-freeze" }); } });
  await started;
  try {
    const completedEarly = await Promise.race([freezing.then(() => true),
      new Promise<boolean>(resolve => { setTimeout(() => resolve(false), 50); })]);
    assert.equal(completedEarly, false);
  } finally { releaseWriter(); }
  await writer;
  const frozen = await freezing;
  assert.equal(frozen.ok, true);
  const exported = await buildPostgresConfigArchive(db, { scope, targetScope: { ...scope, tenantId: "buyer-race" },
    timeZone: "UTC", mappingProvenance: "race-map", archiveId: "race-archive", actorRef: "export-admin",
    createdAt: "2026-09-29T00:00:00Z" }, { authorizeAndRecord: async () => ok({ requestRef: "race-export" }) });
  assert.equal(exported.ok, true);
  if (exported.ok) {
    const decoded = await decodeConfigArchive(exported.value, { ...scope, tenantId: "buyer-race" });
    assert.equal(decoded.ok, true);
    if (decoded.ok) assert.equal(decoded.value.policies.length, 1);
  }
});

test("a repeatable-read writer with a pre-freeze snapshot cannot evade a new fence", async () => {
  const scope = { tenantId: "fence-old-snapshot-tenant", clinicId: "clinic", locationId: "location" };
  const fence = new PostgresPortabilityFence(db);
  let snapshotReady!: () => void;
  let releaseWriter!: () => void;
  const ready = new Promise<void>(resolve => { snapshotReady = resolve; });
  const hold = new Promise<void>(resolve => { releaseWriter = resolve; });
  const writer = db.transaction().setIsolationLevel("repeatable read").execute(async trx => {
    await sql`select 1 from clinic_settings where tenant_id = ${scope.tenantId}`.execute(trx);
    snapshotReady();
    await hold;
    const policy = { ...referenceDefaultPolicy(scope), policyVersion: "1" };
    await sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy)
      values (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, 1, ${JSON.stringify(policy)}::jsonb)`.execute(trx);
  });
  await Promise.race([ready, writer.then(() => { throw new Error("writer ended before signaling"); })]);
  try {
    const frozen = await fence.freeze({ tenantId: scope.tenantId, actorRef: "export-admin", reason: "Old snapshot rehearsal" },
      authority("old-snapshot-freeze"));
    assert.equal(frozen.ok, true);
  } finally { releaseWriter(); }
  await assert.rejects(writer);
  const changed = await sql<{ found: number }>`select 1 as found from clinic_settings where tenant_id = ${scope.tenantId}`.execute(db);
  assert.equal(changed.rows.length, 0);
});
