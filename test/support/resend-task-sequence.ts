import assert from "node:assert/strict";
import type { Kysely } from "kysely";
import type Database from "../../src/storage/generated/Database.ts";
import { EffectWorker } from "../../src/core/effect-worker.ts";
import { PrivateResendVoiceInput } from "../../src/standalone/private-resend-voice-input.ts";
import { PrivateWorkflowKeypad } from "../../src/standalone/private-workflow-keypad.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import type { PrivateKeypadInput } from "../../src/voice/private-keypad-input.ts";
import type { SmtpPatientCodeConfig } from "../../src/standalone/smtp-patient-code-delivery.ts";
import { confirmationResendFixture } from "./confirmation-resend.ts";
import { resendWorkflow } from "./confirmation-resend-workflow.ts";
import { syntheticTaskSequence } from "./call-task-sequence.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

type InputFactory = (config: ConstructorParameters<typeof PrivateResendVoiceInput>[0]) => PrivateKeypadInput;
async function until(check: () => boolean | Promise<boolean>, message = "expected private resend task progress") {
  const end = Date.now() + 5000;
  while (!await check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(await check(), true, message);
  await new Promise(resolve => setImmediate(resolve));
}

/** Real task/verifier/SAM/journal owners and TLS mail; native records and authority are synthetic. */
export async function resendTasksFixture(db: Kysely<Database>, smtp: SmtpPatientCodeConfig,
  createInput: InputFactory = config => new PrivateResendVoiceInput(config)) {
  const f = await confirmationResendFixture(db, smtp, "appointments.resend", true);
  let closeFlow: (() => void) | undefined;
  try {
    f.setChoices([{ id: "81", starts_at: "2026-10-08T04:00:00.000Z", ends_at: "2026-10-08T04:30:00.000Z" },
      { id: "82", starts_at: "2026-10-09T04:00:00.000Z", ends_at: "2026-10-09T04:30:00.000Z" }]);
    const sequence = await syntheticTaskSequence(f.config, f.folder);
    let reviews = 0;
    const fetchPort: typeof fetch = async (value, init) => {
      const response = await f.config.fetchPort(value, init);
      if (init?.method === "POST" && new URL(String(value)).pathname === "/v1/recalls") {
        const row = await response.json(); row.id = String(907 + reviews++);
        return Response.json(row, { status: response.status });
      }
      return response;
    };
    const w = await resendWorkflow({ ...f, config: { ...sequence.config, fetchPort } });
    closeFlow = () => w.flow.dispose();
    const intent = createOpenAIClinicalIntentResolver({ owner: w.flow, apiKey: "synthetic", model: "synthetic", clinicDate: () => "2026-10-04",
      fetch: async () => { throw new Error("private resend requests must stay in the local mapper"); } });
    const lifetime = new AbortController(), prompts: string[] = [];
    const input = createInput({ owner: () => w.flow, signal: lifetime.signal,
      input: new PrivateWorkflowKeypad({ callId: f.callId, sessionId: f.sessionId, owner: () => w.flow }),
      present: async text => { prompts.push(text); return true; } });
    assert.equal(input.claim(f.callId, f.sessionId), true); assert.equal(input.start(), true);
    const play = async () => {
      const id = (await f.state()).pendingPresentationId;
      if (!id) return;
      resultValue(await f.runtime.startPresentation(f.callId, id, f.sessionId, f.sessionConfig.clock()));
      resultValue(await f.runtime.resolvePresentation(f.callId, id, "played", f.sessionId, f.sessionConfig.clock()));
    };
    const verifyAndSelect = async (choice: 1 | 2 = 1) => {
      await until(() => f.mail.length > 0); const before = prompts.length, previousReadbacks = f.readbacks.length;
      assert.equal(w.flow.verificationRequired, true); assert.equal(w.flow.confirmationResendRef, undefined);
      for (const digit of f.mail.at(-1)!.code) assert.equal(await input.accept(digit), "pending");
      assert.equal(await input.accept("#"), "pending");
      await until(() => !w.flow.verificationRequired, `resend task ${f.mail.length} must accept its current verifier's private code`);
      await until(() => f.readbacks.length > previousReadbacks && f.readbacks.at(-1)!.includes("Choose the appointment"),
        "the current private appointment menu must play before a choice");
      await until(() => w.flow.resendMenuPlaybackCompleted(), "the current private appointment menu playback must finish before a choice");
      await input.accept(String(choice));
      await until(() => prompts.length > before && prompts.at(-1)!.includes("Press pound"));
      assert.equal(await input.accept("#"), "verified"); assert.equal(input.blocked(), false);
      assert.ok(w.flow.confirmationResendRef); return w.flow.confirmationResendRef;
    };
    const commit = async () => {
      assert.ok(w.flow.confirmationResendRef); const now = f.sessionConfig.clock();
      resultValue(await w.reception.proposeConfirmationResend(f.scope, w.turn(crypto.randomUUID(), "Send that email"), w.flow.confirmationResendRef, now));
      const action = Object.values((await f.state()).actions).at(-1)!;
      assert.equal(action.kind, "confirmationResend"); assert.equal(action.status, "awaitingConfirmation");
      assert.equal((await w.reception.affirm(f.scope, w.turn(crypto.randomUUID(), "Yes"), action.key, action.digest, now)).ok, false);
      await play(); resultValue(await w.reception.affirm(f.scope, w.turn(crypto.randomUUID(), "Yes"), action.key, action.digest, now));
      await new EffectWorker(f.runtime, w.flow).process(f.callId, `${action.key}:write`, now); await play();
      return (await f.state()).actions[action.key]!;
    };
    const next = async () => {
      const count = f.mail.length;
      const turn = w.turn(crypto.randomUUID(), "Please send the confirmation email for another appointment.");
      const selected = resultValue(await intent(turn));
      if (selected.kind !== "workflow" || selected.operation !== "confirmationResend") return false;
      const result = await w.reception.startWorkflow(f.scope, turn, selected.operation, f.sessionConfig.clock());
      await play();
      // A handled unavailable-action reply is also Result.ok. Only a fresh
      // verifier and its new challenge establish actual task advancement.
      if (!result.ok || !w.flow.verificationRequired) return false;
      await until(() => f.mail.length === count + 1); return true;
    };
    return { ...f, ...w, input, prompts, sequence, intent, verifyAndSelect, commit, next,
      closeTasks: async () => { input.stop(); lifetime.abort(); w.flow.dispose(); await f.close(); } };
  } catch (error) { closeFlow?.(); await f.close(); throw error; }
}
