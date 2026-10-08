import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { cancellationCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

for (const outcome of ["within deadline", "expired"] as const) {
  test(`E2E-299 signed cancellation evidence ${outcome} observes its core budget and cannot send or accept late evidence`, { timeout: 90_000 }, async () => {
    await withDisposablePostgres(async db => {
      const f = await cancellationCallFlowFixture(); f.flow.dispose();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      let armed = false, held = false, returned = false, release = () => {};
      let evidenceSignal: AbortSignal | null | undefined;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      try {
        const port = f.flowConfig.fetchPort!;
        call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort: async (value, init) => {
          if (armed && (init?.method ?? "GET") === "GET" && new URL(String(value)).pathname === "/v1/individual_appointments/91") {
            armed = false; held = true; evidenceSignal = init?.signal;
            await waiting;
            const response = await port(value, init); returned = true; return response;
          }
          return port(value, init);
        } }, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model",
          clinicDate: () => "2026-10-04", fetch: async (_url, init) => {
            const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
            const start = text === "I need to cancel an appointment.";
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text",
              text: JSON.stringify({ kind: start ? "workflow" : "appointments", operation: start ? "cancel" : null, stage: null,
                from: start ? null : "2026-10-04", to: start ? null : "2026-10-09", choice: null }) }] }] });
          } }));
        await call.turn("I need to cancel an appointment."); await call.mark();
        await voiceUntil(() => f.mail.length === 1, "proposal evidence verification"); await call.verify(f.mail[0]!.code);
        await call.turn("Show me my appointments from October 4 through October 9."); await call.mark();
        armed = true;
        const pending = call.turn("Cancel that appointment.").then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
        await voiceUntil(() => held, "held cancellation proposal evidence");
        assert.ok(evidenceSignal); assert.equal(evidenceSignal.aborted, false);
        assert.equal(call.writeRequests.length, 0); assert.equal(Object.keys((await call.state()).actions).length, 0);
        if (outcome === "within deadline") {
          // Past the old generic 10s dispatch wait, inside the existing 15s
          // proposal evidence budget. The caller has not confirmed a write.
          await new Promise<void>(resolve => setTimeout(resolve, 11_000));
          assert.equal(evidenceSignal.aborted, false); release();
          const settled = await pending;
          assert.ok(settled.ok, settled.ok ? undefined : String(settled.error));
          await call.mark();
          const actions = Object.values((await call.state()).actions);
          assert.equal(actions.length, 1); assert.equal(actions[0]!.status, "awaitingConfirmation");
          assert.equal(actions[0]!.mutation.request.kind, "cancel");
          if (actions[0]!.mutation.request.kind !== "cancel") throw new Error("expected cancellation proposal");
          assert.equal(actions[0]!.mutation.request.target.appointmentRef, "91");
          assert.match(call.spoken.at(-1)!, /There is no fee for this cancellation/);
        } else {
          const settled = await pending;
          assert.equal(settled.ok, false);
          if (settled.ok) throw new Error("expired evidence cannot be accepted");
          assert.match(String(settled.error), /effectFailure/);
          await voiceUntil(() => evidenceSignal!.aborted, "original evidence deadline");
          release(); await voiceUntil(() => returned, "late synthetic evidence returned");
          assert.equal(Object.keys((await call.state()).actions).length, 0);
        }
        assert.equal(call.writeRequests.length, 0); assert.equal(f.patches, 0);
        assert.ok(verificationCanaries.every(canary => call!.spoken.every(text => !text.includes(canary))));
        assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, i) => ({ label: `proposal_evidence_${i}`, value })))), []);
      } finally { release(); try { await call?.close(); } finally { await f.close(); } }
    });
  });
}
