import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { conversationPresenceText } from "../../src/core/conversation-presence.ts";
import { SILENCE_FINAL_NOTICE, SILENCE_RETRY_NOTICE } from "../../src/core/silence-notices.ts";
import { pendingClinikoLookupFixture } from "../support/pending-cliniko-lookup.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("E2E-329 real runner read and silence deadlines bound held Cliniko consumers and truthful repair without invented times", { timeout: 120_000 }, async t => {
  await withDisposablePostgres(async db => {
    const run = async (mode: "deadline" | "presenceThenSilence") => {
      const f = await pendingClinikoLookupFixture(); f.flow.dispose();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      const pending: Promise<unknown>[] = [];
      try {
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model",
          clinicDate: () => "2026-10-04", fetch: async (_value, init) => {
            const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
            const start = text === "I need to book an appointment.", menu = text === "What times are available on October 8?";
            assert.ok(start || menu, "presence and silence cannot need a model or fabricated turn");
            const decision = { kind: start ? "workflow" : "menu", operation: start ? "book" : null, stage: null,
              from: menu ? "2026-10-08" : null, to: menu ? "2026-10-08" : null, choice: null };
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
          } }));
        await call.turn("I need to book an appointment."); await call.mark(); await voiceUntil(() => f.mail.length === 1, "booking email proof"); await call.verify(f.mail[0]!.code);
        f.arm(); const speech = call.spoken.length, startedAt = Date.now();
        pending.push(call.turn("What times are available on October 8?").then(() => ({ ok: true }), error => ({ ok: false, error })));
        await f.started;
        if (mode === "presenceThenSilence") {
          pending.push(call.turn("Are you still there?"));
          await voiceUntil(() => call!.spoken.at(-1) === conversationPresenceText, "truthful repair before provider release", 2_000);
        } else {
          // Exercise the actual serving defaults, without shortening or manually
          // firing a timer. The approved contract permits bounded failure closure
          // or a truthful failure notice followed by the ordinary silence flow.
          await voiceUntil(() => call!.closed || call!.spoken.length > speech, "real bounded pending-read result", 20_000);
          if (!call.closed) assert.match(call.spoken.at(-1)!, /can't check.*booking options.*contact the clinic/);
        }
        assert.equal(f.held, true); assert.equal(f.canceled, true); assert.equal(call.writes.length, 0);
        const completion = call.closed ? "boundedFailureClose" : "playedSilenceRetryThenFinal";
        if (!call.closed) {
          await call.mark();
          await voiceUntil(() => call!.spoken.at(-1) === SILENCE_RETRY_NOTICE, "real 15-second silence retry", 20_000);
          assert.equal(call.spoken.filter(text => text === SILENCE_RETRY_NOTICE).length, 1); await call.mark();
          await voiceUntil(() => call!.spoken.at(-1) === SILENCE_FINAL_NOTICE, "real 15-second final silence notice", 20_000);
          await call.mark(); await voiceUntil(() => call!.closed, "normal closure after final notice playback");
          assert.equal(call.closeCode, 1000); assert.equal((await call.state()).terminal?.reason, "sessionClosed");
        } else assert.equal(call.closeCode, 1008);
        const after = await call.state(), spoken = call.spoken.length;
        assert.equal(after.lifecycle, "ended"); assert.equal(Object.keys(after.actions).length, 0); assert.equal(Object.keys(after.staffItems).length, 0);
        assert.equal(call.writes.length, 0); assert.equal(f.mail.length, 1);
        assert.ok(!call.spoken.slice(speech).some(text => /option one|option two|guarantee|reserved|booking.*confirmed/i.test(text)));
        f.release(); await Promise.allSettled(pending);
        assert.equal(call.spoken.length, spoken, "late held provider response cannot speak after closure");
        assert.equal((await call.flow.publicIntentContext()), undefined);
        t.diagnostic(`${mode}: ${completion}, closedAfterMs=${Date.now() - startedAt}, closeCode=${call.closeCode}`);
      } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      finally { f.release(); await Promise.allSettled(pending); await call?.close(); await f.close(); }
    };
    const settled = await Promise.allSettled([run("deadline"), run("presenceThenSilence")]);
    for (const result of settled) if (result.status === "rejected") throw result.reason;
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `waiting_${index}`, value })))), []);
  });
});
