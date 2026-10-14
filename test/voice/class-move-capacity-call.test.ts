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

for (const different of [false, true])
  test(`E2E-402 signed corrected ${different ? "cross-service" : "same-service"} move waits through real silence, renews its lease, and commits only after renewed affirmation`, { timeout: 120_000 }, async () => {
    await withDisposablePostgres(async db => {
      const f = await classMoveCallFlowFixture(different); f.flow.dispose();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined, ticker: ReturnType<typeof setInterval> | undefined, quiet: ReturnType<typeof setInterval> | undefined;
      const publicModel: Record<string, unknown>[] = [];
      const capacityResults: string[] = [];
      try {
        f.native.groups.push({ ...structuredClone(f.native.groups[1]!), id: "95", ...classLink("group_appointments", "95"),
          starts_at: "2026-10-09T12:00:00.000Z", ends_at: different ? "2026-10-09T12:30:00.000Z" : "2026-10-09T13:00:00.000Z" });
        const model: typeof fetch = async (_url, init) => {
          const body = JSON.parse(String(init?.body)), context = JSON.parse(body.input[1].content); publicModel.push(context);
          const decision = { kind: "menu", operation: null, stage: "targets", from: "2026-10-08", to: "2026-10-08", choice: null };
          if (context.callerText === "Show replacement classes on October 9.") {
            assert.equal(context.phase, "listNewTimes"); decision.stage = "offers"; decision.from = decision.to = "2026-10-09";
          } else { assert.equal(context.phase, "listExistingAppointments"); assert.equal(context.callerText, "Show my class bookings on October 8."); }
          return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
        };
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, flow => {
          const capacity = flow.checkConfirmationCapacity.bind(flow);
          flow.checkConfirmationCapacity = async query => { const result = await capacity(query); capacityResults.push(result.ok ? result.value.kind : result.error.kind); return result; };
          return createOpenAIClinicalIntentResolver({ owner: flow, apiKey: "synthetic", model: "synthetic", clinicDate: () => "2026-10-04", fetch: model });
        }, { classMove: true, maximumWrites: 2 });
        f.bindNativeCall(() => call!.state());
        await call.turn("Move my Pilates class"); await call.mark(); await voiceUntil(() => f.mail.length === 1, "class capacity code"); await call.verify(f.mail[0]!.code);
        await call.turn("Show my class bookings on October 8."); await call.mark(); await call.turn("The first time please."); await call.mark();
        await call.turn("Show replacement classes on October 9."); await call.mark(); await call.turn("The first time please.");
        const original = Object.values((await call.state()).actions).at(-1)!;
        await call.turn("No, the second time please.", { interrupt: true });
        const corrected = Object.values((await call.state()).actions).at(-1)!;
        assert.notEqual(corrected.key, original.key); assert.equal((await call.state()).actions[original.key]!.status, "canceled");
        assert.match(call.spoken.at(-1)!, /book the replacement before cancelling the original/); await call.mark();
        while (await f.config.cliniko.rateBudget.claim() === null) { /* actual shared claims at unchanged limit */ }
        await call.turn("Yes"); assert.match(call.spoken.at(-1)!, /wait about 60 seconds.*say yes again/); await call.mark();
        const waiting = await call.state(), leaseVersion = waiting.sessionLease!.version;
        assert.equal(waiting.actions[corrected.key]!.status, "awaitingConfirmation");
        assert.equal(Object.values(waiting.effects).some(effect => effect.kind === "hostWrite"), false);
        assert.deepEqual([f.writes.length, f.recalls.length], [0, 0]);
        const clockStart = Date.parse(f.classSessionConfig.clock()), started = performance.now();
        ticker = setInterval(() => f.setTime(new Date(clockStart + Math.floor((performance.now() - started) / 1000) * 1000).toISOString()), 1000);
        quiet = setInterval(() => call!.media(false), 20);
        // Real time elapses; the connected call owns normal ten-second renewals.
        // No effect, offer, proof, request limit or playback deadline is extended.
        await new Promise<void>(resolve => setTimeout(resolve, 61000));
        clearInterval(ticker); ticker = undefined; clearInterval(quiet); quiet = undefined; f.setTime(new Date(clockStart + 61000).toISOString());
        const recovered = await call.state(); assert.equal(recovered.lifecycle, "active"); assert.ok(recovered.sessionLease!.version > leaseVersion);
        assert.equal(recovered.actions[corrected.key]!.status, "awaitingConfirmation"); assert.deepEqual([f.writes.length, f.recalls.length], [0, 0]);
        await call.turn("Yes"); assert.equal((await call.state()).actions[corrected.key]!.status, "committed", JSON.stringify({ capacityResults, lastSpeech: call.spoken.at(-1), now: f.classSessionConfig.clock() }));
        assert.equal((await call.state()).actions[original.key]!.status, "canceled"); assert.equal(f.recalls.length, 1);
        assert.deepEqual(call.writes, ["POST /v1/attendees", "PATCH /v1/attendees/101/cancel"]); assert.equal(f.writes[0]!.body.booking_id, "95");
        assert.ok(f.windowClaims.every(count => count <= 180));
        for (const value of [...verificationCanaries, f.mail[0]!.code]) assert.equal(JSON.stringify([publicModel, call.spoken, call.transcripts, call.modelTurns]).includes(value), false);
        assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `class_wait_${index}`, value })))), []);
      } finally { if (ticker) clearInterval(ticker); if (quiet) clearInterval(quiet); if (call) await call.close(); await f.close(); }
    });
  });
