import assert from "node:assert/strict";
import test from "node:test";
import { handoffFixture, webBody } from "../support/financial-webhook-handoff.ts";
import { value, stop, now, uuid } from "../support/financial-checkout-owner.ts";
import { ClinikoStripeWebhookHandoff } from "../../src/standalone/cliniko-stripe-webhook-handoff.ts";

test("raw signed notifications acknowledge only independently permitted, freshly reread native pending work", async () => {
  const f = await handoffFixture(), before = structuredClone([...f.rows]), burned = [...f.burned];
  assert.deepEqual(value(await f.accept()), { kind: "acceptedExistingPending" });
  assert.equal(f.nativeReads.filter(u => u.pathname === "/v1/recalls").length, 2);
  assert.deepEqual(f.stripeReads.map(u => u.pathname), ["/v1/account", "/v1/checkout/sessions/cs_test_owner", "/v1/account", "/v1/checkout/sessions/cs_test_owner"]);
  assert.equal(f.grants.length, 1); const q = f.grants[0]!;
  assert.equal(q.pending.pair.intent.intent.actionRef, f.intent.actionRef); assert.equal(q.pending.attempt.attempt.effectRef, f.intent.effects.checkout);
  assert.ok(Object.isFrozen(q.pending.pair.intent.intent.payment));
  assert.doesNotMatch(JSON.stringify(q.notification), /private|customer|paid|amount/);
  assert.equal("payment_status" in q.correlation, false);
  assert.deepEqual([...f.rows], before); assert.deepEqual([...f.burned], burned);
  assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
});

test("duplicates, out-of-order expiry/payment notifications and lost creation ACK do not create money or repeat effects", async () => {
  const f = await handoffFixture({ checkout: { stripe: (r, method) => { if (method === "POST") throw new Error("lost ACK"); return Response.json(r); } } });
  const before = structuredClone([...f.rows]);
  for (const type of ["checkout.session.expired", "checkout.session.async_payment_failed", "checkout.session.completed", "checkout.session.completed", "checkout.session.async_payment_succeeded"]) {
    assert.equal(value(await f.accept({ type })).kind, "acceptedExistingPending");
  }
  assert.deepEqual([...f.rows], before); assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
});

for (const denial of ["denyReference", "denyAccept", "denyPending", "denyRecord", "expire"] as const) test(`current independent ${denial} refuses acknowledgement`, async () => {
  const f = await handoffFixture(); f[denial](); assert.equal((await f.accept()).ok, false);
  if (denial === "denyReference" || denial === "expire") assert.equal(f.stripeReads.length, 0);
});

for (const id of ["30", "31", "32"]) for (const change of ["delete", "recalled", "archived"] as const) test(`${change} native record ${id} cannot be acknowledged as open pending work`, async () => {
  const f = await handoffFixture();
  if (change === "delete") f.rows.delete(id);
  else if (change === "archived") f.rows.get(id)!.archived_at = now;
  else { f.rows.get(id)!.recalled = true; f.rows.get(id)!.recalled_at = now; }
  assert.equal((await f.accept()).ok, false);
});

for (const field of ["amount", "currency", "action", "effect", "digest", "createdBefore", "createdAfter"] as const) test(`fresh Stripe ${field} mismatch cannot be acknowledged`, async () => {
  const f = await handoffFixture(), row = f.sessions[0]!, metadata = row.metadata as Record<string, unknown>;
  if (field === "amount") row.amount_total = 1;
  if (field === "currency") row.currency = "nzd";
  if (field === "action") { row.client_reference_id = uuid(99); metadata.abby_financial_action = uuid(99); }
  if (field === "effect") metadata.abby_effect = uuid(99);
  if (field === "digest") metadata.abby_intent_digest = "a".repeat(64);
  if (field === "createdBefore") row.created = Date.parse(now) / 1_000 - 100;
  if (field === "createdAfter") row.created = Date.parse(now) / 1_000 + 90_000;
  assert.equal((await f.accept()).ok, false);
});

test("native or Stripe context changed during queue acceptance is reread and refused", async () => {
  for (const change of ["native", "stripe", "grant"] as const) {
    let mutate = () => {};
    const f = await handoffFixture({ authority: { acceptsExistingPending: async () => { mutate(); return true; } } });
    mutate = () => { if (change === "native") { f.rows.get("31")!.recalled_at = now; f.rows.get("31")!.recalled = true; }
      else if (change === "stripe") f.sessions[0]!.amount_total = 1; else f.expire(); };
    assert.equal((await f.accept()).ok, false);
  }
});

