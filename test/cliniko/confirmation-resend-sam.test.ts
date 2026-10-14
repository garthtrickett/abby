import assert from "node:assert/strict";
import { after, test } from "node:test";
import { connectPostgres } from "../../src/storage/connect.ts";
import { ClinikoSamConfirmationResendHost } from "../../src/standalone/cliniko-sam-confirmation-resend-host.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { EffectWorker } from "../../src/core/effect-worker.ts";
import { confirmationResendFixture } from "../support/confirmation-resend.ts";
import { withSmtpVerificationServer } from "../support/smtp-verification-server.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const db = connectPostgres(process.env.DATABASE_URL); after(async () => { await db.destroy(); });

test("E2E-373 gateway proposal and real played/affirmed SAM effect drive the native review and one SMTP send", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await confirmationResendFixture(db, smtp.config, "appointments.resend", true);
    let host: ClinikoSamConfirmationResendHost | undefined;
    try {
      await f.verify(); host = resultValue(await ClinikoSamConfirmationResendHost.create(f.config));
      const prepared = resultValue(await host.prepare("81"));
      const reception = new TextReception(f.ledger, f.policies, host, undefined, undefined, undefined, undefined, f.sessionConfig.clock), agent = new CommandGateway({ actorRef: "agent", role: "agent", scope: f.scope }, f.policies, reception);
      const now = f.sessionConfig.clock(), turn = { callId: f.callId, sessionId: f.sessionId, turnId: "resend-proposal", text: "Send my appointment details", quality: "clear" as const, at: now };
      const result = resultValue(await agent.submit({ kind: "notifications.resend.propose.v1", turn, requestRef: prepared.requestRef, now }));
      assert.equal(result.kind, "confirmationResendProposal");
      const action = Object.values((await f.state()).actions).find(a => a.kind === "confirmationResend")!; assert.ok(action);
      f.confirm(prepared.requestRef); // The earlier private test boolean does not bypass the real SAM owner.
      assert.equal((await f.runtime.acceptTurn({ ...turn, turnId: "early", text: "yes" }, { kind: "affirm", actionKey: action.key, digest: action.digest, affirmative: true }, now)).ok, false);
      assert.equal(smtp.commands.length, 0); assert.equal(f.recalls.length, 0);
      resultValue(await f.runtime.startPresentation(f.callId, action.presentationId, f.sessionId, now));
      resultValue(await f.runtime.resolvePresentation(f.callId, action.presentationId, "played", f.sessionId, now));
      resultValue(await f.runtime.acceptTurn({ ...turn, turnId: "affirm", text: "Yes, send it" }, { kind: "affirm", actionKey: action.key, digest: action.digest, affirmative: true }, now));
      await new EffectWorker(f.runtime, host).process(f.callId, `${action.key}:write`, now);
      const state = await f.state(); assert.equal(state.actions[action.key]!.status, "committed"); assert.equal(smtp.messages.length, 1); assert.equal(f.recalls.length, 1);
      assert.match(state.callerMessages.at(-1)!, /mail service accepted.*can't confirm.*inbox/);
      assert.equal(Object.values(state.effects).some(e => e.kind === "notification"), false);
      for (const secret of [...verificationCanaries, f.mail[0]!.code, "20 Fixture Road", "Séamus Example"]) assert.equal(JSON.stringify([state, result]).includes(secret), false);
      assert.equal((await agent.submit({ kind: "notifications.resend.propose.v1", turn: { ...turn, turnId: "injected" }, requestRef: prepared.requestRef, now, email: verificationCanaries[0] } as never)).ok, false);
      const query = resultValue(await agent.submit({ kind: "calls.notifications.outcome.v1", turn: { ...turn, turnId: "query", text: "Was the email sent?" }, now }));
      assert.ok(JSON.stringify(query).includes("notification")); assert.equal(smtp.messages.length, 1); assert.equal(f.recalls.length, 1);
    } finally { host?.dispose(); await f.close(); }
  });
});

