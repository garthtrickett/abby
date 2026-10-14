import assert from "node:assert/strict";
import { after, test } from "node:test";
import { connectPostgres } from "../../src/storage/connect.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { EffectWorker } from "../../src/core/effect-worker.ts";
import { confirmationResendFixture } from "../support/confirmation-resend.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { withSmtpVerificationServer } from "../support/smtp-verification-server.ts";

const db = connectPostgres(process.env.DATABASE_URL!); after(async () => { await db.destroy(); });
async function workflow(f: Awaited<ReturnType<typeof confirmationResendFixture>>) {
  const flow = resultValue(ClinikoCallFlow.create({ ...f.config,
    directory: new OwnerFileAdminDirectory(f.accountPath, f.scope), lookup: f.sessionConfig.lookup,
    verificationBudget: f.sessionConfig.budget, delivery: f.sessionConfig.delivery,
    approvals: { bookCaller: f.path, cancelCaller: f.path, rescheduleCaller: f.path, booking: f.path, cancellation: f.path, rescheduling: f.path },
    cliniko: { ...f.config.cliniko, practitionerId: "22", appointmentTypeId: "33", contactRevision: f.revision },
    resend: { ...f.config, callerApprovalPath: f.path },
  }));
  const now = f.sessionConfig.clock(), state = await f.state(), greeting = state.pendingPresentationId!;
  resultValue(await f.runtime.startPresentation(f.callId, greeting, f.sessionId, now));
  resultValue(await f.runtime.resolvePresentation(f.callId, greeting, "played", f.sessionId, now));
  const reception = new TextReception(f.ledger, f.policies, flow, undefined, undefined, undefined, undefined, f.sessionConfig.clock);
  const turn = (id: string, text: string) => ({ callId: f.callId, sessionId: f.sessionId, turnId: id, text, quality: "clear" as const, at: f.sessionConfig.clock() });
  resultValue(await reception.startWorkflow(f.scope, turn("start", "Please resend my appointment email"), "confirmationResend", now));
  const pending = (await f.state()).pendingPresentationId!;
  resultValue(await f.runtime.startPresentation(f.callId, pending, f.sessionId, now));
  resultValue(await f.runtime.resolvePresentation(f.callId, pending, "played", f.sessionId, now));
  const verify = async () => {
    const deadline = Date.now() + 5000;
    while (!f.mail.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.mail.length, 1); assert.equal((await flow.submitCode(f.mail[0]!.code)).verified, true);
  };
  return { flow, reception, verify, turn };
}

