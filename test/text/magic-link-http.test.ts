import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import test from "node:test";
import { ok, err } from "../../src/core/model.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { MagicLinkIdentity, newIdentitySecret } from "../../src/standalone/identity/magic-link.ts";
import { identityCookieNames } from "../../src/standalone/identity/magic-link-http.ts";
import type { MagicLinkHttp } from "../../src/standalone/identity/magic-link-http.ts";
import { listenLoopbackServer } from "../support/listen-loopback-server.ts";
import { magicLinkDashboard } from "../support/magic-link-dashboard.ts";
import { MagicLinkFixture, syntheticAdminAccount } from "../support/magic-link-fixture.ts";

type Reply = Readonly<{ status: number; body: string; headers: IncomingHttpHeaders }>;
function send(origin: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const pending = request(`${origin}${path}`, { method: body === undefined ? "GET" : "POST", headers: {
      ...(body === undefined ? {} : { Origin: origin, "Content-Type": "application/json" }), ...headers,
    } }, response => {
      let content = ""; response.on("data", part => { content += String(part); });
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body: content, headers: response.headers }));
    });
    pending.once("error", reject); pending.setTimeout(5_000, () => pending.destroy(new Error("synthetic request deadline")));
    pending.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const cookie = (reply: Reply, name: string): string => reply.headers["set-cookie"]!.find(value => value.startsWith(`${name}=`))!.split(";")[0]!;
async function loginPage(origin: string) {
  const reply = await send(origin, "/sign-in"); assert.equal(reply.status, 200);
  const names = identityCookieNames(origin), csrf = reply.body.match(/data-csrf="([A-Za-z0-9_-]{43})"/)![1]!;
  return { csrf, Cookie: cookie(reply, names.csrf) };
}
type App = Readonly<{ origin: string; fixture: MagicLinkFixture; policy: MemoryPolicyStore; identity: MagicLinkIdentity; close: () => Promise<void> }>;
async function withApp(run: (app: App) => Promise<void>, configure?: (fixture: MagicLinkFixture, origin: string) => MagicLinkIdentity) {
  const fixture = new MagicLinkFixture(), account = syntheticAdminAccount(); fixture.accounts.set(account.email, account);
  const policy = new MemoryPolicyStore(); let application: MagicLinkHttp | undefined;
  const server = createServer((incoming, response) => application ? application.handle(incoming, response) : response.writeHead(503).end());
  try {
    const origin = await listenLoopbackServer(server);
    const identity = configure?.(fixture, origin) ?? new MagicLinkIdentity({ publicOrigin: origin, isolatedLoopback: true,
      rateKeyHex: "4".repeat(64), store: fixture, directory: fixture.directory, delivery: fixture.delivery });
    const source = new URL("../../src/standalone/dashboard/sign-in-main.ts", import.meta.url).pathname;
    application = await magicLinkDashboard(identity, policy, { dashboard: source, signIn: source });
    await run({ origin, fixture, policy, identity, close: () => application!.close() });
  } finally {
    server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await application?.close();
  }
}

