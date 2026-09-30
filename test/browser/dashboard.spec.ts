import assert from "node:assert/strict";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { EffectWorker } from "../../src/core/effect-worker.ts";
import { EffectRecovery } from "../../src/core/effect-recovery.ts";
import type { LocationScope } from "../../src/core/model.ts";
import { err, ok } from "../../src/core/model.ts";
import type { AutomationReadiness } from "../../src/core/readiness.ts";
import type { AvailabilityHost } from "../../src/core/host.ts";
import { CallReview } from "../../src/reference/call-review.ts";
import { CallOutcomeReport } from "../../src/reference/call-outcome-report.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { StaffQueue } from "../../src/reference/staff-queue.ts";
import { StaffAlertMonitor } from "../../src/reference/staff-alert-monitor.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { MemoryKnowledgeCatalogue } from "../../src/reference/knowledge-catalogue.ts";
import { createDashboardServer } from "../../src/standalone/dashboard/server.ts";
import { CallAdmissionService } from "../../src/voice/admission.ts";

async function localDashboard(role: "clinicAdmin" | "staff", availability?: AvailabilityHost, readiness?: AutomationReadiness) {
  const scope: LocationScope = { tenantId: "browser-tenant", clinicId: "browser-clinic", locationId: "browser-location" };
  const ledger = new MemoryLedger(readiness);
  const policy = new MemoryPolicyStore("execute", undefined, readiness);
  const host = new ReferenceClinicHost([], [],
    [{ scope, sourceRef: "hours", version: "hours-v1", ownerRef: "clinic-owner", approvedText: "We open at 9 am.", approved: true,
      effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: "2026-10-01T00:00:00.000Z" }]);
  const knowledge = new MemoryKnowledgeCatalogue([{ scope, sourceRef: "hours", version: "hours-v1", ownerRef: "clinic-owner",
    approvedText: "We open at 9 am.", approved: true, effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: "2026-10-01T00:00:00.000Z" }]);
  const reception = new TextReception(ledger, policy, host, availability, undefined, undefined, knowledge);
  const started = await reception.startCall("before-setting", scope, "2026-09-28T10:00:00.000Z");
  assert.equal(started.ok, true);
  const gateway = new CommandGateway({ actorRef: `browser-${role}`, role, scope }, policy, reception,
    new CallReview(ledger), new StaffQueue(ledger, () => "2026-09-30T12:00:00.000Z"), new CallOutcomeReport(ledger), ledger, knowledge);
  const server = await createDashboardServer(gateway, resolve("dist/dashboard/app.js"));
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    scope, ledger, policy, reception, host, knowledge,
    close: () => new Promise<void>((done, reject) => {
      server.close(error => error ? reject(error) : done());
      server.closeAllConnections();
    }),
  };
}

test("SET-001: browser reception switch needs readiness and gates the next call", async ({ page, request }) => {
  let ready = false;
  const readiness: AutomationReadiness = async () => ready ? ok(true) : err({ kind: "readinessFailed", missing: ["mediaTestCall"] });
  const app = await localDashboard("clinicAdmin", undefined, readiness);
  try {
    await page.goto(app.url);
    await expect(page.getByRole("heading", { name: "Reception automation" })).toBeVisible();
    await expect(page.getByText("Automation version 0")).toBeVisible();
    await page.getByRole("button", { name: "Enable reception" }).click();
    await expect(page.getByRole("alert")).toContainText("passed media test call");
    assert.equal((await app.policy.read(app.scope)).ok, true);
    ready = true;
    await page.getByRole("button", { name: "Enable reception" }).click();
    await expect(page.getByText("Reception automation enabled for new calls.")).toBeVisible();
    await expect(page.getByText("Automation version 1")).toBeVisible();
    const admission = new CallAdmissionService(app.ledger, async () => {
      const result = await app.policy.read(app.scope);
      return result.ok ? ok(result.value) : err({ kind: "routeUnavailable" as const });
    }, () => "2026-09-28T10:00:00.000Z", readiness);
    const event = { key: { accountRef: "browser-account", providerCallRef: "browser-automation" },
      dialedNumber: "+6125550100", receivedAt: "2026-09-28T10:00:00.000Z" };
    const created = await admission.begin(event);
    assert.equal(created.ok, true);
    await page.getByRole("button", { name: "Disable reception" }).click();
    await expect(page.getByText("Reception automation disabled for new calls.")).toBeVisible();
    await expect(page.getByText("Automation version 2")).toBeVisible();
    const next = await admission.begin({ ...event, key: { ...event.key, providerCallRef: "next-call" } });
    assert.equal(next.ok, false);
    if (!next.ok) assert.equal(next.error.kind, "automationDisabled");
    const replay = await admission.begin(event);
    assert.equal(replay.ok, true);
    if (replay.ok) assert.equal(replay.value.kind, "duplicate");
    const audit = page.getByLabel("Automation setting audit");
    await expect(audit).toContainText("Version 1 · enabled · browser-clinicAdmin");
    await expect(audit).toContainText("Version 2 · disabled · browser-clinicAdmin");
    await page.reload();
    await expect(page.getByRole("button", { name: "Enable reception" })).toBeVisible();
    await expect(page.getByLabel("Automation setting audit")).toContainText("Version 2 · disabled");
    const invalid = await request.post(`${app.url}/api/settings/automation-enabled`, { data: { expectedVersion: "2", enabled: "yes" } });
    assert.equal(invalid.status(), 400);
  } finally { await app.close(); }
});