test("E2E-373 actual SAM withdrawal or current clinic approval loss stops native resend", async () => {
  for (const fault of ["withdraw", "source"] as const) {
    await withSmtpVerificationServer(async smtp => {
      const f = await confirmationResendFixture(db, smtp.config, "appointments.resend", true); let host: ClinikoSamConfirmationResendHost | undefined;
      try {
        await f.verify(); host = resultValue(await ClinikoSamConfirmationResendHost.create(f.config));
        const prepared = resultValue(await host.prepare("81")), now = f.sessionConfig.clock();
        const reception = new TextReception(f.ledger, f.policies, host, undefined, undefined, undefined, undefined, f.sessionConfig.clock);
        resultValue(await reception.proposeConfirmationResend(f.scope, { callId: f.callId, sessionId: f.sessionId, turnId: "proposal", text: "Send email", quality: "clear", at: now }, prepared.requestRef, now));
        const action = Object.values((await f.state()).actions).find(a => a.kind === "confirmationResend")!;
        resultValue(await f.runtime.startPresentation(f.callId, action.presentationId, f.sessionId, now)); resultValue(await f.runtime.resolvePresentation(f.callId, action.presentationId, "played", f.sessionId, now));
        if (fault === "withdraw") {
          resultValue(await f.runtime.nonAffirmativeFinal({ callId: f.callId, sessionId: f.sessionId, turnId: "no", text: "No", quality: "clear", at: now }, (await f.state()).conversationRevision, now));
        } else {
          resultValue(await f.runtime.acceptTurn({ callId: f.callId, sessionId: f.sessionId, turnId: "yes", text: "Yes", quality: "clear", at: now }, { kind: "affirm", actionKey: action.key, digest: action.digest, affirmative: true }, now));
          await f.replace({ enabled: false }); await new EffectWorker(f.runtime, host).process(f.callId, `${action.key}:write`, now);
        }
        assert.equal(smtp.commands.length, 0); assert.equal(f.recalls.length, 0);
      } finally { host?.dispose(); await f.close(); }
    });
  }
});

test("E2E-373 unknown SMTP outcome in actual SAM is reconciled only by reading the durable receipt", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await confirmationResendFixture(db, smtp.config, "appointments.resend", true); let host: ClinikoSamConfirmationResendHost | undefined;
    try {
      await f.verify(); host = resultValue(await ClinikoSamConfirmationResendHost.create(f.config));
      const prepared = resultValue(await host.prepare("81")), now = f.sessionConfig.clock();
      resultValue(await new TextReception(f.ledger, f.policies, host, undefined, undefined, undefined, undefined, f.sessionConfig.clock).proposeConfirmationResend(f.scope,
        { callId: f.callId, sessionId: f.sessionId, turnId: "proposal", text: "Send email", quality: "clear", at: now }, prepared.requestRef, now));
      const action = Object.values((await f.state()).actions).find(a => a.kind === "confirmationResend")!;
      resultValue(await f.runtime.startPresentation(f.callId, action.presentationId, f.sessionId, now)); resultValue(await f.runtime.resolvePresentation(f.callId, action.presentationId, "played", f.sessionId, now));
      resultValue(await f.runtime.acceptTurn({ callId: f.callId, sessionId: f.sessionId, turnId: "yes", text: "Yes", quality: "clear", at: now }, { kind: "affirm", actionKey: action.key, digest: action.digest, affirmative: true }, now));
      smtp.fault("dropAfterData"); const worker = new EffectWorker(f.runtime, host); await worker.process(f.callId, `${action.key}:write`, now);
      const state = await f.state(); assert.equal(state.actions[action.key]!.status, "uncertain"); const count = f.traffic.length;
      assert.deepEqual(await host.reconcile(action.mutation), { kind: "stillUnknown", actionKey: action.key });
      assert.equal(f.traffic.length, count); assert.equal(smtp.messages.length, 1); assert.equal(f.recalls.length, 1);
      await assert.rejects(worker.process(f.callId, `${action.key}:write`, now)); assert.equal(smtp.messages.length, 1);
    } finally { host?.dispose(); await f.close(); }
  });
});