test("E2E-260 HTTP magic-link preview confirmation session setting and logout use the actual actor gateway", async () => {
  await withApp(async ({ origin, fixture, policy, identity }) => {
    const anonymous = await send(origin, "/"); assert.equal(anonymous.status, 303); assert.equal(anonymous.headers.location, "/sign-in");
    assert.equal((await send(origin, "/api/settings")).status, 403);
    const page = await loginPage(origin), account = syntheticAdminAccount();
    await identity.requestLink(account.email, "synthetic-client");
    const secret = new URL(fixture.mail[0]!.link).hash.slice(1), names = identityCookieNames(origin);
    assert.equal((await send(origin, "/sign-in/confirm")).status, 200);
    assert.equal(fixture.sessions.size, 0); assert.equal(fixture.challenges.size, 1);
    const body = { csrf: page.csrf, secret }, headers = { Cookie: page.Cookie };
    const inspected = await send(origin, "/sign-in/inspect", body, headers);
    assert.equal(inspected.status, 200); assert.deepEqual(JSON.parse(inspected.body), { ok: true, email: account.email });
    assert.equal(fixture.sessions.size, 0);
    const signed = await send(origin, "/sign-in/redeem", body, headers); assert.equal(signed.status, 200);
    assert.deepEqual(JSON.parse(signed.body), { ok: true });
    assert.equal((await send(origin, "/sign-in/redeem", body, headers)).status, 400);
    const Cookie = cookie(signed, names.session), session = Cookie.split("=")[1]!;
    assert.notEqual(session, secret); assert.match(signed.headers["set-cookie"]![0]!, /HttpOnly; SameSite=Lax; Max-Age=28800/);
    assert.equal((await send(origin, "/api/settings", undefined, { Cookie: `${Cookie}; ${Cookie}` })).status, 403);
    assert.equal((await send(origin, "/api/settings", undefined, { Cookie: `${names.session}=${newIdentitySecret()}` })).status, 403);
    const dashboard = await send(origin, "/", undefined, { Cookie }); assert.equal(dashboard.status, 200);
    assert.ok(dashboard.body.includes('href="/sign-in/logout"'));
    for (const value of [secret, session, account.email]) assert.equal(dashboard.body.includes(value), false);
    assert.equal((await send(origin, "/api/settings/booking-enabled", { expectedVersion: "0", enabled: true }, { Cookie })).status, 200);
    const current = await policy.read(account.actor.scope); assert.ok(current.ok); assert.equal(current.value.bookingEnabled, true);
    const history = await policy.listBookingChanges(account.actor.scope); assert.ok(history.ok);
    assert.equal(history.value.entries[0]!.actorRef, account.actor.actorRef);
    fixture.revokeSession = async () => err({ kind: "identityUnavailable" });
    const failed = await send(origin, "/sign-in/logout", {}, { Cookie }); assert.equal(failed.status, 503);
    assert.equal(failed.headers["set-cookie"], undefined); assert.equal((await send(origin, "/api/settings", undefined, { Cookie })).status, 200);
    fixture.revokeSession = async digest => { fixture.sessions.delete(digest); return ok(undefined); };
    const loggedOut = await send(origin, "/sign-in/logout", {}, { Cookie }); assert.equal(loggedOut.status, 200);
    assert.match(loggedOut.headers["set-cookie"]![0]!, /Max-Age=0/);
    assert.equal((await send(origin, "/api/settings", undefined, { Cookie })).status, 403);
  });
});

test("HTTP sign-in refuses forged Host Origin CSRF roles return URLs and unbounded shapes before delivery", async () => {
  await withApp(async ({ origin, fixture }) => {
    const page = await loginPage(origin), body = { csrf: page.csrf, email: "owner@example.test" };
    for (const headers of [{ Host: "foreign.example" }, { Origin: "https://foreign.example" }, { Origin: "" },
      { Cookie: "" }, { Cookie: `${page.Cookie}; ${page.Cookie}` }, { "Content-Type": "text/plain" }]) {
      const response = await send(origin, "/sign-in/request", body, { Cookie: page.Cookie, ...headers });
      assert.ok([400, 403].includes(response.status));
    }
    for (const invalid of [{ ...body, csrf: newIdentitySecret() }, { ...body, role: "clinicAdmin" }, { ...body, returnTo: "https://foreign.example" },
      { ...body, email: "x".repeat(3_000) }, { ...body, email: 12 }, [body]]) {
      assert.ok([400, 403].includes((await send(origin, "/sign-in/request", invalid, { Cookie: page.Cookie })).status));
    }
    for (const path of ["/sign-in?returnTo=https://foreign.example", "/sign-in/confirm?token=forged", "/sign-in/redeem?secret=forged"]) {
      assert.equal((await send(origin, path)).status, 400);
    }
    assert.equal((await send(origin, "/sign-in/redeem", { csrf: page.csrf, secret: newIdentitySecret(), role: "clinicAdmin" }, { Cookie: page.Cookie })).status, 400);
    assert.equal((await send(origin, "/sign-in/logout", {}, { Origin: "https://foreign.example" })).status, 403);
    assert.equal(fixture.rateKeys.length, 0); assert.equal(fixture.mail.length, 0); assert.equal(fixture.sessions.size, 0);
  });
});

