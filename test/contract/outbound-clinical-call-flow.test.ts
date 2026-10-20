// E2E-420: original-patient signed outgoing clinical rescheduling; synthetic remote grants/speech, no live acceptance.
import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import type { ClinikoCallFlowConfig, ClinikoOutboundCallFlowConfig } from "../../src/standalone/cliniko-call-flow.ts";
import { PrivateWorkflowKeypad } from "../../src/standalone/private-workflow-keypad.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { outboundClinicalReschedulingFixture } from "../support/outbound-clinical-rescheduling.ts";
import { value } from "../support/outbound-records.ts";
import { verificationNow } from "../support/caller-verification.ts";

async function fixture() {
  const f = await outboundClinicalReschedulingFixture(); f.owner.dispose();
  const c = f.outgoingConfig;
  const config: ClinikoOutboundCallFlowConfig = { ...c, approvals: { bookCaller: c.callerApprovalPath, cancelCaller: c.callerApprovalPath,
    rescheduleCaller: c.callerApprovalPath, booking: c.bookingApprovalPath, cancellation: c.reschedulingApprovalPath, rescheduling: c.reschedulingApprovalPath } };
  const flow = value(ClinikoCallFlow.createOutbound(config));
  return { ...f, flow, flowConfig: config, reception: new TextReception(f.ledger, f.policies, flow),
    turn: (turnId: string, text = "Move my appointment") => ({ callId: f.callId, sessionId: f.sessionId, turnId, text, quality: "clear" as const, at: verificationNow }),
    get patches() { return f.patches; },
    close: async () => { flow.dispose(); await f.close(); } };
}

test("outgoing call flow uses the actual private keypad and normal played exact-target rescheduling owners", async t => {
  const f = await fixture(); t.after(f.close);
  const keypad = new PrivateWorkflowKeypad({ callId: f.callId, sessionId: f.sessionId, owner: () => f.flow }); t.after(() => keypad.stop());
  assert.equal(keypad.claim(f.callId, f.sessionId), true); assert.equal(keypad.start(), true); assert.equal(keypad.blocked(), false);
  assert.equal(f.mail.length, 0);
  value(await f.reception.startWorkflow(f.scope, f.turn("workflow"), "reschedule", verificationNow));
  assert.equal(keypad.blocked(), true);
  const deadline = Date.now() + 5000;
  while (!f.mail.length && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
  assert.equal(f.mail.length, 1);
  for (const digit of f.mail[0]!.code) assert.equal(await keypad.accept(digit), "pending");
  assert.equal(await keypad.accept("#"), "verified"); assert.equal(keypad.blocked(), false);
  await f.play();
  for (const stage of ["targets", "offers"] as const) {
    value(await f.reception.readReschedulingMenu(f.scope, f.turn("read-" + stage), stage,
      stage === "targets" ? verificationNow : "2026-10-08", stage === "targets" ? "2026-10-09T06:00:00.000Z" : "2026-10-08", verificationNow));
    await f.play();
    value(await f.reception.selectReschedulingMenu(f.scope, f.turn("select-" + stage), stage, 1, verificationNow));
    if (stage === "targets") await f.play();
  }
  assert.equal(f.patches, 0); await f.play();
  const action = Object.values((await f.state()).actions)[0]!;
  value(await f.reception.affirm(f.scope, f.turn("yes", "Yes"), action.key, action.digest, verificationNow));
  value(await f.reception.drain(f.scope, f.callId, verificationNow));
  assert.equal(f.patches, 1); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
  assert.equal((await f.flow.choose("cancel")).ok, false);
});

test("outgoing flow refuses all unimplemented workflows and representative or class variations before reads", async t => {
  const f = await fixture(); t.after(f.close); const before = f.claims;
  for (const op of ["book", "cancel", "intake", "patientUpdate", "confirmationResend", "appointments.read"] as const)
    assert.equal((await f.flow.choose(op)).ok, false, op);
  assert.equal((await f.flow.choose("reschedule", undefined, false, undefined, undefined, true)).ok, false);
  assert.equal((await f.flow.choose("reschedule", undefined, false, undefined, undefined, false, true)).ok, false);
  assert.equal(f.mail.length, 0); assert.equal(f.claims, before); assert.equal(f.flow.workflow, undefined);
});

test("incoming construction rejects an actual outgoing receipt even when handed the unrelated incoming clue", async t => {
  const f = await fixture(); t.after(f.close);
  const { outbound: _, ...rest } = f.flowConfig;
  assert.equal(ClinikoCallFlow.create({ ...rest, inbound: f.inbound }).ok, false);
  assert.equal(ClinikoCallFlow.create(f.flowConfig as unknown as ClinikoCallFlowConfig).ok, false);
  assert.equal(f.flow.matchesPrivateVerificationContext({ receipt: f.receipt, inbound: f.inbound, sessionId: f.sessionId,
    policyVersion: rest.policyVersion, cliniko: rest.cliniko }), false);
});

test("outgoing construction rejects runtime own incoming-only capabilities including explicit undefined", async t => {
  const f = await fixture(); t.after(f.close);
  for (const key of ["inbound", "representative", "classAttendance", "classServices", "intake", "staff", "history", "enquiry",
    "serviceCatalogue", "correction", "resend", "taskSequence", "representativeInput", "catalogue", "financial"])
    assert.equal(ClinikoCallFlow.createOutbound({ ...f.flowConfig, [key]: undefined }).ok, false, key);
  assert.equal(f.mail.length, 0);
});

test("outgoing construction refuses another native budget, account, business or original approval", async t => {
  const f = await fixture(); t.after(f.close); const c = f.flowConfig;
  for (const cliniko of [{ ...c.cliniko, apiKey: "other-au5" }, { ...c.cliniko, businessId: "999" },
    { ...c.cliniko, rateBudget: { claim: async () => null, observe429: async () => ({ kind: "rateLimited" as const }) } }])
    assert.equal(ClinikoCallFlow.createOutbound({ ...c, cliniko }).ok, false);
  f.targetState.live = false;
  assert.equal(ClinikoCallFlow.createOutbound(c).ok, false); assert.equal((await f.flow.choose("reschedule")).ok, false);
  assert.equal(f.mail.length, 0);
});

test("outgoing flow rejects mutated actual admission and ended-call keypad without granting access", async t => {
  const f = await fixture(); t.after(f.close);
  assert.equal(f.receipt.admission.direction, "outbound");
  if (f.receipt.admission.direction !== "outbound") throw Error("Missing actual outgoing admission");
  const receipt = { ...f.receipt, admission: { ...f.receipt.admission, clinicNumber: "+6125550999", direction: "outbound" as const } };
  assert.equal(ClinikoCallFlow.createOutbound({ ...f.flowConfig, receipt }).ok, false);
  f.flow.dispose();
  const keypad = new PrivateWorkflowKeypad({ callId: f.callId, sessionId: f.sessionId, owner: () => f.flow });
  assert.equal(keypad.claim(f.callId, f.sessionId), true); assert.equal(keypad.start(), false);
  assert.equal((await f.flow.choose("reschedule")).ok, false); assert.equal(f.mail.length, 0);
});
