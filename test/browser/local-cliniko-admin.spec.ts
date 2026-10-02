import assert from "node:assert/strict";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { ClinikoCatalogueReader } from "../../src/cliniko/catalogue.ts";
import { ClinikoCatalogueSetup, MemoryClinikoApprovalStore } from "../../src/cliniko/catalogue-setup.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { createHostAuthenticatedDashboardServer } from "../../src/standalone/dashboard/server.ts";
import { StandaloneOperationalCounters } from "../../src/standalone/operational-counters.ts";
import { validKeypadGreetingText } from "../../src/standalone/keypad-greeting.ts";
import type { OperationalDailyCounts } from "../../src/voice/operational-counts.ts";
import { listenLoopbackServer } from "../support/listen-loopback-server.ts";

const scope = { tenantId: "local-browser", clinicId: "clinic", locationId: "main" };
const route = { accountRef: "local-account", dialedNumber: "+6125550199", routeVersion: "v1" };
const token = "synthetic-browser-token";
const basic = `Basic ${Buffer.from(`abby-admin:${token}`).toString("base64")}`;

test("E2E-214 E2E-233 E2E-235 E2E-237 local owner sees aggregate speech and operational status", async ({ page, request }) => {
  const paths: string[] = [];
  const provider: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path === "/v1/businesses") return Response.json({ total_entries: 1, businesses: [{ id: "11",
      business_name: "Synthetic clinic", show_in_online_bookings: true,
      time_zone_identifier: "Australia/Sydney", patient_name: "patient-canary-214" }] });
    if (path === "/v1/businesses/11") return Response.json({ id: "11", business_name: "Synthetic clinic",
      show_in_online_bookings: true, time_zone_identifier: "Australia/Sydney", appointment_type_ids: ["33"] });
    if (path === "/v1/practitioners/22") return Response.json({ id: "22", display_name: "Practitioner",
      active: true, show_in_online_bookings: true });
    if (path === "/v1/appointment_types/33") return Response.json({ id: "33", name: "Consult",
      show_in_online_bookings: true });
    if (path === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1,
      practitioners: [{ id: "22" }] });
    if (path === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1,
      appointment_types: [{ id: "33" }] });
    throw new Error("unexpected synthetic catalogue request");
  };
  const reader = ClinikoCatalogueReader.create({ scope, apiKey: "synthetic-key-au5",
    contactEmail: "test@example.com" }, provider, () => "2026-09-30T10:00:00.000Z");
  assert.ok(reader.ok);
  const policy = new MemoryPolicyStore();
  const setup = new ClinikoCatalogueSetup(reader.value,
    new ReferenceNumberRoutingHost([{ ...scope, ...route }]), policy,
    new MemoryClinikoApprovalStore(), () => "2026-09-30T10:00:00.000Z");
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const actor = { actorRef: "local-browser-owner", role: "clinicAdmin" as const, scope };
  const transcriptCanary = "PRIVATE SYNTHETIC TRANSCRIPT CANARY";
  let speechStatus: unknown = { kind: "speechGateStatus", syntheticCandidateGate: "fail",
    representativeCallGate: "notRun", releaseGate: "unverified", rawTranscript: transcriptCanary,
    checks: [
      { name: "telephony", status: "pass", rawTranscript: transcriptCanary },
      { name: "noise", status: "fail" }, { name: "safety", status: "fail" },
      { name: "speech", status: "pass" },
    ] };
  const operationalCounters = new StandaloneOperationalCounters(() => "2026-10-01T12:00:00.000Z");
  operationalCounters.record(scope, "callOwnerStarted");
  operationalCounters.record(scope, "intentClassificationUnavailable");
  operationalCounters.record({ ...scope, clinicId: "foreign" }, "voiceFailure");
  let malformedOperations = false;
  const server = await createHostAuthenticatedDashboardServer({ publicOrigin: "http://127.0.0.1:0",
    surface: "availabilitySetup",
    resolveActor: incoming => incoming.headers.authorization === basic ? actor
      : incoming.headers.authorization === "Basic synthetic-staff" ? { ...actor, role: "staff" } : null,
    readSpeechGate: async () => speechStatus,
    unauthorized: response => {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Abby local clinic admin"',
        "Cache-Control": "no-store" });
      response.end();
    },
    gatewayFor: bound => new CommandGateway(bound, policy, reception,
      undefined, undefined, undefined, undefined, undefined, setup,
      { daily: location => malformedOperations
        ? { days: [], patientNote: "PRIVATE OPERATIONAL CANARY" } as unknown as OperationalDailyCounts
        : operationalCounters.daily(location) }),
  }, resolve("dist/dashboard/cliniko-admin.js"));
  try {
    const origin = await listenLoopbackServer(server);
    assert.equal((await request.get(origin)).status(), 401);
    assert.equal((await request.get(origin, { headers: { Authorization: "Basic invalid" } })).status(), 401);
    assert.equal((await request.get(`${origin}/api/speech-gate`)).status(), 401);
    assert.equal((await request.get(`${origin}/api/speech-gate`, { headers: {
      Authorization: "Basic synthetic-staff" } })).status(), 403);
    assert.equal((await request.get(`${origin}/api/operations/daily`)).status(), 401);
    assert.equal((await request.get(`${origin}/api/operations/daily`, { headers: {
      Authorization: "Basic synthetic-staff" } })).status(), 403);
    assert.equal(paths.length, 0);
    await page.context().setHTTPCredentials({ username: "abby-admin", password: token });
    await page.goto(origin);
    const speechReply = await request.get(`${origin}/api/speech-gate`, { headers: { Authorization: basic } });
    assert.equal(speechReply.status(), 200, await speechReply.text());
    assert.equal((await speechReply.text()).includes(transcriptCanary), false);
    const browserSpeech = await page.evaluate(async () => {
      const response = await fetch("/api/speech-gate");
      return { status: response.status, body: await response.json() as unknown };
    });
    assert.equal(browserSpeech.status, 200, JSON.stringify(browserSpeech.body));
    await expect(page.getByRole("heading", { name: "Read-only availability setup" })).toBeVisible();
    await expect(page.getByLabel("Voice quality status")).toContainText("Voice quality is blocked");
    await expect(page.getByLabel("Voice quality status")).toContainText("Noisy audio: fail");
    await expect(page.getByLabel("Voice quality status")).toContainText("Release readiness: unverified");
    const operationalReply = await request.get(`${origin}/api/operations/daily`, { headers: { Authorization: basic } });
    assert.equal(operationalReply.status(), 200);
    const operationalBody = await operationalReply.json() as { value: { daily: OperationalDailyCounts } };
    assert.equal(operationalBody.value.daily.days.at(-1)?.counts.callOwnerStarted, 1);
    assert.equal(operationalBody.value.daily.days.at(-1)?.counts.voiceFailure, 0);
    assert.equal(operationalBody.value.daily.days.at(-1)?.counts.intentClassificationUnavailable, 1);
    await expect(page.getByLabel("Operational counts")).toContainText("Call owners started");
    await expect(page.getByLabel("Operational counts")).toContainText("Intent classification unavailable");
    await expect(page.getByLabel("Operational counts")).toContainText("2026-10-01");
    assert.equal((await request.post(`${origin}/api/operations/daily`, { headers: { Authorization: basic } })).status(), 404);
    assert.equal((await request.post(`${origin}/api/speech-gate`, { headers: { Authorization: basic } })).status(), 404);
    await expect(page.getByRole("button", { name: /booking/i })).toHaveCount(0);
    const capabilities = await request.get(`${origin}/api/capabilities`, { headers: { Authorization: basic } });
    assert.equal(capabilities.status(), 200);
    const listed = await capabilities.json() as { value: { id: string }[] };
    assert.ok(listed.value.length > 0);
    assert.ok(listed.value.every(item => item.id === "settings.read.v1" || item.id === "operations.daily.v1" ||
      item.id.startsWith("clinic.availability.") || item.id === "settings.routing.greeting.change.v1" ||
      item.id === "settings.routing.greeting.audit.v1" ||
        item.id === "settings.automation.enabled.change.v1" || item.id === "settings.automation.audit.v1"));
    assert.equal((await request.post(`${origin}/api/settings/booking-enabled`, { headers: {
      Authorization: basic, Origin: origin, "Content-Type": "application/json" },
    data: { expectedVersion: "0", enabled: true } })).status(), 404);
    await page.getByLabel("Practitioner ID", { exact: true }).fill("22");
    await page.getByLabel("Appointment type ID", { exact: true }).fill("33");
    await page.getByRole("button", { name: "Inspect selection" }).click();
    await expect(page.getByLabel("Availability selection inspection")).toContainText("Eligible candidate");
    await page.getByLabel("Route account reference").fill(route.accountRef);
    await page.getByLabel("Dialed number").fill(route.dialedNumber);
    await page.getByLabel("Route version").fill(route.routeVersion);
    await page.getByRole("checkbox", { name: "I approve this route for provisional availability only." }).check();
    await page.getByRole("button", { name: "Approve read-only route" }).click();
    await expect(page.getByLabel("Availability approval status")).toContainText("Stored approval: 11 / 22 / 33 · version 1");
    await page.reload();
    await expect(page.getByLabel("Availability approval status")).toContainText("Stored approval: 11 / 22 / 33 · version 1");
    await page.getByRole("button", { name: "Revoke availability route" }).click();
    await expect(page.getByLabel("Availability approval status")).toContainText("No approved availability route · version 2");
    const pageText = await page.locator("body").innerText();
    assert.equal(pageText.includes("patient-canary-214") || pageText.includes("synthetic-key-au5") ||
      pageText.includes(transcriptCanary), false);
    assert.equal(paths.some(path => path.includes("patients")), false);
    speechStatus = { kind: "speechGateStatus", syntheticCandidateGate: "pass",
      representativeCallGate: "notRun", releaseGate: "unverified", checks: [] };
    assert.equal((await request.get(`${origin}/api/speech-gate`, { headers: { Authorization: basic } })).status(), 503);
    await page.reload();
    await expect(page.getByLabel("Voice quality status")).toContainText("status is unavailable");
    await expect(page.getByLabel("Voice quality status")).toContainText("unverified");
    malformedOperations = true;
    const malformedReply = await request.get(`${origin}/api/operations/daily`, { headers: { Authorization: basic } });
    assert.equal(malformedReply.status(), 503);
    assert.equal((await malformedReply.text()).includes("PRIVATE OPERATIONAL CANARY"), false);
    await page.reload();
    await expect(page.getByLabel("Operational counts")).toContainText("unavailable");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  }
});