test("HTTP public request completes while directory is stalled and its transient queue is bounded and drained", async () => {
  let release: () => void = () => {}, lookups = 0;
  let paused = new Promise<void>(resolve => { release = resolve; });
  await withApp(async ({ origin, fixture, close }) => {
    const page = await loginPage(origin);
    try {
      const replies = await Promise.all(Array.from({ length: 25 }, (_, index) => send(origin, "/sign-in/request",
        { csrf: page.csrf, email: `unknown-${index}@example.test` }, { Cookie: page.Cookie, "X-Forwarded-For": `forged-${index}` })));
      assert.ok(replies.every(reply => reply.status === 200 && reply.body === replies[0]!.body));
      assert.equal(lookups, 4); assert.equal(fixture.mail.length, 0);
      release();
      // This fixture's ports resolve in microtasks; one event-loop turn drains all accepted work.
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(lookups, 20, "five requests above the twenty-request capacity must be discarded");
      assert.equal(fixture.rateKeys.length, 20);
      paused = new Promise<void>(resolve => { release = resolve; });
      await Promise.all(Array.from({ length: 25 }, (_, index) => send(origin, "/sign-in/request",
        { csrf: page.csrf, email: `next-${index}@example.test` }, { Cookie: page.Cookie })));
      assert.equal(lookups, 24);
      let closed = false; const shutdown = close().then(() => { closed = true; });
      assert.equal(closed, false); release(); await shutdown;
      assert.equal(lookups, 24, "shutdown drops pending requests rather than sending later");
      assert.equal(closed, true); assert.equal(fixture.rateKeys.length, 24);
    } finally { release(); }
  }, (fixture, origin) => new MagicLinkIdentity({ publicOrigin: origin, isolatedLoopback: true, rateKeyHex: "4".repeat(64),
    store: fixture, delivery: fixture.delivery, directory: {
      findByEmail: async () => { lookups++; await paused; return ok(undefined); }, findByRef: async () => ok(undefined),
    } }));
});

test("HTTP current membership revocation and staff roles cannot retain administrator authority", async () => {
  await withApp(async ({ origin, fixture, identity }) => {
    const account = syntheticAdminAccount(), names = identityCookieNames(origin);
    fixture.accounts.set(account.email, { ...account, actor: { ...account.actor, role: "staff" } });
    await identity.requestLink(account.email, "client");
    const staff = await identity.redeemLink(new URL(fixture.mail[0]!.link).hash.slice(1)); assert.ok(staff.ok);
    const Cookie = `${names.session}=${staff.value}`;
    assert.equal((await send(origin, "/api/settings", undefined, { Cookie })).status, 200);
    assert.equal((await send(origin, "/api/settings/booking-enabled", { expectedVersion: "0", enabled: true },
      { Cookie, "X-Actor-Role": "clinicAdmin" })).status, 403);
    fixture.accounts.set(account.email, account);
    assert.equal((await send(origin, "/api/settings", undefined, { Cookie })).status, 403);
    await identity.requestLink(account.email, "client");
    const admin = await identity.redeemLink(new URL(fixture.mail.at(-1)!.link).hash.slice(1)); assert.ok(admin.ok);
    fixture.accounts.clear();
    assert.equal((await send(origin, "/api/settings", undefined, { Cookie: `${names.session}=${admin.value}` })).status, 403);
  });
});
