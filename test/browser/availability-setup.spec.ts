import assert from "node:assert/strict";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { ClinikoCatalogueReader } from "../../src/cliniko/catalogue.ts";
import { ClinikoCatalogueSetup, MemoryClinikoApprovalStore } from "../../src/cliniko/catalogue-setup.ts";
import type { ClinikoApprovalStore } from "../../src/cliniko/catalogue-setup.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { createDashboardServer } from "../../src/standalone/dashboard/server.ts";

const scope = { tenantId: "browser-tenant", clinicId: "browser-clinic", locationId: "browser-frontdesk" };
const route = { accountRef: "browser-account", dialedNumber: "+6125550199", routeVersion: "route-1" };
const now = "2026-09-30T10:00:00.000Z";

async function fixture(role: "clinicAdmin" | "staff", uncertainApproval = false) {
  const calls: string[] = [];
  const fetchPort: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === "/v1/businesses") return Response.json({ total_entries: 2, businesses: [{
      id: "44", business_name: "Other location", archived_at: null, show_in_online_bookings: true,
      time_zone_identifier: "Australia/Sydney" }, {
      id: "11", business_name: "Demo clinic", archived_at: null, show_in_online_bookings: true,
      time_zone_identifier: "Australia/Sydney", private_patient_name: "secret-patient" }] });
    if (path === "/v1/businesses/11") return Response.json({
      id: "11", business_name: "Demo clinic", archived_at: null, show_in_online_bookings: true,
      time_zone_identifier: "Australia/Sydney", appointment_type_ids: ["33", "55", "77"] });
    if (path === "/v1/practitioners/22") return Response.json({
      id: "22", display_name: "Practitioner", active: true, show_in_online_bookings: true });
    if (path === "/v1/practitioners/44") return Response.json({
      id: "44", display_name: "Second practitioner", active: true, show_in_online_bookings: true });
    if (path === "/v1/practitioners/66") return Response.json({
      id: "66", display_name: "Third practitioner", active: true, show_in_online_bookings: true });
    if (path === "/v1/appointment_types/33") return Response.json({
      id: "33", name: "Consult", archived_at: null, show_in_online_bookings: true });
    if (path === "/v1/appointment_types/55") return Response.json({
      id: "55", name: "Follow up", archived_at: null, show_in_online_bookings: true });
    if (path === "/v1/appointment_types/77") return Response.json({
      id: "77", name: "Review", archived_at: null, show_in_online_bookings: true });
    if (path === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 3,
      practitioners: [{ id: "22" }, { id: "44" }, { id: "66" }] });
    if (path === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1, appointment_types: [{ id: "33" }] });
    if (path === "/v1/practitioners/44/appointment_types") return Response.json({ total_entries: 1, appointment_types: [{ id: "55" }] });
    if (path === "/v1/practitioners/66/appointment_types") return Response.json({ total_entries: 1, appointment_types: [{ id: "77" }] });
    throw new Error(`unexpected catalogue request ${path}`);
  };
  const reader = ClinikoCatalogueReader.create({ scope, apiKey: "synthetic-key-au5",
    contactEmail: "test@example.com" }, fetchPort, () => now);
  assert.ok(reader.ok);
  const policy = new MemoryPolicyStore();
  const memory = new MemoryClinikoApprovalStore();
  let loseApprovalReceipt = uncertainApproval;
  const store: ClinikoApprovalStore = {
    read: scoped => memory.read(scoped),
    async change(scoped, version, approval, actor) {
      const result = await memory.change(scoped, version, approval, actor);
      if (result.ok && approval && loseApprovalReceipt) {
        loseApprovalReceipt = false;
        throw new Error("synthetic lost approval receipt");
      }
      return result;
    },
  };
  const setup = new ClinikoCatalogueSetup(reader.value, new ReferenceNumberRoutingHost([{ ...scope, ...route }]),
    policy, store, () => now);
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const gateway = new CommandGateway({ actorRef: `browser-${role}`, role, scope }, policy, reception,
    undefined, undefined, undefined, undefined, undefined, setup);
  const server = await createDashboardServer(gateway, resolve("dist/dashboard/app.js"));
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, setup, calls,
    close: () => new Promise<void>((done, reject) => {
      server.close(error => error ? reject(error) : done());
      server.closeAllConnections();
    }) };
}

