import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { bookingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("E2E-331 repeated automated announcements and outbound repetition cannot authorize actions or keep a signed call alive", { timeout: 120_000 }, async () => {
  await withDisposablePostgres(async db => {
    const modes = ["initialHold", "hold", "batchedHold", "bank", "sms", "echo", "pause", "quote", "longHoldWithRequest", "question", "duration", "presence", "affirm"] as const;
    const run = async (mode: typeof modes[number]) => {
      const f = await bookingCallFlowFixture(); f.flow.dispose();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined, requests = 0;
      try {
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model",
          clinicDate: () => "2026-10-04", fetch: async (_value, init) => {
            requests++;
            const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
            const start = text === "I need to book an appointment.", menu = text === "What times are available on October 8?";
            // An adversarial ordinal guess must not turn a script or question into consent.
            const guess = { kind: start ? "workflow" : menu ? "menu" : "choice", operation: start ? "book" : null, stage: null,
              from: menu ? "2026-10-08" : null, to: menu ? "2026-10-08" : null, choice: start || menu ? null : 1 };
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(guess) }] }] });
          } }));
        const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
        if (mode === "initialHold") {
          const traffic = f.allTraffic.length;
          for (let index = 0; index < 3; index++) {
            await call.turn("You have been placed on hold. Please wait.", index === 2 ? { expectedFailure: "automatedCallUnavailable" } : {});
            if (index < 2) await call.mark();
          }
          await voiceUntil(() => call!.closed, "unverified automated call closes");
          assert.equal(requests, 0); assert.equal(f.mail.length, 0); assert.equal(f.allTraffic.length, traffic);
          assert.equal(call.writes.length, 0); assert.equal(Object.keys((await call.state()).staffItems).length, 0);
          assert.equal((await call.state()).lifecycle, "ended"); assert.equal(call.closeCode, 1008);
          return;
        }
        await play("I need to book an appointment."); await voiceUntil(() => f.mail.length === 1, "booking verification"); await call.verify(f.mail[0]!.code);
        await play("What times are available on October 8?"); await play("The first time, please.");
        const before = await call.state(), proposal = Object.values(before.actions).at(-1)!;
        assert.equal(proposal.status, "awaitingConfirmation"); assert.equal(before.presentations[proposal.presentationId]?.status, "played");
        const traffic = f.allTraffic.length, models = requests;
        if (["hold", "batchedHold", "bank", "sms", "echo"].includes(mode)) {
          const script = mode === "hold" ? "You have been placed on hold. Please wait."
            : mode === "batchedHold" ? "You have been placed on hold. Please wait. You have been placed on hold. Please wait."
            : mode === "bank" ? "There is an unauthorized transaction. To allow this transaction press 1, or press 2 to speak to bank security."
            : mode === "sms" ? "You have received an SMS. Please press 1 to listen to the message or 2 for help."
            : call.spoken.at(-1)!;
          for (let index = 0; index < 3; index++) {
            await call.turn(script, index === 2 ? { expectedFailure: "automatedCallUnavailable" } : {});
            assert.equal(requests, models, "a whole automated script or exact outbound repetition never reaches the model");
            if (index < 2) {
              assert.match(call.spoken.at(-1)!, /automated announcement|repeated clinic message/);
              await call.mark();
            }
          }
          await voiceUntil(() => call!.closed, "third unattended turn closes actual transport");
          assert.equal(call.closeCode, 1008); assert.equal((await call.state()).lifecycle, "ended");
          assert.equal((await call.flow.publicIntentContext()), undefined);
        } else if (mode === "affirm") {
          await call.turn("Yes");
          assert.equal(call.writeRequests.length, 1); assert.equal(call.writeRequests[0]?.method, "POST");
          assert.equal(call.writeRequests[0]?.body.starts_at, "2026-10-08T04:00:00.000Z");
          assert.equal(call.writeRequests[0]?.body.patient_id, verificationCanaries[2]);
          assert.equal((await call.state()).actions[proposal.key]?.status, "committed");
          assert.match(call.spoken.at(-1)!, /booking is confirmed/i);
          return;
        } else {
          const text = mode === "pause" ? "Please hold."
            : mode === "quote" ? "Someone told me to press 1, but I want to ask about my appointment."
            : mode === "longHoldWithRequest" ? "You have been placed on hold. Please wait. ".repeat(48) + "I want to ask about my appointment."
            : mode === "question" ? "3 o'clock, did you say?"
            : mode === "duration" ? "Yes, how long is the appointment?" : "Yes, I'm still here.";
          await play(text);
          assert.equal((await call.state()).actions[proposal.key]?.status, "canceled");
          assert.equal(call.closed, false);
          if (mode === "pause") {
            assert.equal(requests, models);
            await play("What times are available on October 8?"); await play("The first time, please."); await call.turn("Yes");
            assert.equal(call.writeRequests.length, 1, "a genuine caller can resume with fresh played options and confirmation");
            assert.equal(Object.values((await call.state()).actions).at(-1)?.status, "committed");
            return;
          }
          if (mode === "quote" || mode === "longHoldWithRequest") assert.equal(requests, models + 1, "an actual request with announcement wording is not a whole automated script");
        }
        const after = await call.state();
        assert.equal(call.writes.length, 0); assert.equal(call.writeRequests.length, 0); assert.equal(f.allTraffic.length, traffic); assert.equal(f.mail.length, 1);
        assert.deepEqual(after.staffItems, before.staffItems);
        assert.ok(!Object.values(after.effects).some(effect => effect.kind === "hostWrite"));
        assert.ok(!call.transcripts.includes(f.mail[0]!.code));
      } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      finally { await call?.close(); await f.close(); }
    };
    let next = 0; const failures: unknown[] = [];
    const settled = await Promise.allSettled(Array.from({ length: 3 }, async () => { for (;;) { const mode = modes[next++]; if (!mode) return; try { await run(mode); } catch (error) { failures.push(error); } } }));
    for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `automated_${index}`, value })))), []);
  });
});
