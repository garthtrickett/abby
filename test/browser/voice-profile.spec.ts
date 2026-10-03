import assert from "node:assert/strict";
import { expect, test } from "../support/browser-test.ts";
import { voiceDashboard } from "../support/voice-dashboard.ts";
import { value } from "../support/voice-settings-contract.ts";

for (const surface of ["full", "availabilitySetup"] as const) {
  test(`E2E-258 E2E-259 ${surface} authenticated locale and voice set change clear share clinic CAS and preserve captured calls`, async ({ page }) => {
    const app = await voiceDashboard(surface);
    try {
      await page.context().addCookies([{ name: "session", value: "voice-owner", url: app.url }]);
      await page.goto(app.url);
      const panel = page.getByRole("region", { name: "Locale and voice" });
      const locale = panel.getByRole("group", { name: "Clinic locale", exact: true });
      const voice = panel.getByRole("group", { name: "Reception voice", exact: true });
      await expect(panel.getByText("Saved: Not set", { exact: true })).toHaveCount(2);
      await expect(panel.getByText("Approved speech profile: Unavailable", { exact: true })).toBeVisible();
      await locale.getByRole("combobox").selectOption("en-AU");
      await locale.getByRole("button", { name: "Save locale", exact: true }).click();
      await expect(locale.getByText("Saved: en-AU", { exact: true })).toBeVisible();
      await expect(panel.getByText("Approved speech profile: Unavailable", { exact: true })).toBeVisible();
      await voice.getByRole("combobox").selectOption("coral");
      await voice.getByRole("button", { name: "Save voice", exact: true }).click();
      await expect(panel.getByText("Approved speech profile: Ready", { exact: true })).toBeVisible();
      const old = value(await app.reception.startCall(`voice-old-${surface}`, app.scope, "2026-10-03T00:00:00.000Z"));
      assert.equal(old.policy.voiceProfile?.voiceId, "coral");
      // Another location edits the same clinic setting without consuming the location policy version.
      assert.ok((await app.policy.changeVoiceSetting({ ...app.scope, locationId: "second" }, "2", "locale", "en-US", "second-owner")).ok);
      await voice.getByRole("combobox").selectOption("cedar");
      await voice.getByRole("button", { name: "Save voice", exact: true }).click();
      await expect(panel.getByRole("alert")).toBeVisible();
      await expect(locale.getByText("Saved: en-US", { exact: true })).toBeVisible();
      await expect(voice.getByText("Saved: coral", { exact: true })).toBeVisible();
      // en-US + cedar was never advertised, even though each value exists separately.
      await expect(voice.getByRole("combobox").locator('option[value="cedar"]')).toHaveCount(0);
      await locale.getByRole("combobox").selectOption("en-AU");
      await locale.getByRole("button", { name: "Save locale", exact: true }).click();
      await expect(locale.getByText("Saved: en-AU", { exact: true })).toBeVisible();
      await voice.getByRole("combobox").selectOption("cedar");
      await voice.getByRole("button", { name: "Save voice", exact: true }).click();
      await expect(voice.getByText("Saved: cedar", { exact: true })).toBeVisible();
      const future = value(await app.reception.startCall(`voice-future-${surface}`, app.scope, "2026-10-03T00:00:00.000Z"));
      assert.equal(future.policy.voiceProfile?.voiceId, "cedar");
      assert.notEqual(future.policy.voiceProfile?.configurationHash, old.policy.voiceProfile?.configurationHash);
      assert.equal(old.policy.voiceProfile?.locale, "en-AU"); assert.equal(old.policy.voiceProfile?.voiceId, "coral");
      await locale.getByRole("button", { name: "Clear locale", exact: true }).click();
      await expect(locale.getByText("Saved: Not set", { exact: true })).toBeVisible();
      await expect(panel.getByText("Approved speech profile: Unavailable", { exact: true })).toBeVisible();
      await voice.getByRole("button", { name: "Clear voice", exact: true }).click();
      await expect(voice.getByText("Saved: Not set", { exact: true })).toBeVisible();
      const state = value(await app.policy.read(app.scope));
      assert.equal(state.voiceProfile, undefined); assert.equal(state.policyVersion, "0"); assert.equal(state.automationEnabled, false);
      assert.equal(state.capabilities.book, "unavailable");
      assert.equal(value(await app.ledger.read(old.callId, app.scope)).policy.voiceProfile?.voiceId, "coral");
      const audit = value(await app.policy.listVoiceChanges(app.scope));
      assert.deepEqual(audit.entries.map(row => row.version), ["1", "2", "3", "4", "5", "6", "7"]);
      assert.equal(audit.entries.filter(row => row.actorRef === "voice-owner").length, 6);
    } finally { await app.close(); }
  });
}

