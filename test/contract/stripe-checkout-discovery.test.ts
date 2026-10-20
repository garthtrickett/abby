import assert from "node:assert/strict";
import test from "node:test";
import { StripeCheckoutDiscovery } from "../../src/stripe/checkout-discovery.ts";

const now = 1_792_190_000_000;
const config = { apiKey: "sk_test_synthetic12345678", accountRef: "acct_synthetic", connected: true,
  livemode: false, apiVersion: "2025-06-30.basil", clock: () => now };
const binding = { actionRef: "12345678-abcd-4321-abcd-123456789abc", amount: 2500, currency: "nzd", createdFrom: 1_792_180_000, createdTo: 1_792_180_100 };
const row = (id = "cs_test_exact", action: string | null = binding.actionRef) => ({ object: "checkout.session", id,
  mode: "payment", livemode: false, created: binding.createdFrom + 50, client_reference_id: action, amount_total: 2500,
  currency: "nzd", customer_email: "private-patient@example.test", metadata: { patient: "private-patient" } });
const page = (data: unknown[], has_more = false) => ({ object: "list", url: "/v1/checkout/sessions", data, has_more });
const signal = () => new AbortController().signal;
function fixture(pages: unknown[], options: { account?: string; mode?: boolean } = {}) {
  const calls: URL[] = [], methods: string[] = [];
  const discovery = new StripeCheckoutDiscovery({ ...config, livemode: options.mode ?? false }, async (url, init) => {
    const target = new URL(String(url)); calls.push(target); methods.push(init!.method!);
    return Response.json(target.pathname === "/v1/account" ? { object: "account", id: options.account ?? config.accountRef } : pages.shift());
  });
  return { discovery, calls, methods };
}

test("Stripe discovery scans the entire original account/window before returning one exact action candidate", async () => {
  const f = fixture([page([row(), row("cs_test_other", null)], true), page([row("cs_test_last", "other-action")])]);
  const result = await f.discovery.find(binding, signal()); assert.ok(result.ok && result.value.kind === "observed");
  assert.equal(result.value.checkoutRef, "cs_test_exact"); assert.equal(f.calls.length, 3);
  assert.ok(Object.isFrozen(result.value)); assert.doesNotMatch(JSON.stringify(result), /private-|patient|metadata|amount|recipient/);
  assert.ok(f.methods.every(method => method === "GET"));
  for (const url of f.calls.slice(1)) {
    assert.equal(url.origin, "https://api.stripe.com"); assert.equal(url.pathname, "/v1/checkout/sessions");
    assert.equal(url.searchParams.get("created[gte]"), String(binding.createdFrom));
    assert.equal(url.searchParams.get("created[lte]"), String(binding.createdTo)); assert.equal(url.searchParams.get("limit"), "100");
    assert.equal(url.searchParams.has("client_reference_id"), false); assert.equal(url.searchParams.has("metadata"), false);
    assert.equal(url.searchParams.has("status"), false, "paid and expired Sessions must not be hidden");
    assert.ok([...url.searchParams.keys()].every(key => ["limit", "created[gte]", "created[lte]", "starting_after"].includes(key)));
  }
  assert.equal(f.calls[2]!.searchParams.get("starting_after"), "cs_test_other");
  assert.equal(JSON.stringify(f.discovery), "{}");
});

test("Stripe discovery does not use phone/latest fallback and a complete miss grants no create permission", async () => {
  const f = fixture([page([{ ...row("cs_test_newer", "another-action"), customer_email: "same-patient@example.test" }])]);
  assert.deepEqual(await f.discovery.find(binding, signal()), { ok: true, value: { kind: "notObserved", observedAt: new Date(now).toISOString() } });
  assert.ok(f.methods.every(m => m === "GET"));
});

test("Stripe discovery refuses competing same-action Sessions instead of choosing the latest or paid one", async () => {
  const f = fixture([page([row()], true), page([{ ...row("cs_test_second"), status: "expired", payment_status: "unpaid" }])]);
  assert.deepEqual(await f.discovery.find(binding, signal()), { ok: false, error: { kind: "ambiguous" } });
});

test("Stripe discovery never releases a partial candidate after truncation, duplicate cursor, bad scope or wrong amount", async () => {
  for (const pages of [
    [page([row()], true), page([], true)], [page([row()], true), page([row()])],
    [page([row()], true), { ...page([]), has_more: "false" }],
    [page([{ ...row(), amount_total: 2499 }])], [page([{ ...row(), currency: "gbp" }])],
    [page([{ ...row(), livemode: true }])], [page([{ ...row(), created: binding.createdTo + 1 }])],
    [page([{ ...row(), mode: "subscription" }])], [page([{ ...row(), client_reference_id: [binding.actionRef] }])],
    [{ ...page([row()]), url: "https://foreign.test/private" }], [page(Array(101).fill(row()))],
  ]) {
    const f = fixture(pages); assert.equal((await f.discovery.find(binding, signal())).ok, false); assert.ok(f.methods.every(m => m === "GET"));
  }
});

test("Stripe discovery page bound refuses incomplete history even after a candidate was observed", async () => {
  const pages = Array.from({ length: 10 }, (_, i) => page([row(`cs_test_page${i}`, i === 0 ? binding.actionRef : null)], true));
  const f = fixture(pages);
  assert.deepEqual(await f.discovery.find(binding, signal()), { ok: false, error: { kind: "unavailable" } });
  assert.equal(f.calls.length, 11);
});

test("Stripe discovery discards an earlier match when a later page ignores cancellation or fails", async () => {
  for (const mode of ["held", "failed"] as const) {
    let calls = 0;
    const discovery = new StripeCheckoutDiscovery({ ...config, deadlineMs: 20 }, async url => {
      calls++;
      if (String(url).endsWith("/account")) return Response.json({ object: "account", id: config.accountRef });
      if (calls === 2) return Response.json(page([row()], true));
      return mode === "held" ? new Promise<Response>(() => {}) : new Response("private-upstream-failure", { status: 500 });
    });
    assert.deepEqual(await discovery.find(binding, signal()), { ok: false, error: { kind: "unavailable" } });
    assert.equal(calls, 3);
  }
});

test("Stripe discovery pins the current account and immutable private binding and rejects invalid windows before I/O", async () => {
  const foreign = fixture([page([row()])], { account: "acct_foreign" });
  assert.deepEqual(await foreign.discovery.find(binding, signal()), { ok: false, error: { kind: "mismatched" } }); assert.equal(foreign.calls.length, 1);
  const f = fixture([]);
  for (const patch of [{ actionRef: "patient" }, { amount: 0 }, { currency: "NZD" }, { createdFrom: -1 },
    { createdTo: binding.createdFrom - 1 }, { createdTo: binding.createdFrom + 3601 }, { createdTo: NaN }]) {
    assert.deepEqual(await f.discovery.find({ ...binding, ...patch }, signal()), { ok: false, error: { kind: "invalidBinding" } });
  }
  assert.equal(f.calls.length, 0);
  const mutable = { ...binding, patient: "private-extra-patient" };
  const discovery = new StripeCheckoutDiscovery(config, async url => {
    mutable.actionRef = "changed"; mutable.amount = 1;
    return Response.json(String(url).endsWith("/account") ? { object: "account", id: config.accountRef } : page([row()]));
  });
  const r = await discovery.find(mutable, signal()); assert.ok(r.ok && r.value.kind === "observed");
  assert.doesNotMatch(JSON.stringify(r), /private-extra|patient|recipient/);
});
