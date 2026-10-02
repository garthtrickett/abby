import assert from "node:assert/strict";
import { expect, test } from "../support/browser-test.ts";
import { withHttpsDashboard } from "../support/https-dashboard.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";

// Only this generated, self-signed fixture certificate bypasses the browser's trust store.
test.use({ ignoreHTTPSErrors: true });

test("E2E-253 real HTTPS browser booking edits retain snapshots and reject foreign origins and staff", async ({ page }) => {
  const scope = { tenantId: "tls-browser", clinicId: "clinic", locationId: "main" };
  const ledger = new MemoryLedger();
  const policy = new MemoryPolicyStore();
  const reception = new TextReception(ledger, policy, new ReferenceClinicHost([], []));
  const before = await reception.startCall("tls-before", scope, "2026-10-02T10:00:00Z");
  assert.ok(before.ok);
  await withHttpsDashboard({ resolveActor: incoming => incoming.headers.cookie === "session=owner"
    ? { actorRef: "tls-owner", role: "clinicAdmin", scope }
    : incoming.headers.cookie === "session=staff" ? { actorRef: "tls-staff", role: "staff", scope } : null,
  gatewayFor: actor => new CommandGateway(actor, policy, reception),
  }, async origin => {
    await page.context().addCookies([{ name: "session", value: "owner", url: origin }]);
    await page.goto(origin);
    const booking = page.getByRole("region", { name: "Booking automation", exact: true });
    await expect(booking.getByText("Disabled", { exact: true })).toBeVisible();
    await booking.getByRole("button", { name: "Enable booking", exact: true }).click();
    await expect(booking.getByText("Enabled", { exact: true })).toBeVisible();
    const enabled = await reception.startCall("tls-enabled", scope, "2026-10-02T10:01:00Z");
    assert.ok(enabled.ok);
    assert.equal(enabled.value.policy.capabilities.book, "execute");
    assert.equal(before.value.policy.capabilities.book, "unavailable");
    await booking.getByRole("button", { name: "Disable booking", exact: true }).click();
    await expect(booking.getByText("Disabled", { exact: true })).toBeVisible();
    const retained = await ledger.read("tls-enabled", scope);
    assert.ok(retained.ok);
    assert.equal(retained.value.policy.capabilities.book, "execute");
    const next = await reception.startCall("tls-next", scope, "2026-10-02T10:02:00Z");
    assert.ok(next.ok);
    assert.equal(next.value.policy.capabilities.book, "unavailable");
    for (const rejected of ["https://foreign.example.test", origin.replace("https:", "http:"), ""]) {
      assert.equal((await page.request.post(`${origin}/api/settings/booking-enabled`, {
        headers: { Origin: rejected }, data: { expectedVersion: "2", enabled: true },
      })).status(), 403);
    }
    await page.reload();
    await expect(booking.getByText("Disabled", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Booking setting history", exact: true })).toContainText("tls-owner");
    await page.context().addCookies([{ name: "session", value: "staff", url: origin }]);
    await page.reload();
    await expect(booking.getByText("View only", { exact: true })).toBeVisible();
    await expect(booking.getByRole("button")).toHaveCount(0);
    assert.equal((await page.request.post(`${origin}/api/settings/booking-enabled`, {
      headers: { Origin: origin, "X-Actor-Role": "clinicAdmin" }, data: { expectedVersion: "2", enabled: true },
    })).status(), 403);
    const current = await policy.read(scope);
    assert.ok(current.ok);
    assert.equal(current.value.policyVersion, "2");
    assert.equal(current.value.bookingEnabled, false);
  });
});
