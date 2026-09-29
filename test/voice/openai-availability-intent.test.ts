import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIAvailabilityIntentResolver } from "../../src/standalone/openai-availability-intent.ts";

const turn = { callId: "private-call", turnId: "private-turn", at: "2026-09-29T10:00:00.000Z",
  quality: "clear" as const, text: "Are there any appointments available on October 2?" };

function completed(decision: unknown): Response {
  return Response.json({ status: "completed", output: [{ type: "message", status: "completed",
    content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
}

test("E2E-137 synthetic intent: a spoken availability request reaches only the read-only action", async () => {
  const decisions = [
    { kind: "availability", from: "2026-10-02", to: "2026-10-02" },
    { kind: "unsupported", from: null, to: null },
    { kind: "availability", from: "2026-09-28", to: "2026-09-28" },
  ];
  let requests = 0;
  const fake = (async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.tool_choice, "none");
    assert.equal(body.text.format.strict, true);
    assert.deepEqual(JSON.parse(body.input[1].content), { callerText: turn.text });
    assert.match(body.input[0].content, /clinic local date 2026-09-29/);
    for (const secret of [turn.callId, turn.turnId, turn.at, "synthetic-api-key"]) {
      assert.equal(String(init?.body).includes(secret), false);
    }
    return completed(decisions[requests++]);
  }) as typeof fetch;
  const resolve = createOpenAIAvailabilityIntentResolver({ apiKey: "synthetic-api-key", model: "configured-model",
    clinicDate: () => "2026-09-29", fetch: fake });
  assert.deepEqual(await resolve(turn), { ok: true, value: { kind: "availability", from: "2026-10-02", to: "2026-10-02" } });
  assert.deepEqual(await resolve(turn), { ok: true, value: { kind: "model" } });
  assert.deepEqual(await resolve(turn), { ok: false, error: { kind: "intentUnavailable" } });
  assert.equal(requests, 3);
});

test("availability intent rejects malformed, unsafe, and unavailable model responses", async () => {
  const responses = [
    completed({ kind: "availability", from: "2026-10-02", to: "2026-10-10" }),
    completed({ kind: "availability", from: "2026-10-02", to: "2026-10-02", book: true }),
    completed({ kind: "unsupported", from: "2026-10-02", to: null }),
    Response.json({ status: "completed", output: [{ type: "function_call", name: "book" }] }),
    Response.json({ status: "completed", output: [{ type: "message", status: "completed",
      content: [{ type: "refusal", refusal: "cannot comply" }] }] }),
    new Response("x".repeat(20_000)),
    new Response(null, { status: 503 }),
  ];
  let next = 0;
  const resolve = createOpenAIAvailabilityIntentResolver({ apiKey: "synthetic-api-key", model: "configured-model",
    clinicDate: () => "2026-09-29", fetch: (async () => responses[next++]!) as typeof fetch });
  for (const response of responses) assert.deepEqual(await resolve(turn),
    { ok: false, error: { kind: "intentUnavailable" } }, String(response.status));
  assert.equal(next, responses.length);
  assert.deepEqual(await resolve({ ...turn, quality: "needsClarification" }),
    { ok: false, error: { kind: "intentUnavailable" } });
  assert.equal(next, responses.length);
});
