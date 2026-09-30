import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoCatalogueReader } from "../../src/cliniko/catalogue.ts";
import { ClinikoCatalogueSetup, MemoryClinikoApprovalStore } from "../../src/cliniko/catalogue-setup.ts";
import type { ClinikoApprovalStore } from "../../src/cliniko/catalogue-setup.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";

const scope = { tenantId: "setup-tenant", clinicId: "clinic", locationId: "frontdesk" };
const route = { accountRef: "account-1", dialedNumber: "+6125550199", routeVersion: "route-1" };
const selection = { businessId: "11", practitionerId: "22", appointmentTypeId: "33", policyVersion: "0" };
const now = "2026-09-30T10:00:00.000Z";

function fixture(store: ClinikoApprovalStore = new MemoryClinikoApprovalStore()) {
  const calls: string[] = [];
  let providerStatus = 200;
  const fetchPort: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (providerStatus !== 200) return new Response(null, { status: providerStatus });
    if (path === "/v1/businesses") return Response.json({ total_entries: 1, businesses: [{
      id: "11", business_name: "Demo clinic", archived_at: null, show_in_online_bookings: true,
      time_zone_identifier: "Australia/Sydney", private_patient_name: "secret-patient" }] });
    if (path === "/v1/businesses/11") return Response.json({
      id: "11", business_name: "Demo clinic", archived_at: null, show_in_online_bookings: true,
      time_zone_identifier: "Australia/Sydney", appointment_type_ids: ["33"], private_patient_name: "secret-patient" });
    if (path === "/v1/practitioners/22") return Response.json({
      id: "22", display_name: "Practitioner", active: true, show_in_online_bookings: true });
    if (path === "/v1/appointment_types/33") return Response.json({
      id: "33", name: "Consult", archived_at: null, show_in_online_bookings: true });
    if (path === "/v1/businesses/11/practitioners") return Response.json({
      total_entries: 1, practitioners: [{ id: "22" }] });
    if (path === "/v1/practitioners/22/appointment_types") return Response.json({
      total_entries: 1, appointment_types: [{ id: "33" }] });
    throw new Error(`unexpected path ${path}`);
  };
  const reader = ClinikoCatalogueReader.create({ scope, apiKey: "synthetic-key-au5",
    contactEmail: "test@example.com" }, fetchPort, () => now);
  assert.ok(reader.ok);
  const policy = new MemoryPolicyStore();
  const setup = new ClinikoCatalogueSetup(reader.value, new ReferenceNumberRoutingHost([{
    ...scope, ...route }]), policy, store, () => now);
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const gateway = (role: "clinicAdmin" | "staff" | "agent", actorScope = scope) =>
    new CommandGateway({ actorRef: `host-${role}`, role, scope: actorScope }, policy, reception,
      undefined, undefined, undefined, undefined, undefined, setup);
  return { gateway, setup, calls, setProviderStatus(value: number) { providerStatus = value; } };
}

test("E2E-194 provider-neutral setup commands bind clinic admin, version and read-only capability", async () => {
  const app = fixture();
  const admin = app.gateway("clinicAdmin");
  const agent = app.gateway("agent");
  const staff = app.gateway("staff");
  const ids = admin.listPermitted().map(item => item.id);
  assert.deepEqual(ids.filter(id => id.startsWith("clinic.availability.")), [
    "clinic.availability.businesses.list.v1", "clinic.availability.selection.inspect.v1",
    "clinic.availability.approval.read.v1", "clinic.availability.approval.change.v1",
    "clinic.availability.approval.revoke.v1",
  ]);
  assert.equal(agent.listPermitted().some(item => item.id.startsWith("clinic.availability.")), false);
  assert.equal(staff.listPermitted().some(item => item.id.startsWith("clinic.availability.")), false);
  assert.deepEqual(await agent.submit({ kind: "clinic.availability.businesses.list.v1" }),
    { ok: false, error: { kind: "forbidden" } });
  assert.deepEqual(await staff.submit({ kind: "clinic.availability.approval.read.v1" }),
    { ok: false, error: { kind: "forbidden" } });
  assert.deepEqual(await agent.submit({ kind: "clinic.availability.approval.change.v1",
    route, selection, expectedVersion: 0 }), { ok: false, error: { kind: "forbidden" } });
  assert.deepEqual(app.calls, []);

  const initial = await admin.submit({ kind: "clinic.availability.approval.read.v1" });
  assert.ok(initial.ok && initial.value.kind === "clinicAvailabilityApprovalState");
  assert.deepEqual(initial.value.state, { version: 0, approval: null });
  const listed = await admin.submit({ kind: "clinic.availability.businesses.list.v1" });
  assert.ok(listed.ok && listed.value.kind === "clinicAvailabilityBusinesses");
  assert.equal(listed.value.catalogue.businesses[0]?.name, "Demo clinic");
  const inspected = await admin.submit({ kind: "clinic.availability.selection.inspect.v1", selection });
  assert.ok(inspected.ok && inspected.value.kind === "clinicAvailabilitySelection");
  assert.equal(inspected.value.snapshot.status, "candidate");
  assert.equal(inspected.value.snapshot.patientActionMode, "unavailable");
  assert.equal(inspected.value.snapshot.patientRequestMode, "unavailable");
  const approved = await admin.submit({ kind: "clinic.availability.approval.change.v1",
    route, selection, expectedVersion: 0 });
  assert.ok(approved.ok && approved.value.kind === "clinicAvailabilityApprovalState");
  assert.equal(approved.value.state.version, 1);
  assert.equal(approved.value.state.approval?.approvedBy, "host-clinicAdmin");
  assert.equal(approved.value.state.approval?.patientActionMode, "unavailable");
  assert.equal(approved.value.state.approval?.patientRequestMode, "unavailable");
  assert.equal(JSON.stringify([listed, inspected, approved]).includes("secret-patient"), false);
  assert.equal(JSON.stringify([listed, inspected, approved]).includes("synthetic-key"), false);
  assert.deepEqual(await admin.submit({ kind: "clinic.availability.approval.change.v1",
    route, selection, expectedVersion: 0 }), { ok: false, error: { kind: "versionConflict" } });
  const revoked = await admin.submit({ kind: "clinic.availability.approval.revoke.v1", expectedVersion: 1 });
  assert.ok(revoked.ok && revoked.value.kind === "clinicAvailabilityApprovalState");
  assert.deepEqual(revoked.value.state, { version: 2, approval: null });
  assert.deepEqual(await app.setup.readApprovedRoute(scope, route),
    { ok: false, error: { kind: "notApproved" } });
});

