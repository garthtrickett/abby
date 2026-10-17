import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { StripeWebhookVerifier } from "../../src/stripe/webhook.ts";

const secret = "whsec_synthetic_endpoint_secret_123456";
const now = 1_792_190_000_000, timestamp = String(now / 1_000), apiVersion = "2025-06-30.basil";
const config = { endpointSecret: secret, accountRef: "acct_synthetic", livemode: false, apiVersion, clock: () => now };
const snapshot = () => ({ id: "evt_synthetic", object: "event", type: "checkout.session.completed", created: 1,
  account: config.accountRef, livemode: false, api_version: apiVersion, data: { object: {
    object: "checkout.session", id: "cs_test_synthetic", payment_status: "unpaid",
    customer_email: "synthetic-private@example.test", metadata: { patient: "synthetic-private-patient" },
  } } });
const body = (value: unknown = snapshot()) => Buffer.from(JSON.stringify(value));
const header = (raw: Uint8Array, at = timestamp, key = secret) =>
  `t=${at},v1=${createHmac("sha256", key).update(at + ".").update(raw).digest("hex")}`;
const invalid = { ok: false, error: { kind: "invalidWebhook" } };

test("Stripe verification matches an independently generated Python HMAC UTF-8 fixture", () => {
  // Generated with Python hmac.new(secret, b'1792190000.' + raw, hashlib.sha256).
  const raw = Buffer.from('{"id":"evt_golden","object":"event","type":"checkout.session.completed","created":1,"account":"acct_synthetic","livemode":false,"api_version":"2025-06-30.basil","data":{"object":{"object":"checkout.session","id":"cs_test_golden","metadata":{"private":"café🩺"}}}}');
  const result = new StripeWebhookVerifier(config).verify(raw,
    "t=1792190000,v1=1a6e8a836dfb8ee1418d6ee1498508e859651fbe95015131d57ac6748c6bd71e");
  assert.ok(result.ok && result.value); assert.equal(result.value.checkoutRef, "cs_test_golden");
  assert.doesNotMatch(JSON.stringify(result), /café|🩺|metadata/);
});

test("Stripe Checkout signatures return only a frozen reference, independently of snapshot payment truth", () => {
  const verifier = new StripeWebhookVerifier(config), raw = body();
  const expected = { ok: true, value: { eventRef: "evt_synthetic", type: "checkout.session.completed",
    checkoutRef: "cs_test_synthetic", accountRef: "acct_synthetic", livemode: false, apiVersion } };
  const result = verifier.verify(raw, header(raw));
  assert.deepEqual(result, expected);
  if (result.ok) assert.ok(Object.isFrozen(result.value));
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|payment_status|unpaid|whsec_/);
  assert.equal(JSON.stringify(verifier), "{}", "endpoint secret is not a serializable property");
  // Signature authentication is deliberately not an event/action claim.
  assert.deepEqual(verifier.verify(raw, header(raw)), expected);
});

test("Stripe raw bytes, secret and signed timestamp cannot be substituted", () => {
  const verifier = new StripeWebhookVerifier(config), raw = body();
  for (const [bytes, signature] of [
    [Buffer.from(JSON.stringify(snapshot(), null, 2)), header(raw)],
    [Buffer.concat([raw, Buffer.from(" ")]), header(raw)],
    [raw, header(raw, timestamp, "whsec_other_synthetic_secret_123456")],
    [raw, header(raw).replace(`t=${timestamp}`, `t=${Number(timestamp) + 1}`)],
    [raw, header(raw).replace("v1=", "v0=")],
  ] as const) assert.deepEqual(verifier.verify(bytes, signature), invalid);
});

test("Stripe delivery freshness uses the signed delivery timestamp and an exact five-minute bound", () => {
  const verifier = new StripeWebhookVerifier(config), raw = body();
  for (const offset of [-300, 0, 300]) assert.equal(verifier.verify(raw, header(raw, String(Number(timestamp) + offset))).ok, true);
  for (const offset of [-301, 301]) assert.deepEqual(verifier.verify(raw, header(raw, String(Number(timestamp) + offset))), invalid);
  // Old event creation time is not delivery age; retries receive a fresh signature.
  assert.equal(verifier.verify(raw, header(raw)).ok, true);
  for (const clock of [() => NaN, () => -1, () => Infinity, () => { throw new Error("synthetic clock failure"); }]) {
    assert.deepEqual(new StripeWebhookVerifier({ ...config, clock }).verify(raw, header(raw)), invalid);
  }
});

