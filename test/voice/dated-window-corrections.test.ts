import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { bookingCallFlowFixture, reschedulingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { appointmentEnquiryFixture } from "../support/cliniko-appointment-enquiry.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

const mixedCorrection = "Maybe Thursday. Actually, make that Wednesday morning.";
const times = ["2026-10-06T22:00:00.000Z", "2026-10-07T00:00:00.000Z", "2026-10-07T05:30:00.000Z", "2026-10-07T22:00:00.000Z", "2026-10-08T05:30:00.000Z"];

test("E2E-316 signed final date/window corrections preserve constraints and require fresh protected confirmation", { timeout: 180_000 }, async () => {
  await withDisposablePostgres(async db => {
    const scenarios = ["bookInitial", "bookProposal", "bookRetain", "bookFinal", "bookAmbiguous", "bookAmbiguousDate", "bookQualified", "bookUnplayedMenu", "bookUnplayedConfirmation", "bookRevoked", "bookCommitted",
      "moveProposal", "moveClear", "readWindow"] as const;
    const run = async (scenario: typeof scenarios[number]) => {
      const move = scenario.startsWith("move"), enquiry = scenario === "readWindow";
      const f = enquiry ? await appointmentEnquiryFixture() : move ? await reschedulingCallFlowFixture() : await bookingCallFlowFixture(); f.flow.dispose();
      if ("setStarts" in f) f.setStarts(times);
      const modelTurns: string[] = [];
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      try {
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner,
          apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_value, init) => {
            const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText; modelTurns.push(text);
            const start = text === "I need to book an appointment." || text === "I need to move an appointment." || text === "I only want to check my appointments.";
            const targets = text === "Show my existing appointments from October 4 through October 9.";
            const menu = text === "What times are available on October 8?" || text === "Show move times on October 8.";
            const decision = { kind: start ? "workflow" : menu || targets ? "menu" : "choice", operation: start ? enquiry ? "appointments.read" : move ? "reschedule" : "book" : null,
              stage: targets ? "targets" : menu && move ? "offers" : null, from: targets ? "2026-10-04" : menu ? "2026-10-08" : null,
              to: targets ? "2026-10-09" : menu ? "2026-10-08" : null, choice: start || targets || menu ? null : 1 };
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
          } }));
        await call.turn(enquiry ? "I only want to check my appointments." : move ? "I need to move an appointment." : "I need to book an appointment."); await call.mark();
        await voiceUntil(() => f.mail.length === 1, "dated correction verification"); await call.verify(f.mail[0]!.code);
        if (enquiry) {
          const before = "reads" in f ? f.reads : -1;
          await call.turn(mixedCorrection);
          assert.equal("reads" in f ? f.reads : -1, before, "a read must not silently drop a time-of-day constraint");
          assert.doesNotMatch(call.spoken.at(-1)!, /I found an appointment|checked upcoming appointments/); assert.equal(call.writes.length, 0); return;
        }
        if (move) {
          await call.turn("Show my existing appointments from October 4 through October 9."); await call.mark();
          await call.turn("My first existing appointment."); await call.mark();
        }
        if (scenario !== "bookInitial") {
          await call.turn(move ? "Show move times on October 8." : "What times are available on October 8?"); await call.mark();
          await call.turn(move ? "Move it to option one." : "The first time, please."); await call.mark();
        }
        const old = Object.values((await call.state()).actions).at(-1);
        if (scenario === "bookCommitted") {
          await call.turn("Yes"); await call.mark(); const committed = Object.values((await call.state()).actions).at(-1)!;
          assert.equal(committed.status, "committed"); await call.turn(mixedCorrection);
          assert.deepEqual((await call.state()).actions[committed.key], committed); assert.equal(call.writes.length, 1);
          assert.match(call.spoken.at(-1)!, /booking is confirmed.*contact the clinic/s); return;
        }
        if (scenario === "bookRevoked" && "replacePolicy" in f) await f.replacePolicy({ enabled: false });
        const text = scenario === "bookFinal" ? "Actually Thursday afternoon. Actually, Wednesday morning."
          : scenario === "bookAmbiguous" ? "Maybe Thursday. Actually, Wednesday after ten."
            : scenario === "bookAmbiguousDate" ? "Maybe Thursday. Actually, Wednesday or Friday morning."
            : scenario === "bookQualified" ? "Maybe Thursday. Actually, Wednesday morning unless it rains." : mixedCorrection;
        const traffic = "allTraffic" in f ? f.allTraffic.length : undefined;
        await call.turn(text); assert.equal(call.writes.length, 0); assert.ok(!modelTurns.includes(text));
        if (old) assert.equal((await call.state()).actions[old.key]?.status, "canceled");
        if (["bookAmbiguous", "bookAmbiguousDate", "bookQualified", "bookRevoked"].includes(scenario)) {
          assert.doesNotMatch(call.spoken.at(-1)!, /option one/);
          if (scenario === "bookAmbiguousDate") {
            assert.match(call.spoken.at(-1)!, /which displayed day.*AM or PM/i);
            assert.equal("allTraffic" in f ? f.allTraffic.length : undefined, traffic, "an unresolved date cannot choose either day for a provider search");
            assert.equal(call.writeRequests.length, 0);
          }
          await call.mark(); await call.turn("Yes"); assert.equal(call.writes.length, 0); return;
        }
        assert.match(call.spoken.at(-1)!, /before 12:00 pm.*Wednesday 7 October.*9:00 am.*11:00 am/s);
        assert.doesNotMatch(call.spoken.at(-1)!, /Thursday 8 October|4:30 pm/);
        if (scenario === "bookUnplayedMenu") {
          await call.turn("The first time, please.", { interrupt: true }); assert.equal(call.writes.length, 0);
          assert.ok(Object.values((await call.state()).actions).every(action => action.status === "canceled")); return;
        }
        await call.mark();
        if (scenario === "bookRetain") {
          await call.turn("What times are available on October 8?"); assert.match(call.spoken.at(-1)!, /before 12:00 pm.*Thursday 8 October.*9:00 am/s);
          assert.doesNotMatch(call.spoken.at(-1)!, /4:30 pm/); await call.mark();
        }
        if (scenario === "moveClear") {
          await call.turn("Maybe Wednesday. Actually, make that Thursday any time.");
          assert.match(call.spoken.at(-1)!, /Thursday 8 October.*4:30 pm/s); assert.doesNotMatch(call.spoken.at(-1)!, /before 12:00 pm/); await call.mark();
        }
        await call.turn(move ? "Move it to option one." : "The first time, please.");
        const replacement = Object.values((await call.state()).actions).at(-1)!;
        if (old) assert.notEqual(replacement.key, old.key); assert.equal(replacement.status, "awaitingConfirmation"); assert.equal(call.writes.length, 0);
        assert.match(call.spoken.at(-1)!, /9:00 am/);
        if (move && old?.mutation.request.kind === "reschedule" && replacement.mutation.request.kind === "reschedule")
          assert.deepEqual(replacement.mutation.request.target, old.mutation.request.target);
        if (scenario === "bookUnplayedConfirmation") {
          await call.turn("Yes please", { interrupt: true }); assert.equal(call.writes.length, 0);
          assert.equal((await call.state()).actions[replacement.key]?.status, "canceled"); return;
        }
        await call.mark(); await call.turn("Yes"); assert.equal(call.writes.length, 1); assert.equal((await call.state()).actions[replacement.key]?.status, "committed");
      } finally { await call?.close(); await f.close(); }
    };
    let next = 0;
    const workers = await Promise.allSettled(Array.from({ length: 4 }, async () => { for (;;) { const item = scenarios[next++]; if (!item) return; await run(item); } }));
    const failed = workers.find(worker => worker.status === "rejected"); if (failed?.status === "rejected") throw failed.reason;
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, i) => ({ label: `dated_${i}`, value })))), []);
  });
});
