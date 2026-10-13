import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "kysely";
import { PostgresClinicPatientCorrectionSettingStore } from "../../src/storage/postgres-clinic-patient-correction-setting.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { migrate, migrateTo } from "../../src/storage/migrate.ts";

test("E2E-363 PostgreSQL correction settings survive restart, have one clinic-wide CAS winner and no location duplicate", async () => {
  await withDisposablePostgres(async db => {
    const scope = { tenantId: "correction-db", clinicId: "clinic", locationId: "first" }, other = { ...scope, locationId: "second" };
    const store = new PostgresClinicPatientCorrectionSettingStore(db);
    await migrateTo(db, "042_patient_verification_budget");
    assert.equal((await store.read(scope)).ok, false, "an older schema cannot silently substitute default settings");
    await migrate(db);
    assert.deepEqual(await store.read(scope), { ok: true, value: { version: "0", enabled: false } });
    const updates = await Promise.all([store.changeEnabled(scope, "0", true, "owner-first"), store.changeEnabled(other, "0", false, "owner-second")]);
    assert.equal(updates.filter(r => r.ok).length, 1);
    const restarted = new PostgresClinicPatientCorrectionSettingStore(db), current = await restarted.read(other); assert.ok(current.ok); assert.equal(current.value.version, "1");
    const composed = new PostgresPolicyStore(db, referenceDefaultPolicy, "unavailable", undefined, false, "unsafeReference", false, { patientUpdate: "execute" });
    const enabled = await composed.changePatientCorrectionsEnabled(scope, "1", true, "owner"); assert.ok(enabled.ok);
    assert.equal(enabled.value.patientCorrectionsVersion, "2"); assert.equal(enabled.value.capabilities.patientUpdate, "execute"); assert.equal(enabled.value.capabilities.book, "unavailable");
    const minimal = new PostgresPolicyStore(db, referenceDefaultPolicy, "execute", undefined, false, "standaloneMinimal", false, { patientUpdate: "execute" });
    const safe = await minimal.read(other); assert.ok(safe.ok); assert.equal(safe.value.patientCorrectionsEnabled, true); assert.equal(safe.value.capabilities.patientUpdate, "unavailable");
    await composed.changeBookingEnabled(scope, "0", false, "booking-owner");
    const rows = await sql<{ policy: Record<string, unknown> }>`select policy from clinic_settings where tenant_id = ${scope.tenantId}`.execute(db);
    for (const row of rows.rows) { assert.equal(Object.hasOwn(row.policy, "patientCorrectionsEnabled"), false); assert.equal(Object.hasOwn(row.policy, "patientCorrectionsVersion"), false); }
    const history = await restarted.listChanges(scope); assert.ok(history.ok); assert.equal(history.value.entries.length, 2);
    assert.deepEqual(Object.keys(history.value.entries[0]!).sort(), ["version", "enabled", "previousEnabled", "actorRef", "changedAt"].sort());
    assert.equal((await restarted.changeEnabled(scope, "1", false, "stale")).ok, false);
    const foreign = await restarted.read({ ...scope, tenantId: "foreign" }); assert.ok(foreign.ok); assert.equal(foreign.value.version, "0");
    await assert.rejects(migrateTo(db, "042_patient_verification_budget"), /history must be removed/);
  });
});
