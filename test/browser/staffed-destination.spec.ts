import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { expect, test } from "../support/browser-test.ts";
import { staffedDestinationRegistry } from "../support/staffed-destination-registry.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { err, ok } from "../../src/core/model.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { createHostAuthenticatedDashboardServer } from "../../src/standalone/dashboard/server.ts";

async function routeDashboard(ready = true) {
  const scope = { tenantId: `route-browser-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  let hostReady = ready;
  const registry = staffedDestinationRegistry(async (bound, ref) => hostReady && ["host/desk-a", "host/desk-b"].includes(ref)
    ? ok({ scope: { ...bound }, destinationRef: ref, hostVersion: "host-route-v1", mode: "execute", ready: true })
    : err({ kind: "readinessFailed", missing: ["staffDestination"] }));
  const ledger = new MemoryLedger();
  const policy = new MemoryPolicyStore("execute", undefined, undefined, undefined, registry);
  const reception = new TextReception(ledger, policy, new ReferenceClinicHost([], []));
  const server = await createHostAuthenticatedDashboardServer({ publicOrigin: "http://127.0.0.1:0",
    resolveActor: request => request.headers.cookie === "session=route-owner" ? { actorRef: "route-owner", role: "clinicAdmin", scope }
      : request.headers.cookie === "session=route-staff" ? { actorRef: "route-staff", role: "staff", scope } : null,
    gatewayFor: actor => new CommandGateway(actor, policy, reception),
  }, resolve("dist/dashboard/app.js"));
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  return { url, scope, ledger, policy, reception,
    headers: { Cookie: "session=route-owner", Origin: url },
    setReady: (value: boolean) => { hostReady = value; },
    close: () => new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); }) };
}

test("E2E-256 SET-007 named route picker sets changes and clears while preserving admitted calls and recovering stale edits", async ({ page, request }) => {
  const app = await routeDashboard();
  try {
    await page.context().addCookies([{ name: "session", value: "route-owner", url: app.url }]);
    await page.goto(app.url);
    const panel = page.getByRole("region", { name: "Staff transfer destination" });
    const picker = panel.getByRole("combobox", { name: "Approved staff destination" });
    await expect(panel.getByText("No transfer destination saved.", { exact: true })).toBeVisible();
    await picker.selectOption({ label: "Front desk" });
    await panel.getByRole("button", { name: "Save transfer destination" }).click();
    await expect(panel.getByText("Saved destination: Front desk", { exact: true })).toBeVisible();
    const admitted = await app.reception.startCall("route-enabled", app.scope, "2026-10-02T10:00:00.000Z");
    assert.ok(admitted.ok);
    assert.equal(admitted.value.policy.transferDestinationRef, "host/desk-a");
    assert.equal(admitted.value.policy.transferDestinationVersion, "host-route-v1");
    assert.ok((await app.policy.changeBookingEnabled(app.scope, "1", true, "other-owner")).ok);
    await picker.selectOption({ label: "Reception team" });
    await panel.getByRole("button", { name: "Save transfer destination" }).click();
    await expect(panel.getByRole("alert")).toBeVisible();
    await expect(panel.getByText("Saved destination: Front desk", { exact: true })).toBeVisible();
    const staleHistory = await app.policy.listStaffedDestinationChanges(app.scope);
    assert.ok(staleHistory.ok);
    assert.equal(staleHistory.value.entries.length, 1);
    await picker.selectOption({ label: "Reception team" });
    await panel.getByRole("button", { name: "Save transfer destination" }).click();
    await expect(panel.getByText("Saved destination: Reception team", { exact: true })).toBeVisible();
    assert.equal(admitted.value.policy.transferDestinationRef, "host/desk-a");
    const next = await app.reception.startCall("route-changed", app.scope, "2026-10-02T10:00:00.000Z");
    assert.ok(next.ok);
    assert.equal(next.value.policy.transferDestinationRef, "host/desk-b");
    for (const invalid of [{ expectedVersion: "3", destinationRef: 123 },
      { expectedVersion: "3", destinationRef: "host/desk-a", actorRef: "forged" },
      { expectedVersion: "3", destinationRef: "host/desk-a", scope: { ...app.scope, clinicId: "foreign" } }]) {
      assert.equal((await request.post(`${app.url}/api/settings/staffed-destination`, { headers: app.headers, data: invalid })).status(), 400);
    }
    assert.equal((await request.post(`${app.url}/api/settings/staffed-destination`, { headers: app.headers,
      data: { expectedVersion: "2", destinationRef: null } })).status(), 409);
    await page.reload();
    await expect(panel.getByText("Saved destination: Reception team", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Clear transfer destination" }).click();
    await expect(panel.getByText("No transfer destination saved.", { exact: true })).toBeVisible();
    const cleared = await app.reception.startCall("route-cleared", app.scope, "2026-10-02T10:00:00.000Z");
    assert.ok(cleared.ok);
    assert.equal(cleared.value.policy.transferDestinationRef, undefined);
    assert.notEqual(cleared.value.policy.capabilities.transfer, "execute");
    assert.equal(admitted.value.policy.capabilities.transfer, "execute");
    const history = await app.policy.listStaffedDestinationChanges(app.scope);
    assert.ok(history.ok);
    assert.deepEqual(history.value.entries.map(row => [row.version, row.destinationRef, row.actorRef]),
      [["1", "host/desk-a", "route-owner"], ["3", "host/desk-b", "route-owner"], ["4", null, "route-owner"]]);
    await expect(panel.getByLabel("Transfer destination audit")).toContainText("Version 4");
  } finally { await app.close(); }
});

test("E2E-256 SET-007 route selection cannot grant unavailable host capability or bypass role Origin and query guards", async ({ page, request }) => {
  const app = await routeDashboard(false);
  try {
    await page.context().addCookies([{ name: "session", value: "route-owner", url: app.url }]);
    await page.goto(app.url);
    const panel = page.getByRole("region", { name: "Staff transfer destination" });
    await panel.getByRole("combobox", { name: "Approved staff destination" }).selectOption({ label: "Front desk" });
    await panel.getByRole("button", { name: "Save transfer destination" }).click();
    await expect(panel.getByRole("alert")).toBeVisible();
    await expect(panel.getByText("No transfer destination saved.", { exact: true })).toBeVisible();
    const history = await app.policy.listStaffedDestinationChanges(app.scope);
    assert.ok(history.ok);
    assert.equal(history.value.entries.length, 0);
    assert.equal((await request.post(`${app.url}/api/settings/staffed-destination`, {
      headers: { ...app.headers, Origin: "https://foreign.example.test" }, data: { expectedVersion: "0", destinationRef: null } })).status(), 403);
    assert.equal((await request.post(`${app.url}/api/settings/staffed-destination`, {
      headers: { ...app.headers, Cookie: "session=forged-owner" }, data: { expectedVersion: "0", destinationRef: null } })).status(), 403);
    for (const path of ["staffed-destination-options", "staffed-destination-audit"]) {
      assert.equal((await request.get(`${app.url}/api/settings/${path}`, { headers: { ...app.headers, Cookie: "session=route-staff" } })).status(), 403);
    }
    assert.equal((await request.get(`${app.url}/api/settings/staffed-destination-options?clinicId=foreign`, { headers: app.headers })).status(), 400);
    assert.equal((await request.get(`${app.url}/api/settings/staffed-destination-audit?after=0&after=1`, { headers: app.headers })).status(), 400);
    await page.context().addCookies([{ name: "session", value: "route-staff", url: app.url }]);
    await page.reload();
    await expect(panel.getByText("View only", { exact: true })).toBeVisible();
    await expect(panel.getByRole("combobox")).toHaveCount(0);
    assert.equal((await request.post(`${app.url}/api/settings/staffed-destination`, {
      headers: { ...app.headers, Cookie: "session=route-staff" }, data: { expectedVersion: "0", destinationRef: null } })).status(), 403);
  } finally { await app.close(); }
});

test("E2E-256 SET-007 lost route reply and failed reread lock edits until current state is reloaded", async ({ page }) => {
  const app = await routeDashboard();
  try {
    let blockReads = false;
    let drop = true;
    await page.route("**/api/settings", route => blockReads ? route.abort("failed") : route.continue());
    await page.route("**/api/settings/staffed-destination", async route => {
      if (!drop) return route.continue();
      const upstream = await route.fetch();
      assert.equal(upstream.status(), 200);
      drop = false; blockReads = true;
      await route.abort("failed");
    });
    await page.context().addCookies([{ name: "session", value: "route-owner", url: app.url }]);
    await page.goto(app.url);
    const panel = page.getByRole("region", { name: "Staff transfer destination" });
    await panel.getByRole("combobox", { name: "Approved staff destination" }).selectOption({ label: "Front desk" });
    await panel.getByRole("button", { name: "Save transfer destination" }).click();
    await expect(panel.getByRole("alert")).toHaveText("The transfer destination could not be confirmed. Reload before editing settings.");
    await expect(panel.getByRole("button", { name: "Save transfer destination" })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Clear transfer destination" })).toBeDisabled();
    const head = await app.policy.read(app.scope);
    assert.ok(head.ok);
    assert.equal(head.value.policyVersion, "1");
    assert.equal(head.value.transferDestinationRef, "host/desk-a");
    const history = await app.policy.listStaffedDestinationChanges(app.scope);
    assert.ok(history.ok);
    assert.equal(history.value.entries.length, 1);
    blockReads = false;
    await page.reload();
    await expect(panel.getByText("Saved destination: Front desk", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Clear transfer destination" }).click();
    await expect(panel.getByText("No transfer destination saved.", { exact: true })).toBeVisible();
  } finally { await app.close(); }
});

test("E2E-256 SET-007 malformed route save reply is recovered by reading current state without replay", async ({ page }) => {
  const app = await routeDashboard();
  try {
    let corrupt = true;
    await page.route("**/api/settings/staffed-destination", async route => {
      if (!corrupt) return route.continue();
      const upstream = await route.fetch();
      assert.equal(upstream.status(), 200);
      corrupt = false;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, value: { kind: "settings", policy: {} } }) });
    });
    await page.context().addCookies([{ name: "session", value: "route-owner", url: app.url }]);
    await page.goto(app.url);
    const panel = page.getByRole("region", { name: "Staff transfer destination" });
    await panel.getByRole("combobox", { name: "Approved staff destination" }).selectOption({ label: "Front desk" });
    await panel.getByRole("button", { name: "Save transfer destination" }).click();
    await expect(panel.getByText("Saved destination: Front desk", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Clear transfer destination" })).toBeEnabled();
    const history = await app.policy.listStaffedDestinationChanges(app.scope);
    assert.ok(history.ok);
    assert.equal(history.value.entries.length, 1);
    app.setReady(false);
    await panel.getByRole("button", { name: "Refresh destinations and history" }).click();
    await expect(panel.getByText("Follow-up only; no live transfer.", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Clear transfer destination" }).click();
    await expect(panel.getByText("No transfer destination saved.", { exact: true })).toBeVisible();
    const after = await app.policy.listStaffedDestinationChanges(app.scope);
    assert.ok(after.ok);
    assert.equal(after.value.entries.length, 2);
  } finally { await app.close(); }
});