test("Stripe secret rotation accepts any matching v1 signature and ignores downgrade schemes", () => {
  const verifier = new StripeWebhookVerifier(config), raw = body(), signed = header(raw);
  for (const value of [`${signed},v1=${"a".repeat(64)}`, `t=${timestamp},v1=${"a".repeat(64)},${signed.split(",")[1]},v0=bogus`]) {
    assert.equal(verifier.verify(raw, value).ok, true);
  }
  for (const value of [null, "", `t=${timestamp}`, `v1=${"a".repeat(64)}`, `${signed},t=${timestamp}`,
    `${signed},t=${Number(timestamp) + 1}`, `t=0${timestamp},${signed.split(",")[1]}`, `${signed},v1=short`,
    `${signed},t`, `${signed},v1`, `${signed},,v0=bogus`,
    `${signed},${Array(8).fill(`v1=${"a".repeat(64)}`).join(",")}`, "x".repeat(4097)]) {
    assert.deepEqual(verifier.verify(raw, value), invalid);
  }
});

test("Stripe signed account, mode and supported-event API version are independently pinned", () => {
  const verifier = new StripeWebhookVerifier(config);
  for (const patch of [{ account: "acct_foreign" }, { account: null }, { livemode: true }, { livemode: "false" }]) {
    const raw = body({ ...snapshot(), ...patch });
    assert.deepEqual(verifier.verify(raw, header(raw)), { ok: false, error: { kind: "foreignEndpoint" } });
  }
  const unsupported = body({ ...snapshot(), api_version: "2020-01-01" });
  assert.deepEqual(verifier.verify(unsupported, header(unsupported)), { ok: false, error: { kind: "unsupportedVersion" } });
  const direct = snapshot() as Record<string, unknown>; delete direct.account;
  const raw = body(direct);
  assert.equal(new StripeWebhookVerifier({ ...config, accountRef: null }).verify(raw, header(raw)).ok, true);
});

test("Stripe authentic unsupported events have no payment selector while malformed snapshots fail closed", () => {
  const verifier = new StripeWebhookVerifier(config), unknown = body({ ...snapshot(), type: "customer.created" });
  assert.deepEqual(verifier.verify(unknown, header(unknown)), { ok: true, value: null });
  for (const value of [null, [], {}, { ...snapshot(), object: "v2.core.event" }, { ...snapshot(), id: "patient-private" },
    { ...snapshot(), created: -1 }, { ...snapshot(), data: null }, { ...snapshot(), data: { object: { object: "charge", id: "ch_synthetic" } } },
    { ...snapshot(), data: { object: { object: "checkout.session", id: "https://foreign.test/private" } } }]) {
    const raw = body(value); assert.deepEqual(verifier.verify(raw, header(raw)), invalid);
  }
  for (const raw of [Buffer.from("{bad json"), Buffer.from([0xff]), Buffer.alloc(0), Buffer.alloc(262145, 32)]) {
    assert.deepEqual(verifier.verify(raw, header(raw)), invalid);
  }
});

test("Stripe all supported Checkout lifecycle events are references requiring fresh inspection", () => {
  const verifier = new StripeWebhookVerifier(config);
  for (const type of ["checkout.session.completed", "checkout.session.expired", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed"]) {
    const raw = body({ ...snapshot(), type });
    const result = verifier.verify(raw, header(raw)); assert.ok(result.ok && result.value);
    assert.equal(result.value.type, type); assert.equal(result.value.checkoutRef, "cs_test_synthetic");
  }
  const mutable = { ...config }; const captured = new StripeWebhookVerifier(mutable);
  mutable.accountRef = "acct_foreign"; mutable.endpointSecret = "whsec_changed_synthetic_secret_123456";
  const raw = body(); assert.equal(captured.verify(raw, header(raw)).ok, true);
});

test("Stripe authentication and parsing use one captured body even if an injected clock reuses its input buffer", () => {
  const raw = body(), signature = header(raw);
  const verifier = new StripeWebhookVerifier({ ...config, clock: () => { raw.fill(0); return now; } });
  const result = verifier.verify(raw, signature); assert.ok(result.ok && result.value);
  assert.equal(result.value.checkoutRef, "cs_test_synthetic");
});

test("Stripe endpoint configuration rejects missing or ambiguous trusted account and secret bindings", () => {
  for (const patch of [{ endpointSecret: "sk_synthetic_secret" }, { endpointSecret: secret + "\n" },
    { endpointSecret: "whsec_short" }, { accountRef: undefined }, { accountRef: "clinic-name" },
    { livemode: "false" }, { apiVersion: "latest" }, { clock: "untrusted-clock" }]) {
    assert.throws(() => new StripeWebhookVerifier({ ...config, ...patch } as never),
      { name: "TypeError", message: "invalid Stripe webhook configuration" });
  }
  // Endpoint secret bytes are opaque, not assumed to use an undocumented alphabet.
  const key = "whsec_synthetic-endpoint+secret/=123456", raw = body();
  assert.equal(new StripeWebhookVerifier({ ...config, endpointSecret: key }).verify(raw, header(raw, timestamp, key)).ok, true);
});
