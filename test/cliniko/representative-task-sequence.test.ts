import assert from "node:assert/strict";
import test from "node:test";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";

import { representativeTaskSequenceFixture as fixture } from "../support/representative-task-sequence.ts";

test("E2E-387 two independently approved patient tasks preserve one root caller, fresh codes, native subjects and immutable receipts", async t => {
  const f = await fixture();
  let claims = 0, deniedClaims = 0, writeKind = "", writeReason = "";
  const phases: { phase: string; claims: number }[] = [];
  const claim = f.flowConfig.cliniko.rateBudget.claim.bind(f.flowConfig.cliniko.rateBudget);
  t.mock.method(f.flowConfig.cliniko.rateBudget, "claim", async () => { claims++; const result = await claim(); if (result) deniedClaims++; return result; });
  const write = f.flow.write.bind(f.flow);
  t.mock.method(f.flow, "write", async (...args: Parameters<typeof write>) => {
    const result = await write(...args); writeKind = result.kind; writeReason = "reason" in result ? result.reason : ""; return result;
  });
  try {
    const firstOwner = await f.verify("43"), firstCode = f.mail[1]!.code; phases.push({ phase: "first-proof", claims });
    const first = await f.book(); assert.equal(first.status, "committed"); phases.push({ phase: "first-commit", claims });
    assert.equal(f.native.requests.length, 1); const firstReceipt = structuredClone(first);
    const secondOwner = await f.verify("44", false); assert.notEqual(firstOwner, secondOwner); assert.equal(firstOwner.closed, true);
    phases.push({ phase: "second-code-delivered", claims });
    assert.equal((await firstOwner.submitCallerCode(f.mail[0]!.code)).verified, false);
    assert.deepEqual((await f.f.state()).actions[first.key], firstReceipt);
    assert.equal((await f.flow.publicIntentContext())?.lastAction, null);
    if (first.mutation.request.kind !== "book") throw new Error("wrong operation");
    assert.equal((await f.flow.resolveBooking(f.f.scope, first.mutation.request.patient.verificationRef, first.mutation.request.offer.offerRef, verificationNow)).ok, false);
    phases.push({ phase: "old-offer-denied", claims });
    assert.equal(f.mail.length, 4); assert.equal(f.mail[3]!.email, "subject-two-private@example.test");
    assert.equal((await f.flow.submitCode(firstCode)).verified, false);
    phases.push({ phase: "old-code-denied", claims });
    assert.equal((await f.flow.submitCode(f.mail[3]!.code)).verified, true);
    phases.push({ phase: "second-proof", claims });
    const second = await f.book(); assert.equal(second.status, "committed", JSON.stringify({ claims, deniedClaims, writeKind, writeReason, nativeWrites: f.native.requests.length, phases }));
    assert.deepEqual(f.native.requests.map(row => row.patient_id), ["43", "44"]);
    assert.notEqual(first.hostRef, second.hostRef); assert.deepEqual((await f.f.state()).actions[first.key], firstReceipt);
    assert.equal(f.native.requests.length, 2); assert.equal(f.f.recalls.length, 2);
    assert.deepEqual(await f.flow.reconcile(first.mutation), { kind: "exactCommit", actionKey: first.key, hostRef: first.hostRef });
    assert.deepEqual(await f.flow.write(first.mutation, verificationNow), { kind: "rejected", actionKey: first.key, reason: "forbidden" });
    const state = await f.f.state();
    assert.equal((await f.flow.startWorkflow({ scope: f.f.scope, callId: f.f.callId, sessionId: f.f.sessionId, policyVersion: f.flowConfig.policyVersion,
      operation: "book", forAnotherPerson: true, expectedConversationRevision: state.conversationRevision, signal: new AbortController().signal })).ok, false);
    assert.equal(f.mail.length, 4); assert.equal(f.native.requests.length, 2);
  } finally { await f.closeSequence(); }
});

