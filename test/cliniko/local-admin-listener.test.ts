import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { sql } from "kysely";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { PostgresOperationalCounters } from "../../src/storage/postgres-operational-counters.ts";
import { keypadInstructions, sevenDayInstructions } from "../../src/standalone/keypad-greeting.ts";
import type { OperationalDailyCounts } from "../../src/voice/operational-counts.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";

const root = new URL("../../", import.meta.url);
const scope = { tenantId: "admin-local", clinicId: "clinic", locationId: "main" };
const accountSid = `AC${"1".repeat(32)}`;
const number = "+6125550199";
const route = { accountRef: accountSid, dialedNumber: number, routeVersion: "local-admin-v1" };
const token = "8".repeat(64);
const apiKey = "synthetic-key-au5";
const basic = `Basic ${Buffer.from(`abby-admin:${token}`).toString("base64")}`;

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  server.close();
  await once(server, "close");
  return address.port;
}

test("E2E-214 E2E-233 E2E-235 E2E-237 E2E-246 E2E-247 E2E-248 loopback admin retains scoped setup and usable greeting",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 }, async () => {
    const adminUrl = process.env.DATABASE_URL;
    assert.ok(adminUrl);
    const admin = connectPostgres(adminUrl);
    const databaseName = `abby_test_admin_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(adminUrl);
    target.pathname = `/${databaseName}`;
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG,
      DATABASE_URL: target.toString(), ABBY_ISOLATED_POSTGRES_PROBE: "1",
      ABBY_ADMIN_PORT: String(port), ABBY_ADMIN_ACCESS_TOKEN_HEX: token,
      ABBY_ADMIN_ACTOR_REF: "synthetic-owner-214", ABBY_TENANT_ID: scope.tenantId,
      ABBY_CLINIC_ID: scope.clinicId, ABBY_LOCATION_ID: scope.locationId,
      ABBY_TWILIO_ACCOUNT_SID: accountSid, ABBY_TWILIO_TEST_NUMBER: number,
      ABBY_VOICE_ROUTE_VERSION: route.routeVersion, ABBY_CLINIKO_API_KEY: apiKey,
      ABBY_CLINIKO_CONTACT_EMAIL: "test@example.com" };
    let created = false;
    let child: ReturnType<typeof spawn> | undefined;
    let output = "";
    const paths: string[] = [];
    const launch = async () => {
      child = spawn(process.execPath, ["test/support/start-synthetic-cliniko-admin.ts"],
        { cwd: root, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      child.stdout?.on("data", data => { output += String(data); });
      child.stderr?.on("data", data => { output += String(data); });
      child.on("message", message => {
        if (typeof message === "object" && message !== null && "kind" in message &&
            message.kind === "clinikoPath" && "path" in message && typeof message.path === "string") {
          paths.push(message.path);
        }
      });
      const until = Date.now() + 15_000;
      let ready = false;
      while (!ready && Date.now() < until) {
        try { ready = (await fetch(origin, { signal: AbortSignal.timeout(500) })).status === 401; }
        catch { await new Promise(resolve => setTimeout(resolve, 40)); }
      }
      assert.ok(ready, "local admin listener did not start");
    };
    const stop = async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      child = undefined;
    };
    const command = (value: object, authorization = basic, requestOrigin = origin) =>
      fetch(`${origin}/api/clinic-availability/command`, { method: "POST", headers: {
        "Content-Type": "application/json", Authorization: authorization, Origin: requestOrigin },
        body: JSON.stringify(value) });
    try {
      await sql.raw(`create database "${databaseName}"`).execute(admin);
      created = true;
      const db = connectPostgres(target.toString());
      try {
        await migrate(db);
        const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "unavailable",
          async () => ok(true), false, "standaloneMinimal");
        assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "synthetic-operator")).ok);
        const counters = new PostgresOperationalCounters(db);
        await counters.record(scope, "callOwnerStarted");
        await counters.record(scope, "intentClassificationUnavailable");
        await counters.record({ ...scope, clinicId: "foreign" }, "voiceFailure");
      } finally { await db.destroy(); }

      await launch();
      const anonymous = await fetch(origin);
      assert.equal(anonymous.status, 401);
      assert.match(anonymous.headers.get("www-authenticate") ?? "", /^Basic realm=/);
      assert.equal((await command({ kind: "clinic.availability.businesses.list.v1" },
        `Basic ${Buffer.from("abby-admin:wrong").toString("base64")}`)).status, 401);
      assert.equal((await command({ kind: "clinic.availability.businesses.list.v1" },
        "", origin)).status, 401);
      assert.equal((await command({ kind: "clinic.availability.businesses.list.v1" },
        basic, "http://foreign.example.test")).status, 403);
      assert.deepEqual(paths, []);
      assert.equal((await fetch(origin, { headers: { Authorization: basic } })).status, 200);
      assert.equal((await fetch(`${origin}/api/speech-gate`)).status, 401);
      const absentSpeech = await fetch(`${origin}/api/speech-gate`, { headers: { Authorization: basic } });
      assert.equal(absentSpeech.status, 503);
      assert.deepEqual(await absentSpeech.json(), { ok: false, error: { kind: "statusUnavailable" } });
      assert.equal((await fetch(`${origin}/api/operations/daily`)).status, 401);
      const operational = await fetch(`${origin}/api/operations/daily`, { headers: { Authorization: basic } });
      assert.equal(operational.status, 200);
      const daily = await operational.json() as { value: { kind: string; daily: OperationalDailyCounts } };
      assert.equal(daily.value.kind, "operationalDaily");
      assert.equal(daily.value.daily.days.length, 7);
      assert.equal(daily.value.daily.days.at(-1)?.counts.callOwnerStarted, 1);
      assert.equal(daily.value.daily.days.at(-1)?.counts.voiceFailure, 0);
      assert.equal(daily.value.daily.days.at(-1)?.counts.intentClassificationUnavailable, 1);
      const capabilities = await fetch(`${origin}/api/capabilities`, { headers: { Authorization: basic } });
      assert.equal(capabilities.status, 200);
      const listed = await capabilities.json() as { value: { id: string }[] };
      assert.ok(listed.value.length > 0);
      assert.ok(listed.value.every(item => item.id === "settings.read.v1" || item.id === "operations.daily.v1" ||
        item.id.startsWith("clinic.availability.") || item.id === "settings.routing.greeting.change.v1" ||
        item.id === "settings.routing.greeting.audit.v1" ||
        item.id === "settings.automation.enabled.change.v1" || item.id === "settings.automation.audit.v1"));
      assert.equal((await fetch(`${origin}/api/settings/booking-enabled`, { method: "POST", headers: {
        Authorization: basic, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: "0", enabled: true }) })).status, 404);
      const bundle = await fetch(`${origin}/app.js`, { headers: { Authorization: basic } });
      assert.equal(bundle.status, 200);
      assert.match(await bundle.text(), /Read-only availability setup/);
      assert.equal((await command({ kind: "clinic.availability.businesses.list.v1" })).status, 200);
      assert.deepEqual(paths, ["/v1/businesses"]);
      assert.equal((await command({ kind: "clinic.availability.approval.change.v1", route,
        selection: { businessId: "11", practitionerId: "22", appointmentTypeId: "33",
          policyVersion: "0" }, expectedVersion: 0 })).status, 200);
      const automationChange = (value: object, authorization = basic, requestOrigin = origin) =>
        fetch(`${origin}/api/settings/automation-enabled`, { method: "POST", headers: {
          "Content-Type": "application/json", Authorization: authorization, Origin: requestOrigin },
          body: JSON.stringify(value) });
      assert.equal((await automationChange({ expectedVersion: "1", enabled: false }, "")).status, 401);
      assert.equal((await automationChange({ expectedVersion: "1", enabled: false }, basic,
        "http://foreign.example.test")).status, 403);
      assert.equal((await automationChange({ expectedVersion: "1", enabled: "false" })).status, 400);
      assert.equal((await automationChange({ expectedVersion: "1", enabled: false, actorRef: "forged" })).status, 400);
      assert.equal((await automationChange({ expectedVersion: "0", enabled: false })).status, 409);
      assert.equal((await automationChange({ expectedVersion: "1", enabled: false })).status, 200);
      const blockedEnable = await automationChange({ expectedVersion: "2", enabled: true });
      assert.equal(blockedEnable.status, 400);
      assert.equal((await blockedEnable.json() as { error: { kind: string } }).error.kind, "readinessFailed");
      await stop();

      await launch();
      const automationState = await fetch(`${origin}/api/settings`, { headers: { Authorization: basic } });
      const savedAutomation = (await automationState.json() as { value: { policy: {
        automationEnabled: boolean; automationVersion: string } } }).value.policy;
      assert.equal(savedAutomation.automationEnabled, false);
      assert.equal(savedAutomation.automationVersion, "2");
      assert.equal((await fetch(`${origin}/api/settings/automation-audit`)).status, 401);
      const automationAudit = await fetch(`${origin}/api/settings/automation-audit`, { headers: { Authorization: basic } });
      assert.equal(automationAudit.status, 200);
      const automationHistory = (await automationAudit.json() as { value: { page: { entries: {
        version: string; actorRef: string; enabled: boolean }[] } } }).value.page.entries;
      assert.deepEqual(automationHistory.map(entry => [entry.version, entry.enabled, entry.actorRef]),
        [["1", true, "synthetic-operator"], ["2", false, "synthetic-owner-214"]]);
      const laterAudit = await fetch(`${origin}/api/settings/automation-audit?after=1`, { headers: { Authorization: basic } });
      assert.deepEqual((await laterAudit.json() as { value: { page: { entries: { version: string }[] } } })
        .value.page.entries.map(entry => entry.version), ["2"]);
      const persistedOperations = await fetch(`${origin}/api/operations/daily`, { headers: { Authorization: basic } });
      assert.equal(persistedOperations.status, 200);
      const persistedDaily = await persistedOperations.json() as { value: { daily: OperationalDailyCounts } };
      assert.equal(persistedDaily.value.daily.days.at(-1)?.counts.callOwnerStarted, 1);
      const current = await command({ kind: "clinic.availability.approval.read.v1" });
      assert.equal(current.status, 200);
      const state = await current.json() as { value: { state: { version: number; approval: unknown } } };
      assert.equal(state.value.state.version, 1);
      assert.ok(state.value.state.approval);
      assert.equal((await command({ kind: "clinic.availability.approval.revoke.v1",
        expectedVersion: 1 })).status, 200);
      const greetingChange = (value: object, authorization = basic, requestOrigin = origin) =>
        fetch(`${origin}/api/settings/greeting`, { method: "POST", headers: {
          "Content-Type": "application/json", Authorization: authorization, Origin: requestOrigin },
          body: JSON.stringify(value) });
      const greeting = { kind: "settings.routing.greeting.change.v1", expectedVersion: "0", enabled: true,
        greetingVersion: "local-v1", approvedText: `Welcome to the clinic. ${keypadInstructions}`,
        effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: "2027-09-01T00:00:00.000Z" };
      const before = await fetch(`${origin}/api/settings`, { headers: { Authorization: basic } });
      assert.equal(before.status, 200);
      assert.equal((await before.json() as { value: { policy: { greeting?: unknown } } }).value.policy.greeting, undefined);
      assert.equal((await greetingChange({ ...greeting, ownerRef: "forged" })).status, 400);
      assert.equal((await greetingChange(greeting, basic, "http://foreign.example.test")).status, 403);
      assert.equal((await greetingChange(greeting, "")).status, 401);
      const missingChoices = await greetingChange({ ...greeting, approvedText: "Welcome to the clinic." });
      assert.equal(missingChoices.status, 400);
      assert.deepEqual(await missingChoices.json(), { ok: false, error: { kind: "invalidValue" } });
      assert.equal((await greetingChange({ ...greeting,
        approvedText: `${greeting.approvedText} ${sevenDayInstructions}` })).status, 400);
      const beforeValid = await fetch(`${origin}/api/settings`, { headers: { Authorization: basic } });
      assert.equal((await beforeValid.json() as { value: { policy: { policyVersion: string } } })
        .value.policy.policyVersion, "0");
      assert.equal((await greetingChange(greeting)).status, 200);
      const greetingAudit = await fetch(`${origin}/api/settings/greeting-audit`, { headers: { Authorization: basic } });
      assert.equal(greetingAudit.status, 200);
      assert.deepEqual((await greetingAudit.json() as { value: { page: { entries: { greetingVersion?: string }[] } } })
        .value.page.entries.map(entry => entry.greetingVersion), ["local-v1"]);
      await stop();
      await launch();
      const approved = await fetch(`${origin}/api/settings`, { headers: { Authorization: basic } });
      assert.equal(approved.status, 200);
      const approvedPolicy = (await approved.json() as { value: { policy: { policyVersion: string;
        greeting?: { approvedText: string; ownerRef: string } } } }).value.policy;
      assert.equal(approvedPolicy.greeting?.approvedText, greeting.approvedText);
      assert.equal(approvedPolicy.greeting?.ownerRef, "synthetic-owner-214");
      assert.equal((await greetingChange(greeting)).status, 409);
      assert.equal((await greetingChange({ kind: "settings.routing.greeting.change.v1",
        expectedVersion: approvedPolicy.policyVersion, enabled: false })).status, 200);
      const disabled = await fetch(`${origin}/api/settings`, { headers: { Authorization: basic } });
      assert.equal(disabled.status, 200);
      const disabledPolicy = (await disabled.json() as { value: { policy: { policyVersion: string;
        greeting?: unknown } } }).value.policy;
      assert.equal(disabledPolicy.greeting, undefined);
      await stop();
      env.ABBY_SEVEN_DAY_AVAILABILITY_ENABLED = "1";
      await launch();
      assert.equal((await greetingChange({ ...greeting,
        expectedVersion: disabledPolicy.policyVersion })).status, 400);
      const weekGreeting = { ...greeting, expectedVersion: disabledPolicy.policyVersion,
        greetingVersion: "local-week-v1", approvedText: `${greeting.approvedText} ${sevenDayInstructions}` };
      assert.equal((await greetingChange(weekGreeting)).status, 200);
      const weekSaved = await fetch(`${origin}/api/settings`, { headers: { Authorization: basic } });
      assert.equal((await weekSaved.json() as { value: { policy: { greeting?: { approvedText: string } } } })
        .value.policy.greeting?.approvedText, weekGreeting.approvedText);
      const weekAudit = await fetch(`${origin}/api/settings/greeting-audit`, { headers: { Authorization: basic } });
      assert.deepEqual((await weekAudit.json() as { value: { page: { entries: { greetingVersion?: string }[] } } })
        .value.page.entries.map(entry => entry.greetingVersion), ["local-v1", undefined, "local-week-v1"]);
      assert.equal(output.includes(token) || output.includes(apiKey), false);
      const privacy = connectPostgres(target.toString());
      try { assert.deepEqual(await scanPatientDataCanaries(privacy, [
        { label: "admin_token", value: token }, { label: "cliniko_key", value: apiKey }]),
      { ok: true, value: [] }); }
      finally { await privacy.destroy(); }
      assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), [
        { label: "admin_token", value: token }, { label: "cliniko_key", value: apiKey }]), []);
    } finally {
      await stop();
      try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); }
      finally { await admin.destroy(); }
    }
  });
