import type { ActionState } from "../../src/core/model.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { bookingCallFlowFixture, reschedulingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";
import { bookingSessionFixture } from "../support/booking-session.ts";
import { bookingMenuPresentation } from "../../src/core/booking-menu.ts";
import { matchesBookingSearchWindow } from "../../src/core/booking-search-window.ts";

const afterFour = { startMinute: 960, endMinute: 1440, startInclusive: false } as const;
// Sydney is UTC+11: the first three times are deliberately outside the window.
const starts = ["2026-10-07T22:00:00.000Z", "2026-10-07T23:00:00.000Z", "2026-10-08T00:00:00.000Z",
  "2026-10-08T05:00:00.000Z", "2026-10-08T05:30:00.000Z", "2026-10-08T06:00:00.000Z", "2026-10-09T06:00:00.000Z"];

test("E2E-312 signed calls retain local start-time windows, re-read bounded later dates and keep exact confirmation authority", { timeout: 150_000 }, async () => {
  await withDisposablePostgres(async db => {
    const scenarios = ["book", "retain", "clear", "empty", "failed", "ambiguous", "unplayed", "laterWeek", "rejectedUnplayed", "proposal", "weekday", "move", "moveProposal", "moveLaterWeek", "afterCommit", "afterAll", "laterRetained", "laterEmpty"] as const;
    const run = async (scenario: typeof scenarios[number]) => {
      const move = scenario.startsWith("move");
      const f = move ? await reschedulingCallFlowFixture() : await bookingCallFlowFixture(); f.flow.dispose(); f.setStarts(starts);
      const modelTurns: string[] = [];
      const availabilityQueries: { from: string | null; to: string | null }[] = [];
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      try {
        const originalProvider = f.flowConfig.fetchPort!;
        const fetchPort: typeof fetch = async (value, init) => {
          const url = new URL(String(value));
          if (url.pathname.endsWith("/available_times")) availabilityQueries.push({ from: url.searchParams.get("from"), to: url.searchParams.get("to") });
          return originalProvider(value, init);
        };
        call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort }, owner => createOpenAIClinicalIntentResolver({ owner,
          apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_value, init) => {
            const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText; modelTurns.push(text);
            const start = text === "I need to book an appointment." || text === "I need to move an appointment.";
            const targets = text === "Show my existing appointments from October 4 through October 9.";
            const menu = text === "What times are available on October 8?" || text === "Show move times on October 8." || text === "What times are available on October 9?";
            const day = text.endsWith("October 9?") ? "2026-10-09" : "2026-10-08";
            const decision = { kind: start ? "workflow" : menu || targets ? "menu" : "choice", operation: start ? move ? "reschedule" : "book" : null,
              stage: targets ? "targets" : menu && move ? "offers" : null,
              from: targets ? "2026-10-04" : menu ? day : null, to: targets ? "2026-10-09" : menu ? day : null,
              choice: start || menu || targets ? null : 1 };
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
          } }));
        await call.turn(move ? "I need to move an appointment." : "I need to book an appointment."); await call.mark();
        await voiceUntil(() => f.mail.length === 1, "window verification mail"); await call.verify(f.mail[0]!.code);
        if (move) {
          await call.turn("Show my existing appointments from October 4 through October 9."); await call.mark();
          await call.turn("My first existing appointment."); await call.mark();
        }
        await call.turn(move ? "Show move times on October 8." : "What times are available on October 8?");
        if (!["unplayed", "rejectedUnplayed"].includes(scenario)) await call.mark();
        let old: ActionState | undefined;
        if (scenario === "proposal" || scenario === "moveProposal") {
          await call.turn(move ? "Move it to option one." : "The first time, please."); await call.mark();
          old = Object.values((await call.state()).actions).at(-1)!; assert.equal(old.status, "awaitingConfirmation");
        }
        if (scenario === "afterCommit") {
          await call.turn("The first time, please."); await call.mark(); await call.turn("Yes"); await call.mark();
          const committedState = await call.state(), committed = Object.values(committedState.actions).at(-1)!;
          const queries = availabilityQueries.length, mail = f.mail.length;
          assert.equal(committed.status, "committed");
          if (committed.mutation.request.kind !== "book") throw new Error("expected committed booking");
          assert.equal(call.writeRequests[0]?.body.starts_at, committed.mutation.request.offer.startsAt);
          await call.turn("I need to change that time after all.");
          assert.equal(call.spoken.at(-1), "Your booking is confirmed. I haven't made another change. Please contact the clinic to review it before trying another change.");
          const after = await call.state();
          assert.deepEqual(after.actions, committedState.actions); assert.deepEqual(after.effects, committedState.effects);
          assert.deepEqual(after.staffItems, committedState.staffItems); assert.equal(call.writes.length, 1);
          assert.equal(availabilityQueries.length, queries); assert.equal(f.mail.length, mail); return;
        }
        if (scenario === "laterRetained") {
          await call.turn("That day is fine, but I can only come after four."); await call.mark();
          assert.match(call.spoken.at(-1)!, /after 4:00 pm.*4:30 pm/s);
        }
        if (scenario === "laterEmpty") f.setStarts(starts.slice(0, -1));
        if (scenario === "empty") f.setStarts(starts.slice(0, 4));
        if (scenario === "failed") f.setFailure("server");
        const later = ["laterWeek", "moveLaterWeek", "rejectedUnplayed", "laterRetained", "laterEmpty"].includes(scenario);
        const request = later ? "None of those work. Is there something later that week?" : scenario === "ambiguous" ? "I can only come after ten."
          : scenario === "weekday" ? "Actually, Wednesday morning." : scenario === "afterAll" ? "I can only come after four after all." : "That day is fine, but I can only come after four.";
        if (scenario === "weekday") f.setStarts(["2026-10-06T22:00:00.000Z", "2026-10-07T05:30:00.000Z"]);
        const queriesBefore = availabilityQueries.length;
        await call.turn(request, { interrupt: ["unplayed", "rejectedUnplayed"].includes(scenario) });
        assert.equal(call.writes.length, 0); assert.ok(!modelTurns.includes(request));
        if (old) assert.equal((await call.state()).actions[old.key]?.status, "canceled");
        if (later && scenario !== "rejectedUnplayed") {
          assert.ok(availabilityQueries.length > queriesBefore, "next search must actually read fresh availability");
          assert.ok(availabilityQueries.slice(queriesBefore).every(query => query.from === "2026-10-09" && query.to === "2026-10-11"),
            "next-week search stays in the remainder of this week and excludes rejected dates");
        }
        if (["failed", "ambiguous", "unplayed", "rejectedUnplayed", "empty", "laterEmpty"].includes(scenario)) {
          if (scenario === "laterEmpty") {
            assert.equal(call.spoken.at(-1), "I couldn't find an eligible booking time for those dates. Please contact the clinic directly.");
            assert.doesNotMatch(call.spoken.at(-1)!, /no (?:clinic )?availability|clinic (?:has|have) no/i);
            assert.equal(Object.keys((await call.state()).actions).length, 0);
          } else if (scenario === "empty") assert.match(call.spoken.at(-1)!, /after 4:00 pm.*couldn't find/s);
          else assert.ok(!/option one/.test(call.spoken.at(-1)!));
          await call.mark(); await call.turn("Yes"); assert.equal(call.writes.length, 0);
          return;
        }
        if (scenario === "weekday") {
          assert.match(call.spoken.at(-1)!, /before 12:00 pm.*Wednesday 7 October.*9:00 am/s);
          assert.doesNotMatch(call.spoken.at(-1)!, /4:30 pm/);
        } else if (later) {
          assert.match(call.spoken.at(-1)!, /Friday 9 October/); assert.doesNotMatch(call.spoken.at(-1)!, /Thursday 8 October/);
          if (scenario === "laterRetained") assert.match(call.spoken.at(-1)!, /after 4:00 pm/);
        } else {
          assert.match(call.spoken.at(-1)!, /after 4:00 pm.*4:30 pm.*5:00 pm/s);
          assert.doesNotMatch(call.spoken.at(-1)!, /9:00 am|10:00 am|11:00 am|option three/);
        }
        await call.mark();
        if (scenario === "retain") {
          await call.turn("What times are available on October 9?");
          assert.match(call.spoken.at(-1)!, /after 4:00 pm.*Friday 9 October.*5:00 pm/s); await call.mark();
        }
        if (scenario === "clear") {
          await call.turn("Any time is fine."); assert.match(call.spoken.at(-1)!, /9:00 am/);
          assert.doesNotMatch(call.spoken.at(-1)!, /after 4:00 pm/); await call.mark();
        }
        await call.turn(move ? "Move it to option one." : "The first time, please.");
        const action = Object.values((await call.state()).actions).at(-1)!;
        assert.equal(action.status, "awaitingConfirmation"); assert.equal(call.writes.length, 0);
        assert.match(call.spoken.at(-1)!, scenario === "clear" || scenario === "weekday" ? /9:00 am/ : later || scenario === "retain" ? /5:00 pm/ : /4:30 pm/);
        if (old?.mutation.request.kind === "reschedule" && action.mutation.request.kind === "reschedule") assert.deepEqual(action.mutation.request.target, old.mutation.request.target);
        await call.mark(); await call.turn("Yes"); assert.equal(call.writes.length, 1);
        assert.equal((await call.state()).actions[action.key]?.status, "committed");
        if (action.mutation.request.kind !== "book" && action.mutation.request.kind !== "reschedule") throw new Error("expected exact window-bound action");
        assert.equal(call.writeRequests.length, 1);
        assert.equal(call.writeRequests[0]?.body.starts_at, action.mutation.request.offer.startsAt);
        if (later) assert.equal(action.mutation.request.offer.startsAt, "2026-10-09T06:00:00.000Z");
        if (!["clear", "weekday"].includes(scenario) && (!later || scenario === "laterRetained"))
          assert.ok(matchesBookingSearchWindow(action.mutation.request.offer.startsAt, "Australia/Sydney", afterFour));
      } finally { await call?.close(); await f.close(); }
    };
    let next = 0;
    const failures: unknown[] = [];
    const settled = await Promise.allSettled(Array.from({ length: 4 }, async () => { for (;;) {
      const item = scenarios[next++]; if (!item) return;
      try { await run(item); } catch (error) { failures.push(new Error(`${item}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
    } }));
    for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `window_${index}`, value })))), []);
  });
});

test("E2E-312 agent menu commands use validated public windows, retained constraints and explicit clearing", async () => {
  const f = await bookingSessionFixture(); f.setStarts(starts);
  try {
    await f.verify();
    const pendingText = async () => {
      const state = await f.state(), presentation = state.presentations[state.pendingPresentationId!];
      assert.ok(presentation && "approvedText" in presentation); return presentation.approvedText;
    };
    const read = (turnId: string, window?: typeof afterFour | null) => ({ kind: "booking.offers.read.v1" as const, turn: f.turn(turnId, "Please check times"),
      from: "2026-10-08", to: "2026-10-08", now: verificationNow, ...(window === undefined ? {} : { window }) });
    resultValue(await f.agent.submit(read("window", afterFour)));
    assert.match(await pendingText(), /after 4:00 pm.*4:30 pm/s); await f.playPending();
    resultValue(await f.agent.submit(read("retain")));
    assert.match(await pendingText(), /after 4:00 pm/); await f.playPending();
    resultValue(await f.agent.submit(read("clear", null)));
    assert.match(await pendingText(), /9:00 am/); await f.playPending();
    const before = f.allTraffic.length;
    assert.equal((await f.agent.submit({ ...read("invalid"), window: { ...afterFour, startMinute: -1 } })).ok, false);
    assert.equal(f.allTraffic.length, before); assert.equal(f.posts, 0);
    // A host that ignores a new public constraint must not produce unrestricted
    // options through SAM, even if its availability evidence is otherwise valid.
    const original = f.owner.effects.readBookingMenu.bind(f.owner.effects);
    f.owner.effects.readBookingMenu = query => original({ ...query, window: null });
    resultValue(await f.agent.submit(read("ignored", afterFour)));
    assert.doesNotMatch(await pendingText(), /option one|9:00 am/);
    assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

test("E2E-312 presentation evidence rejects out-of-window times and local filtering handles daylight saving", () => {
  assert.equal(matchesBookingSearchWindow("2026-10-03T22:30:00.000Z", "Australia/Sydney", { startMinute: 0, endMinute: 540, startInclusive: true }), false);
  assert.equal(matchesBookingSearchWindow("2026-10-02T22:30:00.000Z", "Australia/Sydney", { startMinute: 0, endMinute: 540, startInclusive: true }), true);
  const scope = { tenantId: "demo", clinicId: "demo", locationId: "demo" }, binding = { scope, callId: "call", sessionId: "session", policyVersion: "1" };
  const read = { ...binding, observedAt: verificationNow, timeZone: "Australia/Sydney", practitionerName: "Demo", appointmentTypeName: "Physio", reservable: false as const,
    window: afterFour, choices: [{ startsAt: starts[0]!, endsAt: "2026-10-07T22:30:00.000Z", expiresAt: "2026-10-04T06:02:00.000Z" }] };
  assert.equal(bookingMenuPresentation(read, binding, verificationNow).ok, false);
});