test("E2E-195 E2E-209 clinic admin approves and revokes only a read-only availability route in the browser", async ({ page, request }) => {
  const app = await fixture("clinicAdmin");
  try {
    await page.goto(app.url);
    await expect(page.getByRole("heading", { name: "Read-only availability setup" })).toBeVisible();
    await expect(page.getByLabel("Availability approval status")).toContainText("No approved availability route · version 0");
    await expect(page.getByRole("button", { name: "Approve read-only route" })).toBeDisabled();
    await expect(page.getByLabel("Cliniko business")).toHaveValue("44");
    await page.getByLabel("Cliniko business").selectOption("11");
    await page.getByLabel("Practitioner ID", { exact: true }).fill("22");
    await page.getByLabel("Appointment type ID", { exact: true }).fill("33");
    await page.getByRole("button", { name: "Inspect selection" }).click();
    await expect(page.getByLabel("Availability selection inspection")).toContainText("Eligible candidate for read-only availability");
    await expect(page.getByLabel("Availability selection inspection")).toContainText("Clinic time zone: Australia/Sydney");
    await page.getByLabel("Route account reference").fill(route.accountRef);
    await page.getByLabel("Dialed number").fill(route.dialedNumber);
    await page.getByLabel("Route version").fill(route.routeVersion);
    await page.getByLabel("I approve this route for provisional availability only.").check();
    await page.getByRole("button", { name: "Approve read-only route" }).click();
    await expect(page.getByLabel("Availability approval status")).toContainText("Stored approval: 11 / 22 / 33 · version 1");
    const admitted = await app.setup.readApprovedRoute(scope, route);
    assert.ok(admitted.ok);
    assert.equal(admitted.value.businessTimeZone, "Australia/Sydney");
    assert.equal(admitted.value.patientActionMode, "unavailable");
    assert.equal(admitted.value.patientRequestMode, "unavailable");
    await page.reload();
    await expect(page.getByLabel("Availability approval status")).toContainText("Stored approval: 11 / 22 / 33 · version 1");
    await expect(page.getByText("clinic time zone Australia/Sydney", { exact: false })).toBeVisible();
    await expect(page.getByLabel("Cliniko business")).toHaveValue("11");
    await page.getByRole("button", { name: "Revoke availability route" }).click();
    await expect(page.getByLabel("Availability approval status")).toContainText("No approved availability route · version 2");
    assert.deepEqual(await app.setup.readApprovedRoute(scope, route), { ok: false, error: { kind: "notApproved" } });
    const stale = await request.post(`${app.url}/api/clinic-availability/command`, {
      headers: { Origin: app.url }, data: { kind: "clinic.availability.approval.revoke.v1", expectedVersion: 1 },
    });
    assert.equal(stale.status(), 409);
    const pageText = await page.locator("body").innerText();
    assert.equal(pageText.includes("secret-patient"), false);
    assert.equal(pageText.includes("synthetic-key"), false);
  } finally { await app.close(); }
});

test("E2E-195 staff and foreign-origin requests cannot use availability setup", async ({ page, request }) => {
  const app = await fixture("staff");
  try {
    await page.goto(app.url);
    await expect(page.getByRole("heading", { name: "Read-only availability setup" })).toHaveCount(0);
    const denied = await request.post(`${app.url}/api/clinic-availability/command`, {
      headers: { Origin: app.url }, data: { kind: "clinic.availability.businesses.list.v1" },
    });
    assert.equal(denied.status(), 403);
    const foreign = await request.post(`${app.url}/api/clinic-availability/command`, {
      headers: { Origin: "https://foreign.example" }, data: { kind: "clinic.availability.approval.read.v1" },
    });
    assert.equal(foreign.status(), 403);
    assert.deepEqual(app.calls, []);
  } finally { await app.close(); }
});

