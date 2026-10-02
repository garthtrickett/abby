import assert from "node:assert/strict";
import { expect, test } from "../support/browser-test.ts";
import { dashboard, committedCall } from "../support/notification-dashboard.ts";

test("E2E-257 call review distinguishes pending unknown and verified delivery without clinical or provider references", async ({ page, request }) => {
  const app = await dashboard();
  try {
    const call = await committedCall(app);
    await page.context().addCookies([{ name: "session", value: "notification-owner", url: app.url }]);
    await page.goto(app.url);
    const review = page.getByRole("region", { name: "Call review", exact: true });
    await review.getByRole("textbox", { name: "Call ID", exact: true }).fill(call.callId);
    await review.getByRole("button", { name: "Load call", exact: true }).click();
    const notifications = review.getByRole("list", { name: "Notification delivery", exact: true });
    await expect(notifications).toContainText("Booking confirmation · Host · Waiting to send");
    await expect(review.getByText("book: committed", { exact: true })).toBeVisible();
    const outcomes = page.getByRole("region", { name: "Call outcomes", exact: true });
    await outcomes.getByRole("button", { name: "Refresh outcomes", exact: true }).click();
    await expect(outcomes.getByLabel("Managed notification outcomes").first()).toContainText("1 pending");
    await expect(outcomes.getByLabel("Managed notification outcomes").first()).toContainText("0 sent");
    await call.send();
    assert.ok((await app.policy.changeNotificationOwner(app.scope, "1", "bookingConfirmation", "abby", "notification-owner")).ok);
    await review.getByRole("button", { name: "Load call", exact: true }).click();
    await expect(notifications).toContainText("Booking confirmation · Host · Delivery unconfirmed");
    await outcomes.getByRole("button", { name: "Refresh outcomes", exact: true }).click();
    await expect(outcomes.getByLabel("Managed notification outcomes").first()).toContainText("1 unconfirmed");
    await expect(notifications.getByText("Sent", { exact: true })).toHaveCount(0);
    await expect(review.getByText("book: committed", { exact: true })).toBeVisible();
    await call.resolve("sent");
    await review.getByRole("button", { name: "Load call", exact: true }).click();
    await expect(notifications).toContainText("Booking confirmation · Host · Sent");
    assert.equal(call.sends(), 1);
    await outcomes.getByRole("button", { name: "Refresh outcomes", exact: true }).click();
    await expect(outcomes.getByLabel("Managed notification outcomes").first()).toContainText("1 sent");
    await expect(outcomes.getByLabel("Managed notification outcomes").first()).toContainText("0 unconfirmed");
    const response = await request.get(`${app.url}/api/calls/${call.callId}`, { headers: app.headers });
    assert.equal(response.status(), 200);
    const body = await response.json();
    assert.deepEqual(body.value.call.notifications, [{ kind: "bookingConfirmation", owner: "host", status: "completed", outcome: "sent" }]);
    for (const privateField of ["PRIVATE_", "notificationKey", "deliveryRef", "hostRef", "hostVersion", "patientRef", "offerRef", "actionKey"]) {
      assert.equal(JSON.stringify(body).includes(privateField), false);
      await expect(review).not.toContainText(privateField);
    }
    assert.equal((await request.get(`${app.url}/api/calls/${call.callId}`, { headers: { ...app.headers, Cookie: "session=forged" } })).status(), 403);
    await page.context().addCookies([{ name: "session", value: "notification-staff", url: app.url }]);
    await page.reload();
    await review.getByRole("textbox", { name: "Call ID", exact: true }).fill(call.callId);
    await review.getByRole("button", { name: "Load call", exact: true }).click();
    await expect(notifications).toContainText("Booking confirmation · Host · Sent");
  } finally { await app.close(); }
});

