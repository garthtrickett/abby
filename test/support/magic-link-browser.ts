import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { MagicLinkIdentity } from "../../src/standalone/identity/magic-link.ts";
import { MagicLinkFixture, syntheticAdminAccount } from "./magic-link-fixture.ts";
import { magicLinkDashboard } from "./magic-link-dashboard.ts";
import { withHttpsApplication } from "./https-dashboard.ts";

export async function withMagicLinkBrowser(run: (app: Readonly<{
  origin: string; fixture: MagicLinkFixture; policy: MemoryPolicyStore;
}>) => Promise<void>): Promise<void> {
  const fixture = new MagicLinkFixture(), account = syntheticAdminAccount(), policy = new MemoryPolicyStore();
  fixture.accounts.set(account.email, account);
  await withHttpsApplication(origin => magicLinkDashboard(new MagicLinkIdentity({ publicOrigin: origin,
    rateKeyHex: "4".repeat(64), store: fixture, directory: fixture.directory, delivery: fixture.delivery,
  }), policy, { dashboard: resolve("dist/dashboard/app.js"), signIn: resolve("dist/dashboard/sign-in.js") }),
  origin => run({ origin, fixture, policy }));
}

/** Requests through the UI and opens the actual synthetic delivery, without injecting an actor or session. */
export async function requestBrowserMagicLink(page: Page, origin: string,
  mail: readonly Readonly<{ email: string; link: string }>[], email = "owner@example.test"): Promise<string> {
  const count = mail.length;
  await page.goto(origin);
  await expect(page.getByRole("heading", { name: "Sign in to Abby" })).toBeVisible();
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toHaveText("If this account can sign in, check your email for a link.");
  await expect.poll(() => mail.length).toBe(count + 1);
  return mail.at(-1)!.link;
}
