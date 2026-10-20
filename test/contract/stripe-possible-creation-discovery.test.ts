import assert from "node:assert/strict";
import test from "node:test";
import { StripeCheckoutDiscovery } from "../../src/stripe/checkout-discovery.ts";

const now = 1_792_190_000_000, from = 1_792_000_000;
const config = { apiKey: "sk_test_synthetic12345678", accountRef: "acct_synthetic", connected: true,
  livemode: false, apiVersion: "2025-06-30.basil", clock: () => now };
const binding = { actionRef: "12345678-abcd-4321-abcd-123456789abc", amount: 2500, currency: "nzd", createdFrom: from, createdTo: from + 86_400 };
const row = (id: string, created: number, matches = true) => ({ object: "checkout.session", id, created, mode: "payment", livemode: false,
  client_reference_id: matches ? binding.actionRef : null, amount_total: binding.amount, currency: binding.currency,
  customer_email: "private-patient@example.invalid", metadata: { patient: "private-patient" } });
const page = (data: unknown[], has_more = false) => ({ object: "list", url: "/v1/checkout/sessions", data, has_more });
type Read = (url: URL) => Response | Promise<Response>;
function fixture(read: Read, options: { clock?: () => number; deadlineMs?: number; account?: string } = {}) {
  const urls: URL[] = [], signals: AbortSignal[] = [];
  const discovery = new StripeCheckoutDiscovery({ ...config, ...(options.clock ? { clock: options.clock } : {}),
    ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}) }, async (input, init) => {
    const url = new URL(String(input)); urls.push(url);
    assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal); signals.push(init.signal);
    assert.equal(new Headers(init.headers).get("Stripe-Account"), config.accountRef);
    return url.pathname === "/v1/account" ? Response.json({ object: "account", id: options.account ?? config.accountRef }) : read(url);
  });
  return { discovery, urls, signals };
}
const signal = () => new AbortController().signal;
const start = (url: URL) => Number(url.searchParams.get("created[gte]"));
const end = (url: URL) => Number(url.searchParams.get("created[lte]"));

test("possible creation covers the entire retained 24-hour range, including its last second, under one account scope", async () => {
  const f = fixture(url => Response.json(page(start(url) <= binding.createdTo && end(url) === binding.createdTo ? [row("cs_test_last_second", binding.createdTo)] : [])));
  assert.deepEqual(await f.discovery.findPossibleCreation(binding, signal()), { ok: true, value: {
    kind: "observed", checkoutRef: "cs_test_last_second", observedAt: new Date(now).toISOString() } });
  const windows = f.urls.slice(1); assert.equal(windows.length, 24); assert.equal(start(windows[0]!), from); assert.equal(end(windows.at(-1)!), binding.createdTo);
  for (let i = 0; i < windows.length; i++) {
    assert.ok(end(windows[i]!) - start(windows[i]!) <= 3_600);
    if (i) assert.equal(start(windows[i]!), end(windows[i - 1]!) + 1, "inclusive windows have no gaps or overlap");
  }
  assert.equal(f.urls.filter(u => u.pathname === "/v1/account").length, 1);
  assert.ok(f.signals.every(s => s === f.signals[0]), "the entire discovery shares one deadline and abort signal");
});

test("a same-action candidate in a later hour makes the whole possible creation ambiguous", async () => {
  const f = fixture(url => Response.json(page(start(url) === from || end(url) === binding.createdTo ? [row(`cs_test_${start(url)}`, start(url))] : [])));
  assert.deepEqual(await f.discovery.findPossibleCreation(binding, signal()), { ok: false, error: { kind: "ambiguous" } });
  assert.equal(f.urls.length, 25, "an early candidate cannot short-circuit later windows");
});

