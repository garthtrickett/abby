import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { pendingClinikoLookupFixture } from "../support/pending-cliniko-lookup.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { conversationPresenceText } from "../../src/core/conversation-presence.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("E2E-324 a presence check repairs a signed call before a held Cliniko lookup can return", { timeout: 60_000 }, async () => {
  await withDisposablePostgres(async db => {
    const f = await pendingClinikoLookupFixture(); f.flow.dispose();
    let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
    const pending: Promise<void>[] = [];
    try {
      call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner,
        apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_url, init) => {
          const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
          const book = text === "I need to book an appointment.", menu = text === "What times are available on October 8?";
          const decision = { kind: book ? "workflow" : menu ? "menu" : "unsupported", operation: book ? "book" : null,
            stage: null, from: menu ? "2026-10-08" : null, to: menu ? "2026-10-08" : null, choice: null };
          return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
        } }));
      await call.turn("I need to book an appointment."); await call.mark();
      await voiceUntil(() => f.mail.length === 1, "verification email"); await call.verify(f.mail[0]!.code);
      f.arm(); pending.push(call.turn("What times are available on October 8?")); await f.started;
      const speech = call.spoken.length;
      pending.push(call.turn("Are you still there?"));
      await voiceUntil(() => call!.transcripts.includes("Are you still there?") && call!.spoken.at(-1) === conversationPresenceText, "new caller turn before held provider release", 1_000);
      assert.equal(f.held, true); assert.equal(f.canceled, true);
      assert.ok(call.spoken.length > speech); assert.match(call.spoken.at(-1)!, /I'm here/);
      assert.equal(call.writes.length, 0);
      const state = await call.state(); assert.equal(Object.keys(state.actions).length, 0); assert.equal(Object.keys(state.staffItems).length, 0);
      f.release(); await Promise.all(pending); await call.mark();
      assert.equal(call.spoken.length, speech + 1); assert.equal(call.spoken.at(-1), conversationPresenceText);
      assert.equal((await call.flow.publicIntentContext())?.lastMenu, null);
    } finally { f.release(); await Promise.allSettled(pending); await call?.close(); await f.close(); }
  });
});

