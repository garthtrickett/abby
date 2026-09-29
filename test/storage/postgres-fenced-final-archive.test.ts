import assert from "node:assert/strict";
import test, { after } from "node:test";
import { ok } from "../../src/core/model.ts";
import { verifyArchiveEnvelope } from "../../src/portability/archive-envelope.ts";
import { decodeConfigArchive, decodeTenantConfigArchive } from "../../src/portability/config-archive.ts";
import { ReferenceConfigArchiveImporter } from "../../src/reference/config-archive-import.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { buildPostgresFencedTenantConfigArchive, buildPostgresTenantConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { PostgresPortabilityFence } from "../../src/storage/postgres-portability-fence.ts";
import { PostgresTenantConfigArchiveImporter } from "../../src/storage/postgres-tenant-config-import.ts";
import { comparePostgresFencedTenantArchiveSource } from "../../src/storage/postgres-fenced-archive-compare.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

test("final archive and durable import receipt bind the exact frozen source version", async () => {
  const source = { tenantId: "fenced-final-source", clinicId: "clinic", locationId: "location" };
  const target = { tenantId: "fenced-final-target", clinicId: "buyer", locationId: "location" };
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "requestOnly");
  assert.equal((await policy.changeBookingEnabled(source, "0", true, "source-admin")).ok, true);
  const request = { sourceTenantId: source.tenantId, archiveId: "fenced-final-archive",
    actorRef: "source-admin", createdAt: "2026-09-28T22:00:00Z", expectedFenceVersion: 1,
    locations: [{ sourceScope: source, targetScope: target, timeZone: "UTC", mappingProvenance: "reviewed" }] };
  let exportsAudited = 0;
  const exportAuthority = { authorizeAndRecord: async () => ok({ requestRef: `fenced-final-export-${++exportsAudited}` }) };
  const dryRequest = { sourceTenantId: request.sourceTenantId, archiveId: "fenced-dry-run",
    actorRef: request.actorRef, createdAt: request.createdAt, locations: request.locations };
  const unfenced = await buildPostgresTenantConfigArchive(db, dryRequest, exportAuthority);
  assert.equal(unfenced.ok, true);
  if (unfenced.ok) {
    assert.equal(JSON.parse(Buffer.from(unfenced.value.manifestBytes).toString()).sourceFenceVersion, undefined);
  }
  const tooEarly = await buildPostgresFencedTenantConfigArchive(db, request, exportAuthority);
  assert.deepEqual(tooEarly, { ok: false, error: { kind: "fenceMismatch" } });
  const invalidVersion = await buildPostgresFencedTenantConfigArchive(db,
    { ...request, expectedFenceVersion: Number.NaN }, exportAuthority);
  assert.deepEqual(invalidVersion, { ok: false, error: { kind: "invalidConfig" } });

  const fence = new PostgresPortabilityFence(db);
  const fenceAuthority = { authorizeAndRecord: async (action: string) =>
    ok({ requestRef: action === "freeze" ? "fenced-final-freeze" : "fenced-final-release" }) };
  const frozen = await fence.freeze({ tenantId: source.tenantId, actorRef: "source-admin",
    reason: "Final archive snapshot" }, fenceAuthority);
  assert.equal(frozen.ok && frozen.value.version === 1 && frozen.value.frozen, true);
  const wrongVersion = await buildPostgresFencedTenantConfigArchive(db,
    { ...request, expectedFenceVersion: 2 }, exportAuthority);
  assert.deepEqual(wrongVersion, { ok: false, error: { kind: "fenceMismatch" } });
  const finalArchive = await buildPostgresFencedTenantConfigArchive(db, request, exportAuthority);
  assert.equal(finalArchive.ok, true);
  if (!finalArchive.ok) return;
  assert.equal(JSON.parse(Buffer.from(finalArchive.value.manifestBytes).toString()).sourceFenceVersion, 1);
  assert.equal((await verifyArchiveEnvelope(finalArchive.value)).ok, true);
  const decoded = await decodeTenantConfigArchive(finalArchive.value, target.tenantId);
  assert.equal(decoded.ok && decoded.value.sourceFenceVersion, 1);
  const single = await decodeConfigArchive(finalArchive.value, target);
  assert.equal(single.ok && single.value.sourceFenceVersion, 1);
  const mapper = { mapRef: (kind: string, ref: string) => `buyer:${kind}:${ref}` };
  const importAuthority = { authorizeAndRecord: async () => ok({ auditRef: "fenced-final-import" }) };
  const reference = await new ReferenceConfigArchiveImporter().preflight(finalArchive.value, target,
    "buyer-admin", { authorizeAndRecord: async () => ok({ auditRef: "fenced-final-reference" }) }, mapper);
  assert.equal(reference.ok && reference.value.sourceFenceVersion, 1);
  const imported = await new PostgresTenantConfigArchiveImporter(db).stage(finalArchive.value,
    target.tenantId, "buyer-admin", importAuthority, mapper);
  assert.equal(imported.ok && imported.value.sourceFenceVersion, 1);
  const compared = await comparePostgresFencedTenantArchiveSource(db, finalArchive.value,
    { ...request, archiveId: "fenced-final-compare" }, exportAuthority);
  assert.equal(compared.ok && compared.value.kind, "unchanged");
  if (compared.ok) assert.deepEqual(compared.value.changed, []);
  const retained = await new PostgresTenantConfigArchiveImporter(db).read(target.tenantId, "buyer-admin", importAuthority);
  assert.equal(retained.ok && retained.value?.sourceHistory.sourceFenceVersion, 1);
  assert.equal((await policy.changeBookingEnabled(source, "1", false, "source-admin")).ok, false);

  const released = await fence.release({ tenantId: source.tenantId, actorRef: "source-admin",
    reason: "Cancel synthetic rehearsal", expectedVersion: 1 }, fenceAuthority);
  assert.equal(released.ok && released.value.version === 2 && !released.value.frozen, true);
  const stale = await buildPostgresFencedTenantConfigArchive(db,
    { ...request, archiveId: "fenced-stale-archive" }, exportAuthority);
  assert.deepEqual(stale, { ok: false, error: { kind: "fenceMismatch" } });
  const staleComparison = await comparePostgresFencedTenantArchiveSource(db, finalArchive.value,
    { ...request, archiveId: "fenced-stale-compare" }, exportAuthority);
  assert.deepEqual(staleComparison, { ok: false, error: { kind: "fenceMismatch" } });
  const malformed = await verifyArchiveEnvelope({ ...finalArchive.value,
    manifestBytes: Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(finalArchive.value.manifestBytes).toString()),
      sourceFenceVersion: 0 })) });
  assert.deepEqual(malformed, { ok: false, error: { kind: "invalidManifest" } });
});

