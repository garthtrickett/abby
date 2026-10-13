import assert from "node:assert/strict";
import { resolve } from "node:path";
import { expect, test } from "../support/browser-test.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { withHttpsApplication } from "../support/https-dashboard.ts";
import { requestBrowserMagicLink } from "../support/magic-link-browser.ts";
import { withOperatorAlerts } from "../support/operator-alert-fixture.ts";
import { MagicLinkIdentity } from "../../src/standalone/identity/magic-link.ts";
import { PostgresMagicLinkStore } from "../../src/storage/postgres-magic-link-store.ts";
import { createOperatorAlertMagicLink } from "../../src/standalone/operator-alert-magic-link.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";

test.use({ ignoreHTTPSErrors: true });
test("E2E-220 actual TLS, PostgreSQL sign-in, operator acknowledgment, restart and expired responsibility", async ({ page, browser }) => {
  test.setTimeout(90_000);
  await withDisposablePostgres(async db => withOperatorAlerts(async f => {
    await f.accept(); await f.workflow.observe();
    const mail: Readonly<{ email: string; link: string }>[] = []; let restart = async () => {};
    await withHttpsApplication(async origin => {
      const identity = new MagicLinkIdentity({ publicOrigin: origin, rateKeyHex: "4".repeat(64), store: new PostgresMagicLinkStore(db),
        directory: f.accounts.directory, delivery: { send: async (email, link) => { mail.push({ email, link }); return { ok: true, value: undefined }; } } });
      const prepare = async () => createOperatorAlertMagicLink(identity, await f.restart(), resolve("dist/dashboard/sign-in.js"));
      let app = await prepare(); restart = async () => { await app.close(); app = await prepare(); };
      return { handle: (request, response) => app.handle(request, response), close: () => app.close() };
    }, async origin => {
      const endpoint = `${origin}/api/operator-alerts/acknowledge`, data = { alert: f.alert, expectedVersion: 0 };
      assert.equal((await page.request.get(`${origin}/api/operator-alerts`, { headers: { authorization: `Bearer ${f.tokenHex}`, "X-Actor-Ref": f.owner.actor.actorRef } })).status(), 403);
      const link = await requestBrowserMagicLink(page, origin, mail);
      await page.goto(link); await page.getByRole("button", { name: "Continue to Abby" }).click();
      await expect(page.getByRole("heading", { name: "Operational alerts", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "I’m handling this" })).toBeVisible();
      assert.equal((await page.request.post(endpoint, { data, headers: { Origin: "https://foreign.example.test" } })).status(), 403);
      assert.equal((await page.request.post(endpoint, { data: { ...data, actorRef: f.backup.actor.actorRef }, headers: { Origin: origin } })).status(), 400);
      assert.equal((await page.request.post(endpoint, { data, headers: { Host: "foreign.example.test", Origin: origin } })).status(), 403);
      assert.equal((await f.workflow.view(f.owner.actor))[0]?.state, "awaitingOwner");
      await page.getByRole("button", { name: "I’m handling this" }).click();
      await expect(page.getByRole("status")).toHaveText("Responsibility accepted for the approved period.");
      await expect(page.locator("main")).toContainText("Responsibility accepted · Assigned to you until 2026-10-13T12:15:00.000Z");
      await expect(page.getByRole("button", { name: "I’m handling this" })).toHaveCount(0);
      await restart(); await page.reload();
      await expect(page.locator("main")).toContainText("Responsibility accepted");
      const backupContext = await browser.newContext({ ignoreHTTPSErrors: true });
      try {
        const backupPage = await backupContext.newPage();
        const backupLink = await requestBrowserMagicLink(backupPage, origin, mail, f.backup.email);
        await backupPage.goto(backupLink); await backupPage.getByRole("button", { name: "Continue to Abby" }).click();
        await expect(backupPage.locator("main")).toContainText("Responsibility accepted · Assigned to owner");
        f.setTime("2026-10-13T12:15:00.000Z");
        await backupPage.getByRole("button", { name: "Refresh alerts" }).click();
        await expect(backupPage.locator("main")).toContainText("Awaiting backup · Assigned to you");
        await backupPage.getByRole("button", { name: "I’m handling this" }).click();
        await expect(backupPage.getByRole("status")).toHaveText("Responsibility accepted for the approved period.");
        await expect(backupPage.locator("main")).toContainText("2026-10-13T12:30:00.000Z");
        f.accounts.accounts.delete(f.backup.email);
        assert.equal((await backupPage.request.get(`${origin}/api/operator-alerts`)).status(), 403);
      } finally { await backupContext.close(); }
      for (const secret of [f.tokenHex, f.owner.email, f.backup.email, f.message.alertKey, f.owner.actor.actorRef]) {
        assert.equal((await page.locator("body").innerText()).includes(secret), false);
      }
      assert.deepEqual(await scanPatientDataCanaries(db, [
        { label: "owner_email", value: f.owner.email }, { label: "backup_email", value: f.backup.email },
        { label: "alert_token", value: f.tokenHex }, { label: "sender_key", value: f.message.alertKey },
        { label: "sign_in_secret", value: new URL(link).hash.slice(1) },
      ]), { ok: true, value: [] });
      await page.reload(); await expect(page.locator("body")).toContainText("unavailable");
    });
  }));
});
