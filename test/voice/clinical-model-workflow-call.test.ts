import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import type { ClinikoWorkflow } from "../../src/standalone/cliniko-call-flow.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { bookingCallFlowFixture, cancellationCallFlowFixture, reschedulingCallFlowFixture, intakeCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { intakeDraft } from "../support/intake-edge.ts";

type Decision = { kind: string; operation: ClinikoWorkflow | null; stage: "targets" | "offers" | null;
  from: string | null; to: string | null; choice: 1 | 2 | 3 | null };
const decide = (kind: Decision["kind"], changes: Partial<Decision> = {}): Decision =>
  ({ kind, operation: null, stage: null, from: null, to: null, choice: null, ...changes });

function modelFor(operation: Exclude<ClinikoWorkflow, "appointments.read">, seen: Record<string, unknown>[], observed: Record<string, unknown>[], live: boolean) {
  const start = { book: "I need to book an appointment.", cancel: "I need to cancel an appointment.",
    reschedule: "I need to move an appointment.", intake: "I'm new to this clinic and want to register." }[operation];
  const answers: Record<string, Decision> = {
    [start]: decide("workflow", { operation }),
    "What times are available on October 8?": decide("menu", { from: "2026-10-08", to: "2026-10-08" }),
    "The second time, please.": decide("choice", { choice: 2 }),
    "Show me my appointments from October 4 through October 9.": decide("appointments", { from: "2026-10-04", to: "2026-10-09" }),
    "Cancel that appointment.": decide("cancel"),
    "Show my existing appointments from October 4 through October 9.": decide("menu", { stage: "targets", from: "2026-10-04", to: "2026-10-09" }),
    "My first existing appointment.": decide("choice", { stage: "targets", choice: 1 }),
    "Show move times on October 8.": decide("menu", { stage: "offers", from: "2026-10-08", to: "2026-10-08" }),
    "Move it to option two.": decide("choice", { stage: "offers", choice: 2 }),
    "Please save my registration details.": decide("save"),
    "Did that work?": decide("outcome"),
  };
  const fetchPort = (async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false); assert.equal(body.tool_choice, "none");
    assert.equal(body.text.format.strict, true); assert.equal(body.text.format.name, "abby_clinical_intent_v1");
    const input = JSON.parse(body.input[1].content);
    assert.deepEqual(Object.keys(input).sort(), ["callerText", "lastAction", "lastMenu", "phase", "workflow"]);
    assert.equal(typeof input.callerText, "string");
    const request = String(init?.body);
    for (const secret of [intakeDraft.firstName, intakeDraft.lastName, intakeDraft.email,
      ...verificationCanaries, "synthetic-clinical-model-key"]) assert.equal(request.includes(secret), false);
    const decision = answers[input.callerText]; assert.ok(decision, "the public turn has a pinned structured model decision");
    seen.push(input);
    if (live) {
      const response = await fetch(url, init);
      const raw = await response.clone().json().catch(() => undefined);
      let parsed: Record<string, unknown> | undefined;
      try { parsed = JSON.parse(raw?.output?.find((item: { type: string }) => item.type === "message")?.content?.[0]?.text); } catch { /* malformed responses remain visible as status only */ }
      observed.push(parsed && typeof parsed.kind === "string" ? { kind: parsed.kind, operation: parsed.operation, stage: parsed.stage,
        from: parsed.from, to: parsed.to, choice: parsed.choice } : { kind: "unavailable", status: raw?.status ?? response.status });
      return response;
    }
    observed.push(decision);
    return Response.json({ status: "completed", output: [{ type: "message", status: "completed",
      content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
  }) as typeof fetch;
  return { start, fetchPort };
}

test("E2E-303 structured model decisions select four signed clinical workflows and SAM explains confirmed or uncertain outcomes", { timeout: 150_000 }, async t => {
  await withDisposablePostgres(async db => {
    const live = process.env.ABBY_CLINICAL_LIVE_EVAL === "1";
    if (live) assert.ok(process.env.ABBY_OPENAI_API_KEY && process.env.ABBY_CLINICAL_INTENT_MODEL, "live evaluation requires explicit model and owner-only key");
    const cases = (["book", "cancel", "reschedule", "intake"] as const).map(operation => ({ operation, lost: false }))
      .concat([{ operation: "book", lost: true }, { operation: "intake", lost: true }]);
    const selected = process.env.ABBY_CLINICAL_CASE ? cases.filter(item => `${item.operation}:${item.lost}` === process.env.ABBY_CLINICAL_CASE) : cases;
    await Promise.all(selected.map(({ operation, lost }) => t.test(`${operation}: ${lost ? "lost response" : "confirmed"}`, { concurrency: true }, async () => {
      const f = operation === "book" ? await bookingCallFlowFixture() : operation === "cancel" ? await cancellationCallFlowFixture()
        : operation === "reschedule" ? await reschedulingCallFlowFixture() : await intakeCallFlowFixture();
      f.flow.dispose();
      const seen: Record<string, unknown>[] = [], observed: Record<string, unknown>[] = [], model = modelFor(operation, seen, observed, live);
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      try {
        if (operation === "intake" && lost && "fail" in f.provider) f.provider.fail("intakeLoss");
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({
          owner, apiKey: live ? process.env.ABBY_OPENAI_API_KEY! : "synthetic-clinical-model-key",
          model: live ? process.env.ABBY_CLINICAL_INTENT_MODEL! : "configured-synthetic-model", clinicDate: () => "2026-10-04", fetch: model.fetchPort,
        }), operation !== "intake" ? { lostWrite: lost } : {});
        await call.turn(model.start); await call.mark();
        if (operation === "intake") {
          await call.privateDigit("1"); await call.mark();
          await voiceUntil(() => call!.spoken.at(-1)!.includes("Press one to acknowledge"), "separate loss acknowledgment");
          await call.mark(); await call.privateDigit("1"); await call.mark();
          for (const value of [intakeDraft.firstName, intakeDraft.lastName, "21 June 1987", "private-intake-canary at example dot test"]) {
            await call.privateField(value); await call.mark();
          }
          await voiceUntil(() => f.mail.length === 1 && call!.spoken.at(-1)!.includes("six digits on the keypad"), "private code prompt");
          await call.mark(); await call.verify(f.mail[0]!.code);
          await call.turn("Please save my registration details."); await call.mark(); await call.turn("Yes");
          assert.ok("patientPosts" in f.provider); assert.equal(f.provider.patientPosts, 1); assert.equal(call.writes.length, 0);
          if (!lost) { await call.mark(); await call.turn("What times are available on October 8?"); await call.mark();
            await call.turn("The second time, please."); await call.mark(); await call.turn("Yes"); }
        } else {
          await voiceUntil(() => f.mail.length === 1, "verification mail"); await call.verify(f.mail[0]!.code);
          if (operation === "book") { await call.turn("What times are available on October 8?"); await call.mark(); await call.turn("The second time, please."); }
          if (operation === "cancel") { await call.turn("Show me my appointments from October 4 through October 9."); await call.mark(); await call.turn("Cancel that appointment."); }
          if (operation === "reschedule") {
            await call.turn("Show my existing appointments from October 4 through October 9."); await call.mark(); await call.turn("My first existing appointment."); await call.mark();
            await call.turn("Show move times on October 8."); await call.mark(); await call.turn("Move it to option two.");
          }
          assert.equal(call.writes.length, 0); await call.mark(); await call.turn("Yes");
          assert.equal(call.writes.length, 1, JSON.stringify({ decisions: observed, actions: Object.values((await call.state()).actions).map(action => action.status),
            latestSpeech: call.spoken.at(-1), modelTurns: call.modelTurns.length }));
        }
        const action = Object.values((await call.state()).actions).at(-1)!;
        assert.equal(action.status, lost ? "uncertain" : "committed");
        const firstNotice = call.spoken.at(-1)!;
        await call.mark(); await call.turn("Did that work?");
        const answer = call.spoken.at(-1)!;
        assert.equal(answer, firstNotice, `SAM must repeat the actual result: ${JSON.stringify({ decisions: observed,
          status: Object.values((await call.state()).actions).at(-1)?.status })}`);
        assert.match(answer, lost ? /can't confirm/ : /confirmed|details were saved/);
        if (operation === "intake" && lost) assert.match(answer, /Contact the clinic/);
        if (lost) {
          await call.mark(); await call.turn("Yes");
          assert.equal(call.spoken.at(-1), firstNotice, "model affirmation after uncertainty must restate the actual unresolved outcome");
        }
        assert.equal(call.writes.length, operation === "intake" && lost ? 0 : 1);
        assert.ok(seen.length >= (operation === "book" || operation === "cancel" || operation === "intake" && lost ? 3 : 4)); assert.deepEqual(seen[0]!.workflow, null);
        const trustedChoices = ["The second time, please.", "My first existing appointment.", "Move it to option two.", "Cancel that appointment."];
        assert.deepEqual(call.modelTurns.filter(text => text !== "Yes" && !trustedChoices.includes(text)), seen.map(item => item.callerText));
        assert.ok(seen.every(item => !trustedChoices.includes(String(item.callerText))), "known menu selections must use trusted facts without model guesses");
      } finally { await call?.close(); await f.close(); }
    })));
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, [intakeDraft.firstName, intakeDraft.email]
      .map((value, index) => ({ label: `clinical_model_${index}`, value })))), []);
  });
});
