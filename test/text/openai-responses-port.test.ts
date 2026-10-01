import assert from "node:assert/strict";
import test from "node:test";
import { ModelIngress } from "../../src/model/proposal.ts";
import type { ModelInput } from "../../src/model/proposal.ts";
import { OpenAIResponsesPort } from "../../src/model/openai-responses-port.ts";

const input: ModelInput = {
  scope: { tenantId: "secret-tenant", clinicId: "secret-clinic", locationId: "secret-location" },
  turn: { callId: "secret-call", turnId: "secret-turn", text: "Please ask staff to call me.", quality: "clear",
    at: "2026-09-28T10:00:00.000Z" },
  conversationRevision: 1,
  knowledge: [{ sourceRef: "hours", approvedText: "We open at 9 am." }],
  policyVersion: "policy-v1",
  promptVersion: "prompt-v1",
};

function completed(proposal: unknown): Response {
  return Response.json({ status: "completed", output: [
    { type: "reasoning" },
    { type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ proposal }) }] },
  ] });
}

function port(fetchPort: typeof fetch, proposalVersion?: 1 | 2): OpenAIResponsesPort {
  return new OpenAIResponsesPort({ apiKey: "synthetic-key", model: "configured-model", promptVersion: "prompt-v1",
    instructions: "Classify the request as a typed proposal. Never claim a booking is confirmed.",
    ...(proposalVersion === undefined ? {} : { proposalVersion }), fetch: fetchPort });
}

test("OpenAI Responses adapter sends minimal transient input and accepts one typed proposal", async () => {
  let calls = 0;
  const fake = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer synthetic-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.model, "configured-model");
    assert.equal(body.tool_choice, "none");
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.schema.type, "object");
    assert.equal(body.text.format.schema.properties.proposal.anyOf.length, 4);
    assert.equal(body.text.format.name, "abby_model_proposal_v1");
    assert.deepEqual(body.text.format.schema.properties.proposal.anyOf[3].properties.schemaVersion.enum, [1]);
    assert.deepEqual(body.text.format.schema.properties.proposal.anyOf[3].properties.reason.enum,
      ["callerRequested", "unsupported"]);
    assert.deepEqual(body.input.map((item: { role: string }) => item.role), ["system", "user"]);
    assert.match(body.input[0].content, /current caller turn supersedes them/);
    assert.deepEqual(JSON.parse(body.input[1].content), { callerText: input.turn.text, approvedKnowledge: input.knowledge });
    for (const secret of [input.scope.tenantId, input.scope.clinicId, input.scope.locationId, input.turn.callId,
      input.turn.turnId, input.policyVersion, "synthetic-key"]) assert.equal(String(init?.body).includes(secret), false);
    return completed({ schemaVersion: 1, kind: "handoff", reason: "callerRequested" });
  }) as typeof fetch;
  const result = await new ModelIngress(port(fake)).propose(input, 1_000);
  assert.deepEqual(result, { ok: true, value: { schemaVersion: 1, kind: "handoff", reason: "callerRequested" } });
  assert.equal(calls, 1);
});

test("OpenAI Responses adapter opts into urgent proposal version 2 explicitly", async () => {
  const fake = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const format = JSON.parse(String(init?.body)).text.format;
    assert.equal(format.name, "abby_model_proposal_v2");
    assert.deepEqual(format.schema.properties.proposal.anyOf[3].properties.schemaVersion.enum, [2]);
    assert.deepEqual(format.schema.properties.proposal.anyOf[3].properties.reason.enum,
      ["callerRequested", "unsupported", "potentiallyUrgent"]);
    return completed({ schemaVersion: 2, kind: "handoff", reason: "potentiallyUrgent" });
  }) as typeof fetch;
  assert.deepEqual(await new ModelIngress(port(fake, 2)).propose(input, 1_000),
    { ok: true, value: { schemaVersion: 2, kind: "handoff", reason: "potentiallyUrgent" } });
});

test("prior caller turns are bounded transient context in the same unstored request", async () => {
  const priorCallerTurns = ["Please book next week.", "Actually, I meant Friday."];
  let requests = 0;
  const fake = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests += 1;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.deepEqual(JSON.parse(body.input[1].content), {
      priorCallerTurns, callerText: input.turn.text, approvedKnowledge: input.knowledge,
    });
    assert.equal(String(init?.body).includes(input.turn.callId), false);
    return completed({ schemaVersion: 1, kind: "handoff", reason: "unsupported" });
  }) as typeof fetch;
  const ingress = new ModelIngress(port(fake));
  assert.ok((await ingress.propose({ ...input, priorCallerTurns }, 1_000)).ok);
  assert.deepEqual(await ingress.propose({ ...input, priorCallerTurns: ["x".repeat(4_001)] }, 1_000),
    { ok: false, error: { kind: "unavailable" } });
  assert.equal(requests, 1);
});

test("nullable optional fields are omitted before the domain proposal decoder", async () => {
  const fake = (async () => completed({ schemaVersion: 1, kind: "lookup", target: "appointment", statedName: null,
    statedDate: "2026-10-03", requestedService: null, requestedLocationId: null })) as typeof fetch;
  const result = await new ModelIngress(port(fake)).propose(input, 1_000);
  assert.deepEqual(result, { ok: true, value: { schemaVersion: 1, kind: "lookup", target: "appointment", statedDate: "2026-10-03" } });
});

for (const scenario of [
  { name: "refusal", response: Response.json({ status: "completed", output: [
    { type: "message", status: "completed", content: [{ type: "refusal", refusal: "declined" }] }] }) },
  { name: "incomplete", response: Response.json({ status: "incomplete", output: [
    { type: "message", status: "incomplete", content: [{ type: "output_text", text: "{" }] }] }) },
  { name: "tool call", response: Response.json({ status: "completed", output: [{ type: "function_call", name: "write" }] }) },
  { name: "extra envelope data", response: Response.json({ status: "completed", output: [
    { type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify({
      proposal: { schemaVersion: 1, kind: "handoff", reason: "callerRequested" }, hidden: "extra" }) }] }] }) },
  { name: "oversized body", response: new Response("x".repeat(70_000), { status: 200 }) },
]) {
  test(`OpenAI Responses adapter rejects ${scenario.name} without a proposal`, async () => {
    const fake = (async () => scenario.response.clone()) as typeof fetch;
    const result = await new ModelIngress(port(fake)).propose(input, 1_000);
    assert.deepEqual(result, { ok: false, error: { kind: "malformed" } });
  });
}

test("OpenAI Responses adapter rejects transport failure and prompt mismatch without exposing provider detail", async () => {
  let calls = 0;
  const fake = (async () => { calls += 1; return Response.json({ error: { message: "private provider detail" } }, { status: 429 }); }) as typeof fetch;
  const ingress = new ModelIngress(port(fake));
  assert.deepEqual(await ingress.propose(input, 1_000), { ok: false, error: { kind: "unavailable" } });
  assert.deepEqual(await ingress.propose({ ...input, promptVersion: "wrong" }, 1_000),
    { ok: false, error: { kind: "unavailable" } });
  assert.equal(calls, 1);
});
