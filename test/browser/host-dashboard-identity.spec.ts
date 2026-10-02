import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { expect, test } from "../support/browser-test.ts";
import { ClinikoCatalogueReader } from "../../src/cliniko/catalogue.ts";
import { ClinikoCatalogueSetup, MemoryClinikoApprovalStore } from "../../src/cliniko/catalogue-setup.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import type { HostActor } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { createHostAuthenticatedDashboardServer } from "../../src/standalone/dashboard/server.ts";
import { listenLoopbackServer } from "../support/listen-loopback-server.ts";

const scope = { tenantId: "host-browser", clinicId: "clinic", locationId: "main" };
const route = { accountRef: "host-account", dialedNumber: "+6125550199", routeVersion: "v1" };

test("E2E-211 E2E-249 authenticated host sessions scope browser approval without trusting client role headers", async ({ page, request }) => {
  const adminToken = randomUUID();
  const staffToken = randomUUID();
  const foreignToken = randomUUID();
  const failedIdentityToken = randomUUID();
  const admin: HostActor = { actorRef: "host-admin", role: "clinicAdmin", scope };
  const staff: HostActor = { actorRef: "host-staff", role: "staff", scope };
  const foreign: HostActor = { actorRef: "foreign-admin", role: "clinicAdmin",
    scope: { tenantId: "other-tenant", clinicId: "clinic", locationId: "main" } };
  const sessions = new Map<string, HostActor>([[adminToken, admin], [staffToken, staff], [foreignToken, foreign]]);
  const providerPaths: string[] = [];
  const provider: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    providerPaths.push(path);
    if (path === "/v1/businesses") return Response.json({ total_entries: 1, businesses: [{ id: "11",
      business_name: "Synthetic clinic", show_in_online_bookings: true,
      time_zone_identifier: "Australia/Sydney", private_patient_name: "patient-canary-211" }] });
    if (path === "/v1/businesses/11") return Response.json({ id: "11", business_name: "Synthetic clinic",
      show_in_online_bookings: true, time_zone_identifier: "Australia/Sydney", appointment_type_ids: ["33"] });
    if (path === "/v1/practitioners/22") return Response.json({ id: "22", display_name: "Practitioner",
      active: true, show_in_online_bookings: true });
    if (path === "/v1/appointment_types/33") return Response.json({ id: "33", name: "Consult",
      show_in_online_bookings: true });
    if (path === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1,
      practitioners: [{ id: "22" }] });
    if (path === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1,
      appointment_types: [{ id: "33" }] });
    throw new Error("unexpected synthetic Cliniko request");
  };
  const reader = ClinikoCatalogueReader.create({ scope, apiKey: "synthetic-key-au5",
    contactEmail: "test@example.com" }, provider, () => "2026-09-30T10:00:00.000Z");
  assert.ok(reader.ok);
  const policy = new MemoryPolicyStore();
  const setup = new ClinikoCatalogueSetup(reader.value,
    new ReferenceNumberRoutingHost([{ ...scope, ...route }]), policy,
    new MemoryClinikoApprovalStore(), () => "2026-09-30T10:00:00.000Z");
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const gatewayFor = (actor: HostActor) => new CommandGateway(actor, policy, reception,
    undefined, undefined, undefined, undefined, undefined, setup);
  let mismatch = false;
  const server = await createHostAuthenticatedDashboardServer({ publicOrigin: "http://127.0.0.1:0",
    resolveActor: incoming => {
      const cookie = incoming.headers.cookie?.match(/(?:^|;\s*)hostSession=([^;]+)/)?.[1];
      if (cookie === failedIdentityToken) throw new Error("synthetic identity provider failure");
      return cookie ? sessions.get(cookie) ?? null : null;
    },
    gatewayFor: actor => mismatch ? new CommandGateway(admin, policy, reception, undefined,
      undefined, undefined, undefined, undefined, setup) : gatewayFor(actor),
  }, resolve("dist/dashboard/app.js"));
  try {
    const origin = await listenLoopbackServer(server);
    assert.equal((await request.get(`${origin}/api/capabilities`)).status(), 403);
    assert.equal((await request.get(origin)).status(), 403);
    assert.equal((await request.get(`${origin}/api/capabilities`, { headers: {
      Cookie: `hostSession=${failedIdentityToken}` } })).status(), 403);
    assert.equal((await request.get(`${origin}/api/capabilities`, { headers: {
      Host: "foreign.example", Cookie: `hostSession=${adminToken}` } })).status(), 403);
    const forged = await request.post(`${origin}/api/clinic-availability/command`, { headers: {
      Origin: origin, Cookie: `hostSession=${staffToken}`, "X-Actor-Role": "clinicAdmin" },
      data: { kind: "clinic.availability.businesses.list.v1" } });
    assert.equal(forged.status(), 403);
    assert.equal(providerPaths.length, 0);

    await page.context().addCookies([{ name: "hostSession", value: adminToken, url: origin }]);
    await page.goto(origin);
    await expect(page.getByRole("heading", { name: "Read-only availability setup" })).toBeVisible();
    await page.getByLabel("Practitioner ID", { exact: true }).fill("22");
    await page.getByLabel("Appointment type ID", { exact: true }).fill("33");
    await page.getByRole("button", { name: "Inspect selection" }).click();
    await expect(page.getByLabel("Availability selection inspection")).toContainText("Eligible candidate");
    await page.getByLabel("Route account reference").fill(route.accountRef);
    await page.getByLabel("Dialed number").fill(route.dialedNumber);
    await page.getByLabel("Route version").fill(route.routeVersion);
    await page.getByRole("checkbox", { name: "I approve this route for provisional availability only." }).check();
    await page.getByRole("button", { name: "Approve read-only route" }).click();
    await expect(page.getByLabel("Availability approval status")).toContainText("Stored approval: 11 / 22 / 33 · version 1");
    const approved = await setup.readApprovedRoute(scope, route);
    assert.ok(approved.ok);
    assert.equal(JSON.stringify(approved).includes("patient-canary-211"), false);
    assert.equal(JSON.stringify(approved).includes("synthetic-key-au5"), false);
    const adminPageText = await page.locator("body").innerText();
    assert.equal(adminPageText.includes("patient-canary-211"), false);
    assert.equal(adminPageText.includes("synthetic-key-au5"), false);

    const count = providerPaths.length;
    const foreign = await request.post(`${origin}/api/clinic-availability/command`, { headers: {
      Origin: origin, Cookie: `hostSession=${foreignToken}` },
      data: { kind: "clinic.availability.businesses.list.v1" } });
    assert.equal(foreign.status(), 403);
    const crossOrigin = await request.post(`${origin}/api/clinic-availability/command`, { headers: {
      Origin: "https://foreign.example", Cookie: `hostSession=${adminToken}` },
      data: { kind: "clinic.availability.approval.revoke.v1", expectedVersion: 1 } });
    assert.equal(crossOrigin.status(), 403);
    const crossOriginSetting = await request.post(`${origin}/api/settings/booking-enabled`, { headers: {
      Origin: "https://foreign.example", Cookie: `hostSession=${adminToken}` },
      data: { expectedVersion: "0", enabled: true } });
    assert.equal(crossOriginSetting.status(), 403);
    const missingOrigin = await request.post(`${origin}/api/clinic-availability/command`, { headers: {
      Origin: "", Cookie: `hostSession=${adminToken}` },
      data: { kind: "clinic.availability.approval.revoke.v1", expectedVersion: 1 } });
    assert.equal(missingOrigin.status(), 403);
    assert.equal(providerPaths.length, count);
    mismatch = true;
    assert.equal((await request.get(`${origin}/api/capabilities`, { headers: {
      Cookie: `hostSession=${staffToken}` } })).status(), 403);
    mismatch = false;
    await page.context().addCookies([{ name: "hostSession", value: staffToken, url: origin }]);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Read-only availability setup" })).toHaveCount(0);
    assert.ok((await setup.readApprovedRoute(scope, route)).ok);
    assert.equal(providerPaths.some(path => path.includes("patients")), false);
    const pageText = await page.locator("body").innerText();
    assert.equal(pageText.includes("patient-canary-211"), false);
    assert.equal(pageText.includes("synthetic-key-au5"), false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  }
});
