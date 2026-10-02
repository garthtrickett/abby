import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import { ReferenceConfigArchiveImporter } from "../../src/reference/config-archive-import.ts";
import { decodeConfigArchive } from "../../src/portability/config-archive.ts";
import type { ArchiveEnvelope } from "../../src/portability/archive-envelope.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { buildPostgresConfigArchive, buildPostgresTenantConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { PostgresTenantConfigArchiveImporter } from "../../src/storage/postgres-tenant-config-import.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
const db = connectPostgres(process.env.DATABASE_URL);
after(async () => { await db.destroy(); });

test("E2E-252 cancellation edits have one concurrent winner, scoped durable history and no patient payload", async () => {
  const scope = { tenantId: `cancellation-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const otherLocation = { ...scope, locationId: "other" };
  const otherClinic = { ...scope, clinicId: "other" };
  // Even an incorrectly generous host argument cannot promote strict standalone patient work.
  const store = new PostgresPolicyStore(db, referenceDefaultPolicy, "execute", undefined, false,
    "standaloneMinimal", false, "execute");
  const initial = await store.read(scope);
  assert.ok(initial.ok);
  assert.equal(initial.value.cancellationEnabled, false);
  assert.equal(initial.value.capabilities.cancel, "unavailable");
  const changes = await Promise.all([
    store.changeCancellationEnabled(scope, "0", true, "admin-a"),
    store.changeCancellationEnabled(scope, "0", true, "admin-b"),
    store.changeBookingEnabled(scope, "0", true, "admin-c"),
  ]);
  assert.equal(changes.filter(result => result.ok).length, 1);
  assert.deepEqual(changes.filter(result => !result.ok).map(result => result.error.kind),
    ["versionConflict", "versionConflict"]);
  const persisted = await new PostgresPolicyStore(db, referenceDefaultPolicy).read(scope);
  assert.ok(persisted.ok);
  assert.equal(persisted.value.policyVersion, "1");
  assert.equal(persisted.value.capabilities.cancel, "unavailable");
  assert.ok((await store.changeCancellationEnabled(scope, "1", true, "clinic-admin")).ok);
  assert.ok((await store.changeBookingEnabled(scope, "2", false, "clinic-admin")).ok);
  assert.ok((await store.changeCancellationEnabled(otherLocation, "0", true, "other-admin")).ok);
  assert.ok((await store.changeCancellationEnabled(otherClinic, "0", true, "other-admin")).ok);
  const history = await store.listCancellationChanges(scope);
  assert.ok(history.ok);
  assert.equal(history.value.entries.at(-1)?.version, "2");
  assert.equal(history.value.entries.at(-1)?.actorRef, "clinic-admin");
  assert.equal(history.value.entries.some(row => row.actorRef === "other-admin"), false);
  assert.ok(history.value.entries.every(row => Number.isFinite(Date.parse(row.changedAt))));
  const booking = await store.listBookingChanges(scope);
  assert.ok(booking.ok);
  assert.equal(booking.value.entries.at(-1)?.version, "3");
  const canary = "PATIENT_SECRET_CANCELLATION_INVALID_INPUT";
  assert.deepEqual(await store.changeCancellationEnabled(scope, "3", canary as unknown as boolean, "clinic-admin"),
    { ok: false, error: { kind: "invalidValue" } });
  assert.deepEqual(await store.changeCancellationEnabled(scope, "3", false, " "),
    { ok: false, error: { kind: "invalidValue" } });
  assert.deepEqual(await store.listCancellationChanges(scope, -1), { ok: false, error: { kind: "invalidValue" } });
  assert.deepEqual(await scanPatientDataCanaries(db, [{ label: "invalid_toggle", value: canary }]), ok([]));
  const rows = await sql<{ version: number; policy: Record<string, unknown> }>`select version, policy
    from clinic_settings where tenant_id = ${scope.tenantId} and clinic_id = ${scope.clinicId}
      and location_id = ${scope.locationId} order by version`.execute(db);
  assert.deepEqual(rows.rows.map(row => row.version), [0, 1, 2, 3]);
  assert.ok(rows.rows.every(row => Object.keys(row.policy).every(key =>
    ["scope", "policyVersion", "bookingEnabled", "cancellationEnabled", "reschedulingEnabled", "afterHoursMode", "greeting"].includes(key))));
  assert.equal(rows.rows.at(-1)?.policy.cancellationEnabled, true);
});

test("E2E-252 cancellation audit pagination excludes booking edits and database constraints reject mixed history", async () => {
  const scope = { tenantId: `cancellation-pages-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const store = new PostgresPolicyStore(db, referenceDefaultPolicy);
  for (let version = 0; version < 51; version++) {
    assert.ok((await store.changeCancellationEnabled(scope, String(version), version % 2 === 0, "clinic-admin")).ok);
  }
  assert.ok((await store.changeBookingEnabled(scope, "51", true, "clinic-admin")).ok);
  const page = await store.listCancellationChanges(scope);
  assert.ok(page.ok);
  assert.equal(page.value.entries.length, 50);
  assert.equal(page.value.nextAfterVersion, 50);
  const tail = await store.listCancellationChanges(scope, page.value.nextAfterVersion);
  assert.ok(tail.ok);
  assert.deepEqual(tail.value.entries.map(row => [row.version, row.enabled, row.previousEnabled]), [["51", true, false]]);
  assert.equal(tail.value.nextAfterVersion, undefined);
  await assert.rejects(sql`update clinic_settings set previous_booking_enabled = false
    where tenant_id = ${scope.tenantId} and version = 51`.execute(db), /clinic_settings_change_kind_check/);
  await assert.rejects(sql`update clinic_settings set policy = policy - 'cancellationEnabled'
    where tenant_id = ${scope.tenantId} and version = 51`.execute(db), /clinic_settings_change_kind_check/);
  assert.equal((await store.read(scope)).ok, true);
});

for (const mode of ["standaloneMinimal", "unsafeReference"] as const) {
  test(`E2E-252 ${mode} cancellation archive retains both audits and imports separately disabled`, async () => {
    const scope = { tenantId: `cancellation-export-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
    const target = { tenantId: `cancellation-import-${randomUUID()}`, clinicId: "buyer", locationId: "main" };
    const store = new PostgresPolicyStore(db, referenceDefaultPolicy, "execute", undefined, false, mode, false, "execute");
    assert.ok((await store.changeBookingEnabled(scope, "0", true, "clinic-admin")).ok);
    assert.ok((await store.changeCancellationEnabled(scope, "1", true, "clinic-admin")).ok);
    const exported = await buildPostgresConfigArchive(db, { scope, targetScope: target, timeZone: "UTC",
      mappingProvenance: "reviewed", archiveMode: mode, archiveId: `cancellation-location-${randomUUID()}`,
      actorRef: "clinic-admin", createdAt: "2026-10-02T10:00:00Z" },
    { authorizeAndRecord: async () => ok({ requestRef: "cancellation-export-audit" }) });
    assert.ok(exported.ok, exported.ok ? "" : exported.error.kind);
    const envelope = exported.value;
    // Re-seal the bytes so semantic history validation, rather than a digest mismatch, must reject tampering.
    const chunks: Uint8Array[] = [];
    for await (const chunk of exported.value.sections.settings()) chunks.push(chunk);
    const records = Buffer.concat(chunks).toString().trim().split("\n").map(line => JSON.parse(line));
    function changedArchive(change: (rows: typeof records) => void): ArchiveEnvelope {
      const changed = structuredClone(records);
      change(changed);
      const bytes = Buffer.from(changed.map(row => `${JSON.stringify(row)}\n`).join(""));
      const manifest = JSON.parse(Buffer.from(envelope.manifestBytes).toString());
      manifest.sections.settings.byteCount = bytes.byteLength;
      manifest.sections.settings.sha256 = createHash("sha256").update(bytes).digest("hex");
      return { manifestBytes: Buffer.from(JSON.stringify(manifest)), sections: {
        ...envelope.sections, settings: async function* () { yield bytes; },
      } };
    }
    for (const alter of [
      (rows: typeof records) => { rows.find(row => row.settingKind === "cancellation").previousCancellationEnabled = true; },
      (rows: typeof records) => { rows.find(row => row.settingKind === "cancellation").policy.bookingEnabled = false; },
      (rows: typeof records) => { rows.find(row => row.settingKind === "cancellation").policy.cancellationEnabled = "yes"; },
    ]) {
      assert.deepEqual(await decodeConfigArchive(changedArchive(alter), target),
        { ok: false, error: { kind: "invalidConfigArchive", section: "settings" } });
    }
    // Legacy rows omitted the raw flag; absence must still decode as disabled before the first edit.
    const legacy = await decodeConfigArchive(changedArchive(rows => {
      for (const row of rows.filter(row => row.kind === "locationPolicy" && row.version < 2)) {
        delete row.policy.cancellationEnabled;
      }
    }), target);
    assert.ok(legacy.ok, legacy.ok ? "" : legacy.error.kind);
    assert.equal(legacy.value.policies[0]?.policy.cancellationEnabled, false);
    const authority = { authorizeAndRecord: async () => ok({ auditRef: "cancellation-import-audit" }) };
    const mapper = { mapRef: (kind: string, ref: string) => `buyer:${kind}:${ref}` };
    const imported = await new ReferenceConfigArchiveImporter().stage(exported.value, target, "buyer-admin", authority, mapper);
    assert.ok(imported.ok, imported.ok ? "" : imported.error.kind);
    const read = await imported.value.policy.read(target);
    assert.ok(read.ok);
    assert.equal(read.value.policyVersion, "4");
    assert.equal(read.value.bookingEnabled, false);
    assert.equal(read.value.cancellationEnabled, false);
    assert.equal(read.value.capabilities.cancel, "unavailable");
    const history = await imported.value.policy.listCancellationChanges(target);
    assert.ok(history.ok);
    assert.deepEqual(history.value.entries.map(row => [row.version, row.enabled, row.previousEnabled]),
      [["2", true, false], ["4", false, true]]);
    const tenantArchive = await buildPostgresTenantConfigArchive(db, { sourceTenantId: scope.tenantId,
      archiveId: `cancellation-tenant-${randomUUID()}`, actorRef: "clinic-admin", archiveMode: mode,
      createdAt: "2026-10-02T10:00:00Z", locations: [
        { sourceScope: scope, targetScope: target, timeZone: "UTC", mappingProvenance: "reviewed" },
      ] }, { authorizeAndRecord: async () => ok({ requestRef: "cancellation-tenant-export-audit" }) });
    assert.ok(tenantArchive.ok, tenantArchive.ok ? "" : tenantArchive.error.kind);
    const staged = await new PostgresTenantConfigArchiveImporter(db, undefined, mode).stage(
      tenantArchive.value, target.tenantId, "buyer-admin", authority, mapper);
    assert.ok(staged.ok, staged.ok ? "" : staged.error.kind);
    const targetStore = new PostgresPolicyStore(db, referenceDefaultPolicy, "execute", undefined, false, mode, false, "execute");
    const persisted = await targetStore.read(target);
    assert.ok(persisted.ok);
    assert.equal(persisted.value.policyVersion, "4");
    assert.equal(persisted.value.cancellationEnabled, false);
    assert.equal(persisted.value.capabilities.cancel, "unavailable");
    const recorded = await targetStore.listCancellationChanges(target);
    assert.ok(recorded.ok);
    assert.deepEqual(recorded.value.entries.map(row => [row.version, row.enabled, row.previousEnabled]),
      [["2", true, false], ["4", false, true]]);
    const booking = await targetStore.listBookingChanges(target);
    assert.ok(booking.ok);
    assert.deepEqual(booking.value.entries.map(row => row.version), ["1", "3"]);
  });
}