test("E2E-074 emergency stop in the browser blocks a queued active-call write and survives reload", async ({ page, request }) => {
  let ready = false;
  const readiness: AutomationReadiness = async () => ready ? ok(true) : err({ kind: "readinessFailed", missing: ["mediaTestCall"] });
  const app = await localDashboard("clinicAdmin", undefined, readiness);
  try {
    const enabled = await app.policy.changeBookingEnabled(app.scope, "0", true, "browser-clinicAdmin");
    assert.ok(enabled.ok);
    const callId = "browser-emergency-write";
    const runtime = new CallRuntime(app.ledger, app.scope);
    assert.equal((await runtime.start(callId, enabled.value)).ok, true);
    const at = "2026-09-28T10:00:00.000Z";
    const requestAction = { kind: "book" as const,
      patient: { scope: app.scope, patientRef: "synthetic-patient", verificationRef: "synthetic-proof", expiresAt: "2026-09-29T10:00:00.000Z" },
      offer: { scope: app.scope, offerRef: "synthetic-offer", serviceRef: "physio", startsAt: "2026-09-29T11:00:00.000Z", expiresAt: "2026-09-29T10:00:00.000Z" } };
    const proposed = await runtime.acceptTurn({ callId, turnId: "request", text: "Book", quality: "clear", at },
      { kind: "requestAction", request: requestAction }, at);
    assert.ok(proposed.ok);
    const action = Object.values(proposed.value.actions)[0];
    assert.ok(action);
    assert.equal((await runtime.startPresentation(callId, action.presentationId)).ok, true);
    assert.equal((await runtime.resolvePresentation(callId, action.presentationId, "played")).ok, true);
    assert.equal((await runtime.acceptTurn({ callId, turnId: "confirm", text: "Yes", quality: "clear", at },
      { kind: "affirm", actionKey: action.key, digest: action.digest, affirmative: true }, at)).ok, true);

    await page.goto(app.url);
    await expect(page.getByRole("heading", { name: "Emergency write stop" })).toBeVisible();
    await page.getByRole("textbox", { name: "Reason for emergency stop" }).fill("Clinic incident");
    await page.getByRole("button", { name: "Stop appointment writes" }).click();
    await expect(page.getByLabel("Emergency stop status")).toContainText("Clinic incident");
    await new EffectWorker(runtime, app.host).process(callId, `${action.key}:write`, at);
    const blocked = await runtime.read(callId);
    assert.ok(blocked.ok);
    assert.equal(blocked.value.actions[action.key]?.status, "unsupported");
    assert.equal(Object.values(blocked.value.staffItems)[0]?.reason, "emergencyStopped");
    assert.equal(app.host.bookings(app.scope).length, 0);
    await page.reload();
    await expect(page.getByLabel("Emergency stop status")).toContainText("Clinic incident");
    await page.getByRole("textbox", { name: "Reason for resuming appointment writes" }).fill("Provider recovered");
    await page.getByRole("button", { name: "Resume appointment writes" }).click();
    await expect(page.getByRole("alert")).toContainText("passed media test call");
    ready = true;
    await page.getByRole("button", { name: "Resume appointment writes" }).click();
    await expect(page.getByText("Writes resumed by browser-clinicAdmin")).toBeVisible();
    await expect(page.getByLabel("Write stop audit")).toContainText("Version 2 · resumed · browser-clinicAdmin · Provider recovered");
    const stale = await request.post(`${app.url}/api/writes/resume`, { data: { expectedVersion: "1", reason: "Stale tab" } });
    assert.equal(stale.status(), 409);
    await page.getByRole("textbox", { name: "Reason for emergency stop" }).fill("Second incident");
    await page.getByRole("button", { name: "Stop appointment writes" }).click();
    await expect(page.getByLabel("Emergency stop status")).toContainText("Second incident");
    await expect(page.getByLabel("Write stop audit")).toContainText("Version 3 · stopped · browser-clinicAdmin · Second incident");
    assert.equal((await request.post(`${app.url}/api/writes/stop`, { data: { reason: "" } })).status(), 400);
  } finally { await app.close(); }
});

