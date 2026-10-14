import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { classMoveCallFlowFixture } from "../support/class-move-call-flow.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";

for (const multiple of [false, true])
  test(`E2E-399 ordinary ${multiple ? "catalogue" : "single service"} class move routing reaches only admitted native class work`, async () => {
    const f = await classMoveCallFlowFixture(false, multiple);
    try {
      const resolver = createOpenAIClinicalIntentResolver({ owner: f.flow, apiKey: "synthetic", model: "synthetic", clinicDate: () => "2026-10-04",
        fetch: async () => { throw new Error("explicit class movement uses finite routing"); } });
      const turn = f.turn("move", "Move my Pilates class"), intent = resultValue(await resolver(turn));
      assert.equal(intent.kind, "workflow"); if (intent.kind !== "workflow") throw new Error("missing class move");
      assert.equal(intent.operation, "reschedule"); assert.equal(intent.classAttendance, true);
      const result = await f.flow.startWorkflow({ scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.flowConfig.policyVersion,
        operation: "reschedule", classAttendance: true, ...(intent.classSelectionRef ? { classSelectionRef: intent.classSelectionRef } : {}), turnId: turn.turnId,
        expectedConversationRevision: (await f.state()).conversationRevision, signal: new AbortController().signal });
      resultValue(result); await f.play();
      for (let i = 0; i < 100 && !f.mail.length; i++) await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(f.mail.length, 1); assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, true);
      const reception = new TextReception(f.ledger, f.policies, f.flow, undefined, undefined, undefined, undefined, f.classSessionConfig.clock);
      const action = await f.prepare(reception); await f.play();
      resultValue(await reception.affirm(f.scope, f.turn("yes", "Yes"), action.key, action.digest, verificationNow));
      resultValue(await reception.drain(f.scope, f.callId, verificationNow));
      assert.equal((await f.state()).actions[action.key]!.status, "committed"); assert.equal(f.writes.length, 2);
      assert.equal(f.native.traffic.some(row => row.path.includes("individual_appointments")), false);
    } finally { await f.close(); }
  });

for (const approved of [false, true])
  test(`E2E-399 ordinary model class movement needs explicit ${approved ? "available" : "missing"} pair approval`, async () => {
    const f = await classMoveCallFlowFixture();
    let flow: ClinikoCallFlow | undefined;
    try {
      const { move, ...withoutMove } = f.flowConfig.classAttendance!;
      flow = resultValue(ClinikoCallFlow.create({ ...f.flowConfig, classAttendance: approved ? f.flowConfig.classAttendance! : withoutMove }));
      let modelCalls = 0;
      const resolver = createOpenAIClinicalIntentResolver({ owner: flow, apiKey: "synthetic", model: "synthetic", clinicDate: () => "2026-10-04",
        fetch: async (_url, init) => {
          modelCalls++; const body = JSON.parse(String(init?.body)), context = JSON.parse(body.input[1].content);
          assert.equal(context.classService.moveAvailable === true, approved);
          return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify({
            kind: "classWorkflow", operation: "reschedule", stage: null, from: null, to: null, choice: null }) }] }] });
        } });
      const result = await resolver(f.turn("model-move", "I would like to rearrange Mat Pilates."));
      assert.equal(modelCalls, 1);
      if (approved) assert.deepEqual(resultValue(result), { kind: "workflow", operation: "reschedule", classAttendance: true });
      else assert.equal(result.ok, false);
      assert.deepEqual([f.mail.length, f.writes.length, f.recalls.length], [0, 0, 0]);
    } finally { flow?.dispose(); await f.close(); }
  });

for (const fault of ["missing", "revoked", "destination", "stopped"] as const)
  test(`E2E-399 ${fault} movement approval cannot start ordinary class movement or fall back to individual work`, async () => {
    const f = await classMoveCallFlowFixture(true);
    let flow: ClinikoCallFlow | undefined;
    try {
      let config = f.flowConfig;
      if (fault === "missing") { const { move, ...service } = config.classAttendance!; config = { ...config, classAttendance: service }; }
      if (fault === "revoked") {
        await f.replaceMove({ enabled: false });
        const context = await f.flow.publicIntentContext();
        assert.equal(context?.classService?.className, "Mat Pilates"); assert.equal(context?.classService?.moveAvailable, undefined);
      }
      if (fault === "destination") await f.replaceDestination({ enabled: false });
      if (fault === "stopped") resultValue(await f.ledger.stopWrites(f.scope, "synthetic-admin", "stop"));
      flow = resultValue(ClinikoCallFlow.create(config));
      const result = await flow.startWorkflow({ scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: config.policyVersion,
        operation: "reschedule", classAttendance: true, signal: new AbortController().signal });
      assert.equal(result.ok, false); assert.deepEqual([f.mail.length, f.writes.length, f.recalls.length], [0, 0, 0]);
    } finally { flow?.dispose(); await f.close(); }
  });

for (const fault of ["none", "unplayed", "withdrawnPair"] as const)
  test(`E2E-399 multiple move services require current ${fault} played selection while booking and cancellation stay disabled`, async () => {
    const f = await classMoveCallFlowFixture(true, true); f.flow.dispose();
    let flow: ClinikoCallFlow | undefined;
    try {
      const first = f.flowConfig.classServices![0]!, reversePath = join(f.folder, "reverse-movement.json");
      await writeFile(reversePath, JSON.stringify({ ...JSON.parse(await readFile(f.movePath, "utf8")), revision: "reverse-1",
        sourceServiceRef: "reformer-pilates", destinationServiceRef: "mat-pilates" }), { mode: 0o600 });
      const second = { ...first, ...first.move!.destination, move: { ...first.move!, approvalPath: reversePath,
        destination: { approvalPath: first.approvalPath, practitionerId: first.practitionerId, appointmentTypeId: first.appointmentTypeId } } };
      flow = resultValue(ClinikoCallFlow.create({ ...f.flowConfig, classServices: [first, second] }));
      const ask = f.turn("services", "Move my Pilates class"), question = await flow.classServiceIntent(ask);
      assert.equal(question?.kind, "classServiceQuestion"); if (question?.kind !== "classServiceQuestion") throw new Error("missing service question");
      assert.equal(question.question.operation, "reschedule"); assert.equal(question.question.labels.length, 2);
      resultValue(await f.runtime.acceptTurn(ask, question, verificationNow));
      const state = await f.state(); assert.equal(state.policy.bookingEnabled, false); assert.equal(state.policy.cancellationEnabled, false);
      if (fault !== "unplayed") await f.play();
      if (fault === "withdrawnPair") await f.replaceMove({ enabled: false });
      const choice = f.turn("service", "The first class please"), selection = await flow.classServiceIntent(choice);
      if (fault !== "none") { assert.equal(selection?.kind, "clarify"); assert.equal(f.mail.length, 0); }
      else {
        assert.equal(selection?.kind, "workflow"); if (selection?.kind !== "workflow") throw new Error("missing selected movement");
        assert.ok(selection.classSelectionRef);
        const started = await flow.startWorkflow({ scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.flowConfig.policyVersion,
          operation: "reschedule", classAttendance: true, classSelectionRef: selection.classSelectionRef, turnId: choice.turnId,
          expectedConversationRevision: (await f.state()).conversationRevision, signal: new AbortController().signal });
        assert.equal(started.ok, true);
      }
      assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
    } finally { flow?.dispose(); await f.close(); }
  });