test("failed, held or aborted authority never acknowledges or leaks its private diagnostics", async () => {
  for (const authority of [{ acceptsExistingPending: async () => { throw new Error("private failure canary"); } },
    { acceptsExistingPending: async () => new Promise<boolean>(() => {}) }, { allowsReferenceRead: async () => new Promise<boolean>(() => {}) }]) {
    const f = await handoffFixture({ authority, deadlineMs: 20 });
    assert.deepEqual(await f.accept(), { ok: false, error: { kind: "unavailable" } });
  }
  const f = await handoffFixture(), aborted = new AbortController(); aborted.abort();
  assert.equal((await f.accept({}, aborted.signal)).ok, false); assert.equal(f.stripeReads.length, 0);
});

test("invalid signatures, foreign accounts and versions remain refused; authentic unrelated events perform no financial I/O", async () => {
  const f = await handoffFixture(), signed = f.signed();
  assert.equal((await f.handoff.accept(webBody(signed.raw + " "), signed.signature, stop())).ok, false);
  for (const patch of [{ account: "acct_foreign" }, { livemode: true }, { api_version: "2024-01-01" }]) assert.equal((await f.accept(patch)).ok, false);
  assert.equal(value(await f.accept({ type: "customer.created" })).kind, "ignored"); assert.equal(f.stripeReads.length, 0); assert.equal(f.nativeReads.length, 0);
});

test("factory refuses cross-account/mode/version configuration and missing independent queue owner", async () => {
  const f = await handoffFixture();
  for (const stripe of [{ ...f.config.stripe, accountRef: "acct_foreign" }, { ...f.config.stripe, livemode: true }, { ...f.config.stripe, apiVersion: "2024-01-01" }]) assert.equal(f.make({ stripe }).ok, false);
  assert.equal(f.make({ webhook: { ...f.config.webhook, accountRef: null } }).ok, false);
  for (const deadlineMs of [0, 10_001, NaN]) assert.equal(f.make({ deadlineMs }).ok, false);
  for (const key of ["allowsReferenceRead", "acceptsExistingPending", "current"] as const) {
    const authority = { ...f.authority, [key]: undefined };
    assert.equal(ClinikoStripeWebhookHandoff.create(f.config, authority as unknown as typeof f.authority, f.pendingAuthority, f.nativePort, f.stripePort).ok, false);
  }
});

test("held raw bodies and late caller abort are bounded by the shared handoff lifetime", async () => {
  const f = await handoffFixture({ deadlineMs: 20 }), e = f.signed(); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}), cancel() { cancelled = true; } });
  assert.deepEqual(await f.handoff.accept(body, e.signature, stop()), { ok: false, error: { kind: "unavailable" } });
  assert.equal(cancelled, true); assert.equal(f.stripeReads.length, 0);
  let entered!: () => void; const pending = new Promise<void>(resolve => { entered = resolve; });
  const held = await handoffFixture({ authority: { acceptsExistingPending: async () => { entered(); return new Promise<boolean>(() => {}); } } });
  const abort = new AbortController(), result = held.accept({}, abort.signal); await pending; abort.abort();
  assert.deepEqual(await result, { ok: false, error: { kind: "unavailable" } });
});

const endiveSnapshotVersion = "2026-09-30.endive";
async function endiveFixture(options: Parameters<typeof handoffFixture>[0] = {}) {
  const f = await handoffFixture(options);
  const configured = f.make({ webhook: { ...f.config.webhook, apiVersion: endiveSnapshotVersion } });
  assert.ok(configured.ok, "An explicitly supported snapshot version must not require changing REST requests");
  return { ...f, configured: configured.value, acceptConfigured: (patch: Record<string, unknown> = {}) => {
    const signed = f.signed({ api_version: endiveSnapshotVersion, ...patch });
    return configured.value.accept(webBody(signed.raw), signed.signature, stop());
  } };
}

test("explicit Endive snapshots keep Basil REST reads and require unchanged independently owned pending work", async () => {
  const f = await endiveFixture(), rows = structuredClone([...f.rows]), burned = [...f.burned];
  assert.equal(f.config.stripe.apiVersion, "2025-06-30.basil");
  for (const type of ["checkout.session.completed", "checkout.session.expired", "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed", "checkout.session.expired"]) {
    assert.deepEqual(value(await f.acceptConfigured({ type })), { kind: "acceptedExistingPending" });
  }
  assert.equal(f.grants.length, 5);
  assert.ok(f.grants.every(q => q.notification.apiVersion === endiveSnapshotVersion));
  assert.ok(f.stripeReads.every(u => u.pathname === "/v1/account" || u.pathname === "/v1/checkout/sessions/cs_test_owner"));
  assert.deepEqual([...f.rows], rows); assert.deepEqual([...f.burned], burned);
  assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
});

