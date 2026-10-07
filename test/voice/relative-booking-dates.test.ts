import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { bookingCallFlowFixture, reschedulingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { relativeBookingSearchLanguage as parse } from "../../src/standalone/relative-booking-search-language.ts";

const initial = ["2026-10-07T22:00:00.000Z", "2026-10-08T03:00:00.000Z", "2026-10-08T05:00:00.000Z"];
test("E2E-337 relative dates derive clinic calendars and source-relative clocks only from a played verified target, never classifier guesses", { timeout: 150_000 }, async () => {
  await withDisposablePostgres(async db => {
    const modes = ["nextWeek", "nextWeekAfternoon", "retained", "twoWeeks", "month", "monthDate", "nextFriday", "plainFriday", "weekdayConflict", "conflictRepair", "sourceNextWeek", "sourceEarlier", "sourceDate", "sourceCorrection", "missingSource", "unplayedSource", "deniedSource", "committed", "ambiguousMonth"] as const;
    const failures: unknown[] = [];
    const run = async (mode: typeof modes[number]) => {
      const move = mode.startsWith("source") || mode === "unplayedSource" || mode === "deniedSource";
      const f = move ? await reschedulingCallFlowFixture() : await bookingCallFlowFixture(); f.flow.dispose(); f.setStarts(initial);
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      const models: string[] = [], queries: { from: string | null; to: string | null }[] = [];
      const request = mode === "nextWeek" || mode === "retained" || mode === "committed" ? "Next week, please."
        : mode === "nextWeekAfternoon" ? "Next week afternoon, please."
        : mode === "twoWeeks" ? "In two weeks, please." : mode === "month" ? "In a month, please."
        : mode === "monthDate" ? "Actually, October 9 at 12:30 pm, please."
        : mode === "nextFriday" ? "Next Friday, please." : mode === "plainFriday" ? "Friday at 12:30 pm, please."
        : mode === "weekdayConflict" || mode === "conflictRepair" ? "Monday October 9 at 12:30 pm, please."
        : mode === "sourceEarlier" ? "Thirty minutes earlier on the same day, please."
        : mode === "sourceDate" ? "The same time on 2026-10-15, please."
        : mode === "ambiguousMonth" ? "In a month and two weeks, please." : "Same time next week, please.";
      const from = mode === "nextWeek" || mode === "nextWeekAfternoon" || mode === "retained" ? "2026-10-05" : mode === "twoWeeks" ? "2026-10-18"
        : mode === "month" ? "2026-11-04" : mode === "sourceEarlier" ? "2026-10-08" : move ? "2026-10-15" : "2026-10-09";
      const to = mode === "nextWeek" || mode === "nextWeekAfternoon" || mode === "retained" ? "2026-10-11" : from;
      const chosen = mode === "nextWeek" ? "2026-10-04T22:00:00.000Z" : mode === "retained" ? "2026-10-05T05:00:00.000Z"
        : mode === "nextWeekAfternoon" ? "2026-10-05T03:00:00.000Z"
        : mode === "twoWeeks" ? "2026-10-17T22:00:00.000Z" : mode === "month" ? "2026-11-03T22:00:00.000Z"
        : mode === "sourceEarlier" ? "2026-10-08T03:30:00.000Z" : move ? "2026-10-15T04:00:00.000Z" : "2026-10-09T01:30:00.000Z";
      try {
        const port = f.flowConfig.fetchPort!;
        call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort: async (value, init) => {
          const url = new URL(String(value)); if (url.pathname.endsWith("/available_times")) queries.push({ from: url.searchParams.get("from"), to: url.searchParams.get("to") });
          return port(value, init);
        } }, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_url, init) => {
          models.push(String(init?.body)); const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
          const start = text === "I need to book an appointment." || text === "I need to move an appointment.";
          const targets = text === "Show my existing appointments from October 4 through October 9.";
          const menu = text === "Show my chosen day's times.";
          const decision = { kind: start ? "workflow" : targets || menu ? "menu" : "choice", operation: start ? move ? "reschedule" : "book" : null,
            stage: targets ? "targets" : move && menu ? "offers" : null, from: targets ? "2026-10-04" : menu ? "2026-10-08" : null,
            to: targets ? "2026-10-09" : menu ? "2026-10-08" : null, choice: start || targets || menu ? null : 1 };
          return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
        } }));
        const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
        await play(move ? "I need to move an appointment." : "I need to book an appointment.");
        await voiceUntil(() => f.mail.length === 1, "private relative-date proof"); await call.verify(f.mail[0]!.code);
        if (move) { await play("Show my existing appointments from October 4 through October 9."); await call.turn("My first existing appointment."); if (mode !== "unplayedSource") await call.mark(); }
        else await play("Show my chosen day's times.");
        if (mode === "sourceCorrection") { await play("Show my chosen day's times."); await call.turn("The first time, please."); }
        if (mode === "retained") await play("After 3 pm, please.");
        if (mode === "committed") { await play("The first time, please."); await play("Yes"); }
        if (mode === "deniedSource") f.setPermitted(false);
        f.setStarts(mode === "retained" ? ["2026-10-04T22:00:00.000Z", chosen] : [chosen]);
        const count = models.length, reads = queries.length;
        await call.turn(request, mode === "unplayedSource" || mode === "sourceCorrection" ? { interrupt: true } : {});
        assert.ok(call.transcripts.includes(request)); assert.equal(models.length, count, "relative searches never use a classifier date or ordinal guess");
        if (["month", "weekdayConflict", "ambiguousMonth", "missingSource", "unplayedSource", "deniedSource", "committed"].includes(mode)) {
          assert.equal(queries.length, reads); assert.equal(call.writeRequests.length, mode === "committed" ? 1 : 0);
          assert.doesNotMatch(call.spoken.at(-1)!, /option one,/);
          if (mode === "month") assert.match(call.spoken.at(-1)!, /no more than 30 days ahead.*haven.t searched/s); return;
        }
        if (mode === "conflictRepair") {
          assert.equal(queries.length, reads); await call.mark(); await call.turn("Friday October 9 at 12:30 pm, please."); assert.equal(models.length, count);
        }
        assert.ok(queries.length > reads, `relative request must actually read its resolved dates: ${call.spoken.at(-1)}`);
        assert.ok(queries.slice(reads).every(query => query.from === from && query.to === to), JSON.stringify(queries.slice(reads)));
        assert.equal(call.writeRequests.length, 0); assert.equal(Object.keys((await call.state()).actions).length, mode === "sourceCorrection" ? 1 : 0);
        if (mode === "sourceCorrection") assert.equal(Object.values((await call.state()).actions)[0]?.status, "canceled");
        if (mode === "retained") { assert.match(call.spoken.at(-1)!, /after 3:00 pm.*4:00 pm/s); assert.doesNotMatch(call.spoken.at(-1)!, /9:00 am, for/); }
        await call.mark(); await play("The first time, please."); assert.equal(call.writeRequests.length, 0); await play("Yes");
        assert.equal(call.writeRequests.length, 1); assert.equal(call.writeRequests[0]?.body.starts_at, chosen);
        assert.equal(call.writeRequests[0]?.method, move ? "PATCH" : "POST"); assert.equal(call.writeRequests[0]?.path, move ? "/v1/individual_appointments/91" : "/v1/individual_appointments");
        if (!move) assert.equal(call.writeRequests[0]?.body.patient_id, verificationCanaries[2]);
        assert.equal(Object.values((await call.state()).actions).at(-1)?.status, "committed"); assert.equal(f.mail.length, 1);
        assert.equal(Object.keys((await call.state()).staffItems).length, 0); assert.ok(models.every(body => verificationCanaries.every(canary => !body.includes(canary))));
      } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      finally { await call?.close(); await f.close(); }
    };
    let next = 0; const settled = await Promise.allSettled(Array.from({ length: 3 }, async () => { for (;;) { const mode = modes[next++]; if (!mode) return; try { await run(mode); } catch (error) { failures.push(error); } } }));
    for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `relative_${index}`, value })))), []);
  });
});

