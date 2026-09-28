import assert from "node:assert/strict";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { EffectWorker } from "../../src/core/effect-worker.ts";
import type { LocationScope } from "../../src/core/model.ts";
import type { AvailabilityHost } from "../../src/core/host.ts";
import { CallReview } from "../../src/reference/call-review.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { StaffQueue } from "../../src/reference/staff-queue.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { createDashboardServer } from "../../src/standalone/dashboard/server.ts";

async function localDashboard(role: "clinicAdmin" | "staff", availability?: AvailabilityHost) {
  const scope: LocationScope = { tenantId: "browser-tenant", clinicId: "browser-clinic", locationId: "browser-location" };
  const ledger = new MemoryLedger();
  const policy = new MemoryPolicyStore();
  const host = new ReferenceClinicHost([], [],
    [{ scope, sourceRef: "hours", version: "hours-v1", ownerRef: "clinic-owner", approvedText: "We open at 9 am.", approved: true,
      effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: "2026-10-01T00:00:00.000Z" }]);
  const reception = new TextReception(ledger, policy, host, availability);
  const started = await reception.startCall("before-setting", scope);
  assert.equal(started.ok, true);
  const gateway = new CommandGateway({ actorRef: `browser-${role}`, role, scope }, policy, reception, new CallReview(ledger), new StaffQueue(ledger, () => "2026-09-30T12:00:00.000Z"));
  const server = await createDashboardServer(gateway, resolve("dist/dashboard/app.js"));
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    scope, ledger, policy, reception, host,
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

test("availability read review shows source and status without exposing exact times", async ({ page }) => {
  const availability: AvailabilityHost = { list: async scope => ({ ok: true, value: { kind: "times", scope,
    sourceRef: "cliniko:11:22:33", timeZone: "Australia/Sydney", observedAt: "2026-09-28T10:00:00.000Z",
    startsAt: ["2026-09-30T23:00:00.000Z"], reservable: false } }) };
  const app = await localDashboard("staff", availability);
  try {
    const read = await app.reception.checkAvailability(app.scope,
      { callId: "before-setting", turnId: "availability-review", text: "Check times", quality: "clear", at: "2026-09-28T10:00:00.000Z" },
      "2026-10-01", "2026-10-02", "2026-09-28T10:00:00.000Z");
    assert.equal(read.ok, true);
    await page.goto(app.url);
    await page.getByRole("textbox", { name: "Call ID" }).fill("before-setting");
    await page.getByRole("button", { name: "Load call" }).click();
    await expect(page.getByLabel("Call summary")).toContainText("1 availability read(s)");
    await expect(page.getByLabel("Call summary")).toContainText("shown · cliniko:11:22:33 · Australia/Sydney · 1 time(s)");
    await expect(page.getByLabel("Call summary")).not.toContainText("2026-09-30T23:00:00.000Z");
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

test("staff follow-up queue shows overdue fallback without patient or spoken details", async ({ page, request }) => {
  const app = await localDashboard("staff");
  try {
    const routed = await app.reception.answer(app.scope,
      { callId: "before-setting", turnId: "missing-answer", text: "Private patient question", quality: "clear", at: "2026-09-28T10:00:00.000Z" },
      ["missing-source"], "Private proposed answer", "2026-09-28T10:00:00.000Z");
    assert.equal(routed.ok, true);
    const delivered = await app.reception.drain(app.scope, "before-setting", "2026-09-28T10:00:00.000Z");
    assert.equal(delivered.ok, true);
    await page.goto(app.url);
    const queue = page.getByLabel("Staff follow-up queue");
    await expect(queue).toContainText("before-setting · systemFailure · open · overdue");
    await expect(queue).not.toContainText("Private patient question");
    await expect(queue).not.toContainText("Private proposed answer");
    const response = await request.get(`${app.url}/api/staff?after=`);
    assert.equal(response.status(), 400);
    const foreign = await app.ledger.listStaffItems({ ...app.scope, tenantId: "another-tenant" });
    assert.ok(foreign.ok);
    assert.deepEqual(foreign.value, []);
  } finally {
    await app.close();
  }
});

test("lost host task receipt remains in review until exact reconciliation reaches the queue", async ({ page }) => {
  const app = await localDashboard("staff");
  try {
    const routed = await app.reception.answer(app.scope,
      { callId: "before-setting", turnId: "task-reconcile", text: "Question", quality: "clear", at: "2026-09-28T10:00:00.000Z" },
      ["missing"], "Unapproved answer", "2026-09-28T10:00:00.000Z");
    assert.equal(routed.ok, true);
    const original = app.host.openTask.bind(app.host);
    app.host.openTask = async item => { await original(item); throw new Error("response lost"); };
    assert.equal((await app.reception.drain(app.scope, "before-setting", "2026-09-28T10:00:00.000Z")).ok, true);
    await page.goto(app.url);
    const queue = page.getByLabel("Staff follow-up queue");
    await expect(queue).toContainText("needsReview");
    const stored = await app.ledger.read("before-setting", app.scope);
    assert.ok(stored.ok);
    const taskKey = Object.keys(stored.value.staffItems)[0];
    assert.ok(taskKey);
    const worker = new EffectWorker(new CallRuntime(app.ledger, app.scope), app.host);
    await worker.process("before-setting", `${taskKey}:open:reconcile`, "2026-09-28T10:00:00.000Z");
    await page.getByRole("button", { name: "Refresh follow-up" }).click();
    await expect(queue).toContainText("systemFailure · open · overdue");
    await expect(queue).not.toContainText("needsReview");
    assert.equal(app.host.tasks(app.scope).length, 1);
  } finally {
    await app.close();
  }
});

test("staff dashboard acknowledges, reassigns, and resolves only host-confirmed follow-up", async ({ page, request }) => {
  const app = await localDashboard("staff");
  try {
    assert.equal((await app.reception.answer(app.scope,
      { callId: "before-setting", turnId: "staff-lifecycle", text: "Need help", quality: "clear", at: "2026-09-28T10:00:00.000Z" },
      ["missing"], "Unapproved", "2026-09-28T10:00:00.000Z")).ok, true);
    assert.equal((await app.reception.drain(app.scope, "before-setting", "2026-09-28T10:00:00.000Z")).ok, true);
    const initial = await app.ledger.read("before-setting", app.scope);
    assert.ok(initial.ok);
    const taskKey = Object.keys(initial.value.staffItems)[0];
    assert.ok(taskKey);
    await page.goto(app.url);
    const queue = page.getByLabel("Staff follow-up queue");
    await expect(queue).toContainText("systemFailure · open");
    await page.getByRole("button", { name: "Acknowledge" }).click();
    await expect(queue).toContainText("systemFailure · acknowledged");
    assert.equal(app.host.tasks(app.scope)[0]?.status, "acknowledged");
    const stale = await request.post(`${app.url}/api/staff/change`, { data: { callId: "before-setting", taskKey,
      expectedVersion: initial.value.version, change: { kind: "resolve" } } });
    assert.equal(stale.status(), 409);
    await page.getByRole("button", { name: "Assign to operator" }).click();
    await expect(queue).toContainText("systemFailure · open");
    const policy = await app.policy.read(app.scope);
    assert.ok(policy.ok);
    assert.deepEqual(app.host.tasks(app.scope)[0]?.destination, policy.value.operatorQueue);
    await page.getByRole("button", { name: "Resolve" }).click();
    await expect(queue).toContainText("systemFailure · resolved");
    await expect(queue).not.toContainText("resolved · overdue");
    await expect(page.getByRole("button", { name: "Resolve" })).toHaveCount(0);
    assert.equal(app.host.tasks(app.scope)[0]?.status, "resolved");
    const foreign = new CommandGateway({ actorRef: "foreign-agent", role: "agent", scope: app.scope }, app.policy, app.reception);
    const forbidden = await foreign.submit({ kind: "staff.change.v1", callId: "before-setting", taskKey,
      expectedVersion: initial.value.version, change: { kind: "resolve" }, now: "2026-09-28T10:00:00.000Z" });
    assert.equal(forbidden.ok, false);
    if (!forbidden.ok) assert.equal(forbidden.error.kind, "forbidden");
  } finally {
    await app.close();
  }
});
