import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { bookingCallFlowFixture, reschedulingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { bookingSessionFixture } from "../support/booking-session.ts";
import { reschedulingSessionFixture } from "../support/rescheduling-session.ts";
import { verificationNow } from "../support/caller-verification.ts";
import { bookingSearchLanguage } from "../../src/standalone/booking-search-language.ts";
import { copyBookingSearchWindow, intersectBookingSearchWindow, matchesBookingSearchWindow, sameBookingSearchWindow, validBookingSearchWindow } from "../../src/core/booking-search-window.ts";

const clockStarts = ["2026-10-07T22:00:00.000Z", "2026-10-08T03:00:00.000Z", "2026-10-08T05:00:00.000Z", "2026-10-08T22:00:00.000Z", "2026-10-09T05:00:00.000Z"];
const weekStarts = ["2026-10-04T22:00:00.000Z", "2026-10-05T05:00:00.000Z", "2026-10-05T22:00:00.000Z", "2026-10-06T22:00:00.000Z", "2026-10-08T22:00:00.000Z", "2026-10-09T05:00:00.000Z"];
test("E2E-336 compound weekday, date and clock alternatives filter actual offers before presentation and retain every caller constraint", { timeout: 150_000 }, async () => {
  await withDisposablePostgres(async db => {
    const modes = ["clock", "weekday", "except", "dates", "weekdayClock", "weekdayBands", "datedClock", "move", "unplayed", "malformed", "ambiguous", "refresh", "next"] as const;
    const failures: unknown[] = [];
    const run = async (mode: typeof modes[number]) => {
      const move = mode === "move", week = mode === "weekday" || mode === "weekdayClock" || mode === "weekdayBands";
      const from = week ? "2026-10-05" : "2026-10-08", to = week ? "2026-10-11" : mode === "except" || mode === "dates" ? "2026-10-10" : "2026-10-09";
      const starts = week ? weekStarts : mode === "except" || mode === "dates" ? [clockStarts[0]!, clockStarts[3]!, "2026-10-09T22:00:00.000Z"] : clockStarts;
      const f = move ? await reschedulingCallFlowFixture() : await bookingCallFlowFixture(); f.flow.dispose(); f.setStarts(starts);
      const models: string[] = [], queries: { from: string | null; to: string | null }[] = [];
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      try {
        const port = f.flowConfig.fetchPort!;
        call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort: async (value, init) => {
          const url = new URL(String(value)); if (url.pathname.endsWith("/available_times")) queries.push({ from: url.searchParams.get("from"), to: url.searchParams.get("to") });
          return port(value, init);
        } }, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_url, init) => {
          models.push(String(init?.body)); const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
          const start = text === "I need to book an appointment." || text === "I need to move an appointment.";
          const targets = text === "Show my existing appointments from October 4 through October 9.";
          const menu = text === "Show times for my chosen date range." || text === "Show move times for my chosen date range.";
          const decision = { kind: start ? "workflow" : targets || menu ? "menu" : "choice", operation: start ? move ? "reschedule" : "book" : null,
            stage: targets ? "targets" : move && menu ? "offers" : null, from: targets ? "2026-10-04" : menu ? from : null,
            to: targets ? "2026-10-09" : menu ? to : null, choice: start || targets || menu ? null : 1 };
          return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
        } }));
        const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
        await play(move ? "I need to move an appointment." : "I need to book an appointment.");
        await voiceUntil(() => f.mail.length === 1, "private compound-search proof"); await call.verify(f.mail[0]!.code);
        if (move) { await play("Show my existing appointments from October 4 through October 9."); await play("My first existing appointment."); }
        await call.turn(move ? "Show move times for my chosen date range." : "Show times for my chosen date range.");
        if (mode !== "unplayed") await call.mark();
        const request = mode === "weekday" ? "Monday or Friday, please." : mode === "except" ? "Any day apart from Friday, please."
          : mode === "dates" ? "October 9 or October 10, please." : mode === "weekdayClock" ? "Monday or Friday after 3 pm, please."
          : mode === "weekdayBands" ? "Monday morning or Friday afternoon, please."
          : mode === "datedClock" ? "2026-10-08 before 11 am or 2026-10-09 after 3 pm, please."
          : mode === "malformed" ? "Before 11 am and after 3 pm, please." : mode === "ambiguous" ? "Monday or someday, please."
          : "Before 11 am or after 3 pm, please.";
        const modelCount = models.length, readCount = queries.length;
        await call.turn(request, mode === "unplayed" ? { interrupt: true } : {});
        assert.ok(call.transcripts.includes(request)); assert.equal(models.length, modelCount, "constraints are never a classifier guess");
        assert.equal(call.writeRequests.length, 0); assert.equal(Object.keys((await call.state()).actions).length, 0);
        if (["malformed", "ambiguous", "unplayed"].includes(mode)) {
          assert.equal(queries.length, readCount); assert.match(call.spoken.at(-1)!, /Which option|fresh appointment options/); return;
        }
        assert.ok(queries.length > readCount, `compound constraints must actually reread and filter availability: ${JSON.stringify({ reply: call.spoken.at(-1), priorReply: call.spoken.at(-2), initialReads: readCount })}`);
        const reply = call.spoken.at(-1)!;
        if (mode === "weekday") { assert.match(reply, /Monday.*Friday/s); assert.doesNotMatch(reply, /Tuesday 6 October|Wednesday 7 October/); }
        else if (mode === "except") { assert.doesNotMatch(reply, /Friday 9 October/); assert.match(reply, /Saturday 10 October/); }
        else if (mode === "dates") { assert.doesNotMatch(reply, /Thursday 8 October/); assert.match(reply, /Friday 9 October.*Saturday 10 October/s); }
        else if (mode === "weekdayClock") { assert.doesNotMatch(reply, /9:00 am, for|Tuesday 6 October|Wednesday 7 October/); assert.match(reply, /Monday 5 October.*4:00 pm/s); }
        else if (mode === "weekdayBands") { assert.doesNotMatch(reply, /Monday 5 October at 4:00 pm|Friday 9 October at 9:00 am|Tuesday 6 October/); assert.match(reply, /Monday 5 October at 9:00 am.*Friday 9 October at 4:00 pm/s); }
        else if (mode === "datedClock") { assert.doesNotMatch(reply, /Thursday 8 October at 4:00 pm|Friday 9 October at 9:00 am|2:00 pm, for/); assert.match(reply, /Friday 9 October at 4:00 pm/); }
        else { assert.match(reply, /before 11:00 am.*or.*after 3:00 pm/s); assert.doesNotMatch(reply, /2:00 pm, for/); assert.match(reply, /4:00 pm/); }
        await call.mark();
        if (mode === "refresh") {
          await play("Please check again."); assert.equal(models.length, modelCount);
          assert.doesNotMatch(call.spoken.at(-1)!, /2:00 pm, for/); assert.match(call.spoken.at(-1)!, /before 11:00 am.*or.*after 3:00 pm/s);
        }
        if (mode === "next") {
          await play("What was the first time?");
          await play("What is the next time?");
          assert.equal(models.length, modelCount); assert.equal(call.writeRequests.length, 0);
          assert.doesNotMatch(call.spoken.at(-1)!, /2:00 pm, for/); assert.match(call.spoken.at(-1)!, /4:00 pm/);
        }
        await play("The first time, please."); assert.equal(call.writeRequests.length, 0); await play("Yes");
        const expected = mode === "weekday" || mode === "weekdayBands" ? weekStarts[0] : mode === "weekdayClock" ? weekStarts[1] : mode === "dates" ? clockStarts[3] : mode === "next" ? clockStarts[2] : clockStarts[0];
        assert.equal(call.writeRequests.length, 1); assert.equal(call.writeRequests[0]?.body.starts_at, expected);
        assert.equal(call.writeRequests[0]?.method, move ? "PATCH" : "POST");
        assert.equal(call.writeRequests[0]?.path, move ? "/v1/individual_appointments/91" : "/v1/individual_appointments");
        if (!move) assert.equal(call.writeRequests[0]?.body.patient_id, verificationCanaries[2]);
        assert.equal(Object.values((await call.state()).actions).at(-1)?.status, "committed");
        assert.equal(f.mail.length, 1); assert.equal(Object.keys((await call.state()).staffItems).length, 0);
        assert.ok(models.every(body => verificationCanaries.every(canary => !body.includes(canary))));
      } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      finally { await call?.close(); await f.close(); }
    };
    let next = 0; const settled = await Promise.allSettled(Array.from({ length: 3 }, async () => { for (;;) { const mode = modes[next++]; if (!mode) return; try { await run(mode); } catch (error) { failures.push(error); } } }));
    for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `compound_${index}`, value })))), []);
  });
});

