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

test("E2E-214 loopback admin authenticates an owner and persists read-only approval across listener restart",
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
      const capabilities = await fetch(`${origin}/api/capabilities`, { headers: { Authorization: basic } });
      assert.equal(capabilities.status, 200);
      const listed = await capabilities.json() as { value: { id: string }[] };
      assert.ok(listed.value.length > 0);
      assert.ok(listed.value.every(item => item.id === "settings.read.v1" || item.id.startsWith("clinic.availability.")));
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
      await stop();

      await launch();
      const current = await command({ kind: "clinic.availability.approval.read.v1" });
      assert.equal(current.status, 200);
      const state = await current.json() as { value: { state: { version: number; approval: unknown } } };
      assert.equal(state.value.state.version, 1);
      assert.ok(state.value.state.approval);
      assert.equal((await command({ kind: "clinic.availability.approval.revoke.v1",
        expectedVersion: 1 })).status, 200);
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
