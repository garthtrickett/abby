import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { clinikoStaffCallFlowFixture } from "../support/cliniko-staff-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { verificationNow } from "../support/caller-verification.ts";

test("E2E-311 signed staff requests use independent verification, approved people and exact Cliniko receipts without duplicate or human-receipt claims", { timeout: 120_000 }, async () => {
  await withDisposablePostgres(async db => {
    const scenarios = ["saved", "named", "lost", "nonCommitted", "malformed", "unavailable", "unapproved", "disabled", "unlisted", "revoked", "lateRevoked", "changedApproval", "lateDisabled", "modelGuess", "repeated", "beforeCode", "clinicalGrant", "oldProposal", "committedClinical", "changedPerson", "lateArrival", "lateArrivalLost", "lateArrivalUnavailable"] as const;
    const run = async (scenario: typeof scenarios[number]) => {
      const f = await clinikoStaffCallFlowFixture({ lostResponse: scenario === "lost" || scenario === "lateArrivalLost", nonCommitted: scenario === "nonCommitted",
        malformed: scenario === "malformed", approved: scenario !== "unapproved" });
      f.flow.dispose();
      if (scenario === "disabled") await f.replaceStaffApproval({ enabled: false });
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      const modelInputs: string[] = [];
      try {
        const { staff, ...withoutStaff } = f.flowConfig;
        const config = scenario === "lateRevoked" ? { ...f.flowConfig, cliniko: { ...f.flowConfig.cliniko, rateBudget: {
          ...f.flowConfig.cliniko.rateBudget,
          claim: async () => {
            if (call && Object.values((await call.state()).effects).some(effect => effect.kind === "staffTask" && effect.status === "possiblySent")) f.denyStaffPermission();
            return f.flowConfig.cliniko.rateBudget.claim();
          },
        } } } : f.flowConfig;
        call = await clinikoWorkflowVoiceFixture(db, ["unavailable", "lateArrivalUnavailable"].includes(scenario) ? withoutStaff : config, owner =>
          createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-staff-key", model: "synthetic-staff-model", clinicDate: () => "2026-10-04",
            fetch: async (_value, init) => {
              modelInputs.push(String(init?.body));
              const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
              const start = text === "I need to book an appointment.", menu = text === "What times are available on October 8?";
              const body = JSON.stringify({ kind: start ? "workflow" : menu ? "menu" : text === "Please explain what you found." || text === "I am a few minutes behind schedule. Please let reception know." ? "staffRequest" : "staffOutcome", operation: start ? "book" : null,
                stage: null, from: menu ? "2026-10-08" : null, to: menu ? "2026-10-08" : null, choice: null });
              return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: body }] }] });
            } }));
        const priorClinical = ["clinicalGrant", "oldProposal", "committedClinical", "lateArrival", "lateArrivalLost", "lateArrivalUnavailable"].includes(scenario);
        if (priorClinical) {
          await call.turn("I need to book an appointment."); await call.mark();
          await voiceUntil(() => f.mail.length === 1, "original clinical verification email"); await call.verify(f.mail[0]!.code);
          if (["oldProposal", "committedClinical"].includes(scenario)) {
            await call.turn("What times are available on October 8?"); await call.mark();
            await call.turn("The first time, please."); await call.mark();
            assert.ok(Object.values((await call.state()).actions).some(action => action.status === "awaitingConfirmation"));
            if (scenario === "committedClinical") { await call.turn("Yes"); await call.mark(); }
          }
        }
        const prior = await call.state(), priorStaffPosts = f.staffPosts, priorWrites = call.writes.length;
        await call.turn(["named", "changedPerson"].includes(scenario) ? "Could I speak to Morgan?" : scenario === "unlisted" ? "Could I speak to SomeoneUnknown?"
          : scenario.startsWith("lateArrival") ? "I am a few minutes behind schedule. Please let reception know." : "Can I speak to a receptionist rather than arrange a booking with you?");
        await call.mark();
        assert.doesNotMatch(call.spoken.at(-1)!, /your staff request was saved|staff (?:have|has) (?:read|received)|staff will call|guarantee/i,
          "an initial human request is not a saved, received or promised callback");
        if (["unavailable", "unapproved", "disabled", "unlisted", "lateArrivalUnavailable"].includes(scenario)) {
          assert.match(call.spoken.at(-1)!, /can't send.*staff request.*contact the clinic/);
          assert.equal(f.mail.length, priorClinical ? 1 : 0); assert.equal(f.staffPosts, 0); assert.equal(Object.keys((await call.state()).staffItems).length, 0);
          assert.deepEqual((await call.state()).actions, prior.actions, "unavailable human contact cannot force a booking workflow");
          assert.equal(call.writes.length, priorWrites);
          return;
        }
        const expectedMail = priorClinical ? 2 : 1;
        await voiceUntil(() => f.mail.length === expectedMail, "independent staff verification email");
        assert.equal(f.staffPosts, priorStaffPosts, "request cannot be sent before private code verification");
        if (scenario === "oldProposal") assert.ok(Object.values((await call.state()).actions).every(action => action.status === "canceled"));
        else if (scenario === "committedClinical") assert.equal(Object.values((await call.state()).actions).at(-1)?.status, "committed");
        else assert.equal(Object.keys((await call.state()).actions).length, 0, "human request must not start a booking");
        if (scenario === "beforeCode") {
          await call.close(); call = undefined; assert.equal(f.staffPosts, 0); return;
        }
        await call.verify(f.mail.at(-1)!.code);
        assert.equal(call.flow.bookingMenuAvailable(), false, "staff verification must not reopen the prior clinical menu or proof");
        if (scenario === "revoked") f.denyStaffPermission();
        if (scenario === "changedApproval") await f.replaceStaffApproval({ reviewCadenceMinutes: 45 });
        if (scenario === "lateDisabled") await f.replaceStaffApproval({ enabled: false });
        await call.turn(scenario === "modelGuess" ? "Please explain what you found." : "Please send that request.");
        if (["revoked", "lateRevoked", "changedApproval", "lateDisabled", "modelGuess"].includes(scenario)) {
          assert.match(call.spoken.at(-1)!, /can't send.*staff request/); assert.equal(f.staffPosts, 0); return;
        }
        const state = await call.state(), item = Object.values(state.staffItems).at(-1)!;
        assert.ok(item); assert.equal(f.staffPosts, priorStaffPosts + 1); assert.equal(call.writes.length, priorWrites);
        if (scenario.startsWith("lateArrival")) {
          assert.deepEqual(state.actions, prior.actions, "a late-arrival message cannot cancel, move or book a visit");
          assert.equal(priorWrites, 0);
          assert.equal(f.mail.length, 2, "clinical verification is not permission for a staff request");
        }
        if (scenario === "committedClinical") assert.deepEqual((await call.state()).actions, prior.actions, "staff work retains the known clinical receipt");
        const uncertain = ["lost", "nonCommitted", "malformed", "lateArrivalLost"].includes(scenario);
        assert.equal(item.status, uncertain ? "needsReview" : "open");
        assert.match(call.spoken.at(-1)!, uncertain ? /can't confirm whether.*request.*saved or received.*won't send.*again/
          : /staff request.*was saved.*can't confirm.*read.*can't.*promise|staff request.*was saved.*can't confirm.*read.*promise/i);
        assert.equal(item.requestedPerson, ["named", "changedPerson"].includes(scenario) ? "Morgan" : undefined);
        assert.ok(f.permissions.length > 0); assert.ok(f.permissions.every(operation => operation === "staff.request"));
        if (scenario === "named") {
          assert.match(String(f.recalls[0]?.notes), /Morgan/); assert.match(call.spoken.at(-1)!, /speak to Morgan/);
        }
        await call.mark();
        await call.turn(scenario === "changedPerson" ? "Could I speak to SomeoneUnknown?" : scenario === "repeated" ? "Please ask the team to call me about this." : "Has somebody received my message?");
        if (scenario === "changedPerson") assert.match(call.spoken.at(-1)!, /can't send.*staff request/);
        assert.equal(f.staffPosts, priorStaffPosts + 1, "outcome queries and repeated requests never send another recall");
        if (scenario.startsWith("lateArrival")) {
          assert.deepEqual((await call.state()).actions, prior.actions);
          assert.equal(call.writes.length, 0);
          assert.doesNotMatch(call.spoken.at(-1)!, /(?:staff|reception) (?:have|has|were|was) (?:told|notified)/i);
        }
        if (scenario === "committedClinical") {
          await call.mark(); await call.turn("Did that work?");
          assert.match(call.spoken.at(-1)!, /staff request.*was saved/);
          assert.equal(call.writes.length, 1); assert.deepEqual((await call.state()).actions, prior.actions);
        }
        assert.ok(!call.spoken.some(text => /(?:^|[.!?] )(?:the )?staff (?:have|has) (?:received|read)|staff will call|guarantee/i.test(text)), "provider storage is not human receipt");
        assert.ok(modelInputs.every(input => verificationCanaries.every(canary => !input.includes(canary))));
        assert.ok(call.transcripts.every(text => !text.includes(f.mail[0]!.code)));
      } catch (error) { throw new Error(`${scenario}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      finally { await call?.close(); await f.close(); }
    };
    let next = 0;
    const settled = await Promise.allSettled(Array.from({ length: 4 }, async () => { for (;;) { const index = next++; if (index >= scenarios.length) return; await run(scenarios[index]!); } }));
    for (const result of settled) if (result.status === "rejected") throw result.reason;
    const f = await clinikoStaffCallFlowFixture(); f.flow.dispose();
    const flow = resultValue(ClinikoCallFlow.create(f.flowConfig));
    try {
      const reception = new TextReception(f.ledger, f.policies, flow, undefined, undefined, undefined, undefined, f.flowConfig.clock);
      const agent = new CommandGateway({ actorRef: "staff-agent", role: "agent", scope: f.scope }, f.policies, reception);
      const turn = (turnId: string, text: string) => ({ callId: f.callId, sessionId: f.sessionId, turnId, text, quality: "clear" as const, at: verificationNow });
      assert.ok(agent.listPermitted().some(cap => cap.id === "staff.requests.prepare.v1"));
      resultValue(await agent.submit({ kind: "staff.requests.prepare.v1", turn: turn("ask", "Could I speak to Morgan?"), requestedPerson: "Morgan", now: verificationNow }));
      await voiceUntil(() => f.mail.length === 1, "agent staff verification mail"); assert.equal(f.staffPosts, 0);
      assert.equal((await flow.submitCode(f.mail[0]!.code)).verified, true);
      const send = { kind: "staff.requests.prepare.v1" as const, turn: turn("send", "Please send that request."), now: verificationNow };
      resultValue(await agent.submit(send)); resultValue(await reception.drain(f.scope, f.callId, verificationNow));
      resultValue(await agent.submit(send)); assert.equal(f.staffPosts, 1);
      const query = resultValue(await agent.submit({ kind: "staff.requests.outcome.v1", turn: turn("status", "Was my staff request saved?"), now: verificationNow }));
      assert.equal(query.kind, "staffRequestProgress");
      if (query.kind === "staffRequestProgress") assert.equal(query.progress.staffItems.at(-1)?.status, "open");
      assert.ok(verificationCanaries.every(canary => !JSON.stringify(query).includes(canary)));
      assert.ok(!JSON.stringify(query).includes("Morgan"), "agent progress must not expose private request detail");
    } finally { flow.dispose(); await f.close(); }
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, [...verificationCanaries, "Morgan", "abby.staff-request.v1"].map((value, index) => ({ label: `staff_${index}`, value })))), []);
  });
});


test("E2E-311 a signed staff preparation can settle within its actual deadline after the fixture's old generic speech wait", { timeout: 90_000 }, async () => {
  await withDisposablePostgres(async db => {
    const f = await clinikoStaffCallFlowFixture(); f.flow.dispose();
    let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
    let armed = false, held = false, release = () => {};
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const permission = f.flowConfig.staff.permission;
    try {
      call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, timeoutMs: 15_000, staff: { ...f.flowConfig.staff, permission: {
        allows: async (...args: Parameters<typeof permission.allows>) => {
          if (armed) { armed = false; held = true; await waiting; }
          return permission.allows(...args);
        },
      } } }, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04",
        fetch: async () => { throw new Error("bounded staff wording must not require a model request"); } }));
      await call.turn("Could I speak to a receptionist?"); await call.mark();
      await voiceUntil(() => f.mail.length === 1, "independent staff email"); await call.verify(f.mail[0]!.code);
      armed = true;
      const pending = call.turn("Please send that request.").then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
      await voiceUntil(() => held, "actual staff permission preparation");
      assert.equal(f.staffPosts, 0); assert.equal(call.writes.length, 0);
      // The production inner preparation allows 15 seconds, its outer boundary
      // 20 seconds. Release at 11 seconds to expose the old 10-second observer.
      await new Promise<void>(resolve => setTimeout(resolve, 11_000)); release();
      const settled = await pending;
      assert.ok(settled.ok, settled.ok ? undefined : String(settled.error));
      await call.mark();
      assert.equal(f.staffPosts, 1); assert.equal(call.writes.length, 0);
      assert.match(call.spoken.at(-1)!, /staff request.*was saved.*can't confirm.*read/);
      assert.equal(Object.values((await call.state()).staffItems).at(-1)?.status, "open");
      assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, i) => ({ label: `bounded_staff_${i}`, value })))), []);
    } finally { release(); await call?.close(); await f.close(); }
  });
});
