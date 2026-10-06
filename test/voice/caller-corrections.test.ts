import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { bookingCallFlowFixture, reschedulingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

test("E2E-309 signed corrections fence old proposals before interpretation, revalidate replacements and require fresh confirmation", { timeout: 120_000 }, async () => {
  await withDisposablePostgres(async db => {
    const scenarios = ["later", "weekday", "stop", "mixed", "lostOffer", "unplayed", "heldModel", "move", "moveWeekday"] as const;
    const run = async (scenario: typeof scenarios[number]) => {
      const move = scenario.startsWith("move"), weekday = scenario === "weekday" || scenario === "moveWeekday";
      const f = move ? await reschedulingCallFlowFixture() : await bookingCallFlowFixture(); f.flow.dispose();
      f.setStarts(weekday ? ["2026-10-06T22:00:00.000Z", "2026-10-07T22:00:00.000Z"]
        : ["2026-10-07T22:00:00.000Z", "2026-10-07T23:30:00.000Z"]);
      const modelTurns: string[] = [];
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      let release: () => void = () => undefined;
      const held = new Promise<void>(resolve => { release = resolve; });
      try {
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner,
          apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_value, init) => {
            const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
            modelTurns.push(text);
            if (text === "Please check it again.") await held;
            const start = text === "I need to book an appointment." || text === "I need to move an appointment.";
            const targets = text === "Show my existing appointments from October 4 through October 9.";
            const menu = text === "What times are available on October 8?" || text === "Show move times on October 8.";
            const decision = { kind: start ? "workflow" : menu || targets ? "menu" : "unsupported", operation: start ? move ? "reschedule" : "book" : null,
              stage: targets ? "targets" : menu && move ? "offers" : null,
              from: targets ? "2026-10-04" : menu ? "2026-10-08" : null, to: targets ? "2026-10-09" : menu ? "2026-10-08" : null, choice: null };
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed",
              content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
          } }));
        await call.turn(move ? "I need to move an appointment." : "I need to book an appointment."); await call.mark();
        await voiceUntil(() => f.mail.length === 1, "verification mail"); await call.verify(f.mail[0]!.code);
        if (move) {
          await call.turn("Show my existing appointments from October 4 through October 9."); await call.mark();
          await call.turn("My first existing appointment."); await call.mark();
        }
        await call.turn(move ? "Show move times on October 8." : "What times are available on October 8?"); await call.mark();
        await call.turn(move ? "Move it to option one." : "The first time, please."); await call.mark();
        const old = Object.values((await call.state()).actions).at(-1)!;
        assert.equal(old.status, "awaitingConfirmation"); assert.equal(call.writes.length, 0);
        if (scenario === "lostOffer") f.setFailure("server");
        const text = weekday ? "Actually, Wednesday." : scenario === "stop" ? "No, wait."
          : scenario === "mixed" ? "Yes. No, hold on, I cannot make that time." : scenario === "heldModel" ? "Please check it again."
            : "Wait, the later one would be better.";
        if (scenario === "heldModel") {
          const pending = call.turn(text);
          await voiceUntil(() => modelTurns.includes(text), "held interpretation reached");
          assert.equal((await call.state()).actions[old.key]?.status, "canceled", "fence must precede a held model response");
          release(); await pending;
        } else await call.turn(text);
        assert.equal((await call.state()).actions[old.key]?.status, "canceled"); assert.equal(call.writes.length, 0);
        if (weekday) {
          assert.match(call.spoken.at(-1)!, /Wednesday 7 October/); await call.mark();
          await call.turn(move ? "Move it to option one." : "The first time, please.");
        }
        if (["later", "weekday", "unplayed", "move", "moveWeekday"].includes(scenario)) {
          const replacement = Object.values((await call.state()).actions).at(-1)!;
          assert.notEqual(replacement.key, old.key); assert.equal(replacement.status, "awaitingConfirmation");
          if (replacement.mutation.request.kind !== "book" && replacement.mutation.request.kind !== "reschedule") throw new Error("expected exact replacement offer");
          const expectedStart = weekday ? "2026-10-06T22:00:00.000Z" : "2026-10-07T23:30:00.000Z";
          assert.equal(replacement.mutation.request.offer.startsAt, expectedStart);
          assert.notEqual(replacement.mutation.request.offer.startsAt,
            old.mutation.request.kind === "book" || old.mutation.request.kind === "reschedule" ? old.mutation.request.offer.startsAt : undefined);
          assert.equal(call.writeRequests.length, 0);
          assert.match(call.spoken.at(-1)!, weekday ? /Wednesday 7 October/ : /10:30 am/);
          if (move && old.mutation.request.kind === "reschedule" && replacement.mutation.request.kind === "reschedule")
            assert.deepEqual(replacement.mutation.request.target, old.mutation.request.target, "correction must preserve the protected source appointment");
          assert.ok(!modelTurns.includes(text), "bounded corrections should not depend on a model guess");
          if (scenario === "unplayed") {
            await call.turn("Yes please", { interrupt: true });
            assert.equal(call.writes.length, 0); assert.equal((await call.state()).actions[replacement.key]?.status, "canceled");
          } else {
            await call.mark(); await call.turn("Yes"); assert.equal(call.writes.length, 1);
            assert.equal(call.writeRequests.length, 1);
            const sent = call.writeRequests[0]!;
            assert.equal(sent.body.starts_at, expectedStart);
            assert.equal(sent.method, move ? "PATCH" : "POST");
            assert.equal(sent.path, move && replacement.mutation.request.kind === "reschedule"
              ? `/v1/individual_appointments/${replacement.mutation.request.target.appointmentRef}` : "/v1/individual_appointments");
            if (move) assert.deepEqual(sent.body, { starts_at: expectedStart, ends_at: null }, "moving the source must not reassign its patient, practitioner or type");
            else assert.equal(sent.body.patient_id, verificationCanaries[2]);
            assert.equal((await call.state()).actions[replacement.key]?.status, "committed");
            assert.equal((await call.state()).actions[old.key]?.status, "canceled");
          }
        } else {
          assert.ok(Object.values((await call.state()).actions).every(action => action.status === "canceled"));
          await call.mark(); await call.turn("Yes please"); assert.equal(call.writes.length, 0);
        }
      } finally { release(); try { await call?.close(); } finally { await f.close(); } }
    };
    let next = 0;
    const workers = await Promise.allSettled(Array.from({ length: 4 }, async () => {
      while (next < scenarios.length) await run(scenarios[next++]!);
    }));
    const failures = workers.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "caller correction scenarios failed");
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `correction_${index}`, value })))), []);
  });
});
