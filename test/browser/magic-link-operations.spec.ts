import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { expect, test } from "../support/browser-test.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { withHttpsApplication } from "../support/https-dashboard.ts";
import { requestBrowserMagicLink } from "../support/magic-link-browser.ts";
import { syntheticAdminAccount } from "../support/magic-link-fixture.ts";
import { createStandaloneClinikoMagicLinkAdmin } from "../../src/standalone/cliniko-magic-link-admin.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import type { AdminAccount } from "../../src/standalone/identity/magic-link.ts";
import type { MagicLinkHttp } from "../../src/standalone/identity/magic-link-http.ts";
import { identityCookieNames } from "../../src/standalone/identity/magic-link-http.ts";
import { PostgresOperationalCounters } from "../../src/storage/postgres-operational-counters.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import type Database from "../../src/storage/generated/Database.ts";
import { ok } from "../../src/core/model.ts";
import type { OperationalDailyCounts } from "../../src/voice/operational-counts.ts";

test.use({ ignoreHTTPSErrors: true });
const now = "2026-10-03T10:00:00.000Z";
const privateTranscript = "synthetic-private-transcript-262";
const privatePatient = "synthetic-private-patient-262";
const reportPath = "/synthetic-owner-only/speech-report-262.json";
const speechCandidate = { kind: "speechGateStatus", syntheticCandidateGate: "fail",
  representativeCallGate: "notRun", releaseGate: "unverified", rawTranscript: privateTranscript, reportPath,
  checks: [{ name: "telephony", status: "pass", rawTranscript: privateTranscript },
    { name: "noise", status: "fail" }, { name: "safety", status: "fail" }, { name: "speech", status: "pass" }] };