test("E2E-010: dashboard toggle persists default, enabled and disabled policy for new calls", async ({ page, request }) => {
  const app = await localDashboard("clinicAdmin");
  try {
    await page.goto(app.url);
    await expect(page.getByRole("heading", { name: "Booking automation" })).toBeVisible();
    await expect(page.getByText("Policy version 0")).toBeVisible();
    await expect(page.getByRole("button", { name: "Enable booking" })).toBeVisible();
    await page.getByRole("button", { name: "Enable booking" }).click();
    await expect(page.getByText("Booking enabled for new calls.")).toBeVisible();
    await expect(page.getByText("Policy version 1")).toBeVisible();
    assert.equal((await app.reception.startCall("enabled-setting", app.scope)).ok, true);
    await page.getByRole("button", { name: "Disable booking" }).click();
    await expect(page.getByText("Booking disabled for new calls.")).toBeVisible();
    await expect(page.getByText("Policy version 2")).toBeVisible();
    const audit = page.getByLabel("Booking setting audit");
    await expect(audit).toContainText("Version 1 · enabled · browser-clinicAdmin");
    await expect(audit).toContainText("Version 2 · disabled · browser-clinicAdmin");
    assert.equal((await app.reception.startCall("disabled-setting", app.scope)).ok, true);
    await page.reload();
    await expect(page.getByRole("button", { name: "Enable booking" })).toBeVisible();
    await expect(page.getByLabel("Booking setting audit")).toContainText("Version 2 · disabled · browser-clinicAdmin");
    assert.equal((await request.post(`${app.url}/api/settings/booking-enabled`,
      { data: { expectedVersion: "2", enabled: "yes" } })).status(), 400);
    const before = await app.ledger.read("before-setting", app.scope);
    const enabled = await app.ledger.read("enabled-setting", app.scope);
    const disabled = await app.ledger.read("disabled-setting", app.scope);
    assert.ok(before.ok && enabled.ok && disabled.ok);
    assert.deepEqual([before.value.policy.capabilities.book, enabled.value.policy.capabilities.book, disabled.value.policy.capabilities.book], ["unavailable", "execute", "unavailable"]);
    const other = await app.policy.read({ ...app.scope, tenantId: "another-tenant" });
    assert.ok(other.ok);
    assert.equal(other.value.bookingEnabled, false);
    await page.getByRole("textbox", { name: "Call ID" }).fill("enabled-setting");
    await page.getByRole("button", { name: "Load call" }).click();
    await expect(page.getByLabel("Call summary")).toContainText("enabled-setting · active");
  } finally {
    await app.close();
  }
});