test("configured snapshot versions remain exact and are never learned from event bodies", async () => {
  const f = await endiveFixture();
  for (const api_version of ["2025-06-30.basil", "2026-10-28.endive", "2024-01-01"]) {
    assert.deepEqual(await f.acceptConfigured({ api_version }), { ok: false, error: { kind: "unsupportedVersion" } });
  }
  assert.equal(f.nativeReads.length, 0); assert.equal(f.stripeReads.length, 0); assert.equal(f.grants.length, 0);
  const defaultProfile = await handoffFixture();
  assert.deepEqual(await defaultProfile.accept({ api_version: endiveSnapshotVersion }), { ok: false, error: { kind: "unsupportedVersion" } });
  assert.equal(defaultProfile.nativeReads.length, 0); assert.equal(defaultProfile.stripeReads.length, 0);
});

test("support for a second snapshot profile does not permit another REST version or an unreviewed snapshot profile", async () => {
  const f = await handoffFixture();
  for (const apiVersion of ["2026-10-28.endive", "2025-05-28.basil", "2024-01-01", ""]) {
    assert.deepEqual(f.make({ webhook: { ...f.config.webhook, apiVersion } }), { ok: false, error: { kind: "invalidConfig" } });
  }
  assert.deepEqual(f.make({ stripe: { ...f.config.stripe, apiVersion: endiveSnapshotVersion },
    webhook: { ...f.config.webhook, apiVersion: endiveSnapshotVersion } }), { ok: false, error: { kind: "invalidConfig" } });
});

test("Endive snapshot signature account mode and independent current grants retain their existing refusal boundaries", async () => {
  for (const denial of ["denyReference", "denyAccept", "denyPending", "denyRecord", "expire"] as const) {
    const f = await endiveFixture(); f[denial](); assert.equal((await f.acceptConfigured()).ok, false);
    if (denial === "denyReference" || denial === "expire") assert.equal(f.stripeReads.length, 0);
  }
  const f = await endiveFixture(), signed = f.signed({ api_version: endiveSnapshotVersion });
  assert.deepEqual(await f.configured.accept(webBody(signed.raw + " "), signed.signature, stop()),
    { ok: false, error: { kind: "invalidWebhook" } });
  for (const patch of [{ account: "acct_foreign" }, { livemode: true }]) {
    assert.deepEqual(await f.acceptConfigured(patch), { ok: false, error: { kind: "foreignEndpoint" } });
  }
  assert.equal(f.nativeReads.length, 0); assert.equal(f.stripeReads.length, 0);
});

test("Endive snapshot acceptance still rereads both providers and cannot acknowledge changed native work", async () => {
  let mutate = () => {};
  const f = await endiveFixture({ authority: { acceptsExistingPending: async () => { mutate(); return true; } } });
  mutate = () => { f.rows.get("31")!.archived_at = now; };
  assert.equal((await f.acceptConfigured()).ok, false);
  assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
});

test("explicit Endive direct-account snapshots preserve direct REST routing and current native handoff grants", async () => {
  const f = await handoffFixture(), reads: string[] = [];
  const direct: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers);
    assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
    assert.equal(headers.get("Stripe-Version"), "2025-06-30.basil"); assert.equal(headers.has("Stripe-Account"), false);
    assert.ok(url.pathname === "/v1/account" || url.pathname === "/v1/checkout/sessions/cs_test_owner");
    reads.push(url.pathname);
    return Response.json(url.pathname === "/v1/account" ? { object: "account", id: f.config.stripe.accountRef } : f.sessions[0]);
  };
  const configured = ClinikoStripeWebhookHandoff.create({ ...f.config, stripe: { ...f.config.stripe, connected: false },
    webhook: { ...f.config.webhook, accountRef: null, apiVersion: endiveSnapshotVersion } },
    f.authority, f.pendingAuthority, f.nativePort, direct);
  assert.ok(configured.ok);
  const signed = f.signed({ account: undefined, api_version: endiveSnapshotVersion });
  assert.deepEqual(value(await configured.value.accept(webBody(signed.raw), signed.signature, stop())), { kind: "acceptedExistingPending" });
  assert.deepEqual(reads, ["/v1/account", "/v1/checkout/sessions/cs_test_owner", "/v1/account", "/v1/checkout/sessions/cs_test_owner"]);
  assert.equal(f.grants.length, 1); assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
});
