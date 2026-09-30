import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { ClinikoCatalogueReader } from "../../src/cliniko/catalogue.ts";
import { ClinikoCatalogueSetup } from "../../src/cliniko/catalogue-setup.ts";
import { ok } from "../../src/core/model.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate, migrateTo } from "../../src/storage/migrate.ts";
import type { ClinikoCatalogueApprovalsTenantId } from "../../src/storage/generated/public/ClinikoCatalogueApprovals.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresClinikoApprovalStore } from "../../src/storage/postgres-cliniko-approval-store.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

test("B1 PostgreSQL approval survives reload, isolates clinics, versions races and retains no provider patient text", async () => {
  const scope = { tenantId: `catalogue-${randomUUID()}`, clinicId: "clinic", locationId: "frontdesk" };
  const actor = { actorRef: "clinic-admin-1", role: "clinicAdmin" as const, scope };
  const route = { accountRef: "ACsynthetic", dialedNumber: "+61255501001", routeVersion: "route-1" };
  const selection = { businessId: "11", practitionerId: "22", appointmentTypeId: "33", policyVersion: "0" };
  const at = "2026-09-30T14:00:00.000Z";
  const patientCanary = `patient-private-${randomUUID()}`;
  const fetchPort: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/businesses/11") return Response.json({ id: "11", business_name: "Demo clinic",
      archived_at: null, show_in_online_bookings: true, time_zone_identifier: "Australia/Sydney",
      appointment_type_ids: ["33"], private_patient_note: patientCanary });
    if (path === "/v1/practitioners/22") return Response.json({ id: "22", display_name: "Demo practitioner",
      active: true, show_in_online_bookings: true });
    if (path === "/v1/appointment_types/33") return Response.json({ id: "33", name: "Consult",
      archived_at: null, show_in_online_bookings: true });
    if (path === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1,
      practitioners: [{ id: "22" }] });
    if (path === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1,
      appointment_types: [{ id: "33" }] });
    throw new Error(`unexpected ${path}`);
  };
  const reader = ClinikoCatalogueReader.create({ scope, apiKey: "synthetic-key-au5",
    contactEmail: "demo@example.test" }, fetchPort, () => at);
  assert.ok(reader.ok);
  const routing = new ReferenceNumberRoutingHost([{ ...route, ...scope }]);
  const policy = { async read(target: typeof scope) { return ok(referenceDefaultPolicy(target)); } };
  const store = new PostgresClinikoApprovalStore(db);
  const setup = new ClinikoCatalogueSetup(reader.value, routing, policy, store, () => at);
  assert.deepEqual(await store.read(scope), { ok: true, value: { version: 0, approval: null } });
  const approved = await setup.approve(actor, route, selection, 0);
  assert.ok(approved.ok);
  assert.equal(approved.value.version, 1);
  assert.equal(approved.value.approval?.approvedBy, actor.actorRef);

  const reloaded = new PostgresClinikoApprovalStore(db);
  assert.deepEqual(await reloaded.read(scope), approved);
  assert.deepEqual(await reloaded.read({ ...scope, clinicId: "other" }),
    { ok: true, value: { version: 0, approval: null } });
  assert.ok((await new ClinikoCatalogueSetup(reader.value, routing, policy, reloaded, () => at)
    .resolveForCall(scope, route)).ok);
  assert.ok(approved.value.approval);
  const races = await Promise.all([
    store.change(scope, 1, approved.value.approval, actor.actorRef),
    reloaded.change(scope, 1, approved.value.approval, actor.actorRef),
  ]);
  assert.deepEqual(races.map(result => result.ok).sort(), [false, true]);
  assert.equal(races.find(result => !result.ok)?.error.kind, "versionConflict");
  const revoked = await setup.revoke(actor, 2);
  assert.ok(revoked.ok);
  assert.deepEqual(await reloaded.read(scope), { ok: true, value: { version: 3, approval: null } });
  assert.deepEqual(await setup.resolveForCall(scope, route), { ok: false, error: { kind: "notApproved" } });
  const rows = await db.selectFrom("cliniko_catalogue_approvals").select(["version", "approved", "changed_by"])
    .where("tenant_id", "=", scope.tenantId as ClinikoCatalogueApprovalsTenantId).orderBy("version").execute();
  assert.deepEqual(rows.map(row => [row.version, row.approved, row.changed_by]),
    [[0, false, "system"], [1, true, actor.actorRef], [2, true, actor.actorRef], [3, false, actor.actorRef]]);
  assert.deepEqual(await scanPatientDataCanaries(db, [{ label: "provider_payload", value: patientCanary },
    { label: "api_key", value: "synthetic-key-au5" }]), { ok: true, value: [] });
});

