import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { expect, test } from "../support/browser-test.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { err } from "../../src/core/model.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { createHostAuthenticatedDashboardServer } from "../../src/standalone/dashboard/server.ts";
import { notificationRegistry } from "../support/notification-settings-contract.ts";

async function dashboard(ready = true) {
  const scope = { tenantId: `notification-browser-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  let hostReady = ready;
  const supported = notificationRegistry();
  const policy = new MemoryPolicyStore(undefined, undefined, undefined, undefined, undefined, {
    resolve: (...args) => hostReady ? supported.resolve(...args)
      : Promise.resolve(err({ kind: "readinessFailed", missing: ["notificationOwner"] })),
  });
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const server = await createHostAuthenticatedDashboardServer({ publicOrigin: "http://127.0.0.1:0",
    resolveActor: request => request.headers.cookie === "session=notification-owner" ? { actorRef: "notification-owner", role: "clinicAdmin", scope }
      : request.headers.cookie === "session=notification-staff" ? { actorRef: "notification-staff", role: "staff", scope } : null,
    gatewayFor: actor => new CommandGateway(actor, policy, reception),
  }, resolve("dist/dashboard/app.js"));
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  return { scope, policy, reception, url, headers: { Cookie: "session=notification-owner", Origin: url },
    setReady: (value: boolean) => { hostReady = value; },
    close: () => new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); }) };
}

test("E2E-257 SET-009 owners set change and clear through authenticated admin while active calls retain their snapshot", async ({ page, request }) => {
  const app = await dashboard();
  try {
    await page.context().addCookies([{ name: "session", value: "notification-owner", url: app.url }]);
    await page.goto(app.url);
    const panel = page.getByRole("region", { name: "Notification ownership" });
    const booking = panel.getByRole("group", { name: "Booking confirmation", exact: true });
    const cancellation = panel.getByRole("group", { name: "Cancellation confirmation", exact: true });
    const rescheduling = panel.getByRole("group", { name: "Rescheduling confirmation", exact: true });
    await expect(panel.getByText("Saved owner: Not set", { exact: true })).toHaveCount(3);
    await expect(panel.getByText("Managed delivery: Unavailable", { exact: true })).toHaveCount(3);
    await booking.getByRole("combobox").selectOption({ label: "Host" });
    await booking.getByRole("button", { name: "Save owner", exact: true }).click();
    await expect(booking.getByText("Saved owner: Host", { exact: true })).toBeVisible();
    const admitted = await app.reception.startCall("notification-before-edit", app.scope, "2026-10-02T21:45:00.000Z");
    assert.ok(admitted.ok);
    assert.equal(admitted.value.policy.notificationBindings?.bookingConfirmation?.owner, "host");
    // A different location/type consumes the same clinic version without consuming location policy version.
    assert.ok((await app.policy.changeNotificationOwner({ ...app.scope, locationId: "second" }, "1",
      "cancellationConfirmation", "host", "second-owner")).ok);
    await booking.getByRole("combobox").selectOption({ label: "Abby" });
    await booking.getByRole("button", { name: "Save owner", exact: true }).click();
    await expect(panel.getByRole("alert")).toBeVisible();
    await expect(booking.getByText("Saved owner: Host", { exact: true })).toBeVisible();
    await expect(cancellation.getByText("Saved owner: Host", { exact: true })).toBeVisible();
    await booking.getByRole("combobox").selectOption({ label: "Abby" });
    await booking.getByRole("button", { name: "Save owner", exact: true }).click();
    await expect(booking.getByText("Saved owner: Abby", { exact: true })).toBeVisible();
    await expect(booking.getByText("Managed delivery: Abby", { exact: true })).toBeVisible();
    const changed = await app.reception.startCall("notification-after-edit", app.scope, "2026-10-02T21:45:00.000Z");
    assert.ok(changed.ok);
    assert.equal(changed.value.policy.notificationBindings?.bookingConfirmation?.owner, "abby");
    assert.equal(admitted.value.policy.notificationBindings?.bookingConfirmation?.owner, "host");
    await rescheduling.getByRole("combobox").selectOption({ label: "Host" });
    await rescheduling.getByRole("button", { name: "Save owner", exact: true }).click();
    await expect(rescheduling.getByText("Managed delivery: Host", { exact: true })).toBeVisible();
    for (const group of [booking, cancellation, rescheduling]) {
      await group.getByRole("button", { name: "Clear owner", exact: true }).click();
      await expect(group.getByText("Saved owner: Not set", { exact: true })).toBeVisible();
      await expect(group.getByText("Managed delivery: Unavailable", { exact: true })).toBeVisible();
    }
    const next = await app.reception.startCall("notification-after-clear", app.scope, "2026-10-02T21:45:00.000Z");
    assert.ok(next.ok);
    assert.deepEqual(next.value.policy.notificationBindings, {});
    assert.equal(next.value.policy.policyVersion, "0");
    const audit = await app.policy.listNotificationChanges(app.scope);
    assert.ok(audit.ok);
    assert.deepEqual(audit.value.entries.map(row => row.version), ["1", "2", "3", "4", "5", "6", "7"]);
    assert.equal(audit.value.entries.filter(row => row.actorRef === "notification-owner").length, 6);
    assert.equal((await request.get(`${app.url}/api/settings/notification-audit?after=7`, { headers: app.headers })).status(), 200);
  } finally { await app.close(); }
});

test("E2E-257 SET-009 unavailable sender role Origin forged fields and invalid queries cannot configure notifications", async ({ page, request }) => {
  const app = await dashboard(false);
  try {
    await page.context().addCookies([{ name: "session", value: "notification-owner", url: app.url }]);
    await page.goto(app.url);
    const panel = page.getByRole("region", { name: "Notification ownership" });
    await expect(panel.getByText("No approved notification sender available.", { exact: true })).toHaveCount(3);
    for (const picker of await panel.getByRole("combobox").all()) await expect(picker).toBeDisabled();
    const valid = { expectedVersion: "0", notificationKind: "bookingConfirmation", owner: "host" };
    const unsupported = await request.post(`${app.url}/api/settings/notification-owner`, { headers: app.headers, data: valid });
    assert.equal(unsupported.status(), 400);
    assert.deepEqual(await unsupported.json(), { ok: false, error: { kind: "readinessFailed", missing: ["notificationOwner"] } });
    for (const invalid of [{ ...valid, owner: "both" }, { ...valid, notificationKind: "unknown" }, { ...valid, actorRef: "forged" },
      { ...valid, scope: { ...app.scope, clinicId: "foreign" } }, { ...valid, hostVersion: "forged" }]) {
      assert.equal((await request.post(`${app.url}/api/settings/notification-owner`, { headers: app.headers, data: invalid })).status(), 400);
    }
    for (const headers of [{ ...app.headers, Cookie: "session=notification-staff" },
      { ...app.headers, Cookie: "session=forged" }, { ...app.headers, Origin: "https://foreign.example.test" }]) {
      assert.equal((await request.post(`${app.url}/api/settings/notification-owner`, { headers, data: valid })).status(), 403);
    }
    for (const path of ["notification-options", "notification-audit"]) {
      assert.equal((await request.get(`${app.url}/api/settings/${path}`, { headers: { ...app.headers, Cookie: "session=notification-staff" } })).status(), 403);
      assert.equal((await request.get(`${app.url}/api/settings/${path}`, { headers: { Origin: app.url } })).status(), 403);
    }
    for (const path of ["notification-options?clinicId=foreign", "notification-audit?after=0&after=1", "notification-audit?after=01",
      "notification-audit?tenantId=foreign", "notification-audit?after=2147483648"]) {
      assert.equal((await request.get(`${app.url}/api/settings/${path}`, { headers: app.headers })).status(), 400);
    }
    assert.equal((await request.post(`${app.url}/api/settings/notification-owner?clinicId=foreign`, { headers: app.headers, data: valid })).status(), 400);
    await page.context().addCookies([{ name: "session", value: "notification-staff", url: app.url }]);
    await page.reload();
    await expect(panel.getByText("View only", { exact: true })).toHaveCount(3);
    await expect(panel.getByRole("combobox")).toHaveCount(0);
    const audit = await app.policy.listNotificationChanges(app.scope);
    assert.ok(audit.ok);
    assert.equal(audit.value.entries.length, 0);
  } finally { await app.close(); }
});

for (const failure of ["lost", "malformed"] as const) {
  test(`E2E-257 SET-009 ${failure} owner reply rereads current state without replay and supports clearing a withdrawn sender`, async ({ page }) => {
    const app = await dashboard();
    try {
      let corrupt = true;
      await page.route("**/api/settings/notification-owner", async route => {
        if (!corrupt) return route.continue();
        const upstream = await route.fetch();
        assert.equal(upstream.status(), 200);
        corrupt = false;
        if (failure === "lost") await route.abort("failed");
        else await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, value: { kind: "settings", policy: {} } }) });
      });
      await page.context().addCookies([{ name: "session", value: "notification-owner", url: app.url }]);
      await page.goto(app.url);
      const panel = page.getByRole("region", { name: "Notification ownership" });
      const booking = panel.getByRole("group", { name: "Booking confirmation", exact: true });
      await booking.getByRole("combobox").selectOption({ label: "Abby" });
      await booking.getByRole("button", { name: "Save owner", exact: true }).click();
      await expect(booking.getByText("Saved owner: Abby", { exact: true })).toBeVisible();
      await expect(panel.getByText("Clinic notification version 1", { exact: true })).toBeVisible();
      const audit = await app.policy.listNotificationChanges(app.scope);
      assert.ok(audit.ok);
      assert.equal(audit.value.entries.length, 1);
      app.setReady(false);
      await panel.getByRole("button", { name: "Refresh notification setup and history" }).click();
      await expect(booking.getByText("Managed delivery: Unavailable", { exact: true })).toBeVisible();
      await expect(booking.getByText("Saved owner: Abby", { exact: true })).toBeVisible();
      await expect(booking.getByRole("combobox")).toBeDisabled();
      await booking.getByRole("button", { name: "Clear owner", exact: true }).click();
      await expect(booking.getByText("Saved owner: Not set", { exact: true })).toBeVisible();
      const after = await app.policy.listNotificationChanges(app.scope);
      assert.ok(after.ok);
      assert.equal(after.value.entries.length, 2);
    } finally { await app.close(); }
  });
}

test("E2E-257 SET-009 lost owner reply and failed reread lock editing until scoped state is refreshed", async ({ page }) => {
  const app = await dashboard();
  try {
    let blockReads = false;
    let drop = true;
    await page.route("**/api/settings", route => blockReads ? route.abort("failed") : route.continue());
    await page.route("**/api/settings/notification-owner", async route => {
      if (!drop) return route.continue();
      const upstream = await route.fetch();
      assert.equal(upstream.status(), 200);
      drop = false; blockReads = true;
      await route.abort("failed");
    });
    await page.context().addCookies([{ name: "session", value: "notification-owner", url: app.url }]);
    await page.goto(app.url);
    const panel = page.getByRole("region", { name: "Notification ownership" });
    const booking = panel.getByRole("group", { name: "Booking confirmation", exact: true });
    await booking.getByRole("combobox").selectOption({ label: "Host" });
    await booking.getByRole("button", { name: "Save owner", exact: true }).click();
    await expect(panel.getByRole("alert")).toHaveText("Notification ownership could not be confirmed. Reload before editing settings.");
    for (const button of await panel.getByRole("button", { name: /^(Save|Clear) owner$/ }).all()) await expect(button).toBeDisabled();
    const audit = await app.policy.listNotificationChanges(app.scope);
    assert.ok(audit.ok);
    assert.equal(audit.value.entries.length, 1);
    blockReads = false;
    await panel.getByRole("button", { name: "Refresh notification setup and history" }).click();
    await expect(booking.getByText("Saved owner: Host", { exact: true })).toBeVisible();
    await expect(booking.getByRole("button", { name: "Clear owner", exact: true })).toBeEnabled();
  } finally { await app.close(); }
});

test("E2E-257 SET-009 clinic ownership history pages expose ordered public changes across locations", async ({ page }) => {
  const app = await dashboard();
  try {
    for (let index = 0; index < 52; index++) assert.ok((await app.policy.changeNotificationOwner({ ...app.scope,
      locationId: index % 2 ? "second" : "main" }, String(index), "bookingConfirmation", index % 2 ? "abby" : "host", "history-owner")).ok);
    await page.context().addCookies([{ name: "session", value: "notification-owner", url: app.url }]);
    await page.goto(app.url);
    const panel = page.getByRole("region", { name: "Notification ownership" });
    const history = panel.getByLabel("Notification ownership audit");
    await expect(history.getByRole("listitem")).toHaveCount(50);
    await panel.getByRole("button", { name: "Load more notification history" }).click();
    await expect(history.getByRole("listitem")).toHaveCount(52);
    await expect(history.getByRole("listitem").last()).toContainText("Version 52");
    await expect(panel.getByRole("button", { name: "Load more notification history" })).toHaveCount(0);
  } finally { await app.close(); }
});