test("E2E-374 resend call workflow privately selects an exact appointment and requires separate SAM consent", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await confirmationResendFixture(db, smtp.config, "appointments.resend", true);
    let flow: ClinikoCallFlow | undefined;
    try {
      f.setChoices([{ id: "81", starts_at: "2026-10-08T04:00:00.000Z", ends_at: "2026-10-08T04:30:00.000Z" },
        { id: "82", starts_at: "2026-10-09T04:00:00.000Z", ends_at: "2026-10-09T04:30:00.000Z" }]);
      const w = await workflow(f); flow = w.flow;
      assert.equal(flow.workflow, "confirmationResend"); assert.equal(flow.verificationRequired, true);
      assert.equal((await flow.listResendAppointments()).ok, false); assert.equal(f.traffic.length, 0);
      await w.verify(); assert.equal(flow.verificationRequired, false);
      assert.deepEqual(resultValue(await flow.listResendAppointments()), { count: 2 });
      assert.match(f.readbacks[0]!, /Option 1:.*Option 2:/);
      const request = resultValue(await flow.selectResendAppointment(2));
      assert.match(f.readbacks[1]!, /registered-session@example.test/);
      assert.match(f.readbacks[1]!, /9 October/);
      assert.equal(f.recalls.length, 0); assert.equal(smtp.messages.length, 0);
      const now = f.sessionConfig.clock();
      resultValue(await w.reception.proposeConfirmationResend(f.scope, w.turn("propose", "Send that email"), request.requestRef, now));
      const action = Object.values((await f.state()).actions).find(a => a.kind === "confirmationResend")!;
      assert.equal((await f.runtime.acceptTurn(w.turn("early", "Yes"), { kind: "affirm", actionKey: action.key, digest: action.digest, affirmative: true }, now)).ok, false);
      resultValue(await f.runtime.startPresentation(f.callId, action.presentationId, f.sessionId, now));
      resultValue(await f.runtime.resolvePresentation(f.callId, action.presentationId, "played", f.sessionId, now));
      resultValue(await f.runtime.acceptTurn(w.turn("yes", "Yes, send it"), { kind: "affirm", actionKey: action.key, digest: action.digest, affirmative: true }, now));
      await new EffectWorker(f.runtime, flow).process(f.callId, `${action.key}:write`, now);
      const state = await f.state(); assert.equal(state.actions[action.key]!.status, "committed");
      assert.equal(f.recalls.length, 1); assert.equal(smtp.messages.length, 1);
      const reads = f.traffic.length;
      assert.deepEqual(await flow.reconcile(action.mutation), { kind: "exactCommit", actionKey: action.key, hostRef: `confirmation-mail:${request.requestRef}` });
      assert.equal(f.traffic.length, reads); assert.equal(smtp.messages.length, 1);
      const nativeReview = resultValue(decodeClinikoReview(f.recalls[0]!.notes)).request.operation;
      assert.equal(nativeReview.kind, "confirmationResend");
      assert.equal((nativeReview as Extract<typeof nativeReview, { kind: "confirmationResend" }>).appointmentId, "82");
      for (const secret of [...verificationCanaries, f.mail[0]!.code, "20 Fixture Road", "Séamus Example"]) assert.equal(JSON.stringify([state, request]).includes(secret), false);
      assert.equal((await flow.selectResendAppointment(1)).ok, false);
    } finally { flow?.dispose(); await f.close(); }
  });
});

test("E2E-374 resend private selection rejects changed native times, superseding turns and permission loss", async () => {
  for (const fault of ["time", "turn", "permission", "play", "abort", "close"] as const) {
    await withSmtpVerificationServer(async smtp => {
      const f = await confirmationResendFixture(db, smtp.config, "appointments.resend", true);
      let flow: ClinikoCallFlow | undefined;
      try {
        const w = await workflow(f); flow = w.flow; await w.verify();
        if (fault === "play") f.setPlay(false);
        const controller = new AbortController();
        if (fault === "abort") f.afterReadback(async () => { controller.abort(); });
        const listed = await flow.listResendAppointments(controller.signal);
        if (fault === "play" || fault === "abort") assert.equal(listed.ok, false); else resultValue(listed);
        if (fault === "time") f.setChoices([{ id: "81", starts_at: "2026-10-08T05:00:00.000Z", ends_at: "2026-10-08T05:30:00.000Z" }]);
        if (fault === "turn") resultValue(await f.runtime.acceptTurn(w.turn("other", "What happened?"), { kind: "outcomeQuery" }, f.sessionConfig.clock()));
        if (fault === "permission") f.setPermitted(false);
        if (fault === "close") flow.dispose();
        assert.equal((await flow.selectResendAppointment(1)).ok, false);
        assert.equal((await flow.selectResendAppointment(1)).ok, false);
        assert.equal(f.recalls.length, 0); assert.equal(smtp.messages.length, 0);
      } finally { flow?.dispose(); await f.close(); }
    });
  }
});

test("E2E-374 resend caller policy and email-recipient approval are independently required", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await confirmationResendFixture(db, smtp.config, "appointments.read", true);
    let flow: ClinikoCallFlow | undefined;
    try {
      const w = await workflow(f); flow = w.flow;
      assert.equal(flow.workflow, undefined);
      assert.equal((await flow.listResendAppointments()).ok, false);
      assert.equal(f.mail.length, 0); assert.equal(f.recalls.length, 0); assert.equal(smtp.messages.length, 0);
    } finally { flow?.dispose(); await f.close(); }
  });
});
