import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { expect, test } from "../support/browser-test.ts";
import { vocabularyDashboard } from "../support/vocabulary-dashboard.ts";

const manualLabel = "Additional published terms, one per line";
const confirmation = "These additional terms are already publicly published by the clinic";
const saveLabel = "Approve clinic terms";
const reloadLabel = "Discard edits and reload current terms";

for (const surface of ["full", "availabilitySetup"] as const) {
test(`${surface} clinic owner reviews published vocabulary and manual deletions persist after a browser reload`, async ({ page }) => {
  const f = await vocabularyDashboard(true, surface);
  try {
    await page.context().addCookies([{ name: "session", value: "owner", url: f.url }]);
    await page.goto(f.url);
    const panel = page.getByRole("region", { name: "Clinic terms", exact: true });
    await expect(panel.getByRole("checkbox", { name: "Physiotherapy", exact: true })).toBeChecked();
    await expect(panel.getByText("Unpublished Person")).toHaveCount(0);
    await panel.getByRole("checkbox", { name: "Physiotherapy", exact: true }).uncheck();
    await panel.getByRole("textbox", { name: manualLabel }).fill("Published clinic alias");
    await expect(panel.getByRole("button", { name: saveLabel })).toBeDisabled();
    await panel.getByRole("checkbox", { name: confirmation }).check();
    await panel.getByRole("button", { name: saveLabel }).click();
    await expect(panel.getByRole("status")).toContainText("Clinic terms saved");
    await page.reload();
    await expect(panel.getByRole("textbox", { name: manualLabel })).toHaveValue("Published clinic alias");
    await expect(panel.getByRole("checkbox", { name: "Physiotherapy", exact: true })).toHaveCount(0);
    const persisted = JSON.parse(await readFile(f.path, "utf8"));
    assert.deepEqual(persisted.vocabulary.manualTerms, ["Published clinic alias"]);
    assert.deepEqual(persisted.vocabulary.removedTerms, ["Physiotherapy"]);
  } finally { await f.close(); }
});
}

test("a lost vocabulary-save response requires current-state reload and never automatically replays the write", async ({ page }) => {
  const f = await vocabularyDashboard(true); let writes = 0;
  try {
    await page.route("**/api/clinic-vocabulary", async route => {
      if (route.request().method() !== "POST") return route.continue();
      writes++; const result = await route.fetch(); assert.equal(result.status(), 200); await route.abort("failed");
    });
    await page.context().addCookies([{ name: "session", value: "owner", url: f.url }]);
    await page.goto(f.url);
    const panel = page.getByRole("region", { name: "Clinic terms", exact: true });
    await panel.getByRole("textbox", { name: manualLabel }).fill("Public lost-response alias");
    await panel.getByRole("checkbox", { name: confirmation }).check();
    await panel.getByRole("button", { name: saveLabel }).click();
    await expect(panel.getByRole("alert")).toContainText("could not verify whether your changes were saved");
    await expect(panel.getByRole("button", { name: saveLabel })).toBeDisabled();
    assert.equal(writes, 1);
    await panel.getByRole("button", { name: reloadLabel }).click();
    await expect(panel.getByRole("textbox", { name: manualLabel })).toHaveValue("Public lost-response alias");
    assert.equal(writes, 1);
    assert.equal(JSON.parse(await readFile(f.path, "utf8")).vocabulary.version, "2");
  } finally { await f.close(); }
});

test("a stale owner browser cannot overwrite a newer public vocabulary review", async ({ page, context }) => {
  const f = await vocabularyDashboard(true), second = await context.newPage();
  try {
    await context.addCookies([{ name: "session", value: "owner", url: f.url }]);
    await Promise.all([page.goto(f.url), second.goto(f.url)]);
    const firstPanel = page.getByRole("region", { name: "Clinic terms", exact: true });
    const stalePanel = second.getByRole("region", { name: "Clinic terms", exact: true });
    await expect(stalePanel.getByRole("checkbox", { name: "Physiotherapy", exact: true })).toBeChecked();
    await firstPanel.getByRole("textbox", { name: manualLabel }).fill("Current public alias");
    await firstPanel.getByRole("checkbox", { name: confirmation }).check();
    await firstPanel.getByRole("button", { name: saveLabel }).click();
    await expect(firstPanel.getByRole("status")).toContainText("Clinic terms saved");
    await stalePanel.getByRole("textbox", { name: manualLabel }).fill("Stale public alias");
    await stalePanel.getByRole("checkbox", { name: confirmation }).check();
    await stalePanel.getByRole("button", { name: saveLabel }).click();
    await expect(stalePanel.getByRole("alert")).toContainText("changed elsewhere");
    assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")).vocabulary.manualTerms, ["Current public alias"]);
    await stalePanel.getByRole("button", { name: reloadLabel }).click();
    await expect(stalePanel.getByRole("textbox", { name: manualLabel })).toHaveValue("Current public alias");
  } finally { await second.close(); await f.close(); }
});
