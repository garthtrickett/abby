import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { classMoveCallFlowFixture } from "../support/class-move-call-flow.ts";
import { classLink } from "../support/class-attendance.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

test("E2E-401 signed class movement corrections supersede original consent and require a new exact proposal", { timeout: 120_000 }, async t => {
  await withDisposablePostgres(async db => {
    for (const mode of ["ordinal", "date", "permission"] as const) await t.test(mode, async () => {
      const f = await classMoveCallFlowFixture(); f.flow.dispose();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      const publicModel: Record<string, unknown>[] = [];
      try {
        f.native.groups.push({ ...structuredClone(f.native.groups[1]!), id: "95", ...classLink("group_appointments", "95"),
          starts_at: mode === "date" ? "2026-10-10T10:00:00.000Z" : "2026-10-09T12:00:00.000Z",
          ends_at: mode === "date" ? "2026-10-10T11:00:00.000Z" : "2026-10-09T13:00:00.000Z" });
        const model: typeof fetch = async (_url, init) => {
          const body = JSON.parse(String(init?.body)), context = JSON.parse(body.input[1].content); publicModel.push(context);
          const decision = { kind: "menu", operation: null, stage: "targets", from: "2026-10-08", to: "2026-10-08", choice: null };
          if (context.callerText === "Show replacement classes on October 9.") {
            assert.equal(context.phase, "listNewTimes"); decision.stage = "offers"; decision.from = decision.to = "2026-10-09";
          } else { assert.equal(context.phase, "listExistingAppointments"); assert.equal(context.callerText, "Show my class bookings on October 8.", "corrections and actual played choices must not reach the model"); }
          return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
        };
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, flow => createOpenAIClinicalIntentResolver({ owner: flow, apiKey: "synthetic", model: "synthetic",
          clinicDate: () => "2026-10-04", fetch: model }), { classMove: true, maximumWrites: 2 });
        f.bindNativeCall(() => call!.state());
        await call.turn("Move my Pilates class"); await call.mark(); await voiceUntil(() => f.mail.length === 1, "class correction code");
        await call.verify(f.mail[0]!.code);
        await call.turn("Show my class bookings on October 8."); assert.match(call.spoken.at(-1)!, /Which appointment/); await call.mark();
        await call.turn("The first time please."); assert.match(call.spoken.at(-1)!, /selected your appointment/); await call.mark();
        await call.turn("Show replacement classes on October 9."); assert.match(call.spoken.at(-1)!, /Option one|option one/i); await call.mark(); await call.turn("The first time please.");
        const first = Object.values((await call.state()).actions).at(-1)!; assert.equal(first.status, "awaitingConfirmation");
        if (mode === "permission") f.permit(false);
        await call.turn(mode === "date" ? "Actually, Saturday" : "No, the second time please.", { interrupt: true });
        assert.equal((await call.state()).actions[first.key]!.status, "canceled");
        if (mode === "date") { assert.match(call.spoken.at(-1)!, /Saturday 10 October/); await call.mark(); await call.turn("The first time please."); }
        const actions = Object.values((await call.state()).actions), corrected = actions.at(-1)!;
        if (mode === "permission") assert.equal(actions.length, 1);
        else {
          assert.equal(actions.length, 2); assert.notEqual(corrected.key, first.key); assert.equal(corrected.status, "awaitingConfirmation");
          assert.equal(corrected.mutation.request.kind, "reschedule"); if (corrected.mutation.request.kind !== "reschedule") throw new Error("missing move");
          assert.equal(corrected.mutation.request.offer.startsAt, mode === "date" ? "2026-10-10T10:00:00.000Z" : "2026-10-09T12:00:00.000Z");
          assert.notEqual((await call.state()).presentations[corrected.presentationId]!.status, "played");
          assert.match(call.spoken.at(-1)!, /book the replacement before cancelling the original/);
        }
        assert.deepEqual([f.writes.length, f.recalls.length], [0, 0]);
        for (const value of [...verificationCanaries, f.mail[0]!.code]) assert.equal(JSON.stringify([publicModel, call.spoken, call.transcripts, call.modelTurns]).includes(value), false);
      } finally { if (call) await call.close(); await f.close(); }
    });
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `class_correction_${index}`, value })))), []);
  });
});
