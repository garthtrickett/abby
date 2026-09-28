import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { sql } from "kysely";
import type { Result } from "../src/core/model.ts";
import { CallRuntime } from "../src/core/runtime.ts";
import { EffectWorker } from "../src/core/effect-worker.ts";
import { ReferenceClinicHost } from "../src/reference/clinic-host.ts";
import { referenceDefaultPolicy } from "../src/reference/policy-store.ts";
import { connectPostgres } from "../src/storage/connect.ts";
import { migrate, migrateTo } from "../src/storage/migrate.ts";
import { PostgresLedger } from "../src/storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../src/storage/postgres-policy-store.ts";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`probe operation failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL is required");
if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1") throw new Error("upgrade probe requires an isolated PostgreSQL container");

// An isolated database lets the probe exercise a real v1 -> v2 upgrade without
// mutating the fresh-schema database used by the parallel contract suites.
const name = `abby_upgrade_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({ connectionString: baseUrl });
await admin.connect();
let created = false;
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  const upgradeUrl = new URL(baseUrl);
  upgradeUrl.pathname = `/${name}`;
  const db = connectPostgres(upgradeUrl.toString());
  try {
    await migrateTo(db, "001_text_probe");
    const scope = { tenantId: "upgrade-tenant", clinicId: "upgrade-clinic", locationId: "upgrade-location" };
    const policy = { ...referenceDefaultPolicy(scope), policyVersion: "1", bookingEnabled: true,
      capabilities: { ...referenceDefaultPolicy(scope).capabilities, book: "execute" as const } };
    const callId = "upgrade-call";
    const now = "2026-09-28T10:00:00.000Z";
    const runtime = new CallRuntime(new PostgresLedger(db), scope);
    value(await runtime.start(callId, policy));
    const before = value(await runtime.acceptTurn({ callId, turnId: "request-staff", text: "Please call me", quality: "clear", at: now },
      { kind: "handoff", reason: "callerRequested" }, now));
    const item = Object.values(before.staffItems)[0];
    assert.ok(item);
    const effectId = `${item.key}:open`;
    assert.equal(before.effects[effectId]?.status, "pending");
    await sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy)
      values (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, 1, ${JSON.stringify(policy)}::jsonb)`.execute(db);
    const beforeRows = await sql<{ calls: string; events: string; effects: string; staff: string; settings: string }>`
      select (select count(*) from calls)::text as calls,
             (select count(*) from call_events)::text as events,
             (select count(*) from effect_outbox)::text as effects,
             (select count(*) from staff_items)::text as staff,
             (select count(*) from clinic_settings)::text as settings`.execute(db);
    assert.deepEqual(beforeRows.rows[0], { calls: "1", events: "1", effects: "1", staff: "1", settings: "1" });

    await migrate(db);
    const afterRows = await sql<{ calls: string; events: string; effects: string; staff: string; settings: string }>`
      select (select count(*) from calls)::text as calls,
             (select count(*) from call_events)::text as events,
             (select count(*) from effect_outbox)::text as effects,
             (select count(*) from staff_items)::text as staff,
             (select count(*) from clinic_settings)::text as settings`.execute(db);
    assert.deepEqual(afterRows.rows[0], beforeRows.rows[0]);
    const restarted = new CallRuntime(new PostgresLedger(db), scope);
    const restored = value(await restarted.read(callId));
    assert.equal(restored.version, before.version);
    assert.deepEqual(restored.staffItems[item.key], item);
    assert.equal(restored.effects[effectId]?.status, "pending");
    const settings = new PostgresPolicyStore(db, referenceDefaultPolicy);
    assert.equal(value(await settings.read(scope)).policyVersion, "1");
    assert.equal(value(await settings.read(scope)).automationEnabled, false);
    assert.deepEqual(value(await settings.listBookingChanges(scope)).entries,
      [{ version: "1", enabled: true, provenance: "legacyUnattributed" }]);

    const host = new ReferenceClinicHost([], []);
    await new EffectWorker(restarted, host).process(callId, effectId, now);
    assert.equal(value(await restarted.read(callId)).staffItems[item.key]?.status, "open");
    assert.equal(host.tasks(scope).length, 1);
    assert.equal(value(await settings.changeBookingEnabled(scope, "1", false, "upgrade-probe")).policyVersion, "2");
    assert.equal(value(await settings.listBookingChanges(scope)).entries[1]?.provenance, "recorded");
    console.log("v1 -> latest upgrade retained call, audit, outbox, staff work, and settings; resumed commands passed");

    // Roll back to the version before tenant constraints inside this disposable
    // database, then prove the constraint's forward path rejects old tenant drift.
    await migrateTo(db, "002_booking_setting_audit");
    await sql`insert into call_events (call_id, tenant_id, sequence, kind, payload)
      values (${callId}, 'wrong-tenant', 100, 'forged', '{}'::jsonb)`.execute(db);
    await assert.rejects(migrate(db), (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "23503");
    const mismatched = await sql<{ count: string }>`select count(*)::text as count from call_events
      where call_id = ${callId} and tenant_id = 'wrong-tenant'`.execute(db);
    assert.equal(mismatched.rows[0]?.count, "1");
    console.log("constraint migration rejected a pre-existing cross-tenant event without rewriting it");
  } finally {
    await db.destroy();
  }
} finally {
  try {
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
