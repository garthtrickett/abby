import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { completedAppointmentEnquiry } from "../../src/core/completed-appointment-enquiry.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { representativeCallOwnerFixture, representativeInputOptions } from "../support/representative-call-owner.ts";
import { syntheticTaskSequence } from "../support/call-task-sequence.ts";
import { verificationNow } from "../support/caller-verification.ts";

async function fixture(maximumTasks = 2) {
  const f = await representativeCallOwnerFixture({ multiplePatients: true, operation: "appointments.read" }); f.flow.dispose();
  const source = await syntheticTaskSequence({ ...f.flowConfig, representativeInput: representativeInputOptions(f) }, f.f.folder, maximumTasks);
  await source.replace({ patientSelection: "independentlyVerifiedPatients" });
  const flow = resultValue(ClinikoCallFlow.create(source.config)), reception = new TextReception(f.f.ledger, f.f.policies, flow);
  let sequence = 0;
  const verify = async (id: "43" | "44") => {
    const count = f.mail.length;
    resultValue(await reception.startWorkflow(f.f.scope, f.f.turn(`read-start-${++sequence}`, "Check an appointment for another person"), "appointments.read", verificationNow,
      (await f.f.state()).conversationRevision, undefined, false, undefined, true));
    const owner = flow.representativeInputOwner; assert.ok(owner); await f.play();
    assert.equal(owner.beginCallerVerification(), true); await f.waitForMail(count + 1);
    assert.equal((await owner.submitCallerCode(f.mail.at(-1)!.code)).verified, true);
    const patient = f.r.patients.get(id)!;
    resultValue(await owner.selectPatient({ firstName: patient.first_name, lastName: patient.last_name, dateOfBirth: patient.date_of_birth }));
    assert.equal(owner.beginPatientVerification(), true); await f.waitForMail(count + 2);
    assert.equal((await flow.submitCode(f.mail.at(-1)!.code)).verified, true); return owner;
  };
  const read = () => reception.enquireAppointments(f.f.scope, f.f.turn(`read-${sequence}`, "Check the appointment"),
    { from: verificationNow, to: "2026-10-09T06:00:00.000Z" }, verificationNow);
  const next = async () => flow.startWorkflow({ scope: f.f.scope, callId: f.f.callId, sessionId: f.f.sessionId, policyVersion: f.flowConfig.policyVersion,
    expectedConversationRevision: (await f.f.state()).conversationRevision, operation: "appointments.read", forAnotherPerson: true, signal: new AbortController().signal });
  return { ...f, flow, reception, source, verify, read, next, closeSequence: async () => { flow.dispose(); await f.close(); } };
}

test("E2E-388 played related-patient enquiry completes a task without mutation and a second patient requires fresh verification", async () => {
  const f = await fixture();
  try {
    const firstOwner = await f.verify("43"); resultValue(await f.read());
    const firstRead = structuredClone((await f.f.state()).appointmentReads.at(-1)!); assert.equal(firstRead.status, "shown");
    assert.equal(completedAppointmentEnquiry(await f.f.state()), undefined);
    assert.equal(await f.flow.representativeStartupAvailable("appointments.read"), false); assert.equal((await f.next()).ok, false);
    assert.equal((await f.f.runtime.acceptTurn(f.f.turn("early-advance", "Check someone else"), { kind: "workflowStarted", operation: "appointments.read",
      next: "representativeRequired", advanceTask: true }, verificationNow)).ok, false);
    await f.play(); assert.deepEqual(completedAppointmentEnquiry(await f.f.state()), firstRead);
    assert.equal(await f.flow.representativeStartupAvailable("appointments.read"), true);
    f.setReadEmpty("44"); const secondOwner = await f.verify("44"); assert.notEqual(firstOwner, secondOwner); assert.equal(firstOwner.closed, true);
    assert.deepEqual((await f.f.state()).appointmentReads[0], firstRead);
    assert.equal(completedAppointmentEnquiry(await f.f.state()), undefined, "first patient receipt cannot settle second startup");
    assert.equal((await f.reception.enquireAppointments(f.f.scope, f.f.turn("old-choice", "The first appointment"), { choice: 1 }, verificationNow)).ok, true);
    assert.equal((await f.f.state()).appointmentReads.at(-1)!.status, "failed"); await f.play();
    resultValue(await f.read()); assert.equal((await f.f.state()).appointmentReads.at(-1)!.status, "empty"); await f.play();
    assert.equal(f.mail.length, 4); assert.equal(f.mail[3]!.email, "subject-two-private@example.test");
    assert.equal(await f.flow.representativeStartupAvailable("appointments.read"), false); assert.equal((await f.next()).ok, false);
    assert.deepEqual((await f.f.state()).appointmentReads[0], firstRead); assert.equal(Object.keys((await f.f.state()).actions).length, 0);
    assert.equal(f.writes, 0); assert.equal(f.f.recalls.length, 0);
  } finally { await f.closeSequence(); }
});

test("E2E-388 retired enquiry receipt and playback cannot be altered to enable later patient tasks", async t => {
  const f = await fixture(3);
  try {
    await f.verify("43"); resultValue(await f.read()); await f.play();
    await f.verify("44"); resultValue(await f.read()); await f.play();
    assert.equal(await f.flow.representativeStartupAvailable("appointments.read"), true);
    const firstTurn = (await f.f.state()).appointmentReads[0]!.turnId;
    const original = f.f.ledger.read.bind(f.f.ledger);
    const altered = t.mock.method(f.f.ledger, "read", async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (result.ok && result.value.callId === f.f.callId) {
        const index = result.value.appointmentReads.findIndex(read => read.turnId === firstTurn);
        result.value.appointmentReads[index] = { ...result.value.appointmentReads[index]!, sourceRef: "altered-old-source" };
      }
      return result;
    });
    assert.equal(await f.flow.representativeStartupAvailable("appointments.read"), false); assert.equal((await f.next()).ok, false);
    altered.mock.restore(); assert.equal(await f.flow.representativeStartupAvailable("appointments.read"), true);
    assert.equal(f.mail.length, 4); assert.equal(f.writes, 0);
  } finally { await f.closeSequence(); }
});

test("E2E-388 failed related-person enquiry and withdrawn task approval cannot establish completion or skip to another patient", async () => {
  for (const fault of ["read", "approval"] as const) {
    const f = await fixture();
    try {
      const owner = await f.verify("43"); if (fault === "read") f.setReadFailure();
      resultValue(await f.read()); await f.play();
      if (fault === "approval") await f.source.replace({ enabled: false });
      else assert.equal(completedAppointmentEnquiry(await f.f.state()), undefined);
      assert.equal(await f.flow.representativeStartupAvailable("appointments.read"), false); assert.equal((await f.next()).ok, false);
      assert.equal(f.flow.representativeInputOwner, owner); assert.equal(f.mail.length, 2); assert.equal(f.writes, 0);
    } finally { await f.closeSequence(); }
  }
});
