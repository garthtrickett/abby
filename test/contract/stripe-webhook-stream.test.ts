import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { StripeWebhookVerifier } from "../../src/stripe/webhook.ts";
import { StripeApiRead } from "../../src/stripe/internal/api-read.ts";

const secret = "whsec_synthetic_stream_secret_123456";
const now = 1_792_190_000_000, at = String(now / 1_000);
const config = { endpointSecret: secret, accountRef: null, livemode: false, apiVersion: "2025-06-30.basil", clock: () => now };
const raw = Buffer.from('{ "id":"evt_stream", "object":"event", "type":"checkout.session.completed", "created":1,"livemode":false,"api_version":"2025-06-30.basil","data":{"object":{"object":"checkout.session","id":"cs_test_stream","metadata":{"private":"café🩺"}}}}');
const header = (bytes: Uint8Array) => `t=${at},v1=${createHmac("sha256", secret).update(at + ".").update(bytes).digest("hex")}`;
const signal = () => new AbortController().signal;
const stream = (bytes: Uint8Array, width = 1) => new ReadableStream<Uint8Array>({
  start(controller) { for (let n = 0; n < bytes.length; n += width) controller.enqueue(bytes.slice(n, n + width)); controller.close(); },
});

test("Stripe raw HTTP capture preserves signed whitespace and split UTF-8 without exposing the snapshot", async () => {
  const verifier = new StripeWebhookVerifier(config);
  const server = createServer(async (request, response) => {
    try {
      const found = await verifier.verifyStream(Readable.toWeb(request), String(request.headers["stripe-signature"]), signal());
      response.writeHead(found.ok ? 200 : 400, { "content-type": "application/json" }); response.end(JSON.stringify(found));
    } catch { response.writeHead(500); response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const reply = await fetch(`http://127.0.0.1:${address.port}/fixture`, { method: "POST", headers: { "stripe-signature": header(raw) }, body: raw });
    assert.equal(reply.status, 200);
    const result = await reply.json(); assert.deepEqual(result, verifier.verify(raw, header(raw)));
    assert.doesNotMatch(JSON.stringify(result), /café|metadata|whsec_|private/);
    assert.deepEqual(await verifier.verifyStream(stream(raw), header(raw), signal()), result);
    assert.deepEqual(await verifier.verifyStream(stream(Buffer.from(JSON.stringify(JSON.parse(raw.toString())))), header(raw), signal()),
      { ok: false, error: { kind: "invalidWebhook" } }, "capture cannot parse/re-serialize signed bytes");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("Stripe stream capture enforces the existing byte boundary and retires the oversized reader", async () => {
  const verifier = new StripeWebhookVerifier(config);
  const exact = Buffer.concat([raw, Buffer.alloc(262_144 - raw.length, 0x20)]);
  assert.equal((await verifier.verifyStream(stream(exact, 1_003), header(exact), signal())).ok, true);
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(262_145)); }, cancel() { cancelled = true; } });
  assert.deepEqual(await verifier.verifyStream(oversized, header(exact), signal()), { ok: false, error: { kind: "invalidWebhook" } });
  assert.equal(cancelled, true); assert.equal(oversized.locked, false);
});

test("Stripe capture aborts a stalled body without waiting for an uncooperative cancellation", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise<void>(() => {}); } });
  const stop = new AbortController();
  const read = new StripeWebhookVerifier(config).verifyStream(body, header(raw), stop.signal);
  stop.abort();
  assert.deepEqual(await read, { ok: false, error: { kind: "unavailable" } });
  assert.equal(cancelled, true); assert.equal(body.locked, false);
});

test("Stripe body deadline runs even when the source keeps producing empty chunks", async () => {
  let cancelled = false, reads = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (++reads < 20_000) controller.enqueue(new Uint8Array()); else { controller.enqueue(raw); controller.close(); }
  }, cancel() { cancelled = true; } });
  const stop = new AbortController(); const abort = setImmediate(() => stop.abort());
  try {
    assert.deepEqual(await new StripeWebhookVerifier(config).verifyStream(body, header(raw), stop.signal), { ok: false, error: { kind: "unavailable" } });
    assert.equal(cancelled, true); assert.equal(body.locked, false); assert.ok(reads < 20_000);
  } finally { clearImmediate(abort); }
});

