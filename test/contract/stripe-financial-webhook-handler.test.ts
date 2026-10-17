import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";
import type { TestContext } from "node:test";
import { stripeFinancialWebhookHandler } from "../../src/standalone/stripe-financial-webhook-handler.ts";
import { handoffFixture, signWebhook } from "../support/financial-webhook-handoff.ts";

async function server(t: TestContext, options: Parameters<typeof handoffFixture>[0] = {}) {
  const f = await handoffFixture(options), route = stripeFinancialWebhookHandler(f.handoff);
  const s = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 15000 }, route.handle);
  await new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve));
  const address = s.address(); assert.ok(address && typeof address === "object");
  t.after(async () => { await route.close(); s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); });
  const send = (raw: string, signature: string, patch: { path?: string; method?: string; headers?: Record<string, string | string[]> } = {}) =>
    new Promise<{ status: number; body: string; cache: string | undefined }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: address.port, path: patch.path ?? "/stripe/webhook", method: patch.method ?? "POST",
        headers: { "content-type": "application/json", "stripe-signature": signature, ...patch.headers } }, res => {
        let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, body, cache: res.headers["cache-control"] }));
      });
      req.once("error", reject); req.write(raw.slice(0, 17)); req.end(raw.slice(17));
    });
  return { ...f, route, send };
}

test("HTTP authenticates the original chunked bytes and returns only a fixed acknowledgement", async t => {
  const f = await server(t), raw = JSON.stringify(f.event(), null, 2), signed = signWebhook(raw);
  assert.deepEqual(await f.send(raw, signed.signature), { status: 200, body: '{"ok":true}', cache: "no-store" });
  assert.equal(f.grants.length, 1);
  assert.deepEqual(await f.send(JSON.stringify(f.event()), signed.signature), { status: 400, body: '{"ok":false}', cache: "no-store" });
});

test("HTTP refuses unsigned/duplicate signatures, wrong route/method/encoding, oversized and malformed bodies", async t => {
  const f = await server(t), e = f.signed();
  const invalid: readonly [{ path?: string; method?: string; headers?: Record<string, string | string[]> }, number][] = [
    [{ path: "/stripe/webhook?payload=private" }, 404], [{ method: "PUT" }, 405],
    [{ headers: { "content-encoding": "gzip" } }, 400], [{ headers: { "content-type": "text/plain" } }, 400],
    [{ headers: { "stripe-signature": [e.signature, e.signature] } }, 400],
    [{ headers: { "content-length": "262145" } }, 400]
  ];
  for (const [patch, status] of invalid) {
    const r = await f.send(e.raw, e.signature, patch); assert.equal(r.status, status); assert.equal(r.body, '{"ok":false}');
  }
  assert.equal((await f.send(e.raw, "")).status, 400);
  const malformed = signWebhook("{ private malformed payload"); assert.equal((await f.send(malformed.raw, malformed.signature)).status, 400);
  const huge = signWebhook("x".repeat(262145)); assert.equal((await f.send(huge.raw, huge.signature)).status, 400);
  assert.equal(f.nativeReads.length, 0); assert.equal(f.stripeReads.length, 0);
});

test("HTTP unknown/closed native work and withdrawn grants remain retryable without revealing reasons", async t => {
  const f = await server(t), e = f.signed(); f.denyAccept();
  assert.deepEqual(await f.send(e.raw, e.signature), { status: 503, body: '{"ok":false}', cache: "no-store" });
  const ignored = f.signed({ type: "customer.created" }); assert.equal((await f.send(ignored.raw, ignored.signature)).status, 200);
});

test("closing the handler aborts held authority and prevents subsequent acceptance", async t => {
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const f = await server(t, { authority: { acceptsExistingPending: async () => { entered(); return new Promise<boolean>(() => {}); } } });
  const e = f.signed(), response = f.send(e.raw, e.signature); await waiting; await f.route.close();
  assert.equal((await response).status, 503); assert.equal((await f.send(e.raw, e.signature)).status, 503);
});
