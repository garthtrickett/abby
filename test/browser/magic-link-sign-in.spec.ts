import assert from "node:assert/strict";
import { expect, test } from "../support/browser-test.ts";
import { requestBrowserMagicLink, withMagicLinkBrowser } from "../support/magic-link-browser.ts";
import { identityCookieNames } from "../../src/standalone/identity/magic-link-http.ts";
import { err } from "../../src/core/model.ts";

// Trust only this fixture's generated self-signed TLS certificate.
test.use({ ignoreHTTPSErrors: true });

test("E2E-260 HTTPS magic link requires confirmation and supplies the real setting actor through logout", async ({ page }) => {
  await withMagicLinkBrowser(async ({ origin, fixture, policy }) => {
    const link = await requestBrowserMagicLink(page, origin, fixture.mail);
    const seen: string[] = [];
    page.on("request", incoming => { seen.push(incoming.url()); });
    await page.goto(link);
    await expect(page.getByRole("button", { name: "Continue to Abby" })).toBeVisible();
    await expect(page.getByText("owner@example.test", { exact: true })).toBeVisible();
    assert.equal(new URL(page.url()).hash, "");
    assert.equal(fixture.sessions.size, 0); assert.equal(fixture.challenges.size, 1);
    assert.equal(seen.some(url => url.includes(new URL(link).hash.slice(1))), false);
    assert.equal((await page.context().cookies()).some(cookie => cookie.name === identityCookieNames(origin).session), false);
    await page.getByRole("button", { name: "Continue to Abby" }).click();
    const booking = page.getByRole("region", { name: "Booking automation", exact: true });
    await expect(booking.getByText("Disabled", { exact: true })).toBeVisible();
    const session = (await page.context().cookies()).find(cookie => cookie.name === identityCookieNames(origin).session)!;
    assert.equal(session.secure, true); assert.equal(session.httpOnly, true); assert.equal(session.sameSite, "Lax");
    assert.equal(session.path, "/"); assert.equal(fixture.sessions.size, 1);
    assert.deepEqual(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })), { local: [], session: [] });
    await booking.getByRole("button", { name: "Enable booking", exact: true }).click();
    await expect(booking.getByText("Enabled", { exact: true })).toBeVisible();
    await page.reload(); await expect(booking.getByText("Enabled", { exact: true })).toBeVisible();
    const history = await policy.listBookingChanges({ tenantId: "identity-tenant", clinicId: "clinic", locationId: "location" });
    assert.ok(history.ok); assert.equal(history.value.entries[0]!.actorRef, "user-owner");
    const text = await page.locator("body").innerText();
    for (const value of ["owner@example.test", new URL(link).hash.slice(1), session.value]) assert.equal(text.includes(value), false);
    await page.getByRole("link", { name: "Sign out", exact: true }).click();
    assert.equal(fixture.sessions.size, 1, "GET logout confirmation must not revoke");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Email", exact: true })).toBeVisible();
    assert.equal(fixture.sessions.size, 0);
    assert.equal((await page.request.get(`${origin}/api/settings`)).status(), 403);
    await page.goto(link);
    await expect(page.getByRole("alert")).toContainText("unavailable or expired");
    await expect(page.getByRole("button", { name: "Continue to Abby" })).toHaveCount(0);
  });
});

test("E2E-260 new-browser links preserve staff restrictions and revoked membership removes access", async ({ page, browser }) => {
  await withMagicLinkBrowser(async ({ origin, fixture }) => {
    const account = fixture.accounts.get("owner@example.test")!;
    fixture.accounts.set(account.email, { ...account, actor: { ...account.actor, role: "staff" } });
    const link = await requestBrowserMagicLink(page, origin, fixture.mail);
    const other = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const reader = await other.newPage(); await reader.goto(link);
      await expect(reader.getByRole("button", { name: "Continue to Abby" })).toBeVisible();
      await reader.getByRole("button", { name: "Continue to Abby" }).click();
      const booking = reader.getByRole("region", { name: "Booking automation", exact: true });
      await expect(booking.getByText("View only", { exact: true })).toBeVisible();
      await expect(booking.getByRole("button")).toHaveCount(0);
      assert.equal((await reader.request.post(`${origin}/api/settings/booking-enabled`, { headers: {
        Origin: origin, "X-Actor-Role": "clinicAdmin" }, data: { expectedVersion: "0", enabled: true } })).status(), 403);
      fixture.accounts.clear(); await reader.reload();
      await expect(reader.getByRole("textbox", { name: "Email", exact: true })).toBeVisible();
      assert.equal((await reader.request.get(`${origin}/api/settings`)).status(), 403);
      assert.equal((await page.request.get(`${origin}/api/settings`)).status(), 403, "requesting browser was never signed in");
    } finally { await other.close(); }
  });
});

test("E2E-260 lost committed redemption never retries or claims a usable browser session", async ({ page }) => {
  await withMagicLinkBrowser(async ({ origin, fixture }) => {
    const link = await requestBrowserMagicLink(page, origin, fixture.mail);
    await page.goto(link); await expect(page.getByRole("button", { name: "Continue to Abby" })).toBeVisible();
    let writes = 0;
    await page.route("**/sign-in/redeem", async route => {
      writes++; const committed = await route.fetch(); assert.equal(committed.status(), 200); await route.abort();
    });
    await page.getByRole("button", { name: "Continue to Abby" }).click();
    await expect(page.getByRole("alert")).toContainText("could not sign you in");
    await expect(page.getByRole("button", { name: "Continue to Abby" })).toHaveCount(0);
    assert.equal(writes, 1); assert.equal(fixture.mail.length, 1); assert.equal(fixture.challenges.size, 0); assert.equal(fixture.sessions.size, 1);
    assert.equal(new URL(page.url()).hash, "");
    await page.unrouteAll({ behavior: "wait" }); await page.goto(link);
    await expect(page.getByRole("alert")).toContainText("unavailable or expired");
    assert.equal(writes, 1); assert.equal(fixture.sessions.size, 1);
  });
});

test("E2E-260 unknown accounts and uncertain requests have no automatic resend; failed logout is truthful", async ({ page }) => {
  await withMagicLinkBrowser(async ({ origin, fixture }) => {
    await page.goto(origin);
    await page.getByRole("textbox", { name: "Email", exact: true }).fill("unknown@example.test");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page.getByRole("status")).toHaveText("If this account can sign in, check your email for a link.");
    assert.equal(fixture.mail.length, 0);
    let sends = 0;
    await page.route("**/sign-in/request", async route => { sends++; await route.fetch(); await route.abort(); });
    await page.getByRole("textbox", { name: "Email", exact: true }).fill("owner@example.test");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page.getByRole("alert")).toContainText("Check your email before trying again");
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect.poll(() => fixture.mail.length).toBe(1); assert.equal(sends, 1);
    await page.unrouteAll({ behavior: "wait" }); await page.goto(fixture.mail[0]!.link);
    await page.getByRole("button", { name: "Continue to Abby" }).click();
    await page.getByRole("link", { name: "Sign out", exact: true }).click();
    fixture.revokeSession = async () => err({ kind: "identityUnavailable" });
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Sign-out could not be confirmed");
    assert.equal((await page.request.get(`${origin}/api/settings`)).status(), 200);
    assert.equal(fixture.sessions.size, 1);
  });
});