test("E2E-195 an uncertain approval result reloads the committed state before another edit", async ({ page }) => {
  const app = await fixture("clinicAdmin", true);
  try {
    await page.goto(app.url);
    await page.getByLabel("Cliniko business").selectOption("11");
    await page.getByLabel("Practitioner ID", { exact: true }).fill("22");
    await page.getByLabel("Appointment type ID", { exact: true }).fill("33");
    await page.getByRole("button", { name: "Inspect selection" }).click();
    await expect(page.getByLabel("Availability selection inspection")).toContainText("Eligible candidate");
    await page.getByLabel("Route account reference").fill(route.accountRef);
    await page.getByLabel("Dialed number").fill(route.dialedNumber);
    await page.getByLabel("Route version").fill(route.routeVersion);
    await page.getByLabel("I approve this route for provisional availability only.").check();
    await page.getByRole("button", { name: "Approve read-only route" }).click();
    await expect(page.getByRole("alert")).toContainText("outcome is uncertain");
    await expect(page.getByLabel("Availability approval status")).toContainText("Stored approval: 11 / 22 / 33 · version 1");
    await expect(page.getByRole("button", { name: "Approve read-only route" })).toBeDisabled();
    assert.ok((await app.setup.readApprovedRoute(scope, route)).ok);
  } finally { await app.close(); }
});

test("E2E-201 admin inspects, saves, reloads and removes ordered clinic-specific alternatives", async ({ page }) => {
  const app = await fixture("clinicAdmin");
  try {
    await page.goto(app.url);
    await page.getByLabel("Cliniko business").selectOption("11");
    await page.getByLabel("Practitioner ID", { exact: true }).fill("22");
    await page.getByLabel("Appointment type ID", { exact: true }).fill("33");
    await page.getByRole("button", { name: "Inspect selection" }).click();
    await page.getByText("Optional approved alternatives").click();
    await page.getByLabel("Alternative 1 practitioner ID").fill("44");
    await page.getByLabel("Alternative 1 appointment type ID").fill("55");
    await page.getByLabel("Alternative 2 practitioner ID").fill("66");
    await page.getByLabel("Alternative 2 appointment type ID").fill("77");
    await expect(page.getByRole("button", { name: "Approve read-only route" })).toBeDisabled();
    await page.getByRole("button", { name: "Inspect alternatives" }).click();
    await expect(page.getByLabel("Alternative inspections")).toContainText("Second practitioner · Follow up");
    await expect(page.getByLabel("Alternative inspections")).toContainText("Third practitioner · Review");
    await page.getByLabel("Route account reference").fill(route.accountRef);
    await page.getByLabel("Dialed number").fill(route.dialedNumber);
    await page.getByLabel("Route version").fill(route.routeVersion);
    await page.getByRole("checkbox", { name: "I approve this route for provisional availability only." }).check();
    await page.getByRole("button", { name: "Approve read-only route" }).click();
    await expect(page.getByLabel("Availability approval status")).toContainText("version 1 · 2 alternatives");
    const approved = await app.setup.readApprovedRoute(scope, route);
    assert.ok(approved.ok);
    assert.deepEqual(approved.value.alternatives, [
      { businessId: "11", practitionerId: "44", appointmentTypeId: "55", policyVersion: "0" },
      { businessId: "11", practitionerId: "66", appointmentTypeId: "77", policyVersion: "0" },
    ]);
    await page.reload();
    await page.getByText("Optional approved alternatives").click();
    await expect(page.getByLabel("Alternative 1 practitioner ID")).toHaveValue("44");
    await expect(page.getByLabel("Alternative 1 appointment type ID")).toHaveValue("55");
    await expect(page.getByLabel("Alternative 2 practitioner ID")).toHaveValue("66");
    await expect(page.getByLabel("Alternative 2 appointment type ID")).toHaveValue("77");
    await page.getByLabel("Alternative 1 practitioner ID").fill("");
    await page.getByLabel("Alternative 1 appointment type ID").fill("");
    await expect(page.getByRole("button", { name: "Inspect alternatives" })).toBeDisabled();
    await page.getByLabel("Alternative 2 practitioner ID").fill("");
    await page.getByLabel("Alternative 2 appointment type ID").fill("");
    await page.getByRole("button", { name: "Inspect selection" }).click();
    await page.getByRole("checkbox", { name: "I approve this route for provisional availability only." }).check();
    await page.getByRole("button", { name: "Approve read-only route" }).click();
    await expect(page.getByLabel("Availability approval status")).toContainText("version 2 · 0 alternatives");
    const removed = await app.setup.readApprovedRoute(scope, route);
    assert.ok(removed.ok);
    assert.deepEqual(removed.value.alternatives, []);
  } finally { await app.close(); }
});