test("B4 PostgreSQL keeps only ordered alternative IDs and clears them on revocation", async () => {
  const scope = { tenantId: `alternative-${randomUUID()}`, clinicId: "clinic", locationId: "frontdesk" };
  const store = new PostgresClinikoApprovalStore(db);
  const at = "2026-09-30T14:00:00.000Z";
  const approval = {
    scope, route: { accountRef: "ACsynthetic", dialedNumber: "+61255501001", routeVersion: "route-1" },
    selection: { businessId: "11", practitionerId: "22", appointmentTypeId: "33", policyVersion: "0" },
    alternatives: [
      { businessId: "11", practitionerId: "44", appointmentTypeId: "55", policyVersion: "0" },
      { businessId: "11", practitionerId: "66", appointmentTypeId: "77", policyVersion: "0" },
    ],
    credentialFingerprint: "a".repeat(64), catalogueObservedAt: at,
    approvedBy: "clinic-admin", approvedAt: at,
    patientActionMode: "unavailable" as const, patientRequestMode: "unavailable" as const,
  };
  const changed = await store.change(scope, 0, approval, "clinic-admin");
  assert.ok(changed.ok);
  assert.deepEqual((await new PostgresClinikoApprovalStore(db).read(scope)), changed);
  const rows = await db.selectFrom("cliniko_catalogue_approvals")
    .select(["version", "alternative_1_practitioner_id", "alternative_1_appointment_type_id",
      "alternative_2_practitioner_id", "alternative_2_appointment_type_id"])
    .where("tenant_id", "=", scope.tenantId as ClinikoCatalogueApprovalsTenantId)
    .orderBy("version").execute();
  assert.deepEqual(rows.map(row => [row.version, row.alternative_1_practitioner_id,
    row.alternative_1_appointment_type_id, row.alternative_2_practitioner_id,
    row.alternative_2_appointment_type_id]), [[0, null, null, null, null], [1, "44", "55", "66", "77"]]);
  assert.ok((await store.change(scope, 1, null, "clinic-admin")).ok);
  assert.deepEqual(await store.read(scope), { ok: true, value: { version: 2, approval: null } });
});

test("B4 migration preserves a version 23 single-choice approval as an empty alternative list", async () => {
  const databaseName = `abby_test_approval_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(url!);
  target.pathname = "/" + databaseName;
  await sql.raw(`create database "${databaseName}"`).execute(db);
  const legacy = connectPostgres(target.toString());
  try {
    await migrateTo(legacy, "023_phone_index_credentials");
    const scope = { tenantId: "legacy-tenant", clinicId: "clinic", locationId: "frontdesk" };
    const at = "2026-09-30T14:00:00.000Z";
    await sql`insert into cliniko_catalogue_approvals
      (tenant_id, clinic_id, location_id, version, approved, account_ref, dialed_number,
       route_version, business_id, practitioner_id, appointment_type_id, policy_version,
       credential_fingerprint, catalogue_observed_at, approved_at, changed_by)
      values (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, 1, true, 'ACsynthetic',
        '+61255501001', 'route-1', '11', '22', '33', '0', ${"a".repeat(64)},
        ${at}::timestamptz, ${at}::timestamptz, 'clinic-admin')`.execute(legacy);
    await migrate(legacy);
    const result = await new PostgresClinikoApprovalStore(legacy).read(scope);
    assert.ok(result.ok);
    assert.equal(result.value.version, 1);
    assert.deepEqual(result.value.approval?.alternatives, []);
    assert.deepEqual(result.value.approval?.selection, {
      businessId: "11", practitionerId: "22", appointmentTypeId: "33", policyVersion: "0",
    });
  } finally {
    await legacy.destroy();
    await sql.raw(`drop database "${databaseName}" with (force)`).execute(db);
  }
});