test("agent capability endpoint publishes versioned schemas without exposing internal call state", async ({ request }) => {
  const app = await localDashboard("clinicAdmin");
  try {
    const response = await request.get(`${app.url}/api/capabilities`);
    assert.equal(response.status(), 200);
    const payload = await response.json() as { value: Array<{ id: string; inputSchema: { $schema: string }; resultSchema: { $schema: string } }> };
    const booking = payload.value.find(item => item.id === "booking.propose.v2");
    assert.equal(booking, undefined);
    const setting = payload.value.find(item => item.id === "settings.appointments.booking.enabled.change.v1");
    assert.equal(setting?.inputSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(setting?.resultSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(JSON.stringify(payload).includes("browser-tenant"), false);
  } finally { await app.close(); }
});

test("E2E-010 E2E-069: view-only staff can review a call but cannot change booking settings", async ({ page, request }) => {
  const app = await localDashboard("staff");
  try {
    await page.goto(app.url);
    await expect(page.getByText("View only")).toBeVisible();
    await expect(page.getByRole("button", { name: "Enable booking" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Enable reception" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Emergency write stop" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Booking setting history" })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Call ID" }).fill("before-setting");
    await page.getByRole("button", { name: "Load call" }).click();
    await expect(page.getByLabel("Call summary")).toContainText("before-setting · active");
    const forbidden = await request.post(`${app.url}/api/settings/booking-enabled`, { data: { expectedVersion: "0", enabled: true } });
    assert.equal(forbidden.status(), 403);
    const automationForbidden = await request.post(`${app.url}/api/settings/automation-enabled`, { data: { expectedVersion: "0", enabled: true } });
    assert.equal(automationForbidden.status(), 403);
    assert.equal((await request.post(`${app.url}/api/writes/stop`, { data: { reason: "Forged staff stop" } })).status(), 403);
    assert.equal((await request.get(`${app.url}/api/writes/stop`)).status(), 403);
    assert.equal((await request.post(`${app.url}/api/writes/resume`, { data: { expectedVersion: "1", reason: "Forged staff resume" } })).status(), 403);
    assert.equal((await request.get(`${app.url}/api/writes/stop-audit`)).status(), 403);
    const auditForbidden = await request.get(`${app.url}/api/settings/booking-audit`);
    assert.equal(auditForbidden.status(), 403);
    const policy = await app.policy.read(app.scope);
    assert.ok(policy.ok);
    assert.equal(policy.value.bookingEnabled, false);
  } finally {
    await app.close();
  }
});

test("staff dashboard and agent endpoint report scoped outcomes without spoken or patient content", async ({ page, request }) => {
  const app = await localDashboard("staff");
  try {
    const followUp = await app.reception.answer(app.scope,
      { callId: "before-setting", turnId: "report-fallback", text: "Private patient detail", quality: "clear", at: "2026-09-28T10:00:00.000Z" },
      ["missing-source"], "Private proposed answer", "2026-09-28T10:00:00.000Z");
    assert.ok(followUp.ok);
    const delivered = await app.reception.drain(app.scope, "before-setting", "2026-09-28T10:00:00.000Z");
    assert.ok(delivered.ok);
    const other = await app.reception.startCall("another-call", { ...app.scope, tenantId: "other-tenant" });
    assert.ok(other.ok);
    const callPolicy = await app.policy.read(app.scope);
    assert.ok(callPolicy.ok);
    const runtime = new CallRuntime(app.ledger, app.scope);
    assert.ok((await runtime.admit("browser-disconnect", callPolicy.value, { key: { accountRef: "browser-account", providerCallRef: "browser-disconnect" },
      dialedNumber: "+6125550100", acceptedAt: "2026-09-28T10:00:00.000Z", deadline: "2026-09-28T10:00:30.000Z" })).ok);
    assert.ok((await runtime.activate("browser-disconnect", "browser-session", "2026-09-28T10:00:01.000Z")).ok);
    assert.ok((await runtime.endCall("browser-disconnect", "browser-session", "2026-09-28T10:00:02.000Z", "callerDisconnected")).ok);
    await page.goto(app.url);
    const report = page.getByLabel("Call outcome report");
    await expect(report).toContainText("2 call(s) loaded");
    await expect(report).toContainText("1 call(s) have a host-confirmed task");
    await expect(report).toContainText("1 caller disconnect(s)");
    await expect(report).not.toContainText("another-call");
    await expect(report).not.toContainText("Private");
    const response = await request.get(`${app.url}/api/call-outcomes`);
    assert.equal(response.status(), 200);
    const payload = await response.text();
    assert.equal(payload.includes("another-call"), false);
    assert.equal(payload.includes("Private"), false);
    await page.getByRole("button", { name: "Refresh outcomes" }).click();
    await expect(report).toContainText("before-setting");
  } finally {
    await app.close();
  }
});

test("E2E-004: staff can review the approved answer source without seeing spoken text", async ({ page }) => {
  const app = await localDashboard("staff");
  try {
    const answered = await app.reception.answer(app.scope,
      { callId: "before-setting", turnId: "hours-answer", text: "Hours?", quality: "clear", at: "2026-09-28T10:00:00.000Z" },
      ["hours"], "We open at 9 am.", "2026-09-28T10:00:00.000Z");
    assert.equal(answered.ok, true);
    await page.goto(app.url);
    await page.getByRole("textbox", { name: "Call ID" }).fill("before-setting");
    await page.getByRole("button", { name: "Load call" }).click();
    await expect(page.getByLabel("Call summary")).toContainText("1 sourced answer(s)");
    await expect(page.getByLabel("Call summary")).toContainText("hours · version hours-v1");
    await expect(page.getByLabel("Call summary")).not.toContainText("We open at 9 am.");
  } finally {
    await app.close();
  }
});

test("E2E-004 FR-21: clinic admin drafts, approves and revokes a scoped answer", async ({ page, request }) => {
  const app = await localDashboard("clinicAdmin");
  try {
    await page.goto(app.url);
    await expect(page.getByRole("heading", { name: "Approved clinic information" })).toBeVisible();
    await page.getByRole("textbox", { name: "Knowledge source reference" }).fill("parking");
    await page.getByRole("textbox", { name: "Knowledge owner reference" }).fill("practice-manager");
    await page.getByRole("textbox", { name: "Knowledge answer text" }).fill("Parking is behind the clinic.");
    await page.getByRole("textbox", { name: "Knowledge effective from" }).fill("2026-09-01T00:00:00.000Z");
    await page.getByRole("textbox", { name: "Knowledge effective until" }).fill("2026-10-01T00:00:00.000Z");
    await page.getByRole("button", { name: "Save knowledge draft" }).click();
    await expect(page.getByLabel("Knowledge sources")).toContainText("parking · version 1 · draft");
    const before = await app.reception.answer(app.scope,
      { callId: "before-setting", turnId: "parking-draft", text: "Parking?", quality: "clear", at: "2026-09-28T10:00:00.000Z" },
      ["parking"], "Parking is behind the clinic.", "2026-09-28T10:00:00.000Z");
    assert.ok(before.ok);
    assert.equal(before.value.knowledgeAnswers.length, 0);
    assert.equal(before.value.callerMessages.at(-1), "I can't verify that information right now.");
    assert.equal((await request.post(`${app.url}/api/knowledge/approve`, { data: { sourceRef: "parking", expectedVersion: "0" } })).status(), 409);
    await page.getByRole("button", { name: "Approve parking" }).click();
    await expect(page.getByLabel("Knowledge sources")).toContainText("parking · version 2 · approved");
    await page.reload();
    await expect(page.getByLabel("Knowledge sources")).toContainText("parking · version 2 · approved");
    const oldCall = await app.reception.answer(app.scope,
      { callId: "before-setting", turnId: "parking-old-call", text: "Parking?", quality: "clear", at: "2026-09-28T10:00:00.000Z" },
      ["parking"], "Parking is behind the clinic.", "2026-09-28T10:00:00.000Z");
    assert.ok(oldCall.ok);
    assert.equal(oldCall.value.knowledgeAnswers.length, 0);
    assert.equal(oldCall.value.callerMessages.at(-1), "I can't verify that information right now.");
    assert.ok((await app.reception.startCall("parking-new", app.scope, "2026-09-28T10:00:00.000Z")).ok);
    const approved = await app.reception.answer(app.scope,
      { callId: "parking-new", turnId: "parking-approved", text: "Parking?", quality: "clear", at: "2026-09-28T10:00:00.000Z" },
      ["parking"], "Parking is behind the clinic.", "2026-09-28T10:00:00.000Z");
    assert.ok(approved.ok);
    assert.equal(approved.value.callerMessages.at(-1), "Parking is behind the clinic.");
    assert.equal(approved.value.knowledgeAnswers.at(-1)?.version, "2");
    await page.getByRole("button", { name: "Revoke parking" }).click();
    await expect(page.getByLabel("Knowledge sources")).toContainText("parking · version 3 · revoked");
    const revoked = await app.reception.answer(app.scope,
      { callId: "parking-new", turnId: "parking-revoked", text: "Parking?", quality: "clear", at: "2026-09-28T10:00:00.000Z" },
      ["parking"], "Parking is behind the clinic.", "2026-09-28T10:00:00.000Z");
    assert.ok(revoked.ok);
    assert.equal(revoked.value.knowledgeAnswers.length, 1);
    assert.equal(revoked.value.callerMessages.at(-1), "I can't verify that information right now.");
    await page.getByRole("textbox", { name: "Knowledge source reference" }).fill("parking");
    await page.getByRole("textbox", { name: "Knowledge owner reference" }).fill("practice-manager");
    await page.getByRole("textbox", { name: "Knowledge answer text" }).fill("Parking is across the road.");
    await page.getByRole("textbox", { name: "Knowledge effective from" }).fill("2026-09-01T00:00:00.000Z");
    await page.getByRole("textbox", { name: "Knowledge effective until" }).fill("2026-10-01T00:00:00.000Z");
    await page.getByRole("button", { name: "Save knowledge draft" }).click();
    await expect(page.getByLabel("Knowledge sources")).toContainText("parking · version 4 · draft");
    const afterRevokedDraft = await app.knowledge.readKnowledge(app.scope, ["parking"]);
    assert.ok(afterRevokedDraft.ok);
    assert.equal(afterRevokedDraft.value.length, 0);
  } finally { await app.close(); }

  const staff = await localDashboard("staff");
  try {
    await page.goto(staff.url);
    await expect(page.getByRole("heading", { name: "Approved clinic information" })).toHaveCount(0);
    assert.equal((await request.get(`${staff.url}/api/knowledge`)).status(), 403);
    assert.equal((await request.post(`${staff.url}/api/knowledge/draft`, { data: { sourceRef: "x", expectedVersion: "0",
      ownerRef: "owner", text: "Text", effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: "2026-10-01T00:00:00.000Z" } })).status(), 403);
  } finally { await staff.close(); }
});

test("FR-21: an approval edit reaches the next call while an older call keeps its source version", async ({ page }) => {
  const app = await localDashboard("clinicAdmin");
  try {
    await page.goto(app.url);
    await page.getByRole("textbox", { name: "Knowledge source reference" }).fill("hours");
    await page.getByRole("textbox", { name: "Knowledge owner reference" }).fill("practice-manager");
    await page.getByRole("textbox", { name: "Knowledge answer text" }).fill("We open at 10 am.");
    await page.getByRole("textbox", { name: "Knowledge effective from" }).fill("2026-09-01T00:00:00.000Z");
    await page.getByRole("textbox", { name: "Knowledge effective until" }).fill("2026-10-01T00:00:00.000Z");
    await page.getByRole("button", { name: "Save knowledge draft" }).click();
    await expect(page.getByLabel("Knowledge sources")).toContainText("hours · version 2 · draft");
    const draftCall = await app.reception.answer(app.scope,
      { callId: "before-setting", turnId: "old-hours-draft", text: "Hours?", quality: "clear", at: "2026-09-28T10:00:00.000Z" },
      ["hours"], "We open at 9 am.", "2026-09-28T10:00:00.000Z");
    assert.ok(draftCall.ok);
    assert.equal(draftCall.value.knowledgeAnswers.at(-1)?.version, "hours-v1");
    await page.getByRole("button", { name: "Approve hours" }).click();
    await expect(page.getByLabel("Knowledge sources")).toContainText("hours · version 3 · approved");
    const oldCall = await app.reception.answer(app.scope,
      { callId: "before-setting", turnId: "old-hours-approved", text: "Hours?", quality: "clear", at: "2026-09-28T10:00:00.000Z" },
      ["hours"], "We open at 10 am.", "2026-09-28T10:00:00.000Z");
    assert.ok(oldCall.ok);
    assert.equal(oldCall.value.callerMessages.at(-1), "I can't verify that information right now.");
    assert.equal(oldCall.value.knowledgeAnswers.length, 1);
    assert.ok((await app.reception.startCall("after-edit", app.scope, "2026-09-28T10:00:00.000Z")).ok);
    const newCall = await app.reception.answer(app.scope,
      { callId: "after-edit", turnId: "new-hours", text: "Hours?", quality: "clear", at: "2026-09-28T10:00:00.000Z" },
      ["hours"], "We open at 10 am.", "2026-09-28T10:00:00.000Z");
    assert.ok(newCall.ok);
    assert.equal(newCall.value.callerMessages.at(-1), "We open at 10 am.");
    assert.equal(newCall.value.knowledgeAnswers.at(-1)?.version, "3");
  } finally { await app.close(); }
});

test("availability read review shows source and status without exposing exact times", async ({ page }) => {
  const availability: AvailabilityHost = { list: async scope => ({ ok: true, value: { kind: "times", scope,
    sourceRef: "cliniko:11:22:33", timeZone: "Australia/Sydney", observedAt: "2026-09-28T10:00:00.000Z",
    startsAt: ["2026-09-30T23:00:00.000Z"], reservable: false } }) };
  const app = await localDashboard("staff", availability);
  try {
    const read = await app.reception.checkAvailability(app.scope,
      { callId: "before-setting", turnId: "availability-review", text: "Check times", quality: "clear", at: "2026-09-28T10:00:00.000Z" },
      "2026-10-01", "2026-10-02", "2026-09-28T10:00:00.000Z");
    assert.equal(read.ok, true);
    await page.goto(app.url);
    await page.getByRole("textbox", { name: "Call ID" }).fill("before-setting");
    await page.getByRole("button", { name: "Load call" }).click();
    await expect(page.getByLabel("Call summary")).toContainText("1 availability read(s)");
    await expect(page.getByLabel("Call summary")).toContainText("shown · cliniko:11:22:33 · Australia/Sydney · 1 time(s)");
    await expect(page.getByLabel("Call summary")).not.toContainText("2026-09-30T23:00:00.000Z");
  } finally {
    await app.close();
  }
});

test("stale settings tab reloads the winning policy version", async ({ context }) => {
  const app = await localDashboard("clinicAdmin");
  const first = await context.newPage();
  const stale = await context.newPage();
  try {
    await Promise.all([first.goto(app.url), stale.goto(app.url)]);
    await expect(first.getByRole("button", { name: "Enable booking" })).toBeVisible();
    await expect(stale.getByRole("button", { name: "Enable booking" })).toBeVisible();
    await first.getByRole("button", { name: "Enable booking" }).click();
    await expect(first.getByText("Policy version 1")).toBeVisible();
    await stale.getByRole("button", { name: "Enable booking" }).click();
    await expect(stale.getByRole("alert")).toContainText("Settings changed elsewhere");
    await expect(stale.getByText("Policy version 1")).toBeVisible();
    await expect(stale.getByRole("button", { name: "Disable booking" })).toBeVisible();
  } finally {
    await Promise.all([first.close(), stale.close()]);
    await app.close();
  }
});

test("staff follow-up queue shows overdue fallback without patient or spoken details", async ({ page, request }) => {
  const app = await localDashboard("staff");
  try {
    const routed = await app.reception.answer(app.scope,
      { callId: "before-setting", turnId: "missing-answer", text: "Private patient question", quality: "clear", at: "2026-09-28T10:00:00.000Z" },
      ["missing-source"], "Private proposed answer", "2026-09-28T10:00:00.000Z");
    assert.equal(routed.ok, true);
    const delivered = await app.reception.drain(app.scope, "before-setting", "2026-09-28T10:00:00.000Z");
    assert.equal(delivered.ok, true);
    await page.goto(app.url);
    const queue = page.getByLabel("Staff follow-up queue");
    await expect(queue).toContainText("before-setting · systemFailure · open · overdue");
    await expect(queue).not.toContainText("Private patient question");
    await expect(queue).not.toContainText("Private proposed answer");
    const response = await request.get(`${app.url}/api/staff?after=`);
    assert.equal(response.status(), 400);
    const foreign = await app.ledger.listStaffItems({ ...app.scope, tenantId: "another-tenant" });
    assert.ok(foreign.ok);
    assert.deepEqual(foreign.value, []);
  } finally {
    await app.close();
  }
});

test("overdue follow-up delivers one keyed operator alert and shows its status to staff", async ({ page }) => {
  const app = await localDashboard("staff");
  try {
    const requested = await app.reception.answer(app.scope,
      { callId: "before-setting", turnId: "alert-fallback", text: "Private caller detail", quality: "clear", at: "2026-09-28T10:00:00.000Z" },
      ["missing"], "Private proposed answer", "2026-09-28T10:00:00.000Z");
    assert.ok(requested.ok);
    assert.ok((await app.reception.drain(app.scope, "before-setting", "2026-09-28T10:00:00.000Z")).ok);
    const scan = await new StaffAlertMonitor(app.ledger, app.scope).scan("2026-09-29T10:00:01.000Z");
    assert.ok(scan.ok);
    assert.equal(scan.value, 1);
    const delivered = await new EffectRecovery(app.ledger, () => app.host, app.scope).recover("2026-09-29T10:00:01.000Z");
    assert.ok(delivered.ok);
    assert.deepEqual(delivered.value.failed, []);
    assert.equal(app.host.alerts(app.scope).length, 1);
    await page.goto(app.url);
    const queue = page.getByLabel("Staff follow-up queue");
    await expect(queue).toContainText("overdue alert delivered");
    await expect(queue).not.toContainText("Private");
    await page.reload();
    await expect(page.getByLabel("Staff follow-up queue")).toContainText("overdue alert delivered");
  } finally { await app.close(); }
});

test("lost host task receipt remains in review until exact reconciliation reaches the queue", async ({ page }) => {
  const app = await localDashboard("staff");
  try {
    const routed = await app.reception.answer(app.scope,
      { callId: "before-setting", turnId: "task-reconcile", text: "Question", quality: "clear", at: "2026-09-28T10:00:00.000Z" },
      ["missing"], "Unapproved answer", "2026-09-28T10:00:00.000Z");
    assert.equal(routed.ok, true);
    const original = app.host.openTask.bind(app.host);
    app.host.openTask = async item => { await original(item); throw new Error("response lost"); };
    assert.equal((await app.reception.drain(app.scope, "before-setting", "2026-09-28T10:00:00.000Z")).ok, true);
    await page.goto(app.url);
    const queue = page.getByLabel("Staff follow-up queue");
    await expect(queue).toContainText("needsReview");
    const stored = await app.ledger.read("before-setting", app.scope);
    assert.ok(stored.ok);
    const taskKey = Object.keys(stored.value.staffItems)[0];
    assert.ok(taskKey);
    const worker = new EffectWorker(new CallRuntime(app.ledger, app.scope), app.host);
    await worker.process("before-setting", `${taskKey}:open:reconcile`, "2026-09-28T10:00:00.000Z");
    await page.getByRole("button", { name: "Refresh follow-up" }).click();
    await expect(queue).toContainText("systemFailure · open · overdue");
    await expect(queue).not.toContainText("needsReview");
    assert.equal(app.host.tasks(app.scope).length, 1);
  } finally {
    await app.close();
  }
});

test("staff dashboard acknowledges, reassigns, and resolves only host-confirmed follow-up", async ({ page, request }) => {
  const app = await localDashboard("staff");
  try {
    assert.equal((await app.reception.answer(app.scope,
      { callId: "before-setting", turnId: "staff-lifecycle", text: "Need help", quality: "clear", at: "2026-09-28T10:00:00.000Z" },
      ["missing"], "Unapproved", "2026-09-28T10:00:00.000Z")).ok, true);
    assert.equal((await app.reception.drain(app.scope, "before-setting", "2026-09-28T10:00:00.000Z")).ok, true);
    const initial = await app.ledger.read("before-setting", app.scope);
    assert.ok(initial.ok);
    const taskKey = Object.keys(initial.value.staffItems)[0];
    assert.ok(taskKey);
    await page.goto(app.url);
    const queue = page.getByLabel("Staff follow-up queue");
    await expect(queue).toContainText("systemFailure · open");
    await page.getByRole("button", { name: "Acknowledge" }).click();
    await expect(queue).toContainText("systemFailure · acknowledged");
    assert.equal(app.host.tasks(app.scope)[0]?.status, "acknowledged");
    const stale = await request.post(`${app.url}/api/staff/change`, { data: { callId: "before-setting", taskKey,
      expectedVersion: initial.value.version, change: { kind: "resolve" } } });
    assert.equal(stale.status(), 409);
    await page.getByRole("button", { name: "Assign to operator" }).click();
    await expect(queue).toContainText("systemFailure · open");
    const policy = await app.policy.read(app.scope);
    assert.ok(policy.ok);
    assert.deepEqual(app.host.tasks(app.scope)[0]?.destination, policy.value.operatorQueue);
    await page.getByRole("button", { name: "Resolve" }).click();
    await expect(queue).toContainText("systemFailure · resolved");
    await expect(queue).not.toContainText("resolved · overdue");
    await expect(page.getByRole("button", { name: "Resolve" })).toHaveCount(0);
    assert.equal(app.host.tasks(app.scope)[0]?.status, "resolved");
    const foreign = new CommandGateway({ actorRef: "foreign-agent", role: "agent", scope: app.scope }, app.policy, app.reception);
    const forbidden = await foreign.submit({ kind: "staff.change.v1", callId: "before-setting", taskKey,
      expectedVersion: initial.value.version, change: { kind: "resolve" }, now: "2026-09-28T10:00:00.000Z" });
    assert.equal(forbidden.ok, false);
    if (!forbidden.ok) assert.equal(forbidden.error.kind, "forbidden");
  } finally {
    await app.close();
  }
});
