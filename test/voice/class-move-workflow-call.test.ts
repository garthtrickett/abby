import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { classMoveCallFlowFixture } from "../support/class-move-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

test("E2E-399 actual signed class movement uses ordinary routing, private keypad, played menus and one reviewed two-leg native move", { timeout: 120_000 }, async t => {
  await withDisposablePostgres(async db => {
    for (const fault of ["none", "lostOriginal", "permission"] as const) await t.test(fault, async () => {
      const f = await classMoveCallFlowFixture(); f.flow.dispose();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      const publicModel: Record<string, unknown>[] = [];
      try {
        if (fault === "lostOriginal") f.lose("original");
        const model: typeof fetch = async (_url, init) => {
          const body = JSON.parse(String(init?.body)), context = JSON.parse(body.input[1].content);
          publicModel.push(context); assert.equal(context.classService.moveAvailable, true);
          assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
          const decision = { kind: "unsupported", operation: null, stage: null as string | null, from: null as string | null, to: null as string | null, choice: null as number | null };
          if (context.callerText === "Show my class bookings on October 8.") { decision.kind = "menu"; decision.stage = "targets"; decision.from = "2026-10-08"; decision.to = "2026-10-08"; }
          else if (context.callerText === "Show replacement classes on October 9.") { decision.kind = "menu"; decision.stage = "offers"; decision.from = "2026-10-09"; decision.to = "2026-10-09"; }
          else if (context.callerText === "The first time please.") { decision.kind = "choice"; decision.stage = context.reschedulingTargetSelected ? "offers" : "targets"; decision.choice = 1; }
          else assert.fail("unexpected public class movement classifier request");
          return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
        };
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, flow => createOpenAIClinicalIntentResolver({ owner: flow, apiKey: "synthetic-class-move", model: "synthetic",
          clinicDate: () => "2026-10-04", fetch: model }), { classMove: true, maximumWrites: 2 });
        f.bindNativeCall(() => call!.state());
        await call.turn("Move my Pilates class"); assert.match(call.spoken.at(-1)!, /six-digit code.*keypad/); await call.mark();
        await voiceUntil(() => f.mail.length === 1, "class move verification email");
        const frames = call.transcriptionFrames; await call.verify(f.mail[0]!.code); assert.equal(call.transcriptionFrames, frames);
        await call.turn("Show my class bookings on October 8."); assert.match(call.spoken.at(-1)!, /Which appointment/); await call.mark();
        await call.turn("The first time please."); assert.match(call.spoken.at(-1)!, /selected your appointment/); await call.mark();
        await call.turn("Show replacement classes on October 9."); assert.match(call.spoken.at(-1)!, /Option one|option one/i); await call.mark();
        await call.turn("The first time please.");
        const action = Object.values((await call.state()).actions).at(-1)!;
        assert.equal(action.status, "awaitingConfirmation"); assert.deepEqual([f.recalls.length, f.writes.length], [0, 0]);
        assert.match(call.spoken.at(-1)!, /book the replacement before cancelling the original/);
        await call.mark(); if (fault === "permission") f.permit(false);
        await call.turn("Yes");
        assert.equal((await call.state()).actions[action.key]!.status, fault === "none" ? "committed" : fault === "lostOriginal" ? "uncertain" : "canceled");
        assert.equal(f.writes.length, fault === "permission" ? 0 : 2); assert.equal(f.recalls.length, fault === "permission" ? 0 : 1);
        if (fault !== "permission") {
          assert.deepEqual(call.writes, ["POST /v1/attendees", "PATCH /v1/attendees/101/cancel"]);
          assert.equal(resultValue(decodeClinikoReview(f.recalls[0]!.notes)).request.operation.kind, "classMove");
        }
        if (fault === "lostOriginal") { await call.mark(); await call.turn("Yes"); assert.equal(f.writes.length, 2); }
        assert.equal(f.native.traffic.some(row => row.path.includes("individual_appointments")), false);
        for (const secret of [...verificationCanaries, f.mail[0]!.code]) assert.equal(JSON.stringify([publicModel, call.spoken, call.modelTurns, call.transcripts]).includes(secret), false);
      } finally { if (call) await call.close(); await f.close(); }
    });
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `class_move_${index}`, value })))), []);
  });
});
