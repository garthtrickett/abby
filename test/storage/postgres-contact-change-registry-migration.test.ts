import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "kysely";
import { migrate, migrateTo } from "../../src/storage/migrate.ts";
import { PostgresClinikoContactRevision } from "../../src/storage/postgres-cliniko-contact-revision.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";

test("E2E-366 migration preserves legacy alias blocks without granting reviewed recovery and retains completed reference history", async () => {
  await withDisposablePostgres(async db => {
    await migrateTo(db, "044_cliniko_contact_revision");
    const tenant = "synthetic-registry-upgrade", ref = crypto.randomUUID();
    const aliases = ["synthetic-primary-au5", "synthetic-second-au5"].map(clinikoCredentialFingerprint).sort();
    for (const alias of aliases) {
      await sql`insert into cliniko_contact_revisions (tenant_id, credential_fingerprint, version)
        values (${tenant}, ${alias}, 1)`.execute(db);
      await sql`insert into cliniko_contact_changes (tenant_id, credential_fingerprint, change_ref)
        values (${tenant}, ${alias}, ${ref})`.execute(db);
    }
    await migrate(db);
    const owner = new PostgresClinikoContactRevision(db, tenant, aliases);
    assert.deepEqual(await owner.status(ref), { ok: true, value: {
      binding: "legacyUnlinked", status: "pending", completionMethod: null, completedBy: null,
    } });
    for (const alias of aliases) assert.deepEqual(await owner.read(alias), { ok: true, value: { version: 1, blocked: true } });
    assert.deepEqual(await owner.completeReviewed(ref, "approved-owner"), { ok: false, error: { kind: "contactChanged" } });
    await assert.rejects(migrateTo(db, "044_cliniko_contact_revision"), /reference history must be retained/);
    assert.deepEqual(await owner.complete(ref), { ok: true, value: true });
    for (const alias of aliases) assert.deepEqual(await owner.read(alias), { ok: true, value: { version: 2, blocked: false } });
    assert.deepEqual(await owner.status(ref), { ok: true, value: {
      binding: "legacyUnlinked", status: "completed", completionMethod: "inspected", completedBy: null,
    } });
    assert.deepEqual(await owner.begin(ref), { ok: false, error: { kind: "contactChanged" } });
    await assert.rejects(migrateTo(db, "044_cliniko_contact_revision"), /reference history must be retained/);
  });
});