for (const kind of ["locale", "voiceId"] as const) {
  for (const failure of ["lost", "malformed"] as const) {
    test(`E2E-${kind === "locale" ? "258" : "259"} ${failure} ${kind} save rereads scoped clinic state once and withdrawn speech can be cleared`, async ({ page }) => {
      const app = await voiceDashboard();
      try {
        if (kind === "voiceId") assert.ok((await app.policy.changeVoiceSetting(app.scope, "0", "locale", "en-AU", "owner")).ok);
        const path = kind === "locale" ? "voice-locale" : "voice-id";
        let writes = 0;
        await page.route(`**/api/settings/${path}`, async route => {
          writes++;
          const upstream = await route.fetch(); assert.equal(upstream.status(), 200);
          if (writes > 1) return route.fulfill({ response: upstream });
          if (failure === "lost") return route.abort("failed");
          const body = await upstream.json();
          body.value.policy.voiceProfile = { scope: { tenantId: "foreign", clinicId: "clinic" }, settingsVersion: "999" };
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
        });
        await page.context().addCookies([{ name: "session", value: "voice-owner", url: app.url }]);
        await page.goto(app.url);
        const panel = page.getByRole("region", { name: "Locale and voice" });
        const group = panel.getByRole("group", { name: kind === "locale" ? "Clinic locale" : "Reception voice", exact: true });
        const selected = kind === "locale" ? "en-AU" : "coral", label = kind === "locale" ? "locale" : "voice";
        await group.getByRole("combobox").selectOption(selected);
        await group.getByRole("button", { name: `Save ${label}`, exact: true }).click();
        await expect(group.getByText(`Saved: ${selected}`, { exact: true })).toBeVisible();
        await expect(panel.getByRole("alert")).toBeVisible(); assert.equal(writes, 1);
        app.setReady(false);
        await panel.getByRole("button", { name: "Refresh voice settings", exact: true }).click();
        await expect(group.getByRole("combobox")).toBeDisabled();
        await expect(group.getByText(`Saved: ${selected}`, { exact: true })).toBeVisible();
        await group.getByRole("button", { name: `Clear ${label}`, exact: true }).click();
        await expect(group.getByText("Saved: Not set", { exact: true })).toBeVisible();
        assert.equal(writes, 2);
        assert.equal(value(await app.policy.listVoiceChanges(app.scope)).entries.length, kind === "locale" ? 2 : 3);
      } finally { await app.close(); }
    });
  }
}

test("E2E-258 E2E-259 lost save and failed reread lock edits until a current scoped page reload", async ({ page }) => {
  const app = await voiceDashboard();
  try {
    let blockReads = false, writes = 0;
    await page.route("**/api/settings", route => blockReads ? route.abort("failed") : route.continue());
    await page.route("**/api/settings/voice-locale", async route => {
      writes++; const response = await route.fetch(); assert.equal(response.status(), 200);
      blockReads = true; await route.abort("failed");
    });
    await page.context().addCookies([{ name: "session", value: "voice-owner", url: app.url }]); await page.goto(app.url);
    const panel = page.getByRole("region", { name: "Locale and voice" });
    await panel.getByRole("combobox", { name: "Clinic locale", exact: true }).selectOption("en-AU");
    await panel.getByRole("button", { name: "Save locale", exact: true }).click();
    await expect(panel.getByRole("alert")).toHaveText("Voice settings could not be confirmed. Reload before editing settings.");
    for (const button of await panel.getByRole("button").all()) await expect(button).toBeDisabled();
    assert.equal(writes, 1);
    blockReads = false; await page.reload();
    await expect(panel.getByText("Saved: en-AU", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Clear locale", exact: true })).toBeEnabled();
    assert.equal(value(await app.policy.listVoiceChanges(app.scope)).entries.length, 1);
  } finally { await app.close(); }
});

test("E2E-258 E2E-259 unavailable catalogue and staff cannot edit; public audit pages have shared ordering", async ({ page, request }) => {
  const app = await voiceDashboard("full", false);
  try {
    await page.context().addCookies([{ name: "session", value: "voice-owner", url: app.url }]); await page.goto(app.url);
    const panel = page.getByRole("region", { name: "Locale and voice" });
    for (const picker of await panel.getByRole("combobox").all()) await expect(picker).toBeDisabled();
    assert.equal((await request.post(`${app.url}/api/settings/voice-locale`, { headers: app.headers,
      data: { expectedVersion: "0", locale: "en-AU" } })).status(), 400);
    app.setReady(true);
    for (let i = 0; i < 55; i++) assert.ok((await app.policy.changeVoiceSetting(app.scope, String(i), "locale", i % 2 ? "en-US" : "en-AU", "owner")).ok);
    await panel.getByRole("button", { name: "Refresh voice settings", exact: true }).click();
    await expect(panel.getByRole("listitem")).toHaveCount(50);
    await panel.getByRole("button", { name: "Load more voice history", exact: true }).click();
    await expect(panel.getByRole("listitem")).toHaveCount(55);
    await expect(panel.getByRole("button", { name: "Load more voice history", exact: true })).toHaveCount(0);
    await page.context().addCookies([{ name: "session", value: "voice-staff", url: app.url }]); await page.reload();
    await expect(panel.getByText("View only", { exact: true })).toHaveCount(2);
    await expect(panel.getByRole("combobox")).toHaveCount(0);
    assert.equal((await request.post(`${app.url}/api/settings/voice-id`, { headers: { ...app.headers, Cookie: "session=voice-staff" },
      data: { expectedVersion: "55", voiceId: "coral" } })).status(), 403);
    const first = value(await app.policy.listVoiceChanges(app.scope));
    const last = value(await app.policy.listVoiceChanges(app.scope, first.nextAfterVersion));
    assert.deepEqual([...first.entries, ...last.entries].map(row => Number(row.version)), Array.from({ length: 55 }, (_, i) => i + 1));
  } finally { await app.close(); }
});