test("E2E-387 same-caller task approval cannot authorize representative startup or subject selection", async () => {
  const f = await fixture("sameVerifiedCaller");
  try {
    const state = await f.f.state();
    assert.equal((await f.flow.startWorkflow({ scope: f.f.scope, callId: f.f.callId, sessionId: f.f.sessionId, policyVersion: f.flowConfig.policyVersion,
      operation: "book", forAnotherPerson: true, expectedConversationRevision: state.conversationRevision, signal: new AbortController().signal })).ok, false);
    assert.equal(f.flow.representativeInputOwner, undefined); assert.equal(f.mail.length, 0); assert.equal(f.native.requests.length, 0);
  } finally { await f.closeSequence(); }
});

test("E2E-387 uncertain related-patient booking blocks another task without replay or replacing its actor", async () => {
  const f = await fixture();
  try {
    const owner = await f.verify("43"); f.native.loseResponse(); const first = await f.book();
    assert.ok(["uncertain", "needsReview"].includes(first.status)); const state = await f.f.state();
    assert.equal(await f.flow.representativeStartupAvailable("book"), false);
    assert.equal((await f.flow.startWorkflow({ scope: f.f.scope, callId: f.f.callId, sessionId: f.f.sessionId, policyVersion: f.flowConfig.policyVersion,
      operation: "book", forAnotherPerson: true, expectedConversationRevision: state.conversationRevision, signal: new AbortController().signal })).ok, false);
    assert.equal(f.flow.representativeInputOwner, owner); assert.equal(f.mail.length, 2); assert.equal(f.native.requests.length, 1);
    assert.deepEqual((await f.f.state()).actions[first.key], first); assert.equal((await f.f.state()).previousTaskActionKeys, undefined);
  } finally { await f.closeSequence(); }
});

test("E2E-387 next related-patient task pins the caller and requires current task approval and independent caller permission", async () => {
  for (const fault of ["approval", "candidate", "permission"] as const) {
    const f = await fixture();
    try {
      await f.verify("43"); const first = await f.book(); assert.equal(first.status, "committed");
      if (fault === "approval") {
        await f.source.replace({ enabled: false }); assert.equal(await f.flow.representativeStartupAvailable("book"), false);
      } else {
        const owner = await f.start(); if (fault === "candidate") f.f.setCandidates({ kind: "one", candidateIds: ["99"] }); else f.revokeActor();
        assert.equal(owner.beginCallerVerification(), true);
        assert.equal((await owner.submitCallerCode("000000")).verified, false);
      }
      assert.equal(f.mail.length, 2); assert.equal(f.native.requests.length, 1); assert.deepEqual((await f.f.state()).actions[first.key], first);
    } finally { await f.closeSequence(); }
  }
});

test("E2E-387 aborted related-person preparation preserves the original actor and receipt and permits a fresh next task", async () => {
  const f = await fixture();
  try {
    const firstOwner = await f.verify("43"), first = await f.book(); assert.equal(first.status, "committed");
    const original = f.flow.startWorkflow.bind(f.flow), stop = new AbortController();
    f.flow.startWorkflow = async query => { const prepared = await original(query); stop.abort(); return prepared; };
    assert.equal((await f.reception.startWorkflow(f.f.scope, f.f.turn("aborted-next", "Book for my son"), "book", verificationNow,
      (await f.f.state()).conversationRevision, stop.signal, false, undefined, true)).ok, false);
    assert.equal(f.flow.representativeInputOwner, firstOwner); assert.equal(firstOwner.closed, false);
    assert.equal(f.mail.length, 2); assert.equal((await f.f.state()).previousTaskActionKeys, undefined);
    f.flow.startWorkflow = original; await f.verify("44"); const second = await f.book(); assert.equal(second.status, "committed");
    assert.deepEqual((await f.f.state()).actions[first.key], first); assert.equal(f.native.requests.length, 2);
  } finally { await f.closeSequence(); }
});
