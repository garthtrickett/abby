import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { bookingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";

test("E2E-308 signed calls resolve spoken time and relative selections from actually played offers and clarify rejection, ambiguity and guessed choices", { timeout: 100_000 }, async () => {
  await withDisposablePostgres(async db => {
    const cases = [
      { text: "The half-past-ten appointment, thanks.", ambiguous: false, propose: true },
      { text: "The later one, please.", ambiguous: false, propose: true },
      { text: "The half-past-ten one.", ambiguous: true, propose: false },
      { text: "None of those work.", ambiguous: false, propose: false },
      { text: "The train one, please.", ambiguous: false, propose: false },
      { text: "The half-past-ten appointment, thanks.", ambiguous: false, propose: false, unplayed: true },
    ];
    await Promise.all(cases.map(async item => {
      const f = await bookingCallFlowFixture(); f.flow.dispose();
      f.setStarts(item.ambiguous ? ["2026-10-07T23:30:00.000Z", "2026-10-08T11:30:00.000Z"]
        : ["2026-10-07T22:00:00.000Z", "2026-10-07T23:30:00.000Z"]);
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      const requests: string[] = [];
      try {
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner,
          apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_value, init) => {
            const body = JSON.parse(String(init?.body)), text = JSON.parse(body.input[1].content).callerText;
            requests.push(text);
            const answer = { kind: text === "I need to book an appointment." ? "workflow" : text === "What times are available on October 8?" ? "menu" : "choice",
              operation: text === "I need to book an appointment." ? "book" : null, stage: null,
              from: text === "What times are available on October 8?" ? "2026-10-08" : null,
              to: text === "What times are available on October 8?" ? "2026-10-08" : null,
              choice: text === item.text ? 1 : null }; // Deliberately wrong guessed ordinal.
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed",
              content: [{ type: "output_text", text: JSON.stringify(answer) }] }] });
          } }));
        await call.turn("I need to book an appointment."); await call.mark();
        await voiceUntil(() => f.mail.length === 1, "verification mail"); await call.verify(f.mail[0]!.code);
        await call.turn("What times are available on October 8?"); if (!item.unplayed) await call.mark();
        assert.ok(call.spoken.at(-1)?.includes("10:30 am"));
        await call.turn(item.text, item.unplayed ? { interrupt: true } : {});
        const actions = Object.values((await call.state()).actions);
        assert.equal(call.writes.length, 0);
        if (item.propose) {
          assert.equal(actions.at(-1)?.status, "awaitingConfirmation"); assert.match(call.spoken.at(-1)!, /10:30 am/);
          assert.ok(!requests.includes(item.text), "selection must not require a model ordinal");
          await call.mark(); await call.turn("Yes"); assert.equal(call.writes.length, 1);
          assert.equal(Object.values((await call.state()).actions).at(-1)?.status, "committed");
        } else {
          assert.equal(actions.length, 0); assert.match(call.spoken.at(-1)!, /which option|other date or time|fresh appointment options/i);
          if (item.ambiguous) assert.match(call.spoken.at(-1)!, /which displayed day.*AM or PM/);
          if (item.text === "None of those work.") assert.match(call.spoken.at(-1)!, /won't choose any of those options/);
          if (item.text !== "The train one, please.") assert.ok(!requests.includes(item.text));
        }
      } finally { try { await call?.close(); } finally { await f.close(); } }
    }));
  });
});