test("E2E-336 native booking and move read commands accept full constraints and reject a host that drops a branch", async () => {
  const window = { anyOf: [{ window: { startMinute: 0, endMinute: 660, startInclusive: true } },
    { window: { startMinute: 900, endMinute: 1440, startInclusive: false } }] };
  const booking = await bookingSessionFixture(); booking.setStarts(clockStarts.slice(0, 3));
  try {
    await booking.verify();
    const read = (turnId: string) => ({ kind: "booking.offers.read.v1" as const, turn: booking.turn(turnId), from: "2026-10-08", to: "2026-10-08", now: verificationNow, window });
    resultValue(await booking.agent.submit(read("compound-native-book")));
    assert.match((await booking.state()).callerMessages.at(-1)!, /9:00 am.*4:00 pm/s);
    assert.doesNotMatch((await booking.state()).callerMessages.at(-1)!, /2:00 pm, for/); await booking.playPending();
    const original = booking.owner.effects.readBookingMenu.bind(booking.owner.effects);
    booking.owner.effects.readBookingMenu = query => original({ ...query, window: { anyOf: [window.anyOf[0]!] } });
    resultValue(await booking.agent.submit(read("compound-native-dropped")));
    assert.doesNotMatch((await booking.state()).callerMessages.at(-1)!, /option one/);
    assert.equal(Object.keys((await booking.state()).actions).length, 0); assert.equal(booking.posts, 0);
  } finally { await booking.close(); }
  const move = await reschedulingSessionFixture(); move.setStarts(clockStarts.slice(0, 3));
  try {
    await move.verify(); await move.readMenu("targets"); await move.playPending(); await move.selectMenu("targets"); await move.playPending();
    const read = (turnId: string) => ({ kind: "rescheduling.menu.read.v1" as const, stage: "offers" as const, turn: move.turn(turnId),
      from: "2026-10-08", to: "2026-10-08", now: verificationNow, window });
    resultValue(await move.agent.submit(read("compound-native-move")));
    assert.match((await move.state()).callerMessages.at(-1)!, /9:00 am.*4:00 pm/s);
    assert.doesNotMatch((await move.state()).callerMessages.at(-1)!, /2:00 pm, for/); await move.playPending();
    const original = move.owner.effects.readReschedulingMenu.bind(move.owner.effects);
    move.owner.effects.readReschedulingMenu = query => original({ ...query, window: { anyOf: [window.anyOf[0]!] } });
    resultValue(await move.agent.submit(read("compound-native-move-dropped")));
    assert.doesNotMatch((await move.state()).callerMessages.at(-1)!, /option one/);
    assert.equal(Object.keys((await move.state()).actions).length, 0); assert.equal(move.patches, 0);
  } finally { await move.close(); }
});

