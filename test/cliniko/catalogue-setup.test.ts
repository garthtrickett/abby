import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoCatalogueReader } from "../../src/cliniko/catalogue.ts";
import { ClinikoCatalogueSetup, MemoryClinikoApprovalStore } from "../../src/cliniko/catalogue-setup.ts";
import type { ClinikoSetupRoute } from "../../src/cliniko/catalogue-setup.ts";
import { ok } from "../../src/core/model.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import type { HostActor } from "../../src/reference/command-gateway.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";

const scope = { tenantId: "setup-tenant", clinicId: "setup-clinic", locationId: "frontdesk" };
const admin: HostActor = { actorRef: "admin-1", role: "clinicAdmin", scope };
const route: ClinikoSetupRoute = { accountRef: "twilio-test-account", dialedNumber: "+61255501001", routeVersion: "route-1" };
const selection = { businessId: "11", practitionerId: "22", appointmentTypeId: "33", policyVersion: "0" };
const observedAt = "2026-09-30T14:00:00.000Z";

function fixture() {
  const requests: string[] = [];
  let now = observedAt;
  let routeVersion = route.routeVersion;
  let policyVersion = selection.policyVersion;
  let businessEnabled = true;
  let onBusinessRead: (() => void | Promise<void>) | undefined;
  const fetchPort: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path === "/v1/businesses") return Response.json({ total_entries: 1, businesses: [{ id: "11",
      business_name: "Demo practice", show_in_online_bookings: true, archived_at: null,
      time_zone_identifier: "Australia/Sydney" }] });
    if (path === "/v1/businesses/11") {
      await onBusinessRead?.();
      return Response.json({ id: "11", business_name: "Demo practice",
      show_in_online_bookings: businessEnabled, archived_at: null,
      appointment_type_ids: ["33"], time_zone_identifier: "Australia/Sydney" });
    }
    if (path === "/v1/practitioners/22") return Response.json({ id: "22", display_name: "Demo practitioner",
      active: true, show_in_online_bookings: true });
    if (path === "/v1/appointment_types/33") return Response.json({ id: "33", name: "Consult",
      archived_at: null, show_in_online_bookings: true });
    if (path === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1,
      practitioners: [{ id: "22" }] });
    if (path === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1,
      appointment_types: [{ id: "33" }] });
    throw new Error(`unexpected path ${path}`);
  };
  const reader = ClinikoCatalogueReader.create({ scope, apiKey: "synthetic-key-au5",
    contactEmail: "demo@example.test" }, fetchPort, () => observedAt);
  assert.ok(reader.ok);
  const routing = { async identifyCall(accountRef: string, dialedNumber: string) {
    const host = new ReferenceNumberRoutingHost([{ accountRef: route.accountRef, dialedNumber: route.dialedNumber,
      ...scope, routeVersion }]);
    return host.identifyCall(accountRef, dialedNumber);
  } };
  const policy = { async read(readScope: typeof scope) {
    const value = { ...referenceDefaultPolicy(readScope), policyVersion };
    return ok(value);
  } };
  const store = new MemoryClinikoApprovalStore();
  const setup = new ClinikoCatalogueSetup(reader.value, routing, policy, store, () => now);
  return { setup, store, requests, reader: reader.value,
    setNow(value: string) { now = value; },
    setRouteVersion(value: string) { routeVersion = value; },
    setPolicyVersion(value: string) { policyVersion = value; },
    setBusinessEnabled(value: boolean) { businessEnabled = value; },
    onBusinessRead(callback: () => void | Promise<void>) { onBusinessRead = callback; } };
}

test("B1 clinic admin confirms a scoped read-only candidate and every call reproves it", async () => {
  const app = fixture();
  const listed = await app.setup.businesses(admin);
  assert.ok(listed.ok);
  assert.deepEqual(listed.value.businesses.map(item => item.businessId), ["11"]);
  const approved = await app.setup.approve(admin, route, selection, 0);
  assert.ok(approved.ok);
  assert.equal(approved.value.version, 1);
  assert.deepEqual(approved.value.approval?.selection, selection);
  assert.equal(approved.value.approval?.approvedBy, admin.actorRef);
  assert.equal(approved.value.approval?.patientActionMode, "unavailable");
  assert.equal(approved.value.approval?.patientRequestMode, "unavailable");
  const resolved = await app.setup.resolveForCall(scope, route);
  assert.ok(resolved.ok);
  assert.equal(resolved.value.route.routeVersion, route.routeVersion);
  assert.equal(JSON.stringify([listed, approved, resolved]).includes("synthetic-key"), false);
  assert.equal(app.requests.length, 11);
  const revoked = await app.setup.revoke(admin, 1);
  assert.ok(revoked.ok);
  assert.deepEqual(await app.setup.resolveForCall(scope, route), { ok: false, error: { kind: "notApproved" } });
});

