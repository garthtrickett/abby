import assert from "node:assert/strict";
import { after, test } from "node:test";
import { connectPostgres } from "../../src/storage/connect.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { EffectWorker } from "../../src/core/effect-worker.ts";
import { confirmationResendFixture } from "../support/confirmation-resend.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { withSmtpVerificationServer } from "../support/smtp-verification-server.ts";

const db = connectPostgres(process.env.DATABASE_URL!); after(async () => { await db.destroy(); });
import { resendWorkflow as workflow } from "../support/confirmation-resend-workflow.ts";

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
      assert.deepEqual(resultValue(await flow.listResendAppointments()), { count: 2, hasNext: false, hasPrevious: false });
      assert.match(f.readbacks[0]!, /Press 1 for:.*Press 2 for:/);
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

const sevenAppointments = () => Array.from({ length: 7 }, (_, i) => ({ id: String(81 + i),
  starts_at: `2026-10-${String(8 + i).padStart(2, "0")}T04:00:00.000Z`, ends_at: `2026-10-${String(8 + i).padStart(2, "0")}T04:30:00.000Z` }));

test("E2E-376 private resend pages traverse a stable native list in both directions and select its seventh appointment", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await confirmationResendFixture(db, smtp.config, "appointments.resend", true); let flow: ClinikoCallFlow | undefined;
    try {
      const w = await workflow(f); flow = w.flow; await w.verify(); f.setChoices(sevenAppointments());
      assert.deepEqual(resultValue(await flow.listResendAppointments()), { count: 3, hasNext: true, hasPrevious: false });
      assert.equal((await flow.pageResendAppointments("previous")).ok, false);
      assert.deepEqual(resultValue(await flow.pageResendAppointments("next")), { count: 3, hasNext: true, hasPrevious: true });
      assert.match(f.readbacks.at(-1)!, /11 October/);
      // Provider response order is irrelevant; the private list is chronological.
      f.setChoices(sevenAppointments().reverse());
      assert.deepEqual(resultValue(await flow.pageResendAppointments("previous")), { count: 3, hasNext: true, hasPrevious: false });
      resultValue(await flow.pageResendAppointments("next"));
      assert.deepEqual(resultValue(await flow.pageResendAppointments("next")), { count: 1, hasNext: false, hasPrevious: true });
      assert.equal((await flow.pageResendAppointments("next")).ok, false);
      assert.equal((await flow.selectResendAppointment(2)).ok, false);
      const ref = resultValue(await flow.selectResendAppointment(1));
      assert.match(f.readbacks.at(-1)!, /14 October/);
      assert.equal(ref.requestRef, flow.confirmationResendRef);
      for (const secret of [...verificationCanaries, "20 Fixture Road", "Séamus Example"]) assert.equal(JSON.stringify(await f.state()).includes(secret), false);
      assert.equal(f.recalls.length, 0); assert.equal(smtp.messages.length, 0);
    } finally { flow?.dispose(); await f.close(); }
  });
});

test("E2E-376 resend paging withdraws old choices after native insertion, removal, retiming or failed playback", async () => {
  for (const fault of ["insert", "remove", "time", "play"] as const) {
    await withSmtpVerificationServer(async smtp => {
      const f = await confirmationResendFixture(db, smtp.config, "appointments.resend", true); let flow: ClinikoCallFlow | undefined;
      try {
        const w = await workflow(f); flow = w.flow; await w.verify(); const rows = sevenAppointments(); f.setChoices(rows);
        resultValue(await flow.listResendAppointments());
        if (fault === "insert") f.setChoices([...rows, { id: "99", starts_at: "2026-10-07T04:00:00.000Z", ends_at: "2026-10-07T04:30:00.000Z" }]);
        if (fault === "remove") f.setChoices(rows.slice(1));
        if (fault === "time") f.setChoices(rows.map((row, i) => i === 4 ? { ...row, starts_at: "2026-10-12T05:00:00.000Z", ends_at: "2026-10-12T05:30:00.000Z" } : row));
        if (fault === "play") f.setPlay(false);
        assert.equal((await flow.pageResendAppointments("next")).ok, false);
        assert.equal((await flow.selectResendAppointment(1)).ok, false);
        assert.equal(flow.confirmationResendRef, undefined);
        assert.equal(f.recalls.length, 0); assert.equal(smtp.messages.length, 0);
      } finally { flow?.dispose(); await f.close(); }
    });
  }
});

test("E2E-376 re-entering private menus withdraws a previously prepared resend reference", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await confirmationResendFixture(db, smtp.config, "appointments.resend", true); let flow: ClinikoCallFlow | undefined;
    try {
      const w = await workflow(f); flow = w.flow; await w.verify(); resultValue(await flow.listResendAppointments());
      const old = resultValue(await flow.selectResendAppointment(1)); resultValue(await flow.listResendAppointments());
      assert.equal(flow.confirmationResendRef, undefined);
      assert.equal((await flow.resolveConfirmationResend({ scope: f.scope, callId: f.callId, sessionId: f.sessionId,
        policyVersion: f.sessionConfig.policyVersion, requestRef: old.requestRef, now: f.sessionConfig.clock() })).ok, false);
      const fresh = resultValue(await flow.selectResendAppointment(1)); assert.notEqual(fresh.requestRef, old.requestRef);
      assert.equal(f.recalls.length, 0); assert.equal(smtp.messages.length, 0);
    } finally { flow?.dispose(); await f.close(); }
  });
});
