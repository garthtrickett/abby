import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { bookingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { noticePresentationId } from "../../src/core/transition.ts";

const oldStarts = ["2026-10-07T22:00:00.000Z", "2026-10-07T23:30:00.000Z"];
const currentStarts = ["2026-10-08T23:00:00.000Z", "2026-10-09T00:30:00.000Z"];

test("E2E-327 old spoken menus recover through fresh played options, exact revalidation and separate played confirmation", { timeout: 120_000 }, async () => {
  await withDisposablePostgres(async db => {
    const modes = ["superseded", "expired", "unplayedMenu", "unplayedConfirmation", "vanished", "duplicateFinal"] as const;
    const run = async (mode: typeof modes[number]) => {
      const f = await bookingCallFlowFixture({ offerTtlSeconds: mode === "expired" ? 15 : 120 }); f.flow.dispose();
      f.setStarts([...oldStarts, ...currentStarts]);
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      const modelTurns: string[] = [], resolvedStarts: string[] = [];
      try {
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model",
          clinicDate: () => "2026-10-04", fetch: async (_value, init) => {
            const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
            modelTurns.push(text);
            const start = text === "I need to book an appointment.", menu = /What times are available on October (8|9)\?/.test(text);
            const day = text.includes("October 9") ? "2026-10-09" : "2026-10-08";
            const guessed = { kind: start ? "workflow" : menu ? "menu" : "choice", operation: start ? "book" : null, stage: null,
              from: menu ? day : null, to: menu ? day : null, choice: start || menu ? null : 2 };
            // Any unrecognized selection gets a malicious guessed ordinal. Only
            // the actually played private menu may turn caller syntax into a choice.
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(guessed) }] }] });
          } }));
        const resolve = call.flow.resolveBooking.bind(call.flow);
        call.flow.resolveBooking = async (...args) => { const found = await resolve(...args); if (found.ok) resolvedStarts.push(found.value.offer.startsAt); return found; };
        const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
        await play("I need to book an appointment."); await voiceUntil(() => f.mail.length === 1, "independent booking verification"); await call.verify(f.mail[0]!.code);
        await play("What times are available on October 8?");
        const oldState = await call.state(), oldMenuTurnId = oldState.processedTurnIds.at(-1)!;
        assert.match(call.spoken.at(-1)!, /Thursday 8 October.*9:00 am.*10:30 am/);
        if (mode === "expired") f.setTime("2026-10-04T06:00:16.000Z");
        else await play("What times are available on October 9?");
        if (mode !== "expired") assert.match(call.spoken.at(-1)!, /Friday 9 October.*10:00 am.*11:30 am/);
        await play(mode === "expired" ? "The half-past-ten appointment, thanks." : "I meant the last option you read before those new ones.");
        assert.equal(Object.keys((await call.state()).actions).length, 0); assert.equal(call.writes.length, 0);
        assert.match(call.spoken.at(-1)!, /Which option|fresh appointment options/);
        await play("The later one, please.");
        assert.equal(Object.keys((await call.state()).actions).length, 0, "clarification cannot leave the old menu eligible"); assert.equal(call.writes.length, 0);
        assert.match(call.spoken.at(-1)!, /fresh appointment options/);
        // A denied native host selection intentionally clears spoken state.
        // Probe it after ordinary voice recovery, so it cannot create that proof.
        const beforeOldReference = await call.state();
        const oldSelection = await call.flow.selectBookingMenu({ scope: f.scope, callId: call.callId, sessionId: beforeOldReference.sessionLease!.sessionId,
          policyVersion: beforeOldReference.policy.policyVersion, turnId: "old-menu-replay", menuTurnId: oldMenuTurnId, choice: 2,
          now: mode === "expired" ? "2026-10-04T06:00:16.000Z" : verificationNow, signal: new AbortController().signal });
        assert.equal(oldSelection.ok, false, "actual host selection refuses the old or expired menu binding");
        assert.deepEqual(await call.state(), beforeOldReference);
        f.setStarts(currentStarts);
        await call.turn("What times are available on October 9?");
        if (mode === "unplayedMenu") {
          await call.turn("The later one, please.", { interrupt: true }); await call.mark();
          assert.equal(Object.keys((await call.state()).actions).length, 0); assert.equal(call.writes.length, 0);
          assert.match(call.spoken.at(-1)!, /fresh appointment options/);
          await play("What times are available on October 9?");
        } else await call.mark();
        if (mode === "vanished") {
          f.setStarts(["2026-10-09T00:45:00.000Z"]);
          await play("The later one, please."); assert.equal(Object.keys((await call.state()).actions).length, 0); assert.equal(call.writes.length, 0);
          assert.match(call.spoken.at(-1)!, /fresh options|contact the clinic/);
          await play("What times are available on October 9?");
        }
        const fresh = await call.state(), freshMenuTurnId = fresh.processedTurnIds.at(-1)!;
        assert.notEqual(freshMenuTurnId, oldMenuTurnId); assert.equal(fresh.presentations[noticePresentationId(call.callId, freshMenuTurnId)]?.status, "played");
        const selection = mode === "vanished" ? "The first time, please." : "The later one, please.";
        const requests = modelTurns.length; await call.turn(selection);
        assert.equal(modelTurns.length, requests, "fresh spoken selection uses authoritative matching, not a model guess");
        let action = Object.values((await call.state()).actions).at(-1)!;
        const expected = mode === "vanished" ? "2026-10-09T00:45:00.000Z" : currentStarts[1]!;
        assert.equal(action.status, "awaitingConfirmation"); assert.equal(action.mutation.request.kind, "book");
        if (action.mutation.request.kind !== "book") assert.fail("exact booking proposal required");
        assert.equal(action.mutation.request.offer.startsAt, expected); assert.ok(!oldStarts.includes(action.mutation.request.offer.startsAt));
        assert.match(call.spoken.at(-1)!, mode === "vanished" ? /Friday 9 October.*11:45 am/ : /Friday 9 October.*11:30 am/);
        assert.equal(call.writes.length, 0);
        if (mode === "unplayedConfirmation") {
          const unplayed = action;
          await call.turn("Yes please", { interrupt: true }); await call.mark();
          assert.equal(call.writes.length, 0); assert.equal((await call.state()).actions[unplayed.key]?.status, "canceled");
          await play("What times are available on October 9?"); await call.turn(selection);
          action = Object.values((await call.state()).actions).at(-1)!; assert.notEqual(action.key, unplayed.key); assert.equal(action.status, "awaitingConfirmation");
        }
        await call.mark(); await call.turn("Yes"); await call.mark();
        assert.equal(call.writes.length, 1); assert.equal((await call.state()).actions[action.key]?.status, "committed");
        assert.ok(resolvedStarts.every(start => !oldStarts.includes(start))); assert.equal(resolvedStarts.at(-1), expected);
        if (mode === "duplicateFinal") { await play("Yes"); assert.equal(call.writes.length, 1); assert.equal((await call.state()).actions[action.key]?.status, "committed"); }
        assert.equal(f.mail.length, 1); assert.ok(call.transcripts.every(text => !text.includes(f.mail[0]!.code)));
      } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      finally { await call?.close(); await f.close(); }
    };
    let next = 0; const failures: unknown[] = [];
    const settled = await Promise.allSettled(Array.from({ length: 3 }, async () => { for (;;) { const mode = modes[next++]; if (!mode) return; try { await run(mode); } catch (error) { failures.push(error); } } }));
    for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `stale_menu_${index}`, value })))), []);
  });
});
