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
const alternativeSelection = { businessId: "11", practitionerId: "44", appointmentTypeId: "55", policyVersion: "0" };
const observedAt = "2026-09-30T14:00:00.000Z";

function fixture() {
  const requests: string[] = [];
  let now = observedAt;
  let routeVersion = route.routeVersion;
  let policyVersion = selection.policyVersion;
  let businessEnabled = true;
  let businessTimeZone = "Australia/Sydney";
  let partialPractitionerPage = false;
  let relationshipPage: ((url: URL) => unknown) | undefined;
  let onBusinessRead: (() => void | Promise<void>) | undefined;
  let onRelationshipRead: (() => void | Promise<void>) | undefined;
  const fetchPort: typeof fetch = async input => {
    const url = new URL(String(input));
    const path = url.pathname;
    requests.push(path);
    if (path === "/v1/businesses") return Response.json({ total_entries: 1, businesses: [{ id: "11",
      business_name: "Demo practice", show_in_online_bookings: true, archived_at: null,
      time_zone_identifier: "Australia/Sydney" }] });
    if (path === "/v1/businesses/11") {
      await onBusinessRead?.();
      return Response.json({ id: "11", business_name: "Demo practice",
      show_in_online_bookings: businessEnabled, archived_at: null,
      appointment_type_ids: ["33", "55"], time_zone_identifier: businessTimeZone });
    }
    if (path === "/v1/practitioners/22") return Response.json({ id: "22", display_name: "Demo practitioner",
      active: true, show_in_online_bookings: true });
    if (path === "/v1/practitioners/44") return Response.json({ id: "44", display_name: "Second practitioner",
      active: true, show_in_online_bookings: true });
    if (path === "/v1/appointment_types/33") return Response.json({ id: "33", name: "Consult",
      archived_at: null, show_in_online_bookings: true });
    if (path === "/v1/appointment_types/55") return Response.json({ id: "55", name: "Follow up",
      archived_at: null, show_in_online_bookings: true });
    if (path === "/v1/businesses/11/practitioners") {
      await onRelationshipRead?.();
      return relationshipPage ? Response.json(relationshipPage(url))
      : partialPractitionerPage ? Response.json({ total_entries: 2, practitioners: [{ id: url.searchParams.get("page") === "1" ? "55" : "22" }] })
        : Response.json({ total_entries: 2, practitioners: [{ id: "22" }, { id: "44" }] });
    }
    if (path === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1,
      appointment_types: [{ id: "33" }] });
    if (path === "/v1/practitioners/44/appointment_types") return Response.json({ total_entries: 1,
      appointment_types: [{ id: "55" }] });
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
  return { setup, store, requests, reader: reader.value, fetchPort, routing, policy,
    setNow(value: string) { now = value; },
    setRouteVersion(value: string) { routeVersion = value; },
    setPolicyVersion(value: string) { policyVersion = value; },
    setBusinessEnabled(value: boolean) { businessEnabled = value; },
    setBusinessTimeZone(value: string) { businessTimeZone = value; },
    setPartialPractitionerPage(value: boolean) { partialPractitionerPage = value; },
    setRelationshipPage(value: ((url: URL) => unknown) | undefined) { relationshipPage = value; },
    onBusinessRead(callback: () => void | Promise<void>) { onBusinessRead = callback; },
    onRelationshipRead(callback: () => void | Promise<void>) { onRelationshipRead = callback; } };
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
  assert.equal(approved.value.approval?.businessTimeZone, "Australia/Sydney");
  assert.equal(approved.value.approval?.patientActionMode, "unavailable");
  assert.equal(approved.value.approval?.patientRequestMode, "unavailable");
  assert.ok((await app.setup.readApprovedRoute(scope, route)).ok);
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
  assert.deepEqual(await app.setup.readApprovedRoute(scope, route), { ok: false, error: { kind: "routeChanged" } });
  assert.deepEqual(await app.setup.resolveForCall(scope, route), { ok: false, error: { kind: "routeChanged" } });
  app.setRouteVersion(route.routeVersion);
  app.setPolicyVersion("1");
  assert.deepEqual(await app.setup.readApprovedRoute(scope, route), { ok: false, error: { kind: "policyChanged" } });
  assert.deepEqual(await app.setup.resolveForCall(scope, route), { ok: false, error: { kind: "policyChanged" } });
  app.setPolicyVersion(selection.policyVersion);
  app.setBusinessEnabled(false);
  assert.ok((await app.setup.readApprovedRoute(scope, route)).ok);
  assert.deepEqual(await app.setup.resolveForCall(scope, route),
    { ok: false, error: { kind: "selectionUnavailable" } });
  const rotated = ClinikoCatalogueReader.create({ scope, apiKey: "rotated-key-au5",
    contactEmail: "demo@example.test" });
  assert.ok(rotated.ok);
  const otherSetup = new ClinikoCatalogueSetup(rotated.value, new ReferenceNumberRoutingHost([]),
    { async read() { return ok(referenceDefaultPolicy(scope)); } }, app.store, () => observedAt);
  assert.deepEqual(await otherSetup.resolveForCall(scope, route), { ok: false, error: { kind: "staleApproval" } });
});

