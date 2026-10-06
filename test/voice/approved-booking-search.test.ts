import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { bookingCatalogueFixture } from "../support/cliniko-booking-catalogue.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";

const anyone = "Anyone is fine. What is the soonest opening?";
const preferred = "I would rather see Demo B, even if I have to wait.";

test("E2E-313 signed approved practitioner searches preserve preferences, declare earliest bounds and confirm the exact writer/location", { timeout: 180_000 }, async () => {
  await withDisposablePostgres(async db => {
    const scenarios = ["earliest", "preferred", "primary", "empty", "server", "changedName", "duringRead", "beforeConfirm", "afterReview",
      "correction", "laterCorrection", "retainDate", "retainWindow", "unplayed", "unknown", "location", "tie", "proofRevoked", "lost", "retainLocation"] as const;
    const run = async (scenario: typeof scenarios[number]) => {
      const f = await bookingCatalogueFixture(); f.flow.dispose();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      const modelTurns: string[] = [];
      try {
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model",
          clinicDate: () => "2026-10-04", fetch: async (_value, init) => {
            const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText; modelTurns.push(text);
            const start = text === "I need to book an appointment.", menu = text === "What times are available on October 8?";
            const decision = { kind: start ? "workflow" : menu ? "menu" : "choice", operation: start ? "book" : null, stage: null,
              from: menu ? "2026-10-08" : null, to: menu ? "2026-10-08" : null, choice: start || menu ? null : 1 };
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
          } }), { lostWrite: scenario === "lost" });
        await call.turn("I need to book an appointment."); await call.mark();
        await voiceUntil(() => f.mail.length === 1, "approved catalogue verification"); await call.verify(f.mail[0]!.code);
        if (["correction", "retainWindow"].includes(scenario)) {
          await call.turn("What times are available on October 8?"); await call.mark();
          if (scenario === "correction") { await call.turn("The first time, please."); await call.mark(); }
          else { await call.turn("That day is fine, but I can only come after four."); await call.mark(); }
        }
        const old = Object.values((await call.state()).actions).at(-1);
        if (scenario === "empty") f.setAlternateStarts([]);
        if (scenario === "server" || scenario === "changedName") f.setAlternateFailure(scenario);
        if (scenario === "duringRead") f.setOnAlternateTimes(async () => { await f.replaceCatalogue({ enabled: false }); });
        if (scenario === "tie") f.setAlternateStarts(["2026-10-08T04:00:00.000Z"]);
        if (scenario === "laterCorrection") f.setAlternateStarts(["2026-10-06T23:00:00.000Z", "2026-10-07T05:30:00.000Z"]);
        const request = scenario === "unknown" ? "I prefer Demo C." : scenario === "location" ? "I need the other branch, Demo South."
          : scenario === "primary" ? "I prefer Demo A." : ["earliest", "server", "duringRead", "tie"].includes(scenario) ? anyone : preferred;
        await call.turn(request); assert.equal(call.writes.length, 0); assert.ok(!modelTurns.includes(request));
        if (old) assert.equal((await call.state()).actions[old.key]?.status, "canceled");
        if (["empty", "server", "changedName", "duringRead", "unknown", "location"].includes(scenario)) {
          assert.doesNotMatch(call.spoken.at(-1)!, /option one/);
          if (scenario === "empty") assert.match(call.spoken.at(-1)!, /Demo B.*couldn't find/s);
          if (scenario === "unknown" || scenario === "location") assert.match(call.spoken.at(-1)!, /supports appointments at Demo North.*can’t use/s);
          await call.mark(); await call.turn("Yes"); assert.equal(call.writes.length, 0); return;
        }
        assert.match(call.spoken.at(-1)!, /Demo North.*Sunday 4 October.*Saturday 10 October/s);
        const primary = scenario === "primary" || scenario === "tie";
        if (["earliest", "tie"].includes(scenario)) assert.match(call.spoken.at(-1)!, /Demo A and Demo B.*earliest eligible start.*option one/s);
        if (!primary) assert.match(call.spoken.at(-1)!, /with Demo B/);
        if (scenario === "retainWindow") assert.match(call.spoken.at(-1)!, /after 4:00 pm.*4:30 pm/s);
        if (scenario === "unplayed") {
          await call.turn("The first time, please.", { interrupt: true }); assert.equal(call.writes.length, 0);
          assert.ok(Object.values((await call.state()).actions).every(action => action.status === "canceled")); return;
        }
        await call.mark();
        if (scenario === "retainDate") {
          await call.turn("What times are available on October 8?"); assert.match(call.spoken.at(-1)!, /with Demo B/);
          assert.doesNotMatch(call.spoken.at(-1)!, /with Demo A/); await call.mark();
        }
        if (scenario === "retainLocation") {
          await call.turn("I need the other branch, Demo North."); assert.match(call.spoken.at(-1)!, /with Demo B at Demo North/); await call.mark();
        }
        if (scenario === "proofRevoked") f.setPermitted(false);
        await call.turn("The first time, please.");
        if (scenario === "proofRevoked") { assert.equal(call.writes.length, 0); assert.ok(!Object.values((await call.state()).actions).length); return; }
        let action = Object.values((await call.state()).actions).at(-1)!; assert.equal(action.status, "awaitingConfirmation");
        assert.match(call.spoken.at(-1)!, primary ? /Demo A at Demo North/ : /Demo B at Demo North/); await call.mark();
        if (scenario === "laterCorrection") {
          await call.turn("Wait, the later one would be better.");
          assert.equal((await call.state()).actions[action.key]?.status, "canceled");
          action = Object.values((await call.state()).actions).at(-1)!;
          assert.match(call.spoken.at(-1)!, /Demo B at Demo North.*4:30 pm/s); await call.mark();
        }
        if (scenario === "beforeConfirm") await f.revokeAlternate();
        if (scenario === "afterReview") f.setOnRecall(async () => { await f.replaceCatalogue({ enabled: false }); });
        await call.turn("Yes");
        const blocked = scenario === "beforeConfirm" || scenario === "afterReview";
        assert.equal(call.writes.length, blocked ? 0 : 1);
        assert.equal((await call.state()).actions[action.key]?.status, blocked ? "rejected" : scenario === "lost" ? "uncertain" : "committed");
        if (!blocked) {
          await call.mark(); await call.turn("Yes"); assert.equal(call.writes.length, 1);
        }
      } finally { await call?.close(); await f.close(); }
    };
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => { for (;;) { const i = next++; if (i >= scenarios.length) return; await run(scenarios[i]!); } }));
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, i) => ({ label: `catalogue_${i}`, value })))), []);
  });
});

