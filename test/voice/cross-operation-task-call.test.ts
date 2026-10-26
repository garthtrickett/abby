import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionState } from "../../src/core/model.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { crossOperationTasksFixture } from "../support/cross-operation-tasks.ts";
import type { CrossOperation } from "../support/cross-operation-tasks.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";

const operations = ["book", "cancel", "reschedule"] as const;
const requests = { book: "Book an appointment.", cancel: "Cancel an appointment.", reschedule: "Move an appointment." };
const nextRequests = { book: "Book another appointment.", cancel: "Cancel another appointment.", reschedule: "Reschedule another appointment." };

for (const firstKind of operations) for (const secondKind of operations) {
  if (firstKind === secondKind) continue;
  test(`E2E-381 signed ${firstKind} then ${secondKind} keep fresh proof, played consent and separate native receipts`, { timeout: 120_000 }, async () => {
    await withDisposablePostgres(async db => {
      const f = await crossOperationTasksFixture(); f.flow.dispose();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      const publicContexts: unknown[] = [];
      try {
        const model: typeof fetch = async (_url, init) => {
          const body = JSON.parse(String(init?.body)), context = JSON.parse(body.input[1].content); publicContexts.push(context);
          assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
          const decision = { kind: "unsupported", operation: null as CrossOperation | null, stage: null as "targets" | "offers" | null,
            from: null as string | null, to: null as string | null, choice: null as number | null };
          const operation = operations.find(kind => requests[kind] === context.callerText || nextRequests[kind] === context.callerText);
          if (operation) { decision.kind = "workflow"; decision.operation = operation; }
          else if (context.callerText === "Show my upcoming appointments.") {
            decision.kind = context.workflow === "reschedule" ? "menu" : "appointments";
            decision.stage = context.workflow === "reschedule" ? "targets" : null;
            decision.from = "2026-10-04"; decision.to = "2026-10-09";
          } else if (context.callerText === "Show times on October 8.") {
            decision.kind = "menu"; decision.stage = context.workflow === "reschedule" ? "offers" : null;
            decision.from = "2026-10-08"; decision.to = "2026-10-08";
          } else if (context.callerText === "Cancel that appointment.") decision.kind = "cancel";
          else assert.fail("unexpected public classifier input");
          return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
        };
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner,
          apiKey: "synthetic", model: "synthetic", clinicDate: () => "2026-10-04", fetch: model }),
        { maximumWrites: 2, nativeIndividualChanges: true, clinicalHost: true });
        f.bindNativeCall(() => call!.state());
        let first: ActionState | undefined;
        for (const [index, kind] of [firstKind, secondKind].entries()) {
          const previous = new Set(Object.keys((await call.state()).actions));
          await call.turn(index === 0 ? requests[kind] : nextRequests[kind]); await call.mark();
          await voiceUntil(() => f.mail.length === index + 1, "new task's private verification mail");
          assert.equal(call.writes.length, index); assert.equal(f.native.mutations.length, index);
          const frames: number = call.transcriptionFrames; await call.verify(f.mail.at(-1)!.code); assert.equal(call.transcriptionFrames, frames);
          if (kind !== "book") { await call.turn("Show my upcoming appointments."); await call.mark(); }
          if (kind === "cancel") await call.turn("Cancel the first appointment.");
          else {
            if (kind === "reschedule") { await call.turn("The first appointment please."); await call.mark(); }
            await call.turn("Show times on October 8."); await call.mark(); await call.turn("The first time please.");
          }
          const actions: ActionState[] = Object.values((await call.state()).actions).filter(row => !previous.has(row.key));
          assert.equal(actions.length, 1); const action = actions[0]!; assert.equal(action.status, "awaitingConfirmation");
          assert.equal(call.writes.length, index); await call.mark(); await call.turn("Yes"); await call.mark();
          const current: ActionState = (await call.state()).actions[action.key]!; assert.equal(current.status, "committed");
          if (!first) first = structuredClone(current); else assert.deepEqual((await call.state()).actions[first.key], first);
        }
        assert.ok(first); assert.deepEqual(f.native.mutations.map(row => row.operation), [firstKind, secondKind]);
        assert.equal(f.native.reviews.length, 2); assert.equal(call.writes.length, 2);
        assert.deepEqual(await call.flow.reconcile(first.mutation), { kind: "exactCommit", actionKey: first.key, hostRef: first.hostRef });
        assert.deepEqual(await call.flow.write(first.mutation, call.currentTime()), { kind: "rejected", actionKey: first.key, reason: "forbidden" });
        await call.turn(nextRequests.book); await call.mark(); assert.equal(f.mail.length, 2); assert.equal(call.writes.length, 2);
        assert.deepEqual((await call.state()).actions[first.key], first);
        const secrets = [...verificationCanaries, ...f.mail.map(item => item.code)];
        for (const secret of secrets) assert.equal(JSON.stringify([publicContexts, call.modelTurns, call.transcripts, call.spoken]).includes(secret), false);
        assert.deepEqual(resultValue(await scanPatientDataCanaries(db, secrets.map((value, index) => ({ label: `cross_operation_${index}`, value })))), []);
      } finally { if (call) await call.close(); await f.close(); }
    });
  });
}
