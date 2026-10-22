// E2E-424: independently verified native callback context and exact original ownership.
import assert from "node:assert/strict";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { proposalHarness, proposalNow, resultValue } from "../support/agent-appointment-proposals.ts";

test("verified incoming missed-call context explains only the trusted original purpose", async () => {
  const scope = { tenantId: "incoming-reason", clinicId: "clinic", locationId: "main" };
  const f = proposalHarness(scope, "embedded"); await f.enable();
  const proposal = await f.admit("cancel"), before = resultValue(await f.runtime.read(proposal.turn.callId));
  let reads = 0;
  const host = Object.assign(f.host, { readMissedCallContext: async (query: {
    scope: typeof scope; callId: string; sessionId: string; policyVersion: string;
    turnId: string; expectedConversationRevision: number; now: string; signal: AbortSignal;
  }) => {
    reads++; assert.deepEqual(query.scope, scope); assert.equal(query.callId, proposal.turn.callId);
    assert.equal(query.sessionId, proposal.turn.sessionId); assert.equal(query.policyVersion, before.policy.policyVersion);
    assert.equal(query.expectedConversationRevision, before.conversationRevision);
    assert.equal(query.now, proposalNow); assert.equal(query.signal.aborted, false);
    return ok({ scope, callId: query.callId, sessionId: query.sessionId, policyVersion: query.policyVersion,
      checkedAt: proposalNow, purpose: "sickDay" as const });
  } });
  const reception = new TextReception(f.ledger, f.policy, host, undefined, undefined, undefined, undefined, () => proposalNow);
  const turn = { ...proposal.turn, turnId: "why-original-call", text: "Why did the clinic call me?" };
  const answered = resultValue(await reception.respondMissedCall(scope, turn, before.conversationRevision));
  assert.equal(answered.callerMessages.at(-1), "The clinic called about rescheduling your appointment. I can help with that, or you can contact reception.");
  assert.equal(reads, 1); assert.equal(f.host.writes.length, 0); assert.equal(f.host.tasks(scope).length, 0);
  resultValue(await reception.respondMissedCall(scope, turn, before.conversationRevision));
  assert.equal(reads, 1, "a duplicate turn must not repeat protected context reads");
});

for (const fault of ["scope", "call", "session", "policy", "old", "future", "purpose", "extra", "absent", "throws"] as const) {
  test(`incoming missed-call context refuses ${fault} source and keeps the unknown reply`, async () => {
    const scope = { tenantId: `incoming-${fault}`, clinicId: "clinic", locationId: "main" };
    const f = proposalHarness(scope, "embedded"); await f.enable(); const proposal = await f.admit("cancel");
    const before = resultValue(await f.runtime.read(proposal.turn.callId));
    const host = Object.assign(f.host, { readMissedCallContext: async () => {
      if (fault === "throws") throw Error("private-source-unavailable");
      const context = { scope, callId: proposal.turn.callId, sessionId: proposal.turn.sessionId!, policyVersion: before.policy.policyVersion,
        checkedAt: proposalNow, purpose: "sickDay" as const };
      const value: unknown = fault === "scope" ? { ...context, scope: { ...scope, locationId: "foreign" } }
        : fault === "call" ? { ...context, callId: "other" } : fault === "session" ? { ...context, sessionId: "other" }
        : fault === "policy" ? { ...context, policyVersion: "old" } : fault === "old" ? { ...context, checkedAt: "2026-10-03T09:59:59.999Z" }
        : fault === "future" ? { ...context, checkedAt: "2026-10-03T10:00:00.001Z" } : fault === "purpose" ? { ...context, purpose: "results" }
        : fault === "extra" ? { ...context, patientId: "private-injected-patient" } : undefined;
      return ok(value as typeof context);
    } });
    const reception = new TextReception(f.ledger, f.policy, host, undefined, undefined, undefined, undefined, () => proposalNow);
    const turn = { ...proposal.turn, turnId: "reason", text: "Why did the clinic call me?" };
    const result = resultValue(await reception.respondMissedCall(scope, turn, before.conversationRevision));
    assert.equal(result.callerMessages.at(-1), "I don't know why the clinic called you. I can't verify an outbound-call reason from this call. Please contact the clinic directly.");
    assert.equal(f.host.writes.length, 0); assert.equal(f.host.tasks(scope).length, 0);
    assert.equal(JSON.stringify(result).includes("private-injected-patient"), false);
  });
}

test("incoming missed-call context does not read after identity denial or uncertain audio", async () => {
  const scope = { tenantId: "incoming-denied", clinicId: "clinic", locationId: "main" };
  const f = proposalHarness(scope, "embedded"); await f.enable(); const proposal = await f.admit("cancel");
  let reads = 0;
  const host = Object.assign(f.host, { readMissedCallContext: async () => { reads++; throw Error("must not read"); } });
  const reception = new TextReception(f.ledger, f.policy, host, undefined, undefined, undefined, undefined, () => proposalNow);
  assert.equal((await reception.respondMissedCall(scope, { ...proposal.turn, quality: "needsClarification" })).ok, false);
  resultValue(await f.runtime.acceptTurn({ ...proposal.turn, turnId: "identity-denied" }, { kind: "callerIdentityDenied", reason: "sharedPhone" }, proposalNow));
  resultValue(await reception.respondMissedCall(scope, { ...proposal.turn, turnId: "reason", text: "Why did the clinic call me?" }));
  assert.equal(reads, 0);
});

test("a newer caller turn retires a pending incoming reason without speaking stale private context", async () => {
  const scope = { tenantId: "incoming-late", clinicId: "clinic", locationId: "main" };
  const f = proposalHarness(scope, "embedded"); await f.enable(); const proposal = await f.admit("cancel");
  const before = resultValue(await f.runtime.read(proposal.turn.callId));
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
  const host = Object.assign(f.host, { readMissedCallContext: async () => {
    enter(); await released;
    return ok({ scope, callId: proposal.turn.callId, sessionId: proposal.turn.sessionId!, policyVersion: before.policy.policyVersion,
      checkedAt: proposalNow, purpose: "sickDay" as const });
  } });
  const reception = new TextReception(f.ledger, f.policy, host, undefined, undefined, undefined, undefined, () => proposalNow);
  const pending = reception.respondMissedCall(scope, { ...proposal.turn, turnId: "reason", text: "Why did the clinic call me?" });
  await entered;
  const denied = resultValue(await f.runtime.acceptTurn({ ...proposal.turn, turnId: "denial" }, { kind: "callerIdentityDenied", reason: "identityDisagreement" }, proposalNow));
  release(); assert.equal((await pending).ok, false);
  assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), denied);
});
