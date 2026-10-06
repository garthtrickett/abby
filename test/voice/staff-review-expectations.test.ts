import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { conversationPresenceText } from "../../src/core/conversation-presence.ts";
import { clinikoStaffCallFlowFixture } from "../support/cliniko-staff-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const cadence = /approved process calls for reviewing saved requests every 30 minutes/;
const saved = /staff request was saved.*can't confirm.*read.*promise a callback time/;

test("E2E-326 signed saved requests explain only current approved process evidence and status queries never resend", { timeout: 120_000 }, async () => {
  await withDisposablePostgres(async db => {
    const modes = ["current", "repeated", "changed", "revoked", "expired", "disabled", "unavailable", "receiptRevoked", "uncertain", "interrupted"] as const;
    const run = async (mode: typeof modes[number]) => {
      const f = await clinikoStaffCallFlowFixture({ nonCommitted: mode === "uncertain" }); f.flow.dispose();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined, release = () => {};
      const pending: Promise<void>[] = [];
      try {
        const port = f.flowConfig.fetchPort;
        const config = mode === "receiptRevoked" ? { ...f.flowConfig, fetchPort: (async (value, init) => {
          const response = await port(value, init);
          if (init?.method === "POST" && new URL(String(value)).pathname === "/v1/recalls") await f.replaceStaffApproval({ approved: false });
          return response;
        }) as typeof fetch } : f.flowConfig;
        call = await clinikoWorkflowVoiceFixture(db, config, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model",
          clinicDate: () => "2026-10-04", fetch: async () => { throw new Error("trusted staff wording should not need a model"); } }));
        await call.turn("Could I speak to a receptionist?"); await call.mark();
        await voiceUntil(() => f.mail.length === 1, "independent verification"); await call.verify(f.mail[0]!.code);
        await call.turn("Please send that request."); await call.mark();
        assert.equal(f.staffPosts, 1); assert.equal(call.writes.length, 0);
        if (mode === "uncertain") {
          assert.match(call.spoken.at(-1)!, /can't confirm whether.*saved or received/); assert.doesNotMatch(call.spoken.at(-1)!, cadence);
          assert.equal(Object.values((await call.state()).staffItems).at(-1)?.status, "needsReview"); return;
        }
        assert.match(call.spoken.at(-1)!, saved);
        if (mode === "receiptRevoked") assert.doesNotMatch(call.spoken.at(-1)!, cadence);
        else { assert.match(call.spoken.at(-1)!, cadence); assert.match(call.spoken.at(-1)!, /does not promise a response time/); }
        const before = await call.state(), traffic = f.traffic.length, mail = f.mail.length;
        if (mode === "changed") await f.replaceStaffApproval({ reviewCadenceMinutes: 45 });
        if (mode === "revoked") await f.replaceStaffApproval({ approved: false });
        if (mode === "expired") await f.replaceStaffApproval({ effectiveUntil: "2026-10-04T06:00:00.000Z" });
        if (mode === "disabled") await f.replaceStaffApproval({ enabled: false });
        if (mode === "unavailable") call.flow.readStaffReviewProcess = async () => { throw new Error("unavailable public process"); };
        if (mode === "interrupted") {
          const read = call.flow.readStaffReviewProcess.bind(call.flow);
          let entered!: () => void, canceled = false;
          const started = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
          call.flow.readStaffReviewProcess = async query => {
            const found = await read(query); query.signal.addEventListener("abort", () => { canceled = true; }, { once: true });
            entered(); await hold; return found;
          };
          pending.push(call.turn("Has somebody received my message?")); await started;
          const speech = call.spoken.length;
          pending.push(call.turn("Are you still there?"));
          await voiceUntil(() => call!.spoken.at(-1) === conversationPresenceText, "presence reply before process read release");
          assert.equal(canceled, true); release(); await Promise.all(pending);
          assert.equal(call.spoken.length, speech + 1); assert.equal(call.spoken.at(-1), conversationPresenceText);
        } else {
          await call.turn(mode === "repeated" ? "Please ask the team to call me about this." : "Has somebody received my message?");
          assert.match(call.spoken.at(-1)!, saved);
          if (["current", "repeated"].includes(mode)) assert.match(call.spoken.at(-1)!, cadence);
          else assert.doesNotMatch(call.spoken.at(-1)!, /approved process/);
        }
        assert.equal(f.staffPosts, 1); assert.equal(call.writes.length, 0); assert.equal(f.traffic.length, traffic); assert.equal(f.mail.length, mail);
        assert.deepEqual((await call.state()).staffItems, before.staffItems);
        assert.ok(call.spoken.every(text => [...verificationCanaries, "synthetic-review-owner", "synthetic-review-backup", "synthetic-admin"].every(canary => !text.includes(canary))));
        assert.ok(!call.transcripts.includes(f.mail[0]!.code));
      } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      finally { release(); await Promise.allSettled(pending); await call?.close(); await f.close(); }
    };
    let next = 0; const failures: unknown[] = [];
    const settled = await Promise.allSettled(Array.from({ length: 4 }, async () => { for (;;) { const mode = modes[next++]; if (!mode) return; try { await run(mode); } catch (error) { failures.push(error); } } }));
    for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `staff_review_${index}`, value })))), []);
  });
});
