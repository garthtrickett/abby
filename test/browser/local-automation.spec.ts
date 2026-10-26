import assert from "node:assert/strict";
import { resolve } from "node:path";
import { expect, test } from "../support/browser-test.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { err, ok } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { createHostAuthenticatedDashboardServer } from "../../src/standalone/dashboard/server.ts";
import { listenLoopbackServer } from "../support/listen-loopback-server.ts";

test("E2E-248 local automation preserves readiness, versions, authorization and uncertain writes", async ({ page, request }) => {
  const scope = { tenantId: "automation-browser", clinicId: "clinic", locationId: "main" };
  const actor = { actorRef: "automation-owner", role: "clinicAdmin" as const, scope };
  let ready = false;
  const policy = new MemoryPolicyStore("execute", undefined, async () => ready
    ? ok(true) : err({ kind: "readinessFailed", missing: ["mediaTestCall"] }));
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const server = await createHostAuthenticatedDashboardServer({ publicOrigin: "http://127.0.0.1:0", surface: "availabilitySetup",
    resolveActor: incoming => incoming.headers.cookie === "session=owner" ? actor
      : incoming.headers.cookie === "session=staff" ? { ...actor, role: "staff" } : null,
    gatewayFor: bound => new CommandGateway(bound, policy, reception),
  }, resolve("dist/dashboard/cliniko-admin.js"));
  try {
    const origin = await listenLoopbackServer(server);
    await page.context().addCookies([{ name: "session", value: "owner", url: origin }]);
    await page.goto(origin);
    const panel = page.locator('section[aria-labelledby="local-automation-title"]');
    const enable = panel.getByRole("button", { name: "Enable automation for new calls", exact: true });
    const disable = panel.getByRole("button", { name: "Disable automation for new calls", exact: true });
    await expect(panel.getByLabel("Automation status")).toHaveText("Automation disabled · version 0");
    await expect(disable).toBeDisabled();
    assert.deepEqual(await policy.listAutomationChanges(scope), { ok: true, value: { entries: [] } });
    const rejectedReadiness = page.waitForResponse(response =>
      response.url().endsWith("/api/settings/automation-enabled") && response.request().method() === "POST");
    await enable.click();
    assert.deepEqual(await (await rejectedReadiness).json(),
      { ok: false, error: { kind: "readinessFailed", missing: ["mediaTestCall"] } });
    await expect(panel.getByRole("alert")).toContainText("readiness checks pass");
    await expect(panel.getByRole("alert")).toContainText("passed media test call");
    await expect(panel.getByRole("alert")).toContainText("Next:");
    await expect(panel.getByRole("alert")).toContainText("supervised");
    await expect(enable).toBeEnabled();
    assert.deepEqual(await policy.listAutomationChanges(scope), { ok: true, value: { entries: [] } });
    ready = true;
    await enable.click();
    await expect(panel.getByLabel("Automation status")).toHaveText("Automation enabled · version 1");
    await expect(panel.getByLabel("Automation change history")).toContainText("Version 1 · enabled · automation-owner");
    assert.ok((await policy.changeAutomationEnabled(scope, "1", false, "other-owner")).ok);
    await disable.click();
    await expect(panel.getByRole("alert")).toContainText("changed elsewhere");
    await expect(panel.getByLabel("Automation status")).toHaveText("Automation disabled · version 2");
    await enable.click();
    await expect(panel.getByLabel("Automation status")).toHaveText("Automation enabled · version 3");
    const post = (data: object, session = "owner", requestOrigin = origin) => request.post(
      `${origin}/api/settings/automation-enabled`, { headers: { Cookie: `session=${session}`, Origin: requestOrigin }, data });
    assert.equal((await post({ expectedVersion: "3", enabled: "false" })).status(), 400);
    assert.equal((await post({ expectedVersion: "3", enabled: false, actorRef: "forged" })).status(), 400);
    assert.equal((await post({ expectedVersion: "3", enabled: false, scope: { clinicId: "foreign" } })).status(), 400);
    assert.equal((await post({ expectedVersion: "3", enabled: false }, "staff")).status(), 403);
    assert.equal((await post({ expectedVersion: "3", enabled: false }, "owner", "http://foreign.example.test")).status(), 403);
    assert.equal((await request.get(`${origin}/api/settings/automation-audit`, { headers: { Cookie: "session=staff" } })).status(), 403);
    assert.equal((await request.get(`${origin}/api/settings/automation-audit?after=invalid`, { headers: { Cookie: "session=owner" } })).status(), 400);
    const history = await policy.listAutomationChanges(scope);
    assert.ok(history.ok);
    assert.deepEqual(history.value.entries.map(entry => entry.version), ["1", "2", "3"]);
    await disable.click();
    await expect(panel.getByLabel("Automation status")).toHaveText("Automation disabled · version 4");
    await page.reload();
    await expect(panel.getByLabel("Automation status")).toHaveText("Automation disabled · version 4");
    await expect(panel.getByLabel("Automation change history")).toContainText("Version 4 · disabled");
    // The server commits, but both the write reply and subsequent state read are lost.
    let writes = 0;
    await page.route("**/api/settings/automation-enabled", async route => {
      writes += 1;
      const committed = await route.fetch();
      assert.equal(committed.status(), 200);
      await route.abort();
    });
    await page.route("**/api/settings", route => route.abort());
    await enable.click();
    await expect(panel.getByRole("alert")).toContainText("outcome is uncertain");
    await expect(panel.getByLabel("Automation status")).toHaveText("Current automation setting unavailable");
    await expect(enable).toBeDisabled();
    await expect(disable).toBeDisabled();
    await expect(panel.getByRole("status")).toHaveCount(0);
    assert.equal(writes, 1);
    await page.unrouteAll({ behavior: "wait" });
    await page.reload();
    await expect(panel.getByLabel("Automation status")).toHaveText("Automation enabled · version 5");
    await expect(panel.getByLabel("Automation change history")).toContainText("Version 5 · enabled");
    await expect(page.getByRole("button", { name: /booking/i })).toHaveCount(0);
    for (let version = 5; version < 56; version += 1) {
      assert.ok((await policy.changeAutomationEnabled(scope, String(version), version % 2 === 0,
        "history-owner")).ok);
    }
    await page.reload();
    await expect(panel.getByLabel("Automation status")).toHaveText("Automation disabled · version 56");
    const more = panel.getByRole("button", { name: "Load more automation history" });
    await expect(more).toBeEnabled();
    await more.click();
    await expect(panel.getByLabel("Automation change history")).toContainText("Version 56 · disabled · history-owner");
    await expect(more).toHaveCount(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  }
});
