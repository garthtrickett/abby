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
        assert.equal(action.mutation.request.kind, "book");
        if (action.mutation.request.kind !== "book") throw new Error("expected scoped booking proposal");
        assert.deepEqual(action.mutation.request.offer.scope, f.scope);
        assert.equal(action.mutation.request.offer.presentation?.locationName, "Demo North");
        if (scenario === "earliest") assert.equal(action.mutation.request.offer.startsAt, "2026-10-06T23:00:00.000Z",
          "any-practitioner selection must choose the actual earliest eligible start, not merely name Demo B");
        if (scenario === "tie") assert.equal(action.mutation.request.offer.startsAt, "2026-10-08T04:00:00.000Z");
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
          assert.equal(call.writeRequests.length, 1);
          const sent = call.writeRequests[0]!;
          assert.equal(sent.method, "POST"); assert.equal(sent.path, "/v1/individual_appointments");
          assert.equal(sent.body.business_id, "11"); assert.equal(sent.body.practitioner_id, primary ? "22" : "23");
          assert.equal(sent.body.appointment_type_id, "33"); assert.equal(sent.body.patient_id, verificationCanaries[2]);
          const finalRequest = (await call.state()).actions[action.key]!.mutation.request;
          if (finalRequest.kind !== "book") throw new Error("expected preserved booking request");
          assert.equal(sent.body.starts_at, finalRequest.offer.startsAt);
          await call.mark(); await call.turn("Yes"); assert.equal(call.writes.length, 1);
        }
      } finally { await call?.close(); await f.close(); }
    };
    let next = 0;
    const workers = await Promise.allSettled(Array.from({ length: 4 }, async () => { for (;;) { const i = next++; if (i >= scenarios.length) return; await run(scenarios[i]!); } }));
    const failures = workers.flatMap(worker => worker.status === "rejected" ? [worker.reason] : []);
    if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
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
    if (action.mutation.request.kind === "book") {
      assert.equal(action.mutation.request.offer.presentation?.practitionerName, "Demo B");
      assert.equal(action.mutation.request.offer.startsAt, "2026-10-06T23:00:00.000Z");
    }
    assert.ok(!JSON.stringify(reply).includes("practitionerId")); assert.ok(verificationCanaries.every(canary => !JSON.stringify(reply).includes(canary)));
    const forged = { ...read, turn: f.turn("forged", "23"), preference: { practitioner: "Demo B", practitionerId: "23" } };
    assert.equal((await agent.submit(forged)).ok, false);
    assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

for (const stage of ["read", "selection evidence"] as const) test(`E2E-313 a signed menu ${stage} settles within the core deadline after the fixture's old dispatch wait`, { timeout: 90_000 }, async () => {
  await withDisposablePostgres(async db => {
    const f = await bookingCatalogueFixture(); f.flow.dispose();
    let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
    let held = false, armed = true, release = () => {};
    const waiting = new Promise<void>(resolve => { release = resolve; });
    try {
      f.setOnAlternateTimes(async () => {
        if (stage === "read" && armed) { armed = false; held = true; await waiting; }
      });
      call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner,
        apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async () =>
          Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text",
            text: JSON.stringify({ kind: "workflow", operation: "book", stage: null, from: null, to: null, choice: null }) }] }] }) }));
      await call.turn("I need to book an appointment."); await call.mark();
      await voiceUntil(() => f.mail.length === 1, "bounded menu verification"); await call.verify(f.mail[0]!.code);
      if (stage === "selection evidence") {
        await call.turn(preferred); await call.mark();
        const resolveBooking = call.flow.resolveBooking.bind(call.flow);
        call.flow.resolveBooking = async (...args: Parameters<typeof resolveBooking>) => {
          held = true; await waiting; return resolveBooking(...args);
        };
      }
      const pending = call.turn(stage === "read" ? preferred : "The first time, please.")
        .then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
      await voiceUntil(() => held, "held approved availability read");
      assert.equal(call.writeRequests.length, 0);
      // Release after the old 10-second observer, within the unchanged
      // production 15-second menu deadline. No appointment write is sent.
      await new Promise<void>(resolve => setTimeout(resolve, 11_000)); release();
      const settled = await pending;
      assert.ok(settled.ok, settled.ok ? undefined : String(settled.error));
      await call.mark();
      assert.match(call.spoken.at(-1)!, /Demo B/);
      assert.match(call.spoken.at(-1)!, stage === "read" ? /option one/ : /confirm/i);
      assert.equal(call.writeRequests.length, 0);
      const actions = Object.values((await call.state()).actions);
      assert.equal(actions.length, stage === "read" ? 0 : 1);
      if (stage === "selection evidence") assert.equal(actions[0]!.status, "awaitingConfirmation");
      assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, i) => ({ label: `bounded_menu_${i}`, value })))), []);
    } finally { release(); await call?.close(); await f.close(); }
  });
});
