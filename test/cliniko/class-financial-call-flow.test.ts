import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { PrivateWorkflowKeypad } from "../../src/standalone/private-workflow-keypad.ts";
import { PrivateFinancialBookingInput } from "../../src/standalone/private-financial-booking-input.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { financialClassBookingFixture } from "../support/financial-class-booking.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

for (const passes of [false, true]) test(`actual class call flow carries private financial consent into a separate clinical action (pass=${passes})`, async () => {
  const f = await financialClassBookingFixture({ passes }); f.host.dispose(); f.session.dispose();
  const c = f.classSessionConfig;
  const flow = resultValue(ClinikoCallFlow.create({ ...c,
    approvals: { bookCaller: c.callerApprovalPath, cancelCaller: c.callerApprovalPath, rescheduleCaller: c.callerApprovalPath,
      booking: f.path, cancellation: f.path, rescheduling: f.path },
    classAttendance: { approvalPath: c.classApprovalPath, practitionerId: c.cliniko.practitionerId, appointmentTypeId: c.cliniko.appointmentTypeId,
      bookPermission: c.classPermission, cancelPermission: c.classPermission, ...(c.classPassAuthority ? { passAuthority: c.classPassAuthority } : {}) } }));
  const reception = new TextReception(f.ledger, f.policies, flow, undefined, undefined, undefined, undefined, c.clock);
  const ordinary = new PrivateWorkflowKeypad({ callId: f.callId, sessionId: f.sessionId, owner: () => flow });
  const input = new PrivateFinancialBookingInput(ordinary, () => flow);
  try {
    await f.play(); resultValue(await flow.choose("book")); assert.equal(input.claim(f.callId, f.sessionId), true); assert.equal(input.start(), true);
    await f.verificationDelivered;
    for (const key of f.mail[0]!.code) assert.equal(await input.accept(key), "pending");
    assert.equal(await input.accept("#"), "verified"); assert.equal(input.blocked(), false);
    resultValue(await reception.readBookingMenu(f.scope, f.turn("flow-menu"), "2026-10-08", "2026-10-08", c.clock())); await f.play();
    resultValue(await reception.selectBookingMenu(f.scope, f.turn("flow-select"), 1, c.clock())); await f.play();
    const financial = flow.financialBookingInput; assert.ok(financial); assert.equal(input.blocked(), true);
    const early = input.captureDigit("1", false), first = input.captureDigit("1", false); assert.ok(first && early);
    assert.equal(await input.accept("1", first), "pending"); await new Promise<void>(resolve => setImmediate(resolve));
    await input.accept("1", early); assert.equal(f.texts.length, 1); assert.equal(financial.readySelection, undefined);
    for (let i = 0; i < 16 && financial.inputAdmission()?.phase === "unplayed"; i++) {
      await input.accept("1", input.captureDigit("1", false)); await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(financial.inputAdmission()?.phase, "awaiting"); assert.equal(Object.keys((await f.state()).actions).length, 0);
    assert.equal(await input.accept("1", input.captureDigit("1", false)), "verified"); assert.equal(input.blocked(), false); assert.equal(f.writes.length, 0);
    let modelCalls = 0;
    const resolver = createOpenAIClinicalIntentResolver({ owner: flow, apiKey: "synthetic-model-key", model: "configured-model", clinicDate: () => "2026-10-04",
      fetch: async () => { modelCalls++; throw new Error("Financial resume must stay local"); } });
    const decision = resultValue(await resolver(f.turn("continue", "continue booking"))); assert.equal(decision.kind, "book"); assert.equal(modelCalls, 0);
    if (decision.kind !== "book") assert.fail("missing clinical proposal references");
    resultValue(await reception.proposeBooking(f.scope, f.turn("clinical-proposal"), decision.verificationRef, decision.offerRef, c.clock()));
    assert.equal(f.writes.length, 0); await f.play(); const action = Object.values((await f.state()).actions)[0]!;
    let state = resultValue(await reception.affirm(f.scope, f.turn("clinical-yes", "Yes"), action.key, action.digest, c.clock()));
    const wait = state.pendingPresentationId && state.presentations[state.pendingPresentationId];
    if (wait && wait.kind === "notice" && wait.confirmationWaitSeconds) {
      await f.play(); await f.pause(wait.confirmationWaitSeconds + 1);
      state = resultValue(await reception.affirm(f.scope, f.turn("clinical-yes-after-wait", "Yes"), action.key, action.digest, c.clock()));
    }
    resultValue(await reception.drain(f.scope, f.callId, c.clock())); assert.equal(f.writes.length, 1);
    assert.equal(Object.values((await f.state()).actions)[0]?.status, "committed"); assert.ok(f.proof().financialConsent);
    assert.equal(f.proof().targetRef, "cliniko:attendee:401");
  } finally { input.stop(); flow.dispose(); await f.close(); }
});
