import assert from "node:assert/strict";
import { test } from "node:test";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { bookingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { syntheticMultiTaskBookingProvider, syntheticTaskSequence } from "../support/call-task-sequence.ts";
import { verificationNow, verificationCanaries } from "../support/caller-verification.ts";
import { correctionTasksFixture } from "../support/patient-correction-tasks.ts";

async function fixture() {
  const native = syntheticMultiTaskBookingProvider(), f = await bookingCallFlowFixture({ fetchAround: native.wrap }); f.flow.dispose();
  const source = await syntheticTaskSequence(f.flowConfig, f.folder);
  const flow = resultValue(ClinikoCallFlow.create(source.config)), reception = new TextReception(f.ledger, f.policies, flow);
  const intent = createOpenAIClinicalIntentResolver({ owner: flow, apiKey: "synthetic", model: "synthetic", clinicDate: () => "2026-10-04",
    fetch: async () => { throw new Error("explicit next task should use the trusted mapper"); } });
  let sequence = 0;
  const start = async () => {
    const count = f.mail.length;
    resultValue(await reception.startWorkflow(f.scope, f.turn(`task-${++sequence}`, "Book another appointment"), "book", verificationNow));
    const deadline = Date.now() + 5000; while (f.mail.length === count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.mail.length, count + 1); await f.playPending();
  };
  const book = async () => {
    assert.equal((await flow.submitCode(f.mail.at(-1)!.code)).verified, true);
    resultValue(await reception.readBookingMenu(f.scope, f.turn(`menu-${sequence}`), "2026-10-08", "2026-10-08", verificationNow)); await f.playPending();
    resultValue(await reception.selectBookingMenu(f.scope, f.turn(`select-${sequence}`), 1, verificationNow)); await f.playPending();
    const action = Object.values((await f.state()).actions).at(-1)!;
    resultValue(await reception.affirm(f.scope, f.turn(`yes-${sequence}`, "Yes"), action.key, action.digest, verificationNow));
    resultValue(await reception.drain(f.scope, f.callId, verificationNow)); await f.playPending();
    return (await f.state()).actions[action.key]!;
  };
  return { ...f, source, flow, reception, native, intent, start, book, closeSequence: async () => { flow.dispose(); await f.close(); } };
}

test("E2E-381 two approved tasks keep independent verification, played confirmation, native records and receipts in one call", async () => {
  const f = await fixture();
  try {
    await f.start(); const first = await f.book(); assert.equal(first.status, "committed");
    assert.equal((await f.flow.publicIntentContext())?.nextTaskAvailable, true);
    assert.deepEqual(resultValue(await f.intent(f.turn("next", "Book another appointment"))), { kind: "workflow", operation: "book" });
    await f.start(); assert.equal(f.flow.verificationRequired, true);
    if (first.mutation.request.kind !== "book") throw new Error("wrong prior action kind");
    assert.equal((await f.flow.resolveBooking(f.scope, first.mutation.request.patient.verificationRef, first.mutation.request.offer.offerRef, verificationNow)).ok, false,
      "a completed task's proof and offer cannot authorize the new task");
    assert.equal((await f.flow.publicIntentContext())?.lastAction, null);
    resultValue(await f.runtime.acceptTurn(f.turn("second-outcome", "Is the second task done?"), { kind: "outcomeQuery" }, verificationNow));
    assert.equal((await f.state()).callerMessages.at(-1), "I haven't completed an action for this new task."); await f.playPending();
    assert.equal((await f.reception.readBookingMenu(f.scope, f.turn("early"), "2026-10-08", "2026-10-08", verificationNow)).ok, true);
    assert.equal(f.native.requests.length, 1, "no second write before its verification and consent"); await f.playPending();
    const second = await f.book(); assert.equal(second.status, "committed");
    assert.notEqual(first.key, second.key); assert.notEqual(first.hostRef, second.hostRef);
    assert.deepEqual((await f.state()).actions[first.key], first);
    assert.equal(f.native.requests.length, 2); assert.equal(f.recalls.length, 2); assert.equal(f.mail.length, 2);
    assert.equal(new Set([...f.native.rows.values()].map(row => row.starts_at)).size, 2);
    assert.deepEqual(await f.flow.reconcile(first.mutation), { kind: "exactCommit", actionKey: first.key, hostRef: first.hostRef });
    assert.deepEqual(await f.flow.write(first.mutation, verificationNow), { kind: "rejected", actionKey: first.key, reason: "forbidden" });
    assert.deepEqual(await f.flow.reconcile({ ...first.mutation, payloadDigest: "f".repeat(64) }), { kind: "stillUnknown", actionKey: first.key });
    assert.equal((await f.flow.choose("book")).ok, false, "approved task count is enforced");
    assert.equal((await f.flow.publicIntentContext())?.nextTaskAvailable, undefined);
    for (const secret of [verificationCanaries[0]!, verificationCanaries[1]!, ...f.mail.map(mail => mail.code)]) assert.equal(JSON.stringify(await f.state()).includes(secret), false);
  } finally { await f.closeSequence(); }
});

test("E2E-381 unresolved first action never enables another task or retries its possible write", async () => {
  const f = await fixture();
  try {
    f.native.loseResponse(); await f.start(); const action = await f.book(); assert.ok(["uncertain", "needsReview"].includes(action.status));
    assert.equal((await f.flow.publicIntentContext())?.nextTaskAvailable, undefined);
    assert.equal((await f.flow.choose("book")).ok, false); assert.equal(f.mail.length, 1); assert.equal(f.native.requests.length, 1);
    assert.equal((await f.runtime.acceptTurn(f.turn("forge-next-task", "Another task"), { kind: "workflowStarted", operation: "book", next: "codeRequired", advanceTask: true }, verificationNow)).ok, false);
    assert.equal((await f.state()).previousTaskActionKeys, undefined);
    assert.ok(["uncertain", "needsReview"].includes((await f.state()).actions[action.key]!.status));
  } finally { await f.closeSequence(); }
});

test("E2E-381 withdrawn sequence approval or changed patient candidate cannot turn the first proof into another task's authority", async () => {
  for (const fault of ["source", "membership", "candidate", "permission", "review"] as const) {
    const f = await fixture();
    try {
      await f.start(); const first = await f.book();
      if (fault === "source") await f.source.replace({ enabled: false });
      if (fault === "membership") await f.replaceAccount({ email: "clinic-admin@example.test", actor: { actorRef: "synthetic-admin", role: "clinicAdmin", scope: f.scope }, membershipVersion: "changed" });
      if (fault === "source" || fault === "membership") {
        assert.equal((await f.flow.choose("book")).ok, false); assert.equal(f.mail.length, 1);
      } else {
        await f.start();
        if (fault === "candidate") f.setCandidates({ kind: "one", candidateIds: ["99"] });
        if (fault === "permission") f.setPermitted(false);
        if (fault === "review") f.native.afterReview(() => f.source.replace({ enabled: false }));
        if (fault === "candidate" || fault === "permission") assert.equal((await f.flow.submitCode(f.mail.at(-1)!.code)).verified, false);
        else { const second = await f.book(); assert.equal(second.status, "rejected"); }
      }
      assert.equal(f.native.requests.length, 1); assert.deepEqual((await f.state()).actions[first.key], first);
    } finally { await f.closeSequence(); }
  }
});

test("E2E-381 malformed, foreign, arbitrary-recipient or proof-reuse approvals cannot enable task sequencing", async () => {
  for (const patch of [{ maximumTasks: 1 }, { maximumTasks: 11 }, { operations: ["book", "book"] }, { operations: ["unsupported"] },
    { patientSelection: "household" }, { verification: "reuseFirstProof" }, { unresolvedActions: "ignore" }, { arbitraryRecipient: "someone@example.test" },
    { businessId: "12" }, { credentialFingerprint: "f".repeat(64) }, { scope: { tenantId: "other", clinicId: "clinic", locationId: "main" } }]) {
    const f = await fixture();
    try { await f.source.replace(patch); assert.equal((await f.flow.choose("book")).ok, false); assert.equal(f.mail.length, 0); assert.equal(f.native.requests.length, 0); }
    finally { await f.closeSequence(); }
  }
});

test("E2E-381 aborted task construction cannot publish a verifier, consume a new task or lose the prior receipt", async () => {
  const f = await fixture();
  try {
    await f.start(); const first = await f.book();
    const abort = new AbortController(), original = f.flow.startWorkflow.bind(f.flow);
    f.flow.startWorkflow = async query => { const result = await original(query); abort.abort(); return result; };
    assert.equal((await f.reception.startWorkflow(f.scope, f.turn("aborted-task", "Book another appointment"), "book", verificationNow, undefined, abort.signal)).ok, false);
    assert.equal(f.mail.length, 1); assert.equal((await f.state()).previousTaskActionKeys, undefined);
    assert.deepEqual((await f.state()).actions[first.key], first);
    f.flow.startWorkflow = original; await f.start(); const second = await f.book(); assert.equal(second.status, "committed");
    assert.equal(f.mail.length, 2); assert.equal(f.native.requests.length, 2);
    assert.deepEqual(await f.flow.reconcile(first.mutation), { kind: "exactCommit", actionKey: first.key, hostRef: first.hostRef });
  } finally { await f.closeSequence(); }
});

test("E2E-381 committed task startup with failed activation stays unconfirmed and requires a fresh explicit workflow", async () => {
  const f = await fixture();
  try {
    await f.start(); const first = await f.book(), complete = f.flow.completeWorkflowStart.bind(f.flow);
    f.flow.completeWorkflowStart = async () => false;
    assert.equal((await f.reception.startWorkflow(f.scope, f.turn("lost-activation", "Book another appointment"), "book", verificationNow)).ok, false);
    assert.equal(f.mail.length, 1); assert.deepEqual((await f.state()).actions[first.key], first); await f.playPending();
    resultValue(await f.runtime.acceptTurn(f.turn("startup-outcome", "Was it completed?"), { kind: "outcomeQuery" }, verificationNow));
    assert.match((await f.state()).callerMessages.at(-1)!, /this new task/); await f.playPending();
    f.flow.completeWorkflowStart = complete; await f.start(); const second = await f.book(); assert.equal(second.status, "committed");
    assert.equal(f.mail.length, 2); assert.equal(f.native.requests.length, 2);
  } finally { await f.closeSequence(); }
});

test("E2E-381 two approved contact corrections require fresh proof and consent while retaining the first receipt", async () => {
  const f = await correctionTasksFixture();
  const firstCity = "First Private Correction Town", secondCity = "Second Private Correction Town";
  try {
    await f.start(); const first = await f.correct(firstCity); assert.equal(first.status, "committed");
    const intent = createOpenAIClinicalIntentResolver({ owner: f.flow, apiKey: "synthetic", model: "synthetic", clinicDate: () => "2026-10-04",
      fetch: async () => { throw new Error("private contact requests must remain local"); } });
    assert.deepEqual(resultValue(await intent({ callId: f.callId, sessionId: f.sessionId, turnId: crypto.randomUUID(),
      text: "Please update my email to next-private-correction@example.test.", quality: "clear", at: verificationNow })), { kind: "workflow", operation: "patientUpdate" });
    await f.start(); assert.equal(f.patches.length, 1); assert.equal(f.flow.verificationRequired, true);
    assert.equal((await f.flow.publicIntentContext())?.lastAction, null);
    if (first.mutation.request.kind !== "patientUpdate") throw new Error("wrong retired correction kind");
    assert.equal((await f.flow.resolvePatientCorrection({ scope: f.scope, callId: f.callId, sessionId: f.sessionId,
      policyVersion: f.flowConfig.policyVersion, correctionRef: first.mutation.request.correctionRef, now: verificationNow })).ok, false);
    const second = await f.correct(secondCity); assert.equal(second.status, "committed");
    assert.notEqual(first.key, second.key); assert.equal(f.mail.length, 2); assert.equal(f.reviews(), 2);
    assert.deepEqual(f.patches, [{ city: firstCity }, { city: secondCity }]);
    assert.deepEqual((await f.state()).actions[first.key], first);
    assert.deepEqual(await f.flow.reconcile(first.mutation), { kind: "exactCommit", actionKey: first.key, hostRef: first.hostRef });
    assert.deepEqual(await f.flow.write(first.mutation, verificationNow), { kind: "rejected", actionKey: first.key, reason: "forbidden" });
    assert.equal((await f.flow.choose("patientUpdate")).ok, false);
    // The active MemoryLedger may retain native references. Private values stay
    // outside SAM; standalone SQL persistence is qualified separately.
    for (const secret of [verificationCanaries[0]!, verificationCanaries[1]!, firstCity, secondCity, ...f.mail.map(mail => mail.code)])
      assert.equal(JSON.stringify(await f.state()).includes(secret), false);
    assert.equal(JSON.stringify(await f.flow.publicIntentContext()).includes(verificationCanaries[2]!), false);
  } finally { await f.closeTasks(); }
});

for (const fault of ["unknown", "withdrawn", "permission"] as const)
  test(`E2E-381 ${fault} contact correction cannot carry prior authority into another task`, async () => {
    const f = await correctionTasksFixture();
    try {
      await f.start(); if (fault === "unknown") f.loseResponse();
      const first = await f.correct("Private Correction Fault Town");
      if (fault === "unknown") assert.ok(["uncertain", "needsReview"].includes(first.status));
      else assert.equal(first.status, "committed");
      if (fault === "withdrawn") await f.sequence.replace({ enabled: false });
      if (fault === "permission") {
        await f.start(); f.setPermitted(false);
        assert.equal((await f.flow.submitCode(f.mail.at(-1)!.code)).verified, false);
        assert.equal((await f.flow.collectPatientCorrection({ city: "Unapproved Correction Town" })).ok, false);
      } else {
        assert.equal((await f.flow.choose("patientUpdate")).ok, false); assert.equal(f.mail.length, 1);
      }
      const intent = createOpenAIClinicalIntentResolver({ owner: f.flow, apiKey: "synthetic", model: "synthetic", clinicDate: () => "2026-10-04",
        fetch: async () => { throw new Error("denied private contact request must remain local"); } });
      assert.deepEqual(resultValue(await intent({ callId: f.callId, sessionId: f.sessionId, turnId: crypto.randomUUID(),
        text: "Update my contact details.", quality: "clear", at: verificationNow })), { kind: "clarify", reason: "menuUnavailable" });
      assert.equal(f.patches.length, 1); assert.equal(f.reviews(), 1);
      assert.deepEqual((await f.state()).actions[first.key], first);
    } finally { await f.closeTasks(); }
  });