/** Owns the database, approved account file, real TLS and canonical Cliniko application per journey. */
async function withClinicOperations(run: (app: Readonly<{
  origin: string; account: AdminAccount; db: Kysely<Database>;
  mail: readonly Readonly<{ email: string; link: string }>[]; providerPaths: readonly string[];
  restart(): Promise<void>; replaceAccount(account?: AdminAccount): Promise<void>; setSpeech(value: unknown): void;
}>) => Promise<void>): Promise<void> {
  await withDisposablePostgres(async db => {
    const folder = await mkdtemp(join(tmpdir(), "abby-operations-accounts-")), path = join(folder, "accounts.json");
    const account = syntheticAdminAccount(), mail: Readonly<{ email: string; link: string }>[] = [], providerPaths: string[] = [];
    let speech: unknown = speechCandidate;
    let restart: (() => Promise<void>) | undefined;
    const replaceAccount = async (current?: AdminAccount) => {
      const next = join(folder, "next.json");
      await writeFile(next, JSON.stringify(current ? [current] : []), { mode: 0o600 }); await rename(next, path);
    };
    try {
      await replaceAccount(account);
      const counters = new PostgresOperationalCounters(db, () => now);
      await Promise.all([
        counters.record(account.actor.scope, "voiceFailure"),
        counters.record(account.actor.scope, "intentClassificationUnavailable"),
        counters.record({ ...account.actor.scope, locationId: "foreign-location" }, "clinikoProviderUnavailable"),
        counters.record({ ...account.actor.scope, clinicId: "foreign-clinic" }, "clinikoProviderUnavailable"),
        counters.record({ ...account.actor.scope, tenantId: "foreign-tenant" }, "clinikoProviderUnavailable"),
      ]);
      await withHttpsApplication(async origin => {
        const prepare = async (): Promise<MagicLinkHttp> => {
          const app = await createStandaloneClinikoMagicLinkAdmin({ db, scope: account.actor.scope, publicOrigin: origin, now: () => now,
            apiKey: "synthetic-operations-key-au5", contactEmail: "test@example.test",
            fetch: async input => {
              const pathname = new URL(String(input)).pathname; providerPaths.push(pathname);
              assert.equal(pathname, "/v1/businesses");
              return Response.json({ total_entries: 1, businesses: [{ id: "11", business_name: "Synthetic clinic",
                show_in_online_bookings: true, time_zone_identifier: "Australia/Sydney", patient_name: privatePatient }] });
            },
            route: { accountRef: `AC${"1".repeat(32)}`, dialedNumber: "+6125550199", routeVersion: "synthetic-262" },
            directory: new OwnerFileAdminDirectory(path, account.actor.scope), rateKeyHex: "4".repeat(64),
            delivery: { send: async (email, link) => { mail.push({ email, link }); return ok(undefined); } },
            readSpeechGate: async () => speech,
            bundlePath: resolve("dist/dashboard/cliniko-admin.js"), signInBundlePath: resolve("dist/dashboard/sign-in.js") });
          assert.ok(app.ok); return app.value;
        };
        let active = await prepare();
        restart = async () => { await active.close(); active = await prepare(); };
        return { handle: (incoming, response) => active.handle(incoming, response), close: () => active.close() };
      }, async origin => {
        assert.ok(restart);
        await run({ origin, account, db, mail, providerPaths, replaceAccount, restart, setSpeech: value => { speech = value; } });
      });
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
}

test("E2E-262 magic-link clinic admin discovers scoped aggregate status and sees truthful unavailable data", async ({ page }) => {
  await withClinicOperations(async app => {
    const { origin, account, db, mail } = app;
    for (const route of ["/api/capabilities", "/api/operations/daily", "/api/speech-gate"]) {
      assert.equal((await page.request.get(`${origin}${route}`)).status(), 403);
    }
    assert.equal(app.providerPaths.length, 0);
    const link = await requestBrowserMagicLink(page, origin, mail);
    await page.goto(link); await page.getByRole("button", { name: "Continue to Abby" }).click();
    await expect(page.getByRole("heading", { name: "Read-only availability setup" })).toBeVisible();
    const capabilities = await page.request.get(`${origin}/api/capabilities`);
    assert.equal(capabilities.status(), 200);
    const catalogue = await capabilities.json() as { value: { id: string }[] };
    assert.ok(catalogue.value.some(item => item.id === "operations.daily.v1"), "advertise the actual scoped read contract");
    const response = await page.request.get(`${origin}/api/operations/daily?locationId=foreign-location`,
      { headers: { "X-Actor-Role": "clinicAdmin", "X-Tenant-ID": "foreign-tenant" } });
    assert.equal(response.status(), 200);
    const daily = await response.json() as { value: { daily: OperationalDailyCounts } };
    assert.equal(daily.value.daily.days.length, 7);
    assert.equal(daily.value.daily.days.at(-1)?.counts.voiceFailure, 1);
    assert.equal(daily.value.daily.days.at(-1)?.counts.intentClassificationUnavailable, 1);
    assert.equal(daily.value.daily.days.at(-1)?.counts.clinikoProviderUnavailable, 0);
    const table = page.getByRole("region", { name: "Operational counts", exact: true });
    await expect(table.getByRole("row")).toHaveCount(8);
    await expect(table.getByRole("row").last().getByRole("cell")).toHaveText(["0", "0", "0", "1", "0", "0", "0", "0", "1"]);
    await expect(table).toContainText("zero does not prove service health or staff delivery");
    const speech = page.getByRole("region", { name: "Voice quality status", exact: true });
    await expect(speech).toContainText("Voice quality is blocked");
    await expect(speech).toContainText("Noisy audio: fail");
    await expect(speech).toContainText("Release readiness: unverified");
    const speechResponse = await page.request.get(`${origin}/api/speech-gate`);
    assert.equal(speechResponse.status(), 200);
    const secret = new URL(link).hash.slice(1);
    const session = (await page.context().cookies()).find(cookie => cookie.name === identityCookieNames(origin).session);
    assert.ok(session);
    for (const body of [await response.text(), await speechResponse.text(), await page.locator("body").innerText()]) {
      for (const canary of [account.email, privateTranscript, privatePatient, reportPath, secret, session.value,
        "foreign-location", "foreign-clinic", "foreign-tenant"]) assert.equal(body.includes(canary), false);
    }
    assert.deepEqual(await scanPatientDataCanaries(db, [
      { label: "admin_email", value: account.email }, { label: "link_secret", value: secret },
      { label: "session_secret", value: session.value }, { label: "transcript", value: privateTranscript },
      { label: "patient", value: privatePatient }, { label: "report", value: reportPath },
    ]), ok([]));
    await app.restart(); await page.reload();
    await expect(table.getByRole("row").last().getByRole("cell")).toHaveText(["0", "0", "0", "1", "0", "0", "0", "0", "1"]);
    await expect(speech).toContainText("Voice quality is blocked");
    app.setSpeech({ ...speechCandidate, checks: [] });
    assert.equal((await page.request.get(`${origin}/api/speech-gate`)).status(), 503);
    await sql`alter table clinic_operational_daily_counts rename to temporarily_unavailable_daily_counts`.execute(db);
    try {
      const unavailable = await page.request.get(`${origin}/api/operations/daily`);
      assert.equal(unavailable.status(), 503);
      assert.equal((await unavailable.text()).includes("temporarily_unavailable"), false);
      await page.reload();
      await expect(table).toContainText("Operational counts are unavailable.");
      await expect(table.getByRole("table")).toHaveCount(0);
      await expect(speech).toContainText("status is unavailable");
    } finally { await sql`alter table temporarily_unavailable_daily_counts rename to clinic_operational_daily_counts`.execute(db); }
    app.setSpeech(speechCandidate); await page.reload();
    await expect(table.getByRole("row")).toHaveCount(8);
    await expect(speech).toContainText("Voice quality is blocked");
  });
});

test("E2E-262 actual directory role changes and revocation remove clinic aggregate and speech access", async ({ page }) => {
  await withClinicOperations(async app => {
    const link = await requestBrowserMagicLink(page, app.origin, app.mail);
    await page.goto(link); await page.getByRole("button", { name: "Continue to Abby" }).click();
    await expect(page.getByRole("region", { name: "Operational counts", exact: true }).getByRole("table")).toBeVisible();
    const staff: AdminAccount = { ...app.account, actor: { ...app.account.actor, role: "staff" } };
    await app.replaceAccount(staff);
    for (const route of ["/api/capabilities", "/api/operations/daily", "/api/speech-gate"]) {
      assert.equal((await page.request.get(`${app.origin}${route}`, { headers: { "X-Actor-Role": "clinicAdmin" } })).status(), 403);
    }
    await page.reload(); await expect(page.getByRole("heading", { name: "Sign in to Abby" })).toBeVisible();
    const staffLink = await requestBrowserMagicLink(page, app.origin, app.mail);
    await page.goto(staffLink); await page.getByRole("button", { name: "Continue to Abby" }).click();
    await expect(page.getByRole("region", { name: "Operational counts", exact: true })).toContainText("unavailable");
    await expect(page.getByRole("region", { name: "Voice quality status", exact: true })).toContainText("unavailable");
    const capabilities = await page.request.get(`${app.origin}/api/capabilities`);
    assert.equal(capabilities.status(), 200);
    const catalogue = await capabilities.json() as { value: { id: string }[] };
    assert.equal(catalogue.value.some(item => item.id === "operations.daily.v1" || item.id.endsWith(".change.v1")), false);
    for (const route of ["/api/operations/daily", "/api/speech-gate"]) {
      assert.equal((await page.request.get(`${app.origin}${route}`, { headers: { "X-Actor-Role": "clinicAdmin" } })).status(), 403);
    }
    const edit = await page.request.post(`${app.origin}/api/settings/voice-locale`, { headers: { Origin: app.origin,
      "X-Actor-Role": "clinicAdmin" }, data: { expectedVersion: "0", locale: "en-AU" } });
    assert.equal(edit.status(), 403);
    await app.replaceAccount(); await page.reload();
    await expect(page.getByRole("heading", { name: "Sign in to Abby" })).toBeVisible();
    assert.equal((await page.request.get(`${app.origin}/api/settings`)).status(), 403);
  });
});