for (const fault of ["failed", "outsideWindow", "wrongAmount", "wrongMode"] as const)
test(`a later ${fault} window discards an earlier possible-creation candidate`, async () => {
  const f = fixture(url => {
    if (start(url) === from) return Response.json(page([row("cs_test_first", from)]));
    if (end(url) !== binding.createdTo) return Response.json(page([]));
    if (fault === "failed") return new Response("private failure", { status: 500 });
    const last = row("cs_test_invalid", fault === "outsideWindow" ? start(url) - 1 : start(url));
    return Response.json(page([{ ...last, ...(fault === "wrongAmount" ? { amount_total: 2400 } : {}), ...(fault === "wrongMode" ? { livemode: true } : {}) }]));
  });
  const result = await f.discovery.findPossibleCreation(binding, signal()); assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /cs_test|private|patient|metadata/);
});

test("each hour resets its pagination cursor and incomplete later history cannot release an earlier match", async () => {
  let pages = 0;
  const f = fixture(url => {
    if (start(url) === from) return Response.json(page([row("cs_test_first", from)]));
    if (start(url) !== from + 3_601) return Response.json(page([]));
    const cursor = url.searchParams.get("starting_after");
    assert.equal(cursor, pages ? `cs_test_page${pages}` : null); pages++;
    return Response.json(page([row(`cs_test_page${pages}`, start(url), false)], true));
  });
  assert.deepEqual(await f.discovery.findPossibleCreation(binding, signal()), { ok: false, error: { kind: "unavailable" } });
  assert.equal(pages, 10); assert.equal(f.urls.length, 12);
});

test("the complete 24-hour page bound can scan 24000 rows without exposing account data or authorizing an effect", async () => {
  const pages = new Map<number, number>();
  const f = fixture(url => {
    const first = start(url), n = (pages.get(first) ?? 0) + 1; pages.set(first, n);
    return Response.json(page(Array.from({ length: 100 }, (_, i) => row(`cs_test_${first}_${n}_${i}`, first, false)), n < 10));
  });
  assert.deepEqual(await f.discovery.findPossibleCreation(binding, signal()), { ok: true, value: { kind: "notObserved", observedAt: new Date(now).toISOString() } });
  assert.equal(f.urls.length, 241); assert.equal(pages.size, 24); assert.ok([...pages.values()].every(n => n === 10));
  assert.equal(JSON.stringify(f.discovery), "{}");
});

test("possible creation has one cumulative deadline, not a fresh allowance per hour", async () => {
  let clock = now;
  const f = fixture(url => { clock += 4_000; return Response.json(page(start(url) === from ? [row("cs_test_early", from)] : [])); }, { clock: () => clock });
  assert.deepEqual(await f.discovery.findPossibleCreation({ ...binding, createdTo: from + 7_202 }, signal()), { ok: false, error: { kind: "unavailable" } });
  assert.equal(f.urls.length, 4);
});

test("held later windows and caller cancellation never return an early candidate", async () => {
  for (const abort of [false, true]) {
    const controller = new AbortController();
    const f = fixture(url => {
      if (start(url) === from) return Response.json(page([row("cs_test_early", from)]));
      if (abort) controller.abort(); return new Promise<Response>(() => {});
    }, { deadlineMs: 30 });
    assert.deepEqual(await f.discovery.findPossibleCreation(binding, controller.signal), { ok: false, error: { kind: "unavailable" } });
    assert.equal(f.urls.length, 3);
  }
});

test("the ordinary one-hour API stays bounded and an invalid possible range performs no I/O", async () => {
  const f = fixture(() => Response.json(page([])));
  assert.deepEqual(await f.discovery.find(binding, signal()), { ok: false, error: { kind: "invalidBinding" } });
  for (const bad of [{ ...binding, createdTo: binding.createdTo + 1 }, { ...binding, createdFrom: -1 }, { ...binding, createdTo: from - 1 }])
    assert.deepEqual(await f.discovery.findPossibleCreation(bad, signal()), { ok: false, error: { kind: "invalidBinding" } });
  assert.equal(f.urls.length, 0);
});