test("E2E-337 relative calendars preserve weekday/date agreement, year boundaries and uncertain month lengths", () => {
  assert.deepEqual(parse("Next week", "2026-10-07"), { kind: "range", from: "2026-10-12", to: "2026-10-18" });
  assert.deepEqual(parse("Next Friday", "2026-10-07"), { kind: "range", from: "2026-10-16", to: "2026-10-16" });
  assert.deepEqual(parse("This Friday", "2026-10-07"), { kind: "range", from: "2026-10-09", to: "2026-10-09" });
  assert.deepEqual(parse("In a month", "2026-12-31"), { kind: "range", from: "2027-01-31", to: "2027-01-31" });
  assert.equal(parse("In a month", "2026-01-31")?.kind, "ambiguous");
  assert.equal(parse("This Tuesday", "2026-10-07")?.kind, "ambiguous");
  assert.equal(parse("Monday October 9 at 12:30 pm", "2026-10-07")?.kind, "ambiguous");
  assert.equal(parse("Friday February 30", "2026-01-01")?.kind, "ambiguous");
  assert.equal(parse("Friday at 12:30", "2026-10-07")?.kind, "ambiguous");
  assert.equal(parse("Same time on 2026-02-30", "2026-01-01")?.kind, "ambiguous");
  assert.deepEqual(parse("2026-10-09", "2026-10-07"), { kind: "range", from: "2026-10-09", to: "2026-10-09" });
  assert.deepEqual(parse("9 October", "2026-10-07"), { kind: "range", from: "2026-10-09", to: "2026-10-09" });
  assert.equal(parse("October 9 or October 10", "2026-10-07"), undefined);
  for (const text of ['She said "next week".', "Don't change it to next week.", "If next week works for my mother."])
    assert.equal(parse(text, "2026-10-07"), undefined);
});
