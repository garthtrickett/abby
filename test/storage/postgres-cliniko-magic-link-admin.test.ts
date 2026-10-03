import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";
import { sql } from "kysely";
import { ok, err } from "../../src/core/model.ts";
import { createStandaloneClinikoMagicLinkAdmin } from "../../src/standalone/cliniko-magic-link-admin.ts";
import type { ClinikoMagicLinkAdminConfig } from "../../src/standalone/cliniko-magic-link-admin.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { syntheticAdminAccount } from "../support/magic-link-fixture.ts";
import { listenLoopbackServer } from "../support/listen-loopback-server.ts";

assert.equal(process.env.ABBY_ISOLATED_POSTGRES_PROBE, "1", "composition checks require an isolated PostgreSQL run");
const origin = "https://admin.example.test", account = syntheticAdminAccount();
const source = new URL("../../src/standalone/dashboard/sign-in-main.ts", import.meta.url).pathname;
function config(db: ClinikoMagicLinkAdminConfig["db"]): ClinikoMagicLinkAdminConfig {
  return { db, scope: account.actor.scope, publicOrigin: origin, rateKeyHex: "4".repeat(64),
    apiKey: "synthetic-key-au5", contactEmail: "test@example.test", bundlePath: source, signInBundlePath: source,
    route: { accountRef: `AC${"1".repeat(32)}`, dialedNumber: "+6125550199", routeVersion: "synthetic-260" },
    directory: { findByEmail: async () => ok(account), findByRef: async () => ok(account) },
    delivery: { send: async () => ok(undefined) }, fetch: async () => { throw new Error("unexpected provider access"); } };
}
function send(target: string, path: string, body?: unknown, Cookie?: string): Promise<{ status: number; body: string; cookie?: string }> {
  return new Promise((resolve, reject) => {
    const pending = request(`${target}${path}`, { method: body === undefined ? "GET" : "POST", headers: {
      Host: new URL(origin).host, Origin: origin, "Content-Type": "application/json", ...(Cookie ? { Cookie } : {}),
    } }, response => {
      let content = ""; response.on("data", part => { content += String(part); });
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body: content,
        ...(response.headers["set-cookie"]?.[0] ? { cookie: response.headers["set-cookie"][0].split(";")[0]! } : {}) }));
      response.once("error", reject);
    });
    pending.once("error", reject); pending.setTimeout(5_000, () => pending.destroy(new Error("synthetic HTTP deadline")));
    pending.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test("E2E-260 standalone composition denies foreign directory membership before email or session authority", async () => {
  await withDisposablePostgres(async db => {
    for (const field of ["tenantId", "clinicId", "locationId"] as const) {
      let mail = 0, lookups = 0;
      const foreign = { ...account, actor: { ...account.actor, scope: { ...account.actor.scope, [field]: "foreign" } } };
      const prepared = await createStandaloneClinikoMagicLinkAdmin({ ...config(db),
        directory: { findByEmail: async () => { lookups++; return ok(foreign); }, findByRef: async () => ok(foreign) },
        delivery: { send: async () => { mail++; return ok(undefined); } } });
      assert.ok(prepared.ok); const app = prepared.value, server = createServer(app.handle);
      try {
        const target = await listenLoopbackServer(server), page = await send(target, "/sign-in"); assert.equal(page.status, 200);
        const csrf = page.body.match(/data-csrf="([A-Za-z0-9_-]{43})"/)![1]!;
        const reply = await send(target, "/sign-in/request", { csrf, email: account.email }, page.cookie);
        assert.equal(reply.status, 200);
        assert.deepEqual(JSON.parse(reply.body), { ok: true, message: "If this account can sign in, check your email for a link." });
        await app.close(); assert.equal(lookups, 1); assert.equal(mail, 0);
        const rows = await sql<{ count: number }>`select count(*)::integer as count from admin_sign_in_challenges`.execute(db);
        assert.equal(rows.rows[0]!.count, 0);
        assert.equal((await send(target, "/api/settings")).status, 403);
      } finally {
        server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
        await app.close();
      }
    }
  });
});

test("E2E-260 standalone composition retains typed startup failures and refuses insecure or missing assets", async () => {
  await withDisposablePostgres(async db => {
    const input = config(db);
    for (const publicOrigin of ["http://127.0.0.1:1234", "https://admin.example.test:0", "https://admin.example.test/return"]) {
      assert.deepEqual(await createStandaloneClinikoMagicLinkAdmin({ ...input, publicOrigin }), err({ kind: "invalidConfig" }));
    }
    assert.deepEqual(await createStandaloneClinikoMagicLinkAdmin({ ...input, signInBundlePath: `${source}.missing` }), err({ kind: "dashboardUnavailable" }));
    await db.destroy();
    assert.deepEqual(await createStandaloneClinikoMagicLinkAdmin(input), err({ kind: "storageFailure" }));
  });
});
