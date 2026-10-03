import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sql } from "kysely";
import { expect, test } from "../support/browser-test.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { withHttpsApplication } from "../support/https-dashboard.ts";
import { requestBrowserMagicLink } from "../support/magic-link-browser.ts";
import { syntheticAdminAccount } from "../support/magic-link-fixture.ts";
import { createStandaloneClinikoMagicLinkAdmin } from "../../src/standalone/cliniko-magic-link-admin.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import type { MagicLinkHttp } from "../../src/standalone/identity/magic-link-http.ts";
import { identityCookieNames } from "../../src/standalone/identity/magic-link-http.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { ok } from "../../src/core/model.ts";
import { keypadInstructions } from "../../src/standalone/keypad-greeting.ts";

test.use({ ignoreHTTPSErrors: true });

test("E2E-260 real Cliniko admin PostgreSQL login survives composition restart and retains a scoped greeting through logout", async ({ page }) => {
  await withDisposablePostgres(async db => {
    const folder = await mkdtemp(join(tmpdir(), "abby-browser-accounts-")), path = join(folder, "accounts.json");
    const account = syntheticAdminAccount(), mail: Readonly<{ email: string; link: string }>[] = [];
    const providerPaths: string[] = [];
    const provider: typeof fetch = async input => {
      const pathname = new URL(String(input)).pathname; providerPaths.push(pathname);
      if (pathname === "/v1/businesses") return Response.json({ total_entries: 1, businesses: [{ id: "11",
        business_name: "Synthetic clinic", show_in_online_bookings: true, time_zone_identifier: "Australia/Sydney",
        patient_name: "synthetic-patient-private-canary-260" }] });
      throw new Error("unexpected synthetic catalogue request");
    };
    let restart = async (): Promise<void> => { throw new Error("application not prepared"); };
    try {
      await writeFile(path, JSON.stringify([account]), { mode: 0o600 });
      await withHttpsApplication(async origin => {
        const prepare = async (): Promise<MagicLinkHttp> => {
          const app = await createStandaloneClinikoMagicLinkAdmin({ db, scope: account.actor.scope, publicOrigin: origin,
            apiKey: "synthetic-cliniko-identity-key-au5", contactEmail: "test@example.test", fetch: provider,
            route: { accountRef: `AC${"1".repeat(32)}`, dialedNumber: "+6125550199", routeVersion: "synthetic-260" },
            directory: new OwnerFileAdminDirectory(path, account.actor.scope), rateKeyHex: "4".repeat(64),
            delivery: { send: async (email, link) => { mail.push({ email, link }); return ok(undefined); } },
            bundlePath: resolve("dist/dashboard/cliniko-admin.js"), signInBundlePath: resolve("dist/dashboard/sign-in.js") });
          assert.ok(app.ok); return app.value;
        };
        let active = await prepare();
        restart = async () => { await active.close(); active = await prepare(); };
        return { handle: (incoming, response) => active.handle(incoming, response), close: () => active.close() };
      }, async origin => {
        const link = await requestBrowserMagicLink(page, origin, mail);
        assert.equal(providerPaths.length, 0, "anonymous sign-in must not call Cliniko");
        await page.goto(link); await expect(page.getByRole("button", { name: "Continue to Abby" })).toBeVisible();
        await page.getByRole("button", { name: "Continue to Abby" }).click();
        await expect(page.getByRole("heading", { name: "Read-only availability setup" })).toBeVisible();
        const secret = new URL(link).hash.slice(1);
        const session = (await page.context().cookies()).find(cookie => cookie.name === identityCookieNames(origin).session)!;
        const rows = await sql<{ challenges: number; sessions: number }>`select
          (select count(*)::integer from admin_sign_in_challenges) as challenges,
          (select count(*)::integer from admin_sign_in_sessions) as sessions`.execute(db);
        assert.deepEqual(rows.rows, [{ challenges: 0, sessions: 1 }]);
        await page.getByLabel("Local greeting version").fill("identity-greeting-260");
        await page.getByLabel("Local greeting text").fill(`Welcome to the clinic. ${keypadInstructions}`);
        await page.getByLabel("Local greeting effective from").fill("2026-09-01T00:00:00.000Z");
        await page.getByLabel("Local greeting effective until").fill("2027-09-01T00:00:00.000Z");
        await page.getByRole("button", { name: "Approve greeting for new calls" }).click();
        await expect(page.getByLabel("Greeting approval status")).toContainText("Greeting saved · policy version 1");
        await restart(); await page.reload();
        await expect(page.getByLabel("Greeting approval status")).toContainText("Greeting saved · policy version 1");
        await expect(page.getByLabel("Greeting change history")).toContainText(account.actor.actorRef);
        assert.deepEqual(await scanPatientDataCanaries(db, [
          { label: "link_secret", value: secret }, { label: "session_secret", value: session.value },
          { label: "admin_email", value: account.email }, { label: "cliniko_key", value: "synthetic-cliniko-identity-key-au5" },
          { label: "patient_data", value: "synthetic-patient-private-canary-260" },
        ]), ok([]));
        assert.equal((await page.locator("body").innerText()).includes(account.email), false);
        await page.getByRole("link", { name: "Sign out", exact: true }).click();
        await page.getByRole("button", { name: "Sign out", exact: true }).click();
        await expect(page.getByRole("textbox", { name: "Email", exact: true })).toBeVisible();
        assert.equal((await page.request.get(`${origin}/api/settings`)).status(), 403);
        const remaining = await sql<{ count: number }>`select count(*)::integer as count from admin_sign_in_sessions`.execute(db);
        assert.equal(remaining.rows[0]!.count, 0);
      });
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
});
