import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { representativeCallOwnerFixture, representativeInputOptions } from "../support/representative-call-owner.ts";
import { verificationNow } from "../support/caller-verification.ts";

test("E2E-386 representative startup publishes an owner only after the exact accepted workflow event, without sending either code", async () => {
  const f = await representativeCallOwnerFixture(); f.flow.dispose();
  const flow = resultValue(ClinikoCallFlow.create({ ...f.flowConfig, representativeInput: representativeInputOptions(f) }));
  try {
    const state = await f.f.state(), turn = f.f.turn("representative-start", "Book an appointment for my daughter");
    const query = { scope: f.f.scope, callId: f.f.callId, sessionId: f.f.sessionId, policyVersion: f.f.sessionConfig.policyVersion,
      expectedConversationRevision: state.conversationRevision, signal: new AbortController().signal,
      operation: "book" as const, forAnotherPerson: true as const, turnId: turn.turnId };
    const started = await flow.startWorkflow(query); assert.equal(started.ok, true); if (!started.ok) return;
    assert.deepEqual(started.value, { kind: "representativeRequired" });
    const owner = () => flow.representativeInputOwner;
    assert.equal(owner(), undefined); assert.equal(f.mail.length, 0);
    assert.equal(await flow.completeWorkflowStart(query), false);
    assert.equal((await flow.choose("book")).ok, false, "pending representative cannot fall back to self");
    resultValue(await f.f.runtime.acceptTurn(turn, { kind: "workflowStarted", operation: "book", next: "representativeRequired" }, verificationNow, state.conversationRevision));
    assert.equal(await flow.completeWorkflowStart(query), true); assert.ok(owner());
    assert.equal(await owner()!.privateStartupReady(), false);
    assert.equal(f.mail.length, 0); assert.equal(f.writes, 0);
    await f.play(); assert.equal(await owner()!.privateStartupReady(), true);
    assert.equal((await flow.choose("book")).ok, false, "active actor cannot become a self booking");
  } finally { flow.dispose(); await f.close(); }
});

test("E2E-386 ordinary text reception starts the private representative route; unconfigured starts send nothing", async () => {
  const f = await representativeCallOwnerFixture(); f.flow.dispose();
  const flow = resultValue(ClinikoCallFlow.create({ ...f.flowConfig, representativeInput: representativeInputOptions(f) }));
  try {
    const reception = new TextReception(f.f.ledger, f.f.policies, flow), state = await f.f.state();
    resultValue(await reception.startWorkflow(f.f.scope, f.f.turn("ordinary-start", "Book for someone else"), "book", verificationNow,
      state.conversationRevision, undefined, false, undefined, true));
    assert.ok(flow.representativeInputOwner); assert.equal(f.mail.length, 0);
    assert.match((await f.f.state()).callerMessages.at(-1)!, /verify you as the caller.*privately collect/);
    assert.equal((await flow.choose("book")).ok, false); assert.equal(f.writes, 0);
  } finally { flow.dispose(); await f.close(); }
  const g = await representativeCallOwnerFixture();
  try {
    const state = await g.f.state();
    assert.equal((await g.flow.startWorkflow({ scope: g.f.scope, callId: g.f.callId, sessionId: g.f.sessionId,
      policyVersion: g.f.sessionConfig.policyVersion, expectedConversationRevision: state.conversationRevision,
      signal: new AbortController().signal, operation: "book", forAnotherPerson: true })).ok, false);
    assert.equal(g.mail.length, 0); assert.equal(g.flow.representativeInputOwner, undefined);
  } finally { await g.close(); }
});

test("E2E-386 a different accepted event cannot activate the prepared representative; abandonment permits a fresh explicit request", async () => {
  const f = await representativeCallOwnerFixture(); f.flow.dispose();
  const flow = resultValue(ClinikoCallFlow.create({ ...f.flowConfig, representativeInput: representativeInputOptions(f) }));
  try {
    const before = await f.f.state(), turn = f.f.turn("wrong-start", "Book for my daughter");
    const query = { scope: f.f.scope, callId: f.f.callId, sessionId: f.f.sessionId, policyVersion: f.f.sessionConfig.policyVersion,
      expectedConversationRevision: before.conversationRevision, signal: new AbortController().signal, operation: "book" as const,
      forAnotherPerson: true as const, turnId: turn.turnId };
    assert.equal((await flow.startWorkflow(query)).ok, true);
    resultValue(await f.f.runtime.acceptTurn(turn, { kind: "workflowStarted", operation: "book", next: "codeRequired" }, verificationNow, before.conversationRevision));
    assert.equal(await flow.completeWorkflowStart(query), false); assert.equal(flow.representativeInputOwner, undefined);
    await flow.abandonWorkflowStart(query); assert.equal(f.mail.length, 0); await f.play();
    const reception = new TextReception(f.f.ledger, f.f.policies, flow);
    resultValue(await reception.startWorkflow(f.f.scope, f.f.turn("fresh-start", "Book for my daughter"), "book", verificationNow,
      (await f.f.state()).conversationRevision, undefined, false, undefined, true));
    assert.ok(flow.representativeInputOwner); assert.equal(f.mail.length, 0); assert.equal(f.writes, 0);
  } finally { flow.dispose(); await f.close(); }
});
