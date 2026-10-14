import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { classCallFlowFixture } from "../support/class-call-flow.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow, verificationCanaries } from "../support/caller-verification.ts";

for (const fault of ["missing", "revoked", "wrongMember", "wrongType"] as const)
  test(`E2E-394 ${fault} class approval preserves the explicit class boundary without verifier or individual fallback`, async () => {
    const f = await classCallFlowFixture("book");
    let flow: ClinikoCallFlow | undefined;
    try {
      const { classAttendance, ...ordinary } = f.flowConfig;
      assert.ok(classAttendance);
      if (fault === "revoked") await f.replacePolicy({ enabled: false });
      flow = resultValue(ClinikoCallFlow.create(fault === "missing" ? ordinary : { ...f.flowConfig,
        classAttendance: { ...classAttendance, ...(fault === "wrongMember" ? { practitionerId: "23" } : {}), ...(fault === "wrongType" ? { appointmentTypeId: "34" } : {}) } }));
      const resolver = createOpenAIClinicalIntentResolver({ owner: flow, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04",
        fetch: async () => { throw new Error("finite class boundary must not invoke a model"); } });
      assert.deepEqual(resultValue(await resolver({ ...f.turn("class", "Book my Pilates class"), text: "Book my Pilates class" })), { kind: "requestBoundary", reason: "groupClass" });
      const started = await flow.startWorkflow({ scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.flowConfig.policyVersion,
        operation: "book", classAttendance: true, expectedConversationRevision: (await f.state()).conversationRevision, signal: new AbortController().signal });
      assert.equal(started.ok, false);
      assert.deepEqual([f.mail.length, f.writes.length, f.recalls.length], [0, 0, 0]);
      assert.equal(f.native.traffic.some(value => value.path.includes("individual_appointments")), false);
    } finally { flow?.dispose(); await f.close(); }
  });

test("E2E-394 class routing exposes approved public facts only and keeps distinct service, representative and movement requests unavailable", async () => {
  const f = await classCallFlowFixture("book");
  try {
    const context = await f.flow.publicIntentContext(); assert.ok(context);
    assert.deepEqual(context.classService, { className: "Mat Pilates", practitionerName: "Demo Instructor", locationName: "Demo Clinic", serviceRef: "mat-pilates" });
    for (const secret of verificationCanaries) assert.equal(JSON.stringify(context).includes(secret), false);
    assert.deepEqual(await f.flow.classWorkflowIntent("Book my Pilates class"), { kind: "workflow", operation: "book", classAttendance: true });
    assert.equal(await f.flow.classWorkflowIntent("Book my gym class"), undefined);
    assert.equal(await f.flow.classWorkflowIntent("I do not want to book my Pilates class"), undefined);
    for (const patch of [{ operation: "reschedule" as const }, { forAnotherPerson: true as const }, { serviceChoice: { serviceRef: "other-service" } }]) {
      const result = await f.flow.startWorkflow({ scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.flowConfig.policyVersion,
        operation: "book", classAttendance: true, signal: new AbortController().signal, ...patch } as Parameters<ClinikoCallFlow["startWorkflow"]>[0]);
      assert.equal(result.ok, false);
    }
    assert.equal(f.mail.length, 0); assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test("E2E-394 malformed or phase-incompatible class model decisions cannot manufacture an individual or native class action", async () => {
  const f = await classCallFlowFixture("book");
  try {
    const responses = [
      { operation: "reschedule" }, { operation: "book", choice: 1 }, { operation: "cancel", stage: "targets" },
      { operation: "book", from: "2026-10-08", to: "2026-10-08" }, { operation: null },
    ];
    for (const patch of responses) {
      const decision = Object.assign({ kind: "classWorkflow", operation: null, stage: null, from: null, to: null, choice: null }, patch);
      const resolver = createOpenAIClinicalIntentResolver({ owner: f.flow, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04",
        fetch: async () => Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] }) });
      const result = await resolver({ ...f.turn("malformed", "I would like a place in Mat Pilates"), at: verificationNow });
      assert.equal(result.ok, false);
    }
    assert.deepEqual([f.mail.length, f.writes.length, f.recalls.length], [0, 0, 0]);
  } finally { await f.close(); }
});
