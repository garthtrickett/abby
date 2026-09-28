import assert from "node:assert/strict";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { LocationScope } from "../../src/core/model.ts";
import { CallReview } from "../../src/reference/call-review.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { createDashboardServer } from "../../src/standalone/dashboard/server.ts";

async function localDashboard(role: "clinicAdmin" | "staff") {
  const scope: LocationScope = { tenantId: "browser-tenant", clinicId: "browser-clinic", locationId: "browser-location" };
  const ledger = new MemoryLedger();
  const policy = new MemoryPolicyStore();
  const reception = new TextReception(ledger, policy, new ReferenceClinicHost([], [],
    [{ scope, sourceRef: "hours", version: "hours-v1", ownerRef: "clinic-owner", approvedText: "We open at 9 am.", approved: true,
      effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: "2026-10-01T00:00:00.000Z" }]));
  const started = await reception.startCall("before-setting", scope);
  assert.equal(started.ok, true);
  const gateway = new CommandGateway({ actorRef: `browser-${role}`, role, scope }, policy, reception, new CallReview(ledger));
  const server = await createDashboardServer(gateway, resolve("dist/dashboard/app.js"));
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    scope, ledger, policy, reception,
    close: () => new Promise<void>((done, reject) => {
      server.close(error => error ? reject(error) : done());
      server.closeAllConnections();
    }),
  };
}

test("E2E-010: dashboard toggle persists default, enabled and disabled policy for new calls", async ({ page }) => {
  const app = await localDashboard("clinicAdmin");
  try {
    await page.goto(app.url);
    await expect(page.getByRole("heading", { name: "Booking automation" })).toBeVisible();
    await expect(page.getByText("Policy version 0")).toBeVisible();
    await expect(page.getByRole("button", { name: "Enable booking" })).toBeVisible();
    await page.getByRole("button", { name: "Enable booking" }).click();
    await expect(page.getByText("Booking enabled for new calls.")).toBeVisible();
    await expect(page.getByText("Policy version 1")).toBeVisible();
    assert.equal((await app.reception.startCall("enabled-setting", app.scope)).ok, true);
    await page.getByRole("button", { name: "Disable booking" }).click();
    await expect(page.getByText("Booking disabled for new calls.")).toBeVisible();
    await expect(page.getByText("Policy version 2")).toBeVisible();
    assert.equal((await app.reception.startCall("disabled-setting", app.scope)).ok, true);
    await page.reload();
    await expect(page.getByRole("button", { name: "Enable booking" })).toBeVisible();
    const before = await app.ledger.read("before-setting", app.scope);
    const enabled = await app.ledger.read("enabled-setting", app.scope);
    const disabled = await app.ledger.read("disabled-setting", app.scope);
    assert.ok(before.ok && enabled.ok && disabled.ok);
    assert.deepEqual([before.value.policy.capabilities.book, enabled.value.policy.capabilities.book, disabled.value.policy.capabilities.book], ["unavailable", "execute", "unavailable"]);
    const other = await app.policy.read({ ...app.scope, tenantId: "another-tenant" });
    assert.ok(other.ok);
    assert.equal(other.value.bookingEnabled, false);
    await page.getByRole("textbox", { name: "Call ID" }).fill("enabled-setting");
    await page.getByRole("button", { name: "Load call" }).click();
    await expect(page.getByLabel("Call summary")).toContainText("enabled-setting · active");
  } finally {
    await app.close();
  }
});

test("E2E-069: view-only staff can review a call but cannot change booking settings", async ({ page, request }) => {
  const app = await localDashboard("staff");
  try {
    await page.goto(app.url);
    await expect(page.getByText("View only")).toBeVisible();
    await expect(page.getByRole("button", { name: "Enable booking" })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Call ID" }).fill("before-setting");
    await page.getByRole("button", { name: "Load call" }).click();
    await expect(page.getByLabel("Call summary")).toContainText("before-setting · active");
    const forbidden = await request.post(`${app.url}/api/settings/booking-enabled`, { data: { expectedVersion: "0", enabled: true } });
    assert.equal(forbidden.status(), 403);
    const policy = await app.policy.read(app.scope);
    assert.ok(policy.ok);
    assert.equal(policy.value.bookingEnabled, false);
  } finally {
    await app.close();
  }
});

test("E2E-004: staff can review the approved answer source without seeing spoken text", async ({ page }) => {
  const app = await localDashboard("staff");
  try {
    const answered = await app.reception.answer(app.scope,
      { callId: "before-setting", turnId: "hours-answer", text: "Hours?", quality: "clear", at: "2026-09-28T10:00:00.000Z" },
      ["hours"], "We open at 9 am.", "2026-09-28T10:00:00.000Z");
    assert.equal(answered.ok, true);
    await page.goto(app.url);
    await page.getByRole("textbox", { name: "Call ID" }).fill("before-setting");
    await page.getByRole("button", { name: "Load call" }).click();
    await expect(page.getByLabel("Call summary")).toContainText("1 sourced answer(s)");
    await expect(page.getByLabel("Call summary")).toContainText("hours · version hours-v1");
    await expect(page.getByLabel("Call summary")).not.toContainText("We open at 9 am.");
  } finally {
    await app.close();
  }
});

test("stale settings tab reloads the winning policy version", async ({ context }) => {
  const app = await localDashboard("clinicAdmin");
  const first = await context.newPage();
  const stale = await context.newPage();
  try {
    await Promise.all([first.goto(app.url), stale.goto(app.url)]);
    await expect(first.getByRole("button", { name: "Enable booking" })).toBeVisible();
    await expect(stale.getByRole("button", { name: "Enable booking" })).toBeVisible();
    await first.getByRole("button", { name: "Enable booking" }).click();
    await expect(first.getByText("Policy version 1")).toBeVisible();
    await stale.getByRole("button", { name: "Enable booking" }).click();
    await expect(stale.getByRole("alert")).toContainText("Settings changed elsewhere");
    await expect(stale.getByText("Policy version 1")).toBeVisible();
    await expect(stale.getByRole("button", { name: "Disable booking" })).toBeVisible();
  } finally {
    await Promise.all([first.close(), stale.close()]);
    await app.close();
  }
});
