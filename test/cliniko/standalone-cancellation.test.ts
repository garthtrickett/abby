import assert from "node:assert/strict";
import test from "node:test";
import { cancellationFixture, cancellationNow, cancellationCanaries } from "../support/standalone-cancellation.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("E2E-272 standalone text cancellation crosses email proof, actual agent/SAM confirmation and review before one inspected write", async () => {
  const app = await cancellationFixture();
  try {
    const reply = resultValue(await app.propose(await app.verify()));
    assert.ok("progress" in reply); assert.equal(reply.progress.actions[0]?.status, "awaitingConfirmation");
    for (const value of [...cancellationCanaries, app.mail[0]!.code]) assert.ok(!JSON.stringify(reply).includes(value));
    const action = Object.values((await app.state()).actions)[0]!;
    const presentation = (await app.state()).presentations[action.presentationId]!;
    assert.equal(presentation.kind, "speech"); assert.match(presentation.approvedText, /\$20/);
    await app.drain(); assert.equal(app.patches, 0); assert.equal(app.recalls.length, 0);
    assert.equal((await app.reception.affirm(app.scope, { callId: app.callId, sessionId: app.sessionId,
      turnId: "premature-yes", text: "Yes", quality: "clear", at: cancellationNow }, action.key, action.digest, cancellationNow)).ok, false);
    await app.confirm(); assert.equal(app.patches, 0);
    const committed = await app.drain(); assert.equal(committed.actions[action.key]?.status, "committed");
    assert.equal(app.patches, 1); assert.equal(app.recalls.length, 1); assert.equal(app.recalls[0]!.recalled, false);
    const found = await app.discovery(); assert.equal(found.pending.length, 1);
    const review = found.pending[0]!; assert.equal(review.kind, "review"); assert.equal(review.envelope.request.operation.kind, "cancel");
    assert.equal(review.envelope.request.operation.cancellationReason, 50);
    assert.equal(review.envelope.request.termsVersion, "fee-1");
    assert.equal(action.mutation.request.kind, "cancel");
    resultValue(await app.propose(action.mutation.request.patient.verificationRef)); await app.drain();
    assert.equal(app.patches, 1); assert.equal(app.recalls.length, 1);
    assert.equal(JSON.stringify(await app.state()).includes(cancellationCanaries[0]!), false);
  } finally { app.host.dispose(); app.email.close(); }
});

test("E2E-272 absent or revoked email proof cannot disclose a target or reach recall/clinical send", async () => {
  for (const scenario of ["missing", "revoked"] as const) {
    const app = await cancellationFixture();
    try {
      const ref = scenario === "missing" ? "guessed-proof" : await app.verify();
      if (scenario === "revoked") app.revoke();
      const reply = resultValue(await app.propose(ref)); assert.ok("progress" in reply);
      assert.deepEqual(reply.progress.actions, []); await app.drain();
      assert.equal(app.patches, 0); assert.equal(app.appointmentReads, 0); assert.equal(app.recalls.length, 0);
    } finally { app.host.dispose(); app.email.close(); }
  }
});

test("E2E-272 recall loss/alteration and changed terms, target, permission, policy, stop or disconnect prevent clinical send", async () => {
  for (const scenario of ["recallLost", "recallAltered", "changedTerms", "changedTarget", "revokedProof", "disabled", "stop", "disconnect"] as const) {
    const app = await cancellationFixture(scenario);
    try {
      resultValue(await app.propose(await app.verify())); await app.confirm();
      const settled = await app.drain(); assert.equal(app.patches, 0); assert.equal(app.recalls.length, 1);
      assert.notEqual(Object.values(settled.actions)[0]?.status, "committed");
      assert.equal((await app.discovery()).pending.length, 1);
      await app.drain(); assert.equal(app.patches, 0); assert.equal(app.recalls.length, 1);
      assert.equal(app.recalls[0]!.recalled, false);
    } finally { app.host.dispose(); app.email.close(); }
  }
});

test("E2E-272 lost cancellation response remains unknown after matching provider state and needs review without replay or handoff claim", async () => {
  const app = await cancellationFixture("writeLost");
  try {
    resultValue(await app.propose(await app.verify())); await app.confirm();
    const uncertain = await app.drain(), action = Object.values(uncertain.actions)[0]!;
    assert.equal(action.status, "uncertain"); assert.equal(app.patches, 1);
    assert.ok(uncertain.callerMessages.some(text => text.includes("pending review")));
    const later = await app.drain(); assert.equal(later.actions[action.key]?.status, "uncertain");
    assert.deepEqual(await app.host.reconcile(action.mutation), { kind: "stillUnknown", actionKey: action.key });
    await app.drain("2026-10-04T04:05:00.000Z"); const due = await app.drain("2026-10-04T04:05:00.000Z");
    assert.equal(due.actions[action.key]?.status, "needsReview");
    assert.ok(Object.values(due.staffItems).every(item => item.status !== "open" && item.status !== "acknowledged"));
    assert.equal(app.patches, 1); assert.equal(app.recalls.length, 1); assert.equal(app.recalls[0]!.recalled, false);
    assert.equal((await app.discovery()).pending.length, 1);
  } finally { app.host.dispose(); app.email.close(); }
});

test("E2E-272 closing during a held clinical response cannot produce a late confirmation or replay", async () => {
  const app = await cancellationFixture("heldWrite");
  try {
    resultValue(await app.propose(await app.verify())); await app.confirm();
    const pending = app.drain();
    for (let attempt = 0; attempt < 100 && app.patches === 0; attempt++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(app.patches, 1); app.host.dispose();
    const stopped = await pending; assert.notEqual(Object.values(stopped.actions)[0]?.status, "committed");
    app.releaseWrite(); await new Promise<void>(resolve => setImmediate(resolve));
    const final = await app.drain(); assert.notEqual(Object.values(final.actions)[0]?.status, "committed");
    assert.equal(app.patches, 1); assert.equal(app.recalls.length, 1);
  } finally { app.host.dispose(); app.email.close(); }
});


test("E2E-272 policy, terms and proof changes during the final provider read still block the actual PATCH", async () => {
  for (const scenario of ["lateStop", "lateRevoke", "lateTerms"] as const) {
    const app = await cancellationFixture(scenario);
    try {
      resultValue(await app.propose(await app.verify())); await app.confirm();
      const outcome = await app.drain(); assert.equal(app.appointmentReads, 2); assert.equal(app.patches, 0);
      assert.equal(app.recalls.length, 1); assert.notEqual(Object.values(outcome.actions)[0]?.status, "committed");
      assert.equal((await app.discovery()).pending.length, 1); await app.drain(); assert.equal(app.patches, 0);
    } finally { app.host.dispose(); app.email.close(); }
  }
});
