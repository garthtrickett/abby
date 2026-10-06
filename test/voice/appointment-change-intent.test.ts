import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import type { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { appointmentChangeCallFlowFixture } from "../support/appointment-change-call-flow.ts";
import { cancellationCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

test("E2E-310 signed change intent clarifies conflicts, preserves the source and switches only unsent workflows with new verification", { timeout: 150_000 }, async () => {
  await withDisposablePostgres(async db => {
    const scenarios = ["mixed", "disagreement", "modelGuess", "cancelOnly", "cancelLateOnly", "reassign", "duration", "redirect", "reverse", "denied", "committed", "genericCommitted", "unknown", "multiple", "unplayedChoice", "conflictingChoice"] as const;
    const run = async (scenario: typeof scenarios[number]) => {
      const f = ["redirect", "reverse"].includes(scenario) ? await appointmentChangeCallFlowFixture()
        : await cancellationCallFlowFixture({ multiple: ["multiple", "unplayedChoice", "conflictingChoice"].includes(scenario) });
      f.flow.dispose(); let trustedOwner: ClinikoCallFlow | undefined;
      if (scenario === "cancelLateOnly" && "replaceCancellation" in f) await f.replaceCancellation({ lateNoticeHours: 120 });
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      const requests: string[] = [], reverse = scenario === "reverse";
      try {
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => {
          trustedOwner = owner;
          return createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04",
            fetch: async (_value, init) => {
              const input = JSON.parse(JSON.parse(String(init?.body)).input[1].content), text = input.callerText; requests.push(text);
              const start = text === "I need to cancel an appointment." || text === "I need to move an appointment.";
              const targets = text === "Show my existing appointments from October 4 through October 9.";
              const offers = text === "Show move times on October 8.";
              const appointments = text === "Show me my appointments from October 4 through October 9.";
              // Any otherwise unmatched statement is maliciously suggested as
              // cancellation. The caller-language guard must reject it.
              const decision = { kind: start ? "workflow" : targets || offers ? "menu" : appointments ? "appointments" : "cancel",
                operation: start ? reverse ? "reschedule" : "cancel" : null, stage: targets ? "targets" : offers ? "offers" : null,
                from: targets || appointments ? "2026-10-04" : offers ? "2026-10-08" : null,
                to: targets || appointments ? "2026-10-09" : offers ? "2026-10-08" : null, choice: null };
              return Response.json({ status: "completed", output: [{ type: "message", status: "completed",
                content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
            } });
        }, { lostWrite: scenario === "unknown" });
        await call.turn(reverse ? "I need to move an appointment." : "I need to cancel an appointment."); await call.mark();
        await voiceUntil(() => f.mail.length === 1, "original verification email"); await call.verify(f.mail[0]!.code);
        if (reverse) {
          await call.turn("Show my existing appointments from October 4 through October 9."); await call.mark();
          await call.turn("My first existing appointment."); await call.mark();
          await call.turn("Show move times on October 8."); await call.mark();
          await call.turn("Move it to option two."); await call.mark();
        } else {
          await call.turn("Show me my appointments from October 4 through October 9.");
          if (scenario !== "unplayedChoice") await call.mark();
        }
        if (["redirect", "denied", "committed", "genericCommitted", "unknown"].includes(scenario)) {
          await call.turn("Cancel that appointment."); await call.mark();
          if (["committed", "genericCommitted", "unknown"].includes(scenario)) await call.turn("Yes");
        }
        const before = await call.state(), old = Object.values(before.actions).at(-1);
        if (["committed", "genericCommitted", "unknown"].includes(scenario)) await call.mark();
        const text = scenario === "mixed" ? "I cannot come tomorrow. Could we cancel that and put it on another day?"
          : scenario === "disagreement" ? "I thought it was at ten. You are saying nine?"
          : scenario === "cancelOnly" || scenario === "cancelLateOnly" ? "Please remove this booking. I will arrange another visit myself."
          : scenario === "reassign" ? "Can someone else take my slot instead of me?"
          : scenario === "duration" ? "Could I make that visit an hour instead of the usual half hour?"
          : scenario === "modelGuess" ? "Please explain what you found."
          : scenario === "genericCommitted" ? "I need to change that time after all."
          : scenario === "conflictingChoice" ? "Remove only the first visit. Keep the first one."
          : scenario === "multiple" || scenario === "unplayedChoice" ? "Remove only the second visit. Keep the first one."
          : reverse ? "Actually, cancel it." : "I want to reschedule it.";
        await call.turn(text, scenario === "unplayedChoice" ? { interrupt: true } : {});
        if (["mixed", "disagreement", "modelGuess", "reassign", "duration", "unplayedChoice", "conflictingChoice"].includes(scenario)) {
          assert.equal(Object.keys((await call.state()).actions).length, 0); assert.equal(call.writes.length, 0);
          assert.match(call.spoken.at(-1)!, ["mixed", "modelGuess", "conflictingChoice"].includes(scenario) ? /move.*cancel/
            : scenario === "disagreement" ? /which appointment/ : scenario === "unplayedChoice" ? /fresh appointment options/ : /can't change.*patient.*type.*duration/);
          assert.equal(requests.includes(text), scenario === "modelGuess", "only the unrecognized question exercises the malicious model cancellation");
          if (scenario === "disagreement") {
            await call.mark(); await call.turn("Cancel that appointment.");
            assert.equal(Object.keys((await call.state()).actions).length, 0, "disputed private target must be discarded");
            await call.mark(); await call.turn("Show me my appointments from October 4 through October 9."); await call.mark();
            await call.turn("Cancel that appointment.");
            const refreshed = Object.values((await call.state()).actions).at(-1)!;
            assert.equal(refreshed.status, "awaitingConfirmation");
            assert.equal(refreshed.mutation.request.kind, "cancel");
            if (refreshed.mutation.request.kind !== "cancel") throw new Error("expected refreshed cancellation");
            assert.equal(refreshed.mutation.request.target.startsAt, "2026-10-08T04:00:00.000Z", "caller recollection cannot overwrite provider time");
            assert.equal(call.writes.length, 0); await call.mark(); await call.turn("Yes"); assert.equal(call.writes.length, 1);
          }
        } else if (["committed", "genericCommitted", "unknown"].includes(scenario)) {
          assert.equal((await call.state()).actions[old!.key]?.status, old!.status); assert.equal(call.writes.length, 1);
          assert.match(call.spoken.at(-1)!, scenario === "unknown" ? /can't confirm the previous action/ : /cancellation is confirmed/);
          assert.equal(f.mail.length, 1, "known or uncertain send cannot start another owner");
        } else if (scenario === "redirect" || reverse) {
          assert.equal((await call.state()).actions[old!.key]?.status, "canceled"); assert.equal(call.writes.length, 0);
          assert.equal(trustedOwner!.workflow, reverse ? "cancel" : "reschedule"); assert.equal(trustedOwner!.verificationRequired, true);
          await call.mark(); await voiceUntil(() => f.mail.length === 2, "new operation verification email");
          assert.equal(await trustedOwner!.cancellationProof(), undefined, "the old cancellation grant cannot transfer");
          await call.verify(f.mail[1]!.code);
          if (reverse) {
            await call.turn("Show me my appointments from October 4 through October 9."); await call.mark();
            await call.turn("Cancel that appointment.");
          } else {
            await call.turn("Show my existing appointments from October 4 through October 9."); await call.mark();
            await call.turn("My first existing appointment."); await call.mark();
            await call.turn("Show move times on October 8."); await call.mark();
            await call.turn("Move it to option two.");
          }
          const replacement = Object.values((await call.state()).actions).at(-1)!;
          assert.equal(replacement.status, "awaitingConfirmation");
          assert.equal(replacement.kind, reverse ? "cancel" : "reschedule");
          if ((old!.mutation.request.kind === "cancel" || old!.mutation.request.kind === "reschedule") &&
              (replacement.mutation.request.kind === "cancel" || replacement.mutation.request.kind === "reschedule"))
            assert.deepEqual(replacement.mutation.request.target, old!.mutation.request.target, "switch must retain the unchanged protected source");
          assert.equal(call.writes.length, 0); await call.mark(); await call.turn("Yes");
          assert.equal(call.writes.length, 1); assert.equal((await call.state()).actions[replacement.key]?.status, "committed");
          assert.equal((await call.state()).actions[old!.key]?.status, "canceled");
        } else if (scenario === "denied") {
          assert.equal((await call.state()).actions[old!.key]?.status, "canceled"); assert.equal(call.writes.length, 0);
          assert.equal(trustedOwner!.workflow, "cancel"); assert.equal(f.mail.length, 1);
        } else {
          if (scenario === "multiple") assert.match(call.spoken.at(-1)!, /Thursday 8 October at 4:00 pm/);
          const proposal = Object.values((await call.state()).actions).at(-1)!;
          assert.equal(proposal.kind, "cancel"); assert.equal(proposal.status, "awaitingConfirmation"); assert.equal(call.writes.length, 0);
          if (proposal.mutation.request.kind !== "cancel") throw new Error("expected exact cancellation");
          if (scenario === "cancelOnly" || scenario === "cancelLateOnly") {
            const terms = scenario === "cancelOnly" ? "There is no fee for this cancellation." : "A cancellation fee of $20 applies.";
            assert.equal(proposal.mutation.request.terms.approvedText, terms);
            assert.ok(call.spoken.at(-1)!.includes(terms), "exact approved fee terms must be spoken before confirmation");
            assert.equal(call.writeRequests.length, 0); assert.equal(f.mail.length, 1); assert.equal(trustedOwner!.workflow, "cancel");
          }
          assert.equal(proposal.mutation.request.target.appointmentRef, scenario === "multiple" ? "92" : "91");
          await call.mark(); await call.turn("Yes"); assert.equal(call.writes.length, 1);
          assert.equal(call.writes[0], `PATCH /v1/individual_appointments/${scenario === "multiple" ? "92" : "91"}/cancel`);
          if (scenario === "cancelOnly" || scenario === "cancelLateOnly") {
            assert.equal(call.writeRequests.length, 1); assert.deepEqual(call.writeRequests[0], {
              method: "PATCH", path: "/v1/individual_appointments/91/cancel",
              body: { cancellation_note: null, cancellation_reason: 50, apply_to_repeats: false },
            });
          }
        }
      } finally { try { await call?.close(); } finally { await f.close(); } }
    };
    let next = 0;
    const failures: unknown[] = [];
    const workers = await Promise.allSettled(Array.from({ length: 4 }, async () => { while (next < scenarios.length) {
      const scenario = scenarios[next++]!;
      try { await run(scenario); } catch (error) { failures.push(new Error(`${scenario}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
    } }));
    for (const worker of workers) if (worker.status === "rejected") failures.push(worker.reason);
    if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `change_${index}`, value })))), []);
  });
});