test("a digest-valid archive with a forged fence number fails the fresh source-content comparison", async () => {
  const source = { tenantId: "forged-fence-source", clinicId: "clinic", locationId: "location" };
  const target = { tenantId: "forged-fence-target", clinicId: "buyer", locationId: "location" };
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "requestOnly");
  assert.equal((await policy.changeBookingEnabled(source, "0", true, "source-admin")).ok, true);
  const request = { sourceTenantId: source.tenantId, archiveId: "forged-baseline",
    actorRef: "source-admin", createdAt: "2026-09-28T22:00:00Z",
    locations: [{ sourceScope: source, targetScope: target, timeZone: "UTC", mappingProvenance: "reviewed" }] };
  let audits = 0;
  const authority = { authorizeAndRecord: async () => ok({ requestRef: `forged-audit-${++audits}` }) };
  const old = await buildPostgresTenantConfigArchive(db, request, authority);
  assert.equal(old.ok, true);
  if (!old.ok) return;
  assert.equal((await policy.changeBookingEnabled(source, "1", false, "source-admin")).ok, true);
  const frozen = await new PostgresPortabilityFence(db).freeze({ tenantId: source.tenantId,
    actorRef: "source-admin", reason: "Freeze after changed settings" },
  { authorizeAndRecord: async () => ok({ requestRef: "forged-freeze-audit" }) });
  assert.equal(frozen.ok && frozen.value.version, 1);
  const forged = { ...old.value, manifestBytes: Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(old.value.manifestBytes).toString()), sourceFenceVersion: 1 })) };
  assert.equal((await verifyArchiveEnvelope(forged)).ok, true);
  const comparison = await comparePostgresFencedTenantArchiveSource(db, forged,
    { ...request, archiveId: "forged-fresh-compare", expectedFenceVersion: 1 }, authority);
  assert.equal(comparison.ok && comparison.value.kind, "changed");
  if (comparison.ok) assert.deepEqual(comparison.value.changed, ["settings"]);
  const wrongMapping = await comparePostgresFencedTenantArchiveSource(db, forged,
    { ...request, archiveId: "forged-wrong-map", expectedFenceVersion: 1,
      locations: [{ ...request.locations[0]!, mappingProvenance: "different" }] }, authority);
  assert.deepEqual(wrongMapping, { ok: false, error: { kind: "baselineMismatch" } });
});