test("B4 a Cliniko business time-zone change invalidates a previously approved selection", async () => {
  const app = fixture();
  assert.ok((await app.setup.approve(admin, route, selection, 0)).ok);
  app.setBusinessTimeZone("Etc/UTC");
  assert.deepEqual(await app.setup.resolveForCall(scope, route),
    { ok: false, error: { kind: "selectionUnavailable" } });
});

test("B1 ingress approval is withdrawn by revocation and never reads Cliniko to authorize a route", async () => {
  const app = fixture();
  assert.deepEqual(await app.setup.readApprovedRoute(scope, route),
    { ok: false, error: { kind: "notApproved" } });
  assert.equal(app.requests.length, 0);
  assert.ok((await app.setup.approve(admin, route, selection, 0)).ok);
  const reads = app.requests.length;
  assert.ok((await app.setup.readApprovedRoute(scope, route)).ok);
  assert.equal(app.requests.length, reads);
  assert.ok((await app.setup.revoke(admin, 1)).ok);
  assert.deepEqual(await app.setup.readApprovedRoute(scope, route),
    { ok: false, error: { kind: "notApproved" } });
  assert.equal(app.requests.length, reads);
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

test("E2E-191 a short catalogue relationship page cannot approve or revalidate a clinic route", async () => {
  const app = fixture();
  app.setPartialPractitionerPage(true);
  assert.deepEqual(await app.setup.approve(admin, route, selection, 0),
    { ok: false, error: { kind: "catalogueUnavailable" } });
  const empty = await app.store.read(scope);
  assert.ok(empty.ok);
  assert.equal(empty.value.version, 0);
  assert.equal(empty.value.approval, null);
  app.setPartialPractitionerPage(false);
  assert.ok((await app.setup.approve(admin, route, selection, 0)).ok);
  app.setPartialPractitionerPage(true);
  assert.deepEqual(await app.setup.resolveForCall(scope, route),
    { ok: false, error: { kind: "catalogueUnavailable" } });
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

test("B4 clinic admin approves only bounded alternatives for the same business and policy", async () => {
  const app = fixture();
  for (const invalid of [
    [selection], [alternativeSelection, alternativeSelection],
    [{ ...alternativeSelection, businessId: "12" }],
    [{ ...alternativeSelection, policyVersion: "other" }],
    [alternativeSelection, alternativeSelection, alternativeSelection],
  ]) {
    assert.deepEqual(await app.setup.approveAlternatives(admin, route, selection, invalid, 0),
      { ok: false, error: { kind: "invalid" } });
  }
  assert.deepEqual(await app.store.read(scope), { ok: true, value: { version: 0, approval: null } });
  const approved = await app.setup.approveAlternatives(admin, route, selection, [alternativeSelection], 0);
  assert.ok(approved.ok);
  assert.deepEqual(approved.value.approval?.alternatives, [alternativeSelection]);
  const current = await app.setup.resolveForCall(scope, route);
  assert.ok(current.ok);
  assert.deepEqual(current.value.alternatives, [alternativeSelection]);
  const replaced = await app.setup.approve(admin, route, selection, 1);
  assert.ok(replaced.ok);
  assert.deepEqual(replaced.value.approval?.alternatives, []);
});

test("R15 rejected partial duplicate and inconsistent refreshes preserve the exact prior approval", async () => {
  for (const fault of ["partial", "duplicate", "inconsistent"] as const) {
    const app = fixture();
    const approved = await app.setup.approveAlternatives(admin, route, selection, [alternativeSelection], 0);
    assert.ok(approved.ok);
    const prior = structuredClone(approved.value);
    app.setRelationshipPage(url => Number(url.searchParams.get("page")) === 1
      ? { total_entries: 101, practitioners: Array.from({ length: 100 }, (_, index) => ({ id: String(index + 1) })) }
      : { total_entries: fault === "inconsistent" ? 102 : 101,
        practitioners: fault === "partial" ? [] : [{ id: fault === "duplicate" ? "22" : "101" }] });
    assert.deepEqual(await app.setup.approveAlternatives(admin, route, selection, [alternativeSelection], 1),
      { ok: false, error: { kind: "catalogueUnavailable" } });
    assert.deepEqual(await app.store.read(scope), { ok: true, value: prior });
    assert.deepEqual(await app.setup.resolveForCall(scope, route), { ok: false, error: { kind: "catalogueUnavailable" } });
    assert.deepEqual(await app.store.read(scope), { ok: true, value: prior });
    app.setRelationshipPage(undefined);
    const retried = await app.setup.approveAlternatives(admin, route, selection, [alternativeSelection], 1);
    assert.ok(retried.ok); assert.equal(retried.value.version, 2);
    assert.deepEqual(retried.value.approval?.selection, selection);
    assert.deepEqual(retried.value.approval?.alternatives, [alternativeSelection]);
    assert.equal(retried.value.approval?.patientActionMode, "unavailable");
    assert.equal(retried.value.approval?.patientRequestMode, "unavailable");
  }
});

test("R15 complete removal differs from unreadable refresh and discovered members need explicit approval", async () => {
  const app = fixture();
  const approved = await app.setup.approveAlternatives(admin, route, selection, [alternativeSelection], 0);
  assert.ok(approved.ok); const prior = structuredClone(approved.value);
  app.setRelationshipPage(() => ({ total_entries: 0, practitioners: [] }));
  assert.deepEqual(await app.setup.resolveForCall(scope, route), { ok: false, error: { kind: "selectionUnavailable" } });
  assert.deepEqual(await app.store.read(scope), { ok: true, value: prior });
  app.setRelationshipPage(url => ({ total_entries: 101, practitioners: Number(url.searchParams.get("page")) === 1
    ? Array.from({ length: 100 }, (_, index) => ({ id: String(index + 1), display_name: `Public member ${index + 1}`, active: true, show_in_online_bookings: true }))
    : [{ id: "101", display_name: "New public member", active: true, show_in_online_bookings: true }] }));
  const discovered = await app.setup.practitioners(admin, "11"); assert.ok(discovered.ok);
  assert.ok(discovered.value.practitioners.some(member => member.practitionerId === "101"));
  assert.deepEqual(await app.store.read(scope), { ok: true, value: prior }, "native discovery cannot change the approved selection or fallback set");
  const explicit = await app.setup.approveAlternatives(admin, route, selection, [alternativeSelection], 1);
  assert.ok(explicit.ok); assert.equal(explicit.value.version, 2);
  assert.deepEqual(explicit.value.approval?.selection, selection);
  assert.deepEqual(explicit.value.approval?.alternatives, [alternativeSelection]);
  const resolved = await app.setup.resolveForCall(scope, route); assert.ok(resolved.ok);
  assert.deepEqual(resolved.value, explicit.value.approval);
  assert.equal(resolved.value.patientActionMode, "unavailable"); assert.equal(resolved.value.patientRequestMode, "unavailable");
});

test("R16 revocation while an approval request is held defeats the old completion", { timeout: 20_000 }, async () => {
  const app = fixture();
  assert.ok((await app.setup.approve(admin, route, selection, 0)).ok);
  let entered = () => {}, release = () => {};
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  app.onRelationshipRead(async () => { app.onRelationshipRead(() => {}); entered(); await held; });
  const pending = app.setup.approveAlternatives(admin, route, selection, [alternativeSelection], 1);
  try {
    await reached;
    const revoked = await app.setup.revoke(admin, 1); assert.ok(revoked.ok);
    assert.deepEqual(revoked.value, { version: 2, approval: null });
    release();
    assert.deepEqual(await pending, { ok: false, error: { kind: "versionConflict" } });
    assert.deepEqual(await app.store.read(scope), revoked);
    assert.deepEqual(await app.setup.readApprovedRoute(scope, route), { ok: false, error: { kind: "notApproved" } });
    assert.deepEqual(await app.setup.resolveForCall(scope, route), { ok: false, error: { kind: "notApproved" } });
  } finally { release(); await pending; }
});

test("R16 rotated-key reapproval wins over an older held worker and every reader keeps its credential binding", { timeout: 20_000 }, async () => {
  const app = fixture();
  const first = await app.setup.approve(admin, route, selection, 0); assert.ok(first.ok);
  let entered = () => {}, release = () => {};
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  app.onRelationshipRead(async () => { app.onRelationshipRead(() => {}); entered(); await held; });
  const pending = app.setup.approveAlternatives(admin, route, selection, [alternativeSelection], 1);
  try {
    await reached;
    const reader = ClinikoCatalogueReader.create({ scope, apiKey: "synthetic-rotated-key-au5", contactEmail: "demo@example.test" }, app.fetchPort, () => observedAt);
    assert.ok(reader.ok);
    const rotated = new ClinikoCatalogueSetup(reader.value, app.routing, app.policy, app.store, () => observedAt);
    const replaced = await rotated.approve(admin, route, alternativeSelection, 1); assert.ok(replaced.ok);
    assert.equal(replaced.value.version, 2);
    assert.notEqual(replaced.value.approval?.credentialFingerprint, first.value.approval?.credentialFingerprint);
    release(); assert.deepEqual(await pending, { ok: false, error: { kind: "versionConflict" } });
    assert.deepEqual(await app.store.read(scope), replaced);
    const before = app.requests.length;
    assert.deepEqual(await app.setup.resolveForCall(scope, route), { ok: false, error: { kind: "staleApproval" } });
    assert.equal(app.requests.length, before, "the old credential must refuse before native reads");
    const current = await rotated.resolveForCall(scope, route); assert.ok(current.ok);
    assert.deepEqual(current.value, replaced.value.approval);
    assert.deepEqual(current.value.selection, alternativeSelection);
    assert.deepEqual(current.value.alternatives, []);
    assert.equal(current.value.patientActionMode, "unavailable"); assert.equal(current.value.patientRequestMode, "unavailable");
  } finally { release(); await pending; }
});