test("E2E-194 a mis-scoped approval store cannot disclose another clinic's configuration", async () => {
  const foreignStore: ClinikoApprovalStore = {
    async read() { return { ok: true, value: { version: 1, approval: {
      scope: { ...scope, clinicId: "other-clinic" }, route, selection,
      credentialFingerprint: "fingerprint", catalogueObservedAt: now,
      approvedBy: "host-clinicAdmin", approvedAt: now,
      patientActionMode: "unavailable", patientRequestMode: "unavailable",
    } } }; },
    async change() { return { ok: false, error: { kind: "storageFailure" } }; },
  };
  const app = fixture(foreignStore);
  assert.deepEqual(await app.gateway("clinicAdmin").submit({ kind: "clinic.availability.approval.read.v1" }),
    { ok: false, error: { kind: "storageFailure" } });
  assert.deepEqual(app.calls, []);
});

test("E2E-194 invalid, foreign-scope and provider-denied commands fail before approval", async () => {
  const app = fixture();
  const admin = app.gateway("clinicAdmin");
  assert.deepEqual(await admin.submit({ kind: "clinic.availability.selection.inspect.v1",
    selection: { ...selection, businessId: "../11" } }), { ok: false, error: { kind: "invalid" } });
  assert.deepEqual(await admin.submit({ kind: "clinic.availability.approval.change.v1",
    route: { ...route, dialedNumber: "invalid" }, selection, expectedVersion: 0 }),
  { ok: false, error: { kind: "invalid" } });
  assert.deepEqual(app.calls, []);
  const foreign = app.gateway("clinicAdmin", { ...scope, tenantId: "foreign" });
  assert.deepEqual(await foreign.submit({ kind: "clinic.availability.businesses.list.v1" }),
    { ok: false, error: { kind: "scopeMismatch" } });
  assert.deepEqual(await foreign.submit({ kind: "clinic.availability.approval.change.v1",
    route, selection, expectedVersion: 0 }), { ok: false, error: { kind: "scopeMismatch" } });
  assert.deepEqual(app.calls, []);
  app.setProviderStatus(403);
  assert.deepEqual(await admin.submit({ kind: "clinic.availability.businesses.list.v1" }),
    { ok: false, error: { kind: "credentialForbidden" } });
  assert.deepEqual(await admin.submit({ kind: "clinic.availability.approval.change.v1",
    route, selection, expectedVersion: 0 }), { ok: false, error: { kind: "credentialForbidden" } });
  app.setProviderStatus(429);
  assert.deepEqual(await admin.submit({ kind: "clinic.availability.businesses.list.v1" }),
    { ok: false, error: { kind: "catalogueRateLimited" } });
  assert.deepEqual(await admin.submit({ kind: "clinic.availability.approval.change.v1",
    route, selection, expectedVersion: 0 }), { ok: false, error: { kind: "catalogueRateLimited" } });
  assert.deepEqual(await admin.submit({ kind: "clinic.availability.approval.read.v1" }),
    { ok: true, value: { kind: "clinicAvailabilityApprovalState", state: { version: 0, approval: null } } });
});
