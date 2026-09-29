import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { createStandaloneTextComposition } from "../../src/standalone/text-composition.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import type { Result } from "../../src/core/model.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

function value<T, E>(result: Result<T, E>): T {
  assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.error));
  return result.value;
}

test("default PostgreSQL policy store uses minimal rows and rejects legacy rich rows", async () => {
  const scope = { tenantId: `default-policy-${randomUUID()}`, clinicId: "clinic", locationId: "location" };
  const canary = `patient-private-policy-${randomUUID()}`;
  const defaultPolicy = (target: typeof scope) => ({ ...referenceDefaultPolicy(target),
    greeting: { scope: target, version: "test", ownerRef: "synthetic", approvedText: canary, approved: true as const } });
  const policy = new PostgresPolicyStore(db, defaultPolicy);
  const changed = value(await policy.changeBookingEnabled(scope, "0", true, "clinic-admin"));
  assert.equal(changed.bookingEnabled, true);
  assert.equal(changed.staffWorkEnabled, false);
  assert.deepEqual(Object.values(changed.capabilities), Array(5).fill("unavailable"));
  const rows = await sql<{ version: number; policy: unknown }>`select version, policy from clinic_settings
    where tenant_id = ${scope.tenantId} order by version`.execute(db);
  assert.deepEqual(rows.rows, [
    { version: 0, policy: { scope, policyVersion: "0", bookingEnabled: false } },
    { version: 1, policy: { scope, policyVersion: "1", bookingEnabled: true } },
  ]);
  assert.equal(value(await new PostgresPolicyStore(db, defaultPolicy).read(scope)).policyVersion, "1");
  assert.deepEqual(await scanPatientDataCanaries(db, [{ label: "default_policy", value: canary }]),
    { ok: true, value: [] });

  const richScope = { ...scope, locationId: "legacy-rich" };
  await sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy)
    values (${richScope.tenantId}, ${richScope.clinicId}, ${richScope.locationId}, 0,
      ${JSON.stringify(referenceDefaultPolicy(richScope))}::jsonb)`.execute(db);
  const legacy = await new PostgresPolicyStore(db, defaultPolicy).read(richScope);
  assert.equal(legacy.ok, false);
  if (!legacy.ok) assert.equal(legacy.error.kind, "storageFailure");
});

test("standalone setting toggle stores only structured policy while knowledge stays transient and unavailable", async () => {
  const scope = { tenantId: "standalone-config-tenant", clinicId: "standalone-config-clinic", locationId: "location-a" };
  const other = { ...scope, locationId: "location-b" };
  const canary = "private-patient-note-canary-16492";
  const now = "2026-09-29T10:00:00.000Z";
  const host = new ReferenceClinicHost([], [], [{ scope, sourceRef: "parking", version: "1", ownerRef: "clinic-owner",
    approvedText: canary, approved: true, effectiveFrom: "2026-09-01T00:00:00.000Z",
    effectiveUntil: "2026-10-01T00:00:00.000Z" }]);
  const app = createStandaloneTextComposition(db, host);

  assert.equal(value(await app.policy.read(scope)).bookingEnabled, false);
  assert.deepEqual(value(await app.knowledge.readKnowledge(scope, ["parking"])), []);
  assert.ok(app.knowledge.listModelKnowledge);
  assert.deepEqual(value(await app.knowledge.listModelKnowledge(scope, now)), []);
  assert.equal(value(await app.policy.changeBookingEnabled(scope, "0", true, "clinic-admin")).capabilities.book, "unavailable");
  assert.equal(value(await app.policy.changeBookingEnabled(scope, "1", false, "clinic-admin")).bookingEnabled, false);
  const rows = await sql<{ version: number; policy: unknown }>`select version, policy from clinic_settings
    where tenant_id = ${scope.tenantId} and clinic_id = ${scope.clinicId} and location_id = ${scope.locationId}
    order by version`.execute(db);
  assert.deepEqual(rows.rows, [
    { version: 0, policy: { scope, policyVersion: "0", bookingEnabled: false } },
    { version: 1, policy: { scope, policyVersion: "1", bookingEnabled: true } },
    { version: 2, policy: { scope, policyVersion: "2", bookingEnabled: false } },
  ]);

  const reloaded = createStandaloneTextComposition(db, host);
  assert.equal(value(await reloaded.policy.read(scope)).policyVersion, "2");
  assert.equal(value(await reloaded.policy.read(scope)).bookingEnabled, false);
  assert.equal(value(await reloaded.policy.read(other)).policyVersion, "0");
  const callId = randomUUID();
  value(await reloaded.reception.startCall(callId, scope, now));
  const answer = value(await reloaded.reception.answer(scope,
    { callId, turnId: randomUUID(), text: "Where can I park?", quality: "clear", at: now },
    ["parking"], canary, now));
  assert.equal(answer.callerMessages.includes(canary), false);
  assert.match(answer.callerMessages.at(-1) ?? "", /can't verify/);
  const knowledgeRows = await sql<{ count: string }>`select count(*)::text as count from clinic_knowledge_events
    where tenant_id = ${scope.tenantId} and clinic_id = ${scope.clinicId}`.execute(db);
  assert.equal(knowledgeRows.rows[0]?.count, "0");
  assert.deepEqual(await scanPatientDataCanaries(db, [{ label: "host_knowledge", value: canary }]), { ok: true, value: [] });
});

test("standalone settings reject a legacy full-policy row instead of importing its free text", async () => {
  const scope = { tenantId: "standalone-legacy-tenant", clinicId: "standalone-legacy-clinic", locationId: "location-a" };
  const policy = { scope, policyVersion: "0", bookingEnabled: false, greeting: { approvedText: "patient-canary-legacy-731" } };
  await sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy)
    values (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, 0, ${JSON.stringify(policy)}::jsonb)`.execute(db);
  const app = createStandaloneTextComposition(db, new ReferenceClinicHost([], []));
  const read = await app.policy.read(scope);
  assert.equal(read.ok, false);
  assert.equal(read.error.kind, "storageFailure");
  const change = await app.policy.changeBookingEnabled(scope, "0", true, "clinic-admin");
  assert.equal(change.ok, false);
  assert.equal(change.error.kind, "storageFailure");
});
