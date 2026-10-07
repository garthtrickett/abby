import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { bookingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("E2E-332 a trailing negative stops unsent clock corrections and preserves the actual receipt after one possible send", { timeout: 120_000 }, async () => {
  await withDisposablePostgres(async db => {
    const modes = ["menu", "proposal", "committedClock", "committedDontBook", "uncertain", "dispatch"] as const;
    const run = async (mode: typeof modes[number]) => {
      const f = await bookingCallFlowFixture(); f.flow.dispose();
      f.setStarts(["2026-10-08T04:00:00.000Z", "2026-10-08T04:30:00.000Z"]);
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      const pending: Promise<unknown>[] = [];
      let release!: () => void, writeResponseHeld = false;
      const held = new Promise<void>(resolve => { release = resolve; });
      try {
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner,
          apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_value, init) => {
            const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
            const start = text === "I need to book an appointment.", menu = text === "What times are available on October 8?";
            const guess = { kind: start ? "workflow" : menu ? "menu" : "unsupported", operation: start ? "book" : null, stage: null,
              from: menu ? "2026-10-08" : null, to: menu ? "2026-10-08" : null, choice: null };
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(guess) }] }] });
          } }), mode === "dispatch" ? { beforeWriteResponse: async () => { writeResponseHeld = true; await held; } } : mode === "uncertain" ? { lostWrite: true } : {});
        const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
        await play("I need to book an appointment."); await voiceUntil(() => f.mail.length === 1, "private booking proof"); await call.verify(f.mail[0]!.code);
        await play("What times are available on October 8?");
        if (mode !== "menu") await play("The first time, please.");
        const proposal = Object.values((await call.state()).actions).at(-1);
        const correction = mode === "committedDontBook" ? "3 o'clock... 3:30. Don’t book it." : "3 o'clock... 3:30. No.";
        if (mode === "dispatch") {
          pending.push(call.turn("Yes")); await voiceUntil(() => writeResponseHeld, "actual dispatched mutation awaiting its response", call.flow.effectDeadlineMs);
          assert.equal(call.writeRequests.length, 1); assert.equal(Object.values((await call.state()).actions).at(-1)?.status, "dispatched");
          pending.push(call.turn(correction, { interrupt: true })); release();
          const settled = await Promise.allSettled(pending);
          for (const result of settled) if (result.status === "rejected") throw result.reason;
        } else {
          if (mode.startsWith("committed") || mode === "uncertain") await play("Yes");
          await call.turn(correction);
        }
        const after = await call.state();
        assert.ok(call.transcripts.includes(correction), `the correction must actually reach a final owned transcript: ${JSON.stringify({ closed: call.closed, closeCode: call.closeCode,
          transcriptCount: call.transcripts.length, correctionInterpreted: call.modelTurns.includes(correction), lifecycle: after.lifecycle,
          terminal: after.terminal?.reason, processedTurns: after.processedTurnIds.length, markers: call.sent.filter(item => item.event === "mark").length,
          clears: call.sent.filter(item => item.event === "clear").length, speechCount: call.spoken.length })}`);
        if (mode === "menu" || mode === "proposal") {
          assert.equal(call.writeRequests.length, 0); assert.equal(call.writes.length, 0);
          assert.ok(Object.values(after.actions).every(action => action.status === "canceled"));
          if (proposal) assert.equal(after.actions[proposal.key]?.status, "canceled");
          assert.match(call.spoken.at(-1)!, /new confirmation|fresh appointment options/);
        } else {
          assert.equal(call.writeRequests.length, 1); assert.equal(call.writeRequests[0]?.method, "POST");
          assert.equal(call.writeRequests[0]?.path, "/v1/individual_appointments");
          assert.equal(call.writeRequests[0]?.body.starts_at, "2026-10-08T04:00:00.000Z");
          assert.equal(call.writeRequests[0]?.body.patient_id, verificationCanaries[2]);
          assert.equal(after.actions[proposal!.key]?.status, mode === "uncertain" ? "uncertain" : "committed");
          assert.match(call.spoken.at(-1)!, mode === "uncertain"
            ? /can't confirm the previous action yet\. I haven't made another change\. Please contact the clinic/
            : /Your booking is confirmed\. I haven't made another change\. Please contact the clinic/);
          assert.ok(!/won't be booked|not booked|have canceled|have cancelled|stopped the booking/i.test(call.spoken.at(-1)!));
        }
        assert.equal(Object.keys(after.staffItems).length, 0); assert.equal(f.mail.length, 1);
        assert.ok(!call.transcripts.includes(f.mail[0]!.code));
      } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      finally { release(); await Promise.allSettled(pending); await call?.close(); await f.close(); }
    };
    let next = 0; const failures: unknown[] = [];
    const settled = await Promise.allSettled(Array.from({ length: 3 }, async () => { for (;;) { const mode = modes[next++]; if (!mode) return; try { await run(mode); } catch (error) { failures.push(error); } } }));
    for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `final_negative_${index}`, value })))), []);
  });
});