test("E2E-246 E2E-247 local Cliniko panel rejects unusable keypad text before approval", async ({ page, request }) => {
  const policy = new MemoryPolicyStore();
  assert.ok((await policy.changeGreeting(scope, "0", undefined, "setup-seed")).ok);
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const actor = { actorRef: "local-greeting-owner", role: "clinicAdmin" as const, scope };
  const server = await createHostAuthenticatedDashboardServer({ publicOrigin: "http://127.0.0.1:0", surface: "availabilitySetup",
    greetingTextValidator: text => validKeypadGreetingText(text, false),
    resolveActor: incoming => incoming.headers.authorization === basic ? actor
      : incoming.headers.authorization === "Basic synthetic-staff" ? { ...actor, role: "staff" } : null,
    unauthorized: response => { response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Abby clinic admin"' }); response.end(); },
    gatewayFor: bound => new CommandGateway(bound, policy, reception),
  }, resolve("dist/dashboard/cliniko-admin.js"));
  try {
    const origin = await listenLoopbackServer(server);
    await page.context().setHTTPCredentials({ username: "abby-admin", password: token });
    await page.goto(origin);
    await expect(page.getByRole("heading", { name: "Approved greeting" })).toBeVisible();
    await expect(page.getByLabel("Greeting approval status")).toContainText("No approved greeting");
    const headers = { Authorization: basic, Origin: origin, "Content-Type": "application/json" };
    const change = { kind: "settings.routing.greeting.change.v1", expectedVersion: "1", enabled: true,
      greetingVersion: "local-v1",
      approvedText: "Welcome to the clinic. Press 1 for possible times today. Press 2 for possible times tomorrow.",
      effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: "2027-09-01T00:00:00.000Z" };
    assert.equal((await request.post(`${origin}/api/settings/greeting`, { headers,
      data: { ...change, ownerRef: "forged-owner" } })).status(), 400);
    assert.equal((await request.post(`${origin}/api/settings/greeting`, { headers: { ...headers,
      Origin: "http://foreign.example.test" }, data: change })).status(), 403);
    assert.equal((await request.post(`${origin}/api/settings/greeting`, { headers: {
      ...headers, Authorization: "Basic synthetic-staff" }, data: change })).status(), 403);
    assert.equal((await request.get(`${origin}/api/settings/greeting-audit`, { headers: {
      Authorization: "Basic synthetic-staff" } })).status(), 403);
    await page.getByLabel("Local greeting version").fill(change.greetingVersion);
    await page.getByLabel("Local greeting text").fill("Welcome to the clinic.");
    await page.getByLabel("Local greeting effective from").fill(change.effectiveFrom);
    await page.getByLabel("Local greeting effective until").fill(change.effectiveUntil);
    await page.getByRole("button", { name: "Approve greeting for new calls" }).click();
    await expect(page.getByRole("alert")).toContainText("exact keypad instructions");
    await expect(page.getByLabel("Greeting approval status")).toContainText("No approved greeting · policy version 1");
    await expect(page.getByLabel("Greeting change history")).toContainText("setup-seed");
    await expect(page.getByLabel("Greeting change history")).not.toContainText("local-v1");
    await expect(page.getByLabel("Local greeting version")).toHaveValue(change.greetingVersion);
    await expect(page.getByLabel("Local greeting effective from")).toHaveValue(change.effectiveFrom);
    await page.getByLabel("Local greeting text").fill(change.approvedText);
    await page.getByRole("button", { name: "Approve greeting for new calls" }).click();
    await expect(page.getByLabel("Greeting approval status")).toContainText("Greeting saved · policy version 2");
    await expect(page.getByLabel("Greeting change history")).toContainText("greeting local-v1");
    const saved = await policy.read(scope);
    assert.ok(saved.ok);
    assert.equal(saved.value.greeting?.ownerRef, actor.actorRef);
    const stale = await request.post(`${origin}/api/settings/greeting`, { headers, data: change });
    assert.equal(stale.status(), 409);
    await page.reload();
    await expect(page.getByLabel("Greeting approval status")).toContainText("Greeting saved · policy version 2");
    await page.getByRole("button", { name: "Disable greeting for new calls" }).click();
    await expect(page.getByLabel("Greeting approval status")).toContainText("No approved greeting · policy version 3");
    await expect(page.getByLabel("Greeting change history")).toContainText("disabled");
    const disabled = await policy.read(scope);
    assert.ok(disabled.ok);
    assert.equal(disabled.value.greeting, undefined);
    assert.equal((await request.post(`${origin}/api/settings/booking-enabled`, { headers,
      data: { expectedVersion: "3", enabled: true } })).status(), 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  }
});