test("E2E-336 compound windows reject unresolved clauses and preserve clinic dates, intersections and immutable read echoes", () => {
  for (const text of ["Monday or someday, please.", "Before 11 am and after 3 pm, please.", "October 9 or October 20, please.",
    "October 9 or Friday, please.", "Before 11 am or cancel my appointment.", "Before 11 or after 3."])
    assert.equal(bookingSearchLanguage(text, "2026-10-04")?.kind, "ambiguous", text);
  for (const text of ["Don't search Monday or Friday.", 'She said "Monday or Friday".', "If I could come Monday or Friday."])
    assert.equal(bookingSearchLanguage(text, "2026-10-04"), undefined);
  assert.equal(bookingSearchLanguage("Before eleven am or after three pm, please.", "2026-10-04")?.kind, "window");
  const original = { anyOf: [{ weekdays: [4], dates: ["2026-10-08"], window: { startMinute: 0, endMinute: 660, startInclusive: true } },
    { weekdays: [5], dates: ["2026-10-09"], window: { startMinute: 900, endMinute: 1440, startInclusive: false } }] };
  assert.ok(validBookingSearchWindow(original));
  const saved = copyBookingSearchWindow(original);
  original.anyOf[0]!.weekdays[0] = 5; original.anyOf[0]!.window.endMinute = 1440;
  assert.equal(sameBookingSearchWindow(saved, original), false);
  for (const [start, expected] of [[clockStarts[0]!, true], [clockStarts[1]!, false], [clockStarts[2]!, false],
    [clockStarts[3]!, false], [clockStarts[4]!, true]] as const)
    assert.equal(matchesBookingSearchWindow(start, "Australia/Sydney", saved), expected, start);
  assert.equal(matchesBookingSearchWindow("invalid", "Australia/Sydney", saved), false);
  const after = intersectBookingSearchWindow(saved, { startMinute: 660, endMinute: 1440, startInclusive: true });
  assert.deepEqual(after, { anyOf: [{ weekdays: [5], dates: ["2026-10-09"], window: { startMinute: 900, endMinute: 1440, startInclusive: false } }] });
  assert.equal(matchesBookingSearchWindow(clockStarts[2]!, "Australia/Sydney", after), false);
  for (const invalid of [{ anyOf: [] }, { anyOf: [{ weekdays: [] }] }, { anyOf: [{ weekdays: [7] }] },
    { anyOf: [{ dates: ["2026-02-30"] }] }, { anyOf: [{ window: { anyOf: [{}] } }] },
    { anyOf: Array.from({ length: 9 }, () => ({ weekdays: [1] })) }, { anyOf: [{ weekdays: [1], extra: true }] }])
    assert.equal(validBookingSearchWindow(invalid), false);
});
