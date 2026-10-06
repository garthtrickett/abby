import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { bookingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("E2E-330 ambiguous played times explicitly ask the displayed day and AM/PM without guessing, then require fresh played authority", { timeout: 100_000 }, async () => {
  await withDisposablePostgres(async db => {
    const cases = [
      { label: "different-day-period", starts: ["2026-10-07T23:30:00.000Z", "2026-10-09T11:30:00.000Z"] },
      { label: "same-day-period", starts: ["2026-10-07T23:30:00.000Z", "2026-10-08T11:30:00.000Z"] },
      { label: "same-period-different-days", starts: ["2026-10-07T23:30:00.000Z", "2026-10-08T23:30:00.000Z"] },
    ];
    const settled = await Promise.allSettled(cases.map(async item => {
      const f = await bookingCallFlowFixture(); f.flow.dispose(); f.setStarts(item.starts);
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      let modelRequests = 0;
      try {
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner,
          apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_url, init) => {
            modelRequests++; const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
            const start = text === "I need to book an appointment.", menu = text === "What times are available on October 8 and 9?";
            // An unmatched caller phrase receives a malicious guessed ordinal;
            // the played-menu owner must reject that as selection authority.
            const answer = { kind: start ? "workflow" : menu ? "menu" : "choice", operation: start ? "book" : null, stage: null,
              from: menu ? "2026-10-08" : null, to: menu ? "2026-10-09" : null, choice: start || menu ? null : 1 };
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(answer) }] }] });
          } }));
        const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
        await play("I need to book an appointment."); await voiceUntil(() => f.mail.length === 1, "verification email"); await call.verify(f.mail[0]!.code);
        await play("What times are available on October 8 and 9?");
        assert.match(call.spoken.at(-1)!, /option one.*10:30 am.*option two/is);
        const before = await call.state(), requests = modelRequests, traffic = f.allTraffic.length;
        await call.turn("The half-past-ten one.");
        assert.match(call.spoken.at(-1)!, /which.*displayed day/i);
        assert.match(call.spoken.at(-1)!, /\bAM\b/); assert.match(call.spoken.at(-1)!, /\bPM\b/);
        assert.match(call.spoken.at(-1)!, /option number/);
        const after = await call.state();
        assert.deepEqual(after.actions, before.actions); assert.deepEqual(after.staffItems, before.staffItems);
        assert.equal(call.writes.length, 0); assert.equal(f.allTraffic.length, traffic); assert.equal(f.mail.length, 1); assert.equal(modelRequests, requests);
        // Clarification supersedes the previous notice. Another choice needs
        // a fresh menu presentation, even when the original offers still exist.
        await call.mark(); await play("The first time, please.");
        assert.match(call.spoken.at(-1)!, /fresh appointment options/); assert.equal(Object.keys((await call.state()).actions).length, 0);
        await play("What times are available on October 8 and 9?"); await call.turn("The first time, please.");
        const proposal = Object.values((await call.state()).actions).at(-1)!;
        assert.equal(proposal.status, "awaitingConfirmation"); assert.equal(proposal.mutation.request.kind, "book");
        if (proposal.mutation.request.kind !== "book") throw new Error("expected exact booking proposal");
        assert.equal(proposal.mutation.request.offer.startsAt, item.starts[0]); assert.equal(call.writes.length, 0);
        await call.mark(); await call.turn("Yes"); assert.equal(call.writes.length, 1);
        assert.equal((await call.state()).actions[proposal.key]?.status, "committed");
        assert.ok(!call.transcripts.includes(f.mail[0]!.code));
      } catch (error) { throw new Error(`${item.label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      finally { await call?.close(); await f.close(); }
    }));
    const failures = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "ambiguous played time failures");
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `time_ambiguity_${index}`, value })))), []);
  });
});
