import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { bookingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("E2E-328 signed proposed calls reject foreign stream/session/generation and unrelated or unclear text as action authority", { timeout: 120_000 }, async () => {
  await withDisposablePostgres(async db => {
    const modes = ["session", "generation", "futureGeneration", "mixedBatch", "stream", "track", "ownedBackground", "unclearAffirmative"] as const;
    const run = async (mode: typeof modes[number]) => {
      const f = await bookingCallFlowFixture(); f.flow.dispose();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined, armed = false;
      const bodies: string[] = [];
      try {
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model",
          clinicDate: () => "2026-10-04", fetch: async (_value, init) => {
            bodies.push(String(init?.body)); const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
            const start = text === "I need to book an appointment.", menu = text === "What times are available on October 8?";
            const guess = { kind: start ? "workflow" : menu ? "menu" : "choice", operation: start ? "book" : null, stage: null,
              from: menu ? "2026-10-08" : null, to: menu ? "2026-10-08" : null, choice: start || menu ? null : 1 };
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(guess) }] }] });
          } }), { transcriptFinal: event => {
            if (!armed) return [event];
            if (mode === "session") return [{ ...event, sessionId: "foreign-session" }];
            if (mode === "generation") return [{ ...event, generation: event.generation - 1 }];
            if (mode === "futureGeneration") return [{ ...event, generation: event.generation + 1 }];
            if (mode === "mixedBatch") return [event, { ...event, sessionId: "foreign-session", utteranceId: "foreign-final" }];
            if (mode === "unclearAffirmative") return [{ ...event, quality: "needsClarification" }];
            return [event];
          } });
        const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
        await play("I need to book an appointment."); await voiceUntil(() => f.mail.length === 1, "booking email proof"); await call.verify(f.mail[0]!.code);
        await play("What times are available on October 8?"); await play("The first time, please.");
        const before = await call.state(), action = Object.values(before.actions).at(-1)!;
        assert.equal(action.status, "awaitingConfirmation"); assert.equal(before.presentations[action.presentationId]?.status, "played");
        const models = call.modelTurns.length, requests = bodies.length, provider = f.allTraffic.length, speech = call.spoken.length;
        armed = true;
        if (mode === "stream" || mode === "track") {
          call.sendEvent({ event: "media", ...(mode === "stream" ? { streamSid: `MZ${"9".repeat(32)}` } : {}),
            media: { track: mode === "track" ? "outbound" : "inbound", chunk: "999", timestamp: "19980", payload: Buffer.alloc(160, 0x9f).toString("base64") } });
          await voiceUntil(() => call!.closed, "unowned media closes the actual call");
        } else {
          await call.turn(mode === "ownedBackground" ? "There is a programme talking about a competition in the background." : mode === "generation" ? "The later one, please." : "Yes",
            ["session", "generation", "futureGeneration", "mixedBatch"].includes(mode) ? { expectedFailure: "staleGeneration" } : {});
          if (!["ownedBackground", "unclearAffirmative"].includes(mode)) await voiceUntil(() => call!.closed, "rejected transcript closes the actual call");
        }
        const after = await call.state();
        assert.equal(call.writes.length, 0); assert.equal(f.allTraffic.length, provider); assert.equal(f.mail.length, 1);
        assert.deepEqual(Object.keys(after.actions), Object.keys(before.actions));
        assert.deepEqual(after.staffItems, before.staffItems);
        if (["ownedBackground", "unclearAffirmative"].includes(mode)) {
          assert.equal(after.actions[action.key]?.status, "canceled");
          assert.equal(after.lifecycle, "active"); assert.match(call.spoken.at(-1)!, /Which option|repeat|fresh|clarif/i);
          if (mode === "unclearAffirmative") assert.equal(bodies.length, requests);
        } else {
          assert.equal(after.lifecycle, "ended"); assert.equal(call.closeCode, 1008);
          assert.deepEqual(after.actions, before.actions, "terminal lifecycle rejects further authority without rewriting the original unconfirmed receipt");
          assert.deepEqual(after.processedTurnIds, before.processedTurnIds);
          assert.ok(!Object.values(after.effects).some(effect => effect.kind === "hostWrite"));
          assert.equal(call.modelTurns.length, models); assert.equal(bodies.length, requests); assert.equal(call.spoken.length, speech);
          assert.deepEqual(after.callerMessages, [], "terminal retention clears caller text; rejected events create no processed turn");
        }
        assert.ok(verificationCanaries.every(canary => bodies.every(body => !body.includes(canary))));
        assert.ok(!call.transcripts.includes(f.mail[0]!.code));
      } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      finally { await call?.close(); await f.close(); }
    };
    let next = 0; const failures: unknown[] = [];
    const settled = await Promise.allSettled(Array.from({ length: 4 }, async () => { for (;;) { const mode = modes[next++]; if (!mode) return; try { await run(mode); } catch (error) { failures.push(error); } } }));
    for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `ownership_${index}`, value })))), []);
  });
});