test("Stripe stream deadline is finite and body failures disclose no private error text", async () => {
  const verifier = new StripeWebhookVerifier({ ...config, bodyDeadlineMs: 5 });
  const stalled = new ReadableStream<Uint8Array>();
  assert.deepEqual(await verifier.verifyStream(stalled, header(raw), signal()), { ok: false, error: { kind: "unavailable" } });
  assert.equal(stalled.locked, false);
  const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("private stream body")); } });
  assert.deepEqual(await verifier.verifyStream(broken, header(raw), signal()), { ok: false, error: { kind: "unavailable" } });
  assert.equal(broken.locked, false);
  for (const bodyDeadlineMs of [0, 10_001, NaN]) assert.throws(() => new StripeWebhookVerifier({ ...config, bodyDeadlineMs }), TypeError);
});

test("Stripe capture owns delivered chunk bytes and leaves a foreign reader locked", async () => {
  const verifier = new StripeWebhookVerifier(config), first = Uint8Array.from(raw.subarray(0, 32));
  let turn = 0;
  const source = new ReadableStream<Uint8Array>({ pull(controller) {
    if (turn++ === 0) controller.enqueue(first);
    else { first.fill(0); controller.enqueue(raw.slice(32)); controller.close(); }
  } }, { highWaterMark: 0 });
  assert.equal((await verifier.verifyStream(source, header(raw), signal())).ok, true);
  assert.equal(source.locked, false);
  const foreign = stream(raw), owner = foreign.getReader();
  try {
    assert.deepEqual(await verifier.verifyStream(foreign, header(raw), signal()), { ok: false, error: { kind: "unavailable" } });
    assert.equal(foreign.locked, true, "another reader's lock is not ours to release");
  } finally { owner.releaseLock(); }
});

test("Stripe pre-aborted capture acquires no reader; empty and non-byte bodies cannot authenticate", async () => {
  const verifier = new StripeWebhookVerifier(config), stop = new AbortController(); stop.abort();
  const unused = stream(raw);
  assert.deepEqual(await verifier.verifyStream(unused, header(raw), stop.signal), { ok: false, error: { kind: "unavailable" } });
  assert.equal(unused.locked, false);
  for (const body of [null, stream(new Uint8Array()),
    new ReadableStream({ start(controller) { controller.enqueue("private wrong chunk"); controller.close(); } }) as unknown as ReadableStream<Uint8Array>]) {
    assert.deepEqual(await verifier.verifyStream(body, header(raw), signal()), { ok: false, error: { kind: "invalidWebhook" } });
  }
});

test("Stripe account reads service queued aborts while an immediate body produces empty chunks", async () => {
  let reads = 0, cancelled = false, consumed = false;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (++reads < 20_000) controller.enqueue(new Uint8Array());
    else { controller.enqueue(Buffer.from(JSON.stringify({ object: "account", id: "acct_synthetic" }))); controller.close(); }
  }, cancel() { cancelled = true; } });
  const api = new StripeApiRead({ apiKey: "sk_test_synthetic_123456", accountRef: "acct_synthetic", connected: false,
    livemode: false, apiVersion: config.apiVersion, clock: config.clock }, async () => new Response(body));
  const stop = new AbortController(), abort = setImmediate(() => stop.abort());
  try {
    assert.deepEqual(await api.run(stop.signal, async () => { consumed = true; return "not financial evidence"; }),
      { ok: false, error: { kind: "unavailable" } });
    assert.equal(consumed, false); assert.equal(cancelled, true); assert.equal(body.locked, false); assert.ok(reads < 20_000);
  } finally { clearImmediate(abort); }
});