test("E2E-257 missing suppression proof is visible for review while appointment truth remains committed", async ({ page }) => {
  const app = await dashboard();
  try {
    const call = await committedCall(app, false);
    await assert.rejects(call.send(), /invalidTransition/); assert.equal(call.sends(), 0);
    await page.context().addCookies([{ name: "session", value: "notification-owner", url: app.url }]);
    await page.goto(app.url);
    const review = page.getByRole("region", { name: "Call review", exact: true });
    await review.getByRole("textbox", { name: "Call ID", exact: true }).fill(call.callId);
    await review.getByRole("button", { name: "Load call", exact: true }).click();
    await expect(review.getByText("book: committed", { exact: true })).toBeVisible();
    await expect(review.getByRole("list", { name: "Notification delivery", exact: true })).toContainText(
      "Booking confirmation · Host · Needs review · Native send suppression unproven");
    const outcomes = page.getByRole("region", { name: "Call outcomes", exact: true });
    await outcomes.getByRole("button", { name: "Refresh outcomes", exact: true }).click();
    await expect(outcomes.getByLabel("Managed notification outcomes").first()).toContainText("1 need review");
    await expect(outcomes.getByLabel("Managed notification outcomes").first()).toContainText("0 sent");
  } finally { await app.close(); }
});

test("E2E-257 malformed delivery replies cannot invent sent status or expose private provider fields", async ({ page }) => {
  const app = await dashboard();
  try {
    const call = await committedCall(app);
    let malformed: "missingOutcome" | "privatePayload" = "missingOutcome";
    await page.route(`**/api/calls/${call.callId}`, async route => {
      const response = await route.fetch(); assert.equal(response.status(), 200);
      const body = await response.json();
      body.value.call.notifications = malformed === "missingOutcome"
        ? [{ kind: "bookingConfirmation", owner: "host", status: "completed" }]
        : [{ kind: "bookingConfirmation", owner: "host", status: "completed", outcome: "sent", recipient: "PRIVATE_RECIPIENT_CANARY" }];
      await route.fulfill({ response, json: body });
    });
    await page.context().addCookies([{ name: "session", value: "notification-owner", url: app.url }]);
    await page.goto(app.url);
    const review = page.getByRole("region", { name: "Call review", exact: true });
    await review.getByRole("textbox", { name: "Call ID", exact: true }).fill(call.callId);
    for (const variant of ["missingOutcome", "privatePayload"] as const) {
      malformed = variant; await review.getByRole("button", { name: "Load call", exact: true }).click();
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(review.getByRole("list", { name: "Notification delivery", exact: true })).toHaveCount(0);
      await expect(review).not.toContainText("PRIVATE_RECIPIENT_CANARY");
    }
    await page.route("**/api/call-outcomes", async route => {
      const response = await route.fetch(); assert.equal(response.status(), 200);
      const body = await response.json(); body.value.page.notificationDelivery.sent = 100;
      await route.fulfill({ response, json: body });
    });
    const outcomes = page.getByRole("region", { name: "Call outcomes", exact: true });
    await outcomes.getByRole("button", { name: "Refresh outcomes", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(outcomes.getByLabel("Managed notification outcomes")).toHaveCount(0);
    assert.equal(call.sends(), 0);
  } finally { await app.close(); }
});

test("E2E-257 paged outcome discovery includes notification review on a later page without changing appointment totals", async ({ page }) => {
  const app = await dashboard();
  try {
    const call = await committedCall(app, false);
    const seeded = await Promise.all(Array.from({ length: 100 }, (_, index) => app.reception.startCall(
      `empty-notification-${String(index).padStart(3, "0")}`, app.scope, call.now)));
    assert.ok(seeded.every(row => row.ok));
    await page.context().addCookies([{ name: "session", value: "notification-owner", url: app.url }]);
    await page.goto(app.url);
    const outcomes = page.getByRole("region", { name: "Call outcomes", exact: true });
    await expect(outcomes).toContainText("100 call(s) loaded");
    await expect(outcomes.getByLabel("Managed notification outcomes")).toHaveCount(0);
    await outcomes.getByRole("button", { name: "Load more outcomes", exact: true }).click();
    await expect(outcomes).toContainText("101 call(s) loaded · 1 completed action(s)");
    await expect(outcomes.getByLabel("Managed notification outcomes").first()).toContainText("1 need review");
    await expect(outcomes.getByLabel("Managed notification outcomes").first()).toContainText("0 sent");
    await expect(outcomes).toContainText(call.callId);
    await expect(outcomes.getByRole("button", { name: "Load more outcomes", exact: true })).toHaveCount(0);
    assert.equal(call.sends(), 0);
  } finally { await app.close(); }
});