test("E2E-324 parallel pending menus and selections fence new speech, late responses, fresh searches, noise and disconnects", { timeout: 180_000 }, async () => {
  await withDisposablePostgres(async db => {
    type Stage = "book" | "moveOffers" | "moveTargets" | "bookChoice" | "moveChoice" | "moveTargetChoice";
    const cases: { stage: Stage; mode: string }[] = ["book", "moveOffers"].flatMap(stage =>
      ["presence", "wait", "weekday", "fresh", "disconnect", "noise"].map(mode => ({ stage: stage as Stage, mode })));
    cases.push(...["presence", "wait", "fresh", "disconnect"].map(mode => ({ stage: "moveTargets" as const, mode })),
      ...["bookChoice", "moveChoice"].flatMap(stage => ["presence", "wait", "disconnect"].map(mode => ({ stage: stage as Stage, mode }))),
      { stage: "moveTargetChoice", mode: "presence" });
    const run = async ({ stage, mode }: typeof cases[number]) => {
      const move = stage.startsWith("move"), choosing = stage.endsWith("Choice");
      const f = await pendingClinikoLookupFixture({ workflow: move ? "reschedule" : "book",
        hold: stage === "moveTargets" ? "appointmentList" : move && choosing ? "appointmentTarget" : "availableTimes" });
      f.flow.dispose(); f.setStarts(["2026-10-06T22:00:00.000Z", "2026-10-07T22:00:00.000Z", "2026-10-08T23:00:00.000Z"]);
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      const pending: Promise<unknown>[] = [], bodies: string[] = [];
      const track = (work: Promise<void>) => { pending.push(work.then(() => undefined, error => error)); };
      try {
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner,
          apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_url, init) => {
            bodies.push(String(init?.body)); const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
            const start = text === "I need to book an appointment." || text === "I need to move an appointment.";
            const targets = text === "Show my existing appointments from October 4 through October 9.";
            const menu = text === "What times are available on October 8?" || text === "Show move times on October 8." ||
              text === "What times are available on October 9?" || text === "Show move times on October 9.";
            const day = text.includes("October 9?") || text === "Show move times on October 9." ? "2026-10-09" : "2026-10-08";
            const decision = { kind: start ? "workflow" : targets || menu ? "menu" : "unsupported", operation: start ? move ? "reschedule" : "book" : null,
              stage: targets ? "targets" : menu && move ? "offers" : null, from: targets ? "2026-10-04" : menu ? day : null,
              to: targets ? "2026-10-09" : menu ? day : null, choice: null };
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
          } }));
        const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
        const targets = "Show my existing appointments from October 4 through October 9.", offers = move ? "Show move times on October 8." : "What times are available on October 8?";
        await play(move ? "I need to move an appointment." : "I need to book an appointment.");
        await voiceUntil(() => f.mail.length === 1, "independent clinical verification"); await call.verify(f.mail[0]!.code);
        if (move && stage !== "moveTargets") { await play(targets); if (stage !== "moveTargetChoice") await play("My first existing appointment."); }
        if (choosing && stage !== "moveTargetChoice") await play(offers);
        const state = await call.state(), speech = call.spoken.length;
        f.arm(); track(call.turn(stage === "moveTargets" ? targets : stage === "moveTargetChoice" ? "My first existing appointment." : choosing ? move ? "Move it to option one." : "The first time, please." : offers));
        await voiceUntil(() => f.held, "held actual menu/selection provider read");
        if (mode === "disconnect") {
          const close = call.close(); await voiceUntil(() => f.canceled, "disconnect cancels held read"); f.release(); await close; call = undefined; return;
        }
        if (mode === "noise") {
          call.media(true); call.media(false); f.release(); await Promise.all(pending); await call.mark();
          assert.match(call.spoken.at(-1)!, /Thursday 8 October/); assert.equal(Object.keys((await call.state()).actions).length, 0); return;
        }
        await play(mode === "weekday" ? "Actually, Wednesday." : mode === "wait" ? "No, wait." : "Are you still there?");
        assert.equal(f.held, true); assert.equal(f.canceled, true); assert.equal(call.writes.length, 0);
        if (mode === "weekday") assert.match(call.spoken.at(-1)!, /Wednesday 7 October/);
        else if (mode !== "wait") assert.equal(call.spoken.at(-1), conversationPresenceText);
        if (mode === "fresh") await play(stage === "moveTargets" ? targets : move ? "Show move times on October 9." : "What times are available on October 9?");
        const repaired = await call.state(), menu = (await call.flow.publicIntentContext())?.lastMenu, spoken = [...call.spoken];
        assert.equal(Object.keys(repaired.actions).length, 0); assert.deepEqual(repaired.staffItems, state.staffItems);
        if (mode !== "fresh" || stage !== "moveTargets") assert.ok(!call.spoken.slice(speech).some(text => /Thursday 8 October/.test(text)), "old lookup must never be spoken");
        f.release(); await Promise.all(pending);
        assert.deepEqual(call.spoken, spoken); assert.deepEqual((await call.flow.publicIntentContext())?.lastMenu, menu);
        assert.ok(!bodies.some(body => verificationCanaries.some(canary => body.includes(canary))));
        assert.ok(!call.transcripts.includes(f.mail[0]!.code));
      } catch (error) { throw new Error(`${stage}/${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      finally { f.release(); await Promise.allSettled(pending); await call?.close(); await f.close(); }
    };
    let next = 0; const failures: unknown[] = [];
    const settled = await Promise.allSettled(Array.from({ length: 4 }, async () => { for (;;) { const item = cases[next++]; if (!item) return;
      try { await run(item); } catch (error) { failures.push(error); }
    } }));
    for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, i) => ({ label: `lookup_${i}`, value })))), []);
  });
});
