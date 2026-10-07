import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { bookingCallFlowFixture, reschedulingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { menuNavigationLanguage, menuNavigationQuery } from "../../src/standalone/menu-navigation-language.ts";

// Sydney local starts: Thursday 8:30, 9:15, 11:00; Friday 9:30.
const starts = ["2026-10-07T21:30:00.000Z", "2026-10-07T22:15:00.000Z", "2026-10-08T00:00:00.000Z", "2026-10-08T22:30:00.000Z"];
test("E2E-335 questions repeat current menu subsets and navigate later times without selecting, guessing dates or widening caller windows", { timeout: 150_000 }, async () => {
  await withDisposablePostgres(async db => {
    const modes = ["all", "day", "dayNumber", "second", "next", "nextWindow", "later", "moveDay", "moveSecond", "unplayed", "missingDay", "ambiguous", "denied", "committed", "window", "vanished", "repeatedUnplayed"] as const;
    const failures: unknown[] = [];
    const run = async (mode: typeof modes[number]) => {
      const move = mode.startsWith("move"), single = mode === "later" || mode === "window";
      const f = move ? await reschedulingCallFlowFixture() : await bookingCallFlowFixture(); f.flow.dispose(); f.setStarts(single ? starts.slice(0, 1) : starts);
      const modelBodies: string[] = [], queries: { from: string | null; to: string | null }[] = [];
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      try {
        const original = f.flowConfig.fetchPort!;
        call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort: async (value, init) => {
          const url = new URL(String(value));
          if (url.pathname.endsWith("/available_times")) queries.push({ from: url.searchParams.get("from"), to: url.searchParams.get("to") });
          return original(value, init);
        } }, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_url, init) => {
          modelBodies.push(String(init?.body));
          const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
          const start = text === "I need to book an appointment." || text === "I need to move an appointment.";
          const targets = text === "Show my existing appointments from October 4 through October 9.";
          const menu = text === "Show times from October 8 through October 9." || text === "Show move times from October 8 through October 9.";
          // Unrecognized questions are deliberately guessed as option one;
          // question wording must never give the model selection authority.
          const decision = { kind: start ? "workflow" : targets || menu ? "menu" : "choice", operation: start ? move ? "reschedule" : "book" : null,
            stage: targets ? "targets" : move && menu ? "offers" : null, from: targets ? "2026-10-04" : menu ? "2026-10-08" : null,
            to: targets || menu ? "2026-10-09" : null, choice: start || targets || menu ? null : 1 };
          return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
        } }));
        const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
        await play(move ? "I need to move an appointment." : "I need to book an appointment.");
        await voiceUntil(() => f.mail.length === 1, "private menu verification"); await call.verify(f.mail[0]!.code);
        if (move) { await play("Show my existing appointments from October 4 through October 9."); await play("My first existing appointment."); }
        await call.turn(move ? "Show move times from October 8 through October 9." : "Show times from October 8 through October 9.");
        if (mode !== "unplayed") await call.mark();
        if (mode === "window" || mode === "nextWindow") await play("Before 10 am, please.");
        if (mode === "committed") { await play("The first time, please."); await play("Yes"); }
        if (mode === "denied") f.setPermitted(false);
        if (mode === "vanished") f.setStarts([starts[0]!, starts[2]!]);
        if (single) f.setStarts(starts);
        const request = mode === "all" || mode === "unplayed" || mode === "denied" || mode === "committed" ? "Could you repeat those options, please?"
          : mode === "day" || mode === "moveDay" ? "Could you repeat the Thursday options?"
          : mode === "dayNumber" ? "What time was the 8th?"
          : mode === "missingDay" ? "Could you repeat the Friday options?"
          : mode === "later" || mode === "ambiguous" || mode === "window" ? "Could it be a bit later, please?" : "What was the second one?";
        const prior = await call.state(), modelCount = modelBodies.length, readCount = queries.length;
        await call.turn(request, mode === "unplayed" ? { interrupt: true } : {});
        assert.ok(call.transcripts.includes(request), "navigation must reach an owned final transcript");
        assert.equal(modelBodies.length, modelCount, `${mode}: no model option/date guess`);
        assert.equal(call.writeRequests.length, mode === "committed" ? 1 : 0);
        assert.deepEqual((await call.state()).actions, prior.actions, "asking about an option cannot propose it");
        if (["unplayed", "missingDay", "ambiguous", "committed"].includes(mode)) {
          assert.equal(queries.length, readCount);
          assert.match(call.spoken.at(-1)!, mode === "committed" ? /Your booking is confirmed/ : /fresh appointment options|Which option/);
          return;
        }
        if (mode === "denied") { assert.equal(queries.length, readCount); assert.doesNotMatch(call.spoken.at(-1)!, /option one,/); return; }
        assert.ok(queries.length > readCount, "repeat/navigation independently rereads the provider");
        const expectedFrom = "2026-10-08", expectedTo = mode === "all" ? "2026-10-09" : "2026-10-08";
        assert.ok(queries.slice(readCount).every(query => query.from === expectedFrom && query.to === expectedTo));
        if (mode === "vanished") {
          assert.doesNotMatch(call.spoken.at(-1)!, /9:15 am, for|option one,/);
          await call.mark(); await play("Yes"); assert.equal(call.writeRequests.length, 0);
          assert.equal(Object.keys((await call.state()).actions).length, 0); return;
        }
        if (mode === "repeatedUnplayed") {
          await call.turn("The first time, please.", { interrupt: true });
          assert.match(call.spoken.at(-1)!, /fresh appointment options/);
          assert.equal(call.writeRequests.length, 0); assert.equal(Object.keys((await call.state()).actions).length, 0); return;
        }
        if (mode === "day" || mode === "moveDay") assert.doesNotMatch(call.spoken.at(-1)!, /Friday 9 October/);
        if (["second", "next", "moveSecond", "later", "window"].includes(mode)) {
          assert.match(call.spoken.at(-1)!, /9:15 am/); assert.doesNotMatch(call.spoken.at(-1)!, /8:30 am, for/);
          if (mode !== "later") assert.doesNotMatch(call.spoken.at(-1)!, /option two,/);
        }
        if (mode === "next" || mode === "nextWindow") {
          await call.mark(); const models = modelBodies.length;
          await call.turn("What was the next one?");
          assert.equal(modelBodies.length, models); assert.equal(Object.keys((await call.state()).actions).length, 0);
          if (mode === "nextWindow") {
            assert.match(call.spoken.at(-1)!, /before 10:00 am/); assert.doesNotMatch(call.spoken.at(-1)!, /11:00 am|option one,/);
            assert.equal(call.writeRequests.length, 0); return;
          }
          assert.match(call.spoken.at(-1)!, /11:00 am/);
        }
        if (mode === "window") { assert.doesNotMatch(call.spoken.at(-1)!, /11:00 am/); assert.match(call.spoken.at(-1)!, /before 10:00 am/); }
        await call.mark();
        await play("The first time, please."); assert.equal(call.writeRequests.length, 0);
        await play("Yes");
        const expectedStart = mode === "next" ? starts[2] : ["second", "moveSecond", "later", "window"].includes(mode) ? starts[1] : starts[0];
        assert.equal(call.writeRequests.length, 1); assert.equal(call.writeRequests[0]?.body.starts_at, expectedStart);
        assert.equal(call.writeRequests[0]?.method, move ? "PATCH" : "POST");
        assert.equal(call.writeRequests[0]?.path, move ? "/v1/individual_appointments/91" : "/v1/individual_appointments");
        if (!move) assert.equal(call.writeRequests[0]?.body.patient_id, verificationCanaries[2]);
        assert.equal(Object.values((await call.state()).actions).at(-1)?.status, "committed");
        assert.equal(f.mail.length, 1); assert.equal(Object.keys((await call.state()).staffItems).length, 0);
        assert.ok(modelBodies.every(body => verificationCanaries.every(canary => !body.includes(canary))));
      } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      finally { await call?.close(); await f.close(); }
    };
    let next = 0;
    const settled = await Promise.allSettled(Array.from({ length: 3 }, async () => { for (;;) { const mode = modes[next++]; if (!mode) return; try { await run(mode); } catch (error) { failures.push(error); } } }));
    for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `menu_navigation_${index}`, value })))), []);
  });
});

test("E2E-335 navigation cannot reinterpret quoted/mixed requests or a clock with hidden seconds as later authority", () => {
  for (const text of ["Don't repeat those options.", "You said 'what was the second one'.", "Repeat the Thursday options and book it.",
    "What was the second one for my wife?", "Could it be a bit later if the original was canceled?"])
    assert.equal(menuNavigationLanguage(text), undefined, text);
  const menu = { from: "2026-10-08", to: "2026-10-09", snapshot: { timeZone: "Australia/Sydney", choices: [
    { startsAt: "2026-10-07T21:30:30.000Z", endsAt: "2026-10-07T22:00:30.000Z", expiresAt: "2026-10-04T00:10:00.000Z" } ] } };
  assert.deepEqual(menuNavigationQuery({ kind: "later" }, menu, null), { kind: "clarify", reason: "menuAmbiguous" });
  assert.deepEqual(menuNavigationQuery({ kind: "date", day: 26 }, menu, null), { kind: "clarify", reason: "menuAmbiguous" });
});