test("B1 staff, agent and foreign clinic are denied before any Cliniko or route read", async () => {
  const app = fixture();
  for (const role of ["staff", "agent"] as const) {
    assert.deepEqual(await app.setup.businesses({ ...admin, role }), { ok: false, error: { kind: "forbidden" } });
    assert.deepEqual(await app.setup.approve({ ...admin, role }, route, selection, 0),
      { ok: false, error: { kind: "forbidden" } });
  }
  assert.deepEqual(await app.setup.approve({ ...admin, scope: { ...scope, tenantId: "other" } }, route, selection, 0),
    { ok: false, error: { kind: "scopeMismatch" } });
  assert.deepEqual(await app.setup.resolveForCall({ ...scope, clinicId: "other" }, route),
    { ok: false, error: { kind: "scopeMismatch" } });
  assert.deepEqual(app.requests, []);
});

test("B1 route, policy, eligibility and freshness failures refuse approval", async () => {
  const app = fixture();
  assert.deepEqual(await app.setup.approve(admin, { ...route, dialedNumber: "+61255501999" }, selection, 0),
    { ok: false, error: { kind: "routeChanged" } });
  assert.deepEqual(await app.setup.approve(admin, route, { ...selection, policyVersion: "2" }, 0),
    { ok: false, error: { kind: "policyChanged" } });
  app.setBusinessEnabled(false);
  assert.deepEqual(await app.setup.approve(admin, route, selection, 0),
    { ok: false, error: { kind: "selectionUnavailable" } });
  app.setBusinessEnabled(true);
  app.setNow("2026-09-30T14:02:00.000Z");
  assert.deepEqual(await app.setup.approve(admin, route, selection, 0),
    { ok: false, error: { kind: "staleCatalogue" } });
  const state = await app.store.read(scope);
  assert.ok(state.ok);
  assert.equal(state.value.version, 0);
});

test("B1 route or policy drift, rotation and concurrent approval do not reuse the old selection", async () => {
  const app = fixture();
  assert.ok((await app.setup.approve(admin, route, selection, 0)).ok);
  assert.deepEqual(await app.setup.approve(admin, route, selection, 0),
    { ok: false, error: { kind: "versionConflict" } });
  app.setRouteVersion("route-2");
  assert.deepEqual(await app.setup.resolveForCall(scope, route), { ok: false, error: { kind: "routeChanged" } });
  app.setRouteVersion(route.routeVersion);
  app.setPolicyVersion("1");
  assert.deepEqual(await app.setup.resolveForCall(scope, route), { ok: false, error: { kind: "policyChanged" } });
  app.setPolicyVersion(selection.policyVersion);
  app.setBusinessEnabled(false);
  assert.deepEqual(await app.setup.resolveForCall(scope, route),
    { ok: false, error: { kind: "selectionUnavailable" } });
  const rotated = ClinikoCatalogueReader.create({ scope, apiKey: "rotated-key-au5",
    contactEmail: "demo@example.test" });
  assert.ok(rotated.ok);
  const otherSetup = new ClinikoCatalogueSetup(rotated.value, new ReferenceNumberRoutingHost([]),
    { async read() { return ok(referenceDefaultPolicy(scope)); } }, app.store, () => observedAt);
  assert.deepEqual(await otherSetup.resolveForCall(scope, route), { ok: false, error: { kind: "staleApproval" } });
});

test("B1 route or policy changes during provider reads fail before recording approval", async () => {
  const app = fixture();
  app.onBusinessRead(() => app.setRouteVersion("route-2"));
  assert.deepEqual(await app.setup.approve(admin, route, selection, 0),
    { ok: false, error: { kind: "routeChanged" } });
  const state = await app.store.read(scope);
  assert.ok(state.ok);
  assert.equal(state.value.version, 0);
});

test("B1 revocation during call-time provider recheck wins before approval is returned", async () => {
  const app = fixture();
  assert.ok((await app.setup.approve(admin, route, selection, 0)).ok);
  app.onBusinessRead(async () => {
    const revoked = await app.store.change(scope, 1, null, "admin-1");
    assert.ok(revoked.ok);
  });
  assert.deepEqual(await app.setup.resolveForCall(scope, route),
    { ok: false, error: { kind: "staleApproval" } });
});
