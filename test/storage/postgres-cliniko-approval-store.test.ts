import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { ClinikoCatalogueReader } from "../../src/cliniko/catalogue.ts";
import { ClinikoCatalogueSetup } from "../../src/cliniko/catalogue-setup.ts";
import { ok } from "../../src/core/model.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
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
