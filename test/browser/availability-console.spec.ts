import assert from "node:assert/strict";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { ok } from "../../src/core/model.ts";
import type { AvailabilityTextRequest } from "../../src/standalone/availability-text-runner.ts";
import { createAvailabilityConsoleServer } from "../../src/standalone/availability-console/server.ts";

test("E2E-125 text: lit-html console shows provisional, empty, and failed availability without saving the question", async ({ page, request }) => {
  const seen: AvailabilityTextRequest[] = [];
  const acknowledgments: string[] = [];
  const statuses = ["shown", "empty", "failed"] as const;
  const runner = {
    async prepare(input: AvailabilityTextRequest) {
      seen.push(input);
      const status = statuses[seen.length - 1] ?? "failed";
      return ok({ callId: `call-${seen.length}`, presentationId: `presentation-${seen.length}`, status,
        message: status === "shown" ? "Possible times are provisional. I can't reserve or confirm." :
          status === "empty" ? "No possible times found." : "Availability could not be checked." });
    },
    async confirmWritten(input: { callId: string; presentationId: string }) {
      acknowledgments.push(input.presentationId);
      return ok(true as const);
    },
  };
  const server = await createAvailabilityConsoleServer(runner, resolve("dist/availability-console/app.js"));
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await page.goto(base);
    assert.equal(response?.headers()["cache-control"], "no-store");
    await expect(page.getByRole("heading", { name: "Abby availability" })).toBeVisible();
    for (const [index, status] of statuses.entries()) {
      await page.getByRole("textbox", { name: "Question" }).fill(`caller-private-${index}`);
      await page.getByLabel("From").fill("2026-10-02");
      await page.getByLabel("To").fill("2026-10-02");
      await page.getByRole("button", { name: "Check availability" }).click();
      await expect(page.getByRole("status")).toContainText(status);
      await expect(page.getByRole("textbox", { name: "Question" })).toBeEmpty();
    }
    assert.deepEqual(seen.map(item => item.text), ["caller-private-0", "caller-private-1", "caller-private-2"]);
    assert.deepEqual(acknowledgments, ["presentation-1", "presentation-2", "presentation-3"]);
    assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
      { local: 0, session: 0 });
    await page.reload();
    await expect(page.getByRole("status")).toHaveCount(0);
    const invalid = await request.post(`${base}/api/availability`, {
      headers: { Origin: base }, data: { text: "x", from: "2026-10-02", to: "2026-10-02", requestOnly: true },
    });
    assert.equal(invalid.status(), 400);
    assert.equal(seen.length, 3);
    const foreign = await request.post(`${base}/api/availability`, {
      headers: { Origin: "https://elsewhere.example" }, data: { text: "x", from: "2026-10-02", to: "2026-10-02" },
    });
    assert.equal(foreign.status(), 403);
    assert.equal(seen.length, 3);
  } finally {
    await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
  }
});
