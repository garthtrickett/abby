import assert from "node:assert/strict";
import { request } from "node:http";
import { spawnSync } from "node:child_process";
import type { Server } from "node:http";
import test from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { createDashboardServer, createHostAuthenticatedDashboardServer } from "../../src/standalone/dashboard/server.ts";
import { listenLoopbackServer } from "../support/listen-loopback-server.ts";

const bundle = new URL("../../src/standalone/dashboard/cliniko-admin-main.ts", import.meta.url).pathname;

function send(origin: string, path: string, headers: Record<string, string> = {}, command?: object, includeOrigin = true):
  Promise<Readonly<{ status: number; body: string }>> {
  return new Promise((resolve, reject) => {
    const pending = request(`${origin}${path}`, { method: command ? "POST" : "GET",
      headers: { Cookie: "session=owner", ...(command ? { "Content-Type": "application/json", ...(includeOrigin ? { Origin: origin } : {}) } : {}),
        ...headers } }, response => {
      let body = "";
      response.on("data", chunk => { body += String(chunk); });
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    pending.once("error", reject);
    pending.setTimeout(5_000, () => pending.destroy(new Error("dashboard request timed out")));
    pending.end(command ? JSON.stringify(command) : undefined);
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("E2E-249 concurrent dashboard listeners own their ports and reject crossed Host, Origin and roles", async t => {
  const policy = new MemoryPolicyStore("execute", undefined, async () => ok(true));
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const scopes = ["left", "right"].map(clinicId => ({ tenantId: "listener-test", clinicId, locationId: "main" }));
  let identityReads = 0;
  const servers = await Promise.all(scopes.map(scope => createHostAuthenticatedDashboardServer({
    publicOrigin: "http://127.0.0.1:0", surface: "availabilitySetup",
    resolveActor: incoming => {
      identityReads += 1;
      return incoming.headers.cookie === "session=owner" ? { actorRef: "owner", role: "clinicAdmin", scope }
        : incoming.headers.cookie === "session=staff" ? { actorRef: "staff", role: "staff", scope } : null;
    },
    gatewayFor: actor => new CommandGateway(actor, policy, reception),
  }, bundle)));
  for (const server of servers) t.after(() => close(server));
  const [left, right] = await Promise.all(servers.map(listenLoopbackServer));
  assert.ok(left && right);
  assert.notEqual(left, right);
  const change = { expectedVersion: "0", enabled: true };
  const before = identityReads;
  for (const host of [new URL(right).host, "127.0.0.1:0", `localhost:${new URL(left).port}`]) {
    assert.equal((await send(left, "/api/settings", { Host: host })).status, 403);
  }
  assert.equal(identityReads, before, "crossed Host reached the identity resolver");
  for (const origin of [right, "http://127.0.0.1:0", "null", ""]) {
    assert.equal((await send(left, "/api/settings/automation-enabled", { Origin: origin }, change)).status, 403);
  }
  assert.equal((await send(left, "/api/settings/automation-enabled", { Cookie: "session=staff" }, change)).status, 403);
  assert.equal((await send(left, "/api/settings", { Cookie: "" })).status, 403);
  assert.equal((await send(left, "/api/settings/automation-enabled", {}, change)).status, 200);
  const leftPolicy = await policy.read(scopes[0]!);
  const rightPolicy = await policy.read(scopes[1]!);
  assert.ok(leftPolicy.ok && rightPolicy.ok);
  assert.equal(leftPolicy.value.automationEnabled, true);
  assert.equal(rightPolicy.value.automationEnabled, false);
  // Forwarding headers cannot replace the listener's own Host/Origin tuple.
  const rightSettings = await send(right, "/api/settings", { "X-Forwarded-Host": new URL(left).host,
    "X-Forwarded-Proto": "https" });
  assert.equal(rightSettings.status, 200);
  assert.equal(JSON.parse(rightSettings.body).value.policy.scope.clinicId, "right");
  const history = await policy.listAutomationChanges(scopes[0]!);
  assert.ok(history.ok);
  assert.equal(history.value.entries.length, 1);
});

test("E2E-249 ephemeral origins are loopback HTTP only and fixed HTTPS host authentication remains exact", async t => {
  const scope = { tenantId: "fixed-origin", clinicId: "clinic", locationId: "main" };
  const actor = { actorRef: "owner", role: "clinicAdmin" as const, scope };
  const policy = new MemoryPolicyStore("execute", undefined, async () => ok(true));
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const identity = { resolveActor: () => actor, gatewayFor: () => new CommandGateway(actor, policy, reception) };
  for (const publicOrigin of ["https://admin.example.test:0", "https://127.0.0.1:0", "http://localhost:0"]) {
    await assert.rejects(createHostAuthenticatedDashboardServer({ ...identity, publicOrigin }, bundle), RangeError);
  }
  const server = await createHostAuthenticatedDashboardServer({ ...identity, publicOrigin: "https://admin.example.test" }, bundle);
  t.after(() => close(server));
  const origin = await listenLoopbackServer(server);
  const command = { expectedVersion: "0", enabled: true };
  assert.equal((await send(origin, "/api/settings")).status, 403);
  assert.equal((await send(origin, "/api/settings/automation-enabled", {
    Host: "admin.example.test", Origin: "http://admin.example.test" }, command)).status, 403);
  assert.equal((await send(origin, "/api/settings/automation-enabled", {
    Host: "admin.example.test", Origin: "https://admin.example.test" }, command)).status, 200);
});

test("E2E-252 cancellation edits use the configured HTTPS host origin exactly", async t => {
  const scope = { tenantId: "cancellation-https", clinicId: "clinic", locationId: "main" };
  const actor = { actorRef: "https-owner", role: "clinicAdmin" as const, scope };
  const policy = new MemoryPolicyStore();
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const server = await createHostAuthenticatedDashboardServer({ publicOrigin: "https://admin.example.test",
    resolveActor: () => actor, gatewayFor: () => new CommandGateway(actor, policy, reception),
  }, bundle);
  t.after(() => close(server));
  const origin = await listenLoopbackServer(server);
  const path = "/api/settings/cancellation-enabled";
  const command = { expectedVersion: "0", enabled: true };
  for (const rejected of ["http://admin.example.test", "https://foreign.example.test", "null"]) {
    assert.equal((await send(origin, path, { Host: "admin.example.test", Origin: rejected,
      "X-Forwarded-Proto": "https" }, command)).status, 403);
  }
  assert.equal((await send(origin, path, { Host: "foreign.example.test",
    Origin: "https://admin.example.test" }, command)).status, 403);
  assert.equal((await send(origin, path, { Host: "admin.example.test",
    Origin: "https://admin.example.test" }, command)).status, 200);
  const current = await policy.read(scope);
  assert.ok(current.ok);
  assert.equal(current.value.policyVersion, "1");
  assert.equal(current.value.cancellationEnabled, true);
  const audit = await send(origin, "/api/settings/cancellation-audit", { Host: "admin.example.test" });
  assert.equal(audit.status, 200);
  assert.deepEqual(JSON.parse(audit.body).value.page.entries.map((row: { actorRef: string; previousEnabled: boolean }) =>
    [row.actorRef, row.previousEnabled]), [["https-owner", false]]);
});

test("E2E-253 E2E-254 every dashboard writer uses the configured HTTPS origin before parsing input", async t => {
  const scope = { tenantId: "all-writers-https", clinicId: "clinic", locationId: "main" };
  const policy = new MemoryPolicyStore();
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const server = await createHostAuthenticatedDashboardServer({ publicOrigin: "https://admin.example.test",
    resolveActor: incoming => incoming.headers.cookie === "session=owner"
      ? { actorRef: "https-owner", role: "clinicAdmin", scope }
      : incoming.headers.cookie === "session=staff" ? { actorRef: "https-staff", role: "staff", scope } : null,
    gatewayFor: actor => new CommandGateway(actor, policy, reception),
  }, bundle);
  t.after(() => close(server));
  const origin = await listenLoopbackServer(server);
  const headers = { Host: "admin.example.test", Origin: "https://admin.example.test" };
  const writers = ["/api/clinic-availability/command", "/api/settings/booking-enabled", "/api/settings/cancellation-enabled", "/api/settings/rescheduling-enabled",
    "/api/settings/after-hours", "/api/settings/urgent", "/api/settings/staff-schedule", "/api/settings/greeting",
    "/api/settings/automation-enabled", "/api/knowledge/draft", "/api/knowledge/approve", "/api/knowledge/revoke",
    "/api/writes/stop", "/api/writes/resume", "/api/staff/change"];
  for (const path of writers) {
    for (const rejected of ["http://admin.example.test", "https://foreign.example.test", "null", ""]) {
      assert.equal((await send(origin, path, { ...headers, Origin: rejected,
        "X-Forwarded-Proto": "https" }, {})).status, 403, `${path}: rejected Origin`);
    }
    assert.equal((await send(origin, path, { ...headers, Host: "foreign.example.test" }, {})).status, 403);
    assert.equal((await send(origin, path, { ...headers, Cookie: "" }, {})).status, 403);
    assert.equal((await send(origin, path, headers, {})).status, 400,
      `${path}: configured Origin must reach input validation`);
  }
  const command = { expectedVersion: "0", enabled: true };
  assert.equal((await send(origin, "/api/settings/booking-enabled", { ...headers, Cookie: "session=staff" }, command)).status, 403);
  assert.equal((await send(origin, "/api/settings/booking-enabled", headers, command)).status, 200);
  const changed = await policy.read(scope);
  assert.ok(changed.ok);
  assert.equal(changed.value.policyVersion, "1");
  assert.equal(changed.value.bookingEnabled, true);
  assert.equal((await send(origin, "/api/settings/booking-enabled", headers,
    { expectedVersion: "1", enabled: false })).status, 200);
  const history = await policy.listBookingChanges(scope);
  assert.ok(history.ok);
  assert.deepEqual(history.value.entries.map(row => [row.version, row.enabled, row.actorRef]),
    [["1", true, "https-owner"], ["2", false, "https-owner"]]);
});

test("E2E-253 E2E-254 local reference origin omission and supervised setup restrictions survive the shared guard", async t => {
  const scope = { tenantId: "origin-profile-compat", clinicId: "clinic", locationId: "main" };
  const actor = { actorRef: "local-owner", role: "clinicAdmin" as const, scope };
  const policy = new MemoryPolicyStore();
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const gateway = new CommandGateway(actor, policy, reception);
  const local = await createDashboardServer(gateway, bundle);
  t.after(() => close(local));
  const localOrigin = await listenLoopbackServer(local);
  assert.equal((await send(localOrigin, "/api/settings/booking-enabled", {},
    { expectedVersion: "0", enabled: true }, false)).status, 200);
  assert.equal((await send(localOrigin, "/api/settings/booking-enabled", { Origin: "https://foreign.example.test" },
    { expectedVersion: "1", enabled: false })).status, 403);
  assert.equal((await send(localOrigin, "/api/settings/booking-enabled", {},
    { expectedVersion: "1", enabled: false })).status, 200);
  const setup = await createHostAuthenticatedDashboardServer({ publicOrigin: "https://setup.example.test",
    surface: "availabilitySetup", resolveActor: () => actor, gatewayFor: () => gateway,
  }, bundle);
  t.after(() => close(setup));
  const setupOrigin = await listenLoopbackServer(setup);
  const headers = { Host: "setup.example.test", Origin: "https://setup.example.test" };
  for (const path of ["/api/settings/booking-enabled", "/api/settings/cancellation-enabled", "/api/settings/rescheduling-enabled", "/api/staff/change"]) {
    assert.equal((await send(setupOrigin, path, headers, { expectedVersion: "2", enabled: true })).status, 404);
  }
  assert.equal((await send(setupOrigin, "/api/settings/greeting", headers,
    { kind: "settings.routing.greeting.change.v1", expectedVersion: "2", enabled: false })).status, 200);
  const current = await policy.read(scope);
  assert.ok(current.ok);
  assert.equal(current.value.policyVersion, "3");
  assert.equal(current.value.bookingEnabled, false);
  assert.equal(current.value.cancellationEnabled, false);
});

test("E2E-249 local admin port zero refuses startup outside the isolated probe", () => {
  const result = spawnSync(process.execPath, ["scripts/serve-cliniko-admin.ts"], {
    cwd: new URL("../../", import.meta.url),
    env: { PATH: process.env.PATH, ABBY_ADMIN_PORT: "0" }, encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^invalid ABBY_ADMIN_PORT\n$/);
});
