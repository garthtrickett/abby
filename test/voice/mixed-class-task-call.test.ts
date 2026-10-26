import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionState } from "../../src/core/model.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { mixedClassTasksFixture } from "../support/mixed-class-tasks.ts";

for (const firstKind of ["class", "individual"] as const) for (const lostSecond of [false, true])
  test(`E2E-381 signed mixed tasks ${firstKind} first keep ${lostSecond ? "uncertain" : "committed"} second outcome separate`, { timeout: 120_000 }, async () => {
    await withDisposablePostgres(async db => {
      const f = await mixedClassTasksFixture(); f.flow.dispose();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      const publicContexts: unknown[] = [];
      try {
        const model: typeof fetch = async (_url, init) => {
          const body = JSON.parse(String(init?.body)), context = JSON.parse(body.input[1].content);
          assert.equal(body.store, false); assert.equal(body.text.format.strict, true); publicContexts.push(context);
          const decision = { kind: "unsupported", operation: null as string | null, stage: null,
            from: null as string | null, to: null as string | null, choice: null as number | null };
          if (context.callerText === "Book my Mat Pilates class.") { decision.kind = "classWorkflow"; decision.operation = "book"; }
          else if (context.callerText === "Book an appointment.") { decision.kind = "workflow"; decision.operation = "book"; }
          else if (context.callerText === "Show times on October 8.") { decision.kind = "menu"; decision.from = "2026-10-08"; decision.to = "2026-10-08"; }
          else if (context.callerText === "The first time please.") { decision.kind = "choice"; decision.choice = 1; }
          else assert.fail("unexpected public classifier input");
          return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
        };
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner,
          apiKey: "synthetic", model: "synthetic", clinicDate: () => "2026-10-04", fetch: model }),
        { maximumWrites: 2, nativeIndividualChanges: true, clinicalHost: true });
        f.bindMixedCall(() => call!.state());
        const kinds = firstKind === "class" ? ["class", "individual"] as const : ["individual", "class"] as const;
        let first: ActionState | undefined;
        for (const [index, kind] of kinds.entries()) {
          await call.turn(kind === "class" ? "Book my Mat Pilates class." : "Book an appointment."); await call.mark();
          await voiceUntil(() => f.mail.length === index + 1, "new task's private verification email");
          assert.equal(call.writes.length, index, "a new task cannot write with the previous task's proof");
          const privateFrames: number = call.transcriptionFrames;
          await call.verify(f.mail.at(-1)!.code); assert.equal(call.transcriptionFrames, privateFrames);
          await call.turn("Show times on October 8."); await call.mark();
          await call.turn("The first time please.");
          const action: ActionState = Object.values((await call.state()).actions).at(-1)!;
          assert.equal(action.status, "awaitingConfirmation"); assert.equal(call.writes.length, index);
          await call.mark();
          if (index === 1 && lostSecond) { if (kind === "class") f.loseWrite(); else f.loseIndividual(); }
          await call.turn("Yes"); await call.mark();
          const current: ActionState = (await call.state()).actions[action.key]!;
          assert.equal(current.status, index === 1 && lostSecond ? "uncertain" : "committed");
          if (index === 0) first = structuredClone(current);
          else assert.deepEqual((await call.state()).actions[first!.key], first);
        }
        assert.deepEqual(call.writes, kinds.map(kind => `POST /v1/${kind === "class" ? "attendees" : "individual_appointments"}`));
        assert.deepEqual([f.mail.length, f.writes.length, f.individualWrites.length, f.recalls.length, f.individualRecalls.length], [2, 1, 1, 1, 1]);
        if (lostSecond) assert.match(call.spoken.at(-1)!, /can't confirm|couldn't confirm|not confirmed|unconfirmed/i);
        else assert.equal(call.spoken.at(-1), "Your booking is confirmed.");
        assert.ok(first);
        assert.deepEqual(await call.flow.reconcile(first.mutation), { kind: "exactCommit", actionKey: first.key, hostRef: first.hostRef });
        assert.deepEqual(await call.flow.write(first.mutation, call.currentTime()), { kind: "rejected", actionKey: first.key, reason: "forbidden" });
        await call.turn("Book an appointment."); await call.mark();
        assert.equal(call.writes.length, 2); assert.equal(f.mail.length, 2, "an exhausted or unresolved sequence cannot issue a third verifier");
        assert.deepEqual((await call.state()).actions[first.key], first);
        const secrets = [...verificationCanaries, ...f.mail.map(item => item.code)];
        for (const secret of secrets) assert.equal(JSON.stringify([publicContexts, call.modelTurns, call.transcripts, call.spoken]).includes(secret), false);
        assert.deepEqual(resultValue(await scanPatientDataCanaries(db, secrets.map((value, index) => ({ label: `mixed_${index}`, value })))), []);
      } finally { if (call) await call.close(); await f.close(); }
    });
  });