test("E2E-313 agent searches use approved public names and never use a model/provider ID to route a write", async () => {
  const f = await bookingCatalogueFixture();
  try {
    resultValue(await f.reception.startWorkflow(f.scope, f.turn("begin", "I need to book"), "book", verificationNow));
    f.flow.beginVerification(); await voiceUntil(() => f.mail.length === 1, "agent catalogue verification");
    assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, true); await f.playPending();
    const agent = new CommandGateway({ actorRef: "search-agent", role: "agent", scope: f.scope }, f.policies, f.reception);
    const read = { kind: "booking.offers.read.v1" as const, turn: f.turn("read", "Anyone is fine"), from: "2026-10-04", to: "2026-10-10",
      preference: { practitioner: "any" }, now: verificationNow };
    const reply = resultValue(await agent.submit(read)); assert.equal(reply.kind, "bookingProposal");
    const state = await f.state(), notice = state.presentations[state.pendingPresentationId!]; assert.ok(notice && "approvedText" in notice);
    assert.match(notice.approvedText, /Demo A and Demo B.*earliest eligible start.*with Demo B/s); await f.playPending();
    resultValue(await agent.submit({ kind: "booking.offers.select.v1", turn: f.turn("select", "Option one"), choice: 1, now: verificationNow }));
    const action = Object.values((await f.state()).actions).at(-1)!; assert.equal(action.status, "awaitingConfirmation");
    assert.equal(action.mutation.request.kind, "book");
    if (action.mutation.request.kind === "book") assert.equal(action.mutation.request.offer.presentation?.practitionerName, "Demo B");
    assert.ok(!JSON.stringify(reply).includes("practitionerId")); assert.ok(verificationCanaries.every(canary => !JSON.stringify(reply).includes(canary)));
    const forged = { ...read, turn: f.turn("forged", "23"), preference: { practitioner: "Demo B", practitionerId: "23" } };
    assert.equal((await agent.submit(forged)).ok, false);
    assert.equal(f.posts, 0);
  } finally { await f.close(); }
});
