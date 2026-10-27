import assert from "node:assert/strict";
import { test } from "node:test";
import { completedAppointmentEnquiry } from "../../src/core/completed-appointment-enquiry.ts";
import { correctionTasksFixture } from "../support/patient-correction-tasks.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";

async function read(f: Awaited<ReturnType<typeof correctionTasksFixture>>) {
  assert.equal((await f.flow.submitCode(f.mail.at(-1)!.code)).verified, true);
  resultValue(await f.reception.enquireAppointments(f.scope, f.turn("Check my appointments"),
    { from: verificationNow, to: "2026-10-09T06:00:00.000Z" }, verificationNow));
  const enquiry = (await f.state()).appointmentReads.at(-1)!;
  assert.equal(enquiry.status, "empty");
  assert.equal(completedAppointmentEnquiry(await f.state()), undefined);
  return enquiry;
}

test("E2E-381 a completed correction and played enquiry exhaust two tasks before a third verifier or write", async () => {
  const f = await correctionTasksFixture({ enquiry: true });
  try {
    await f.start(); const first = await f.correct("First Mixed Private Town"); assert.equal(first.status, "committed");
    await f.start("appointments.read"); assert.equal(f.flow.patientCorrectionRef, undefined);
    const enquiry = await read(f); await f.playTaskPresentation();
    assert.deepEqual(completedAppointmentEnquiry(await f.state()), enquiry);
    resultValue(await f.reception.startWorkflow(f.scope, f.turn("Correct my details again"), "patientUpdate", verificationNow));
    await f.playTaskPresentation();
    assert.equal(f.flow.workflow, "appointments.read"); assert.equal(f.flow.verificationRequired, false);
    assert.equal(f.mail.length, 2); assert.deepEqual(f.patches, [{ city: "First Mixed Private Town" }]);
    assert.deepEqual((await f.state()).actions[first.key], first);
    assert.deepEqual((await f.state()).appointmentReads[0], enquiry);
    assert.deepEqual(await f.flow.write(first.mutation, verificationNow), { kind: "rejected", actionKey: first.key, reason: "forbidden" });
  } finally { await f.closeTasks(); }
});

test("E2E-381 played enquiry then correction requires fresh proof, private terms and separate played consent", async () => {
  const f = await correctionTasksFixture({ enquiry: true });
  try {
    await f.start("appointments.read"); const enquiry = await read(f); await f.playTaskPresentation();
    await f.start(); assert.equal(completedAppointmentEnquiry(await f.state()), undefined);
    const action = await f.correct("Second Mixed Private Town"); assert.equal(action.status, "committed");
    assert.deepEqual((await f.state()).appointmentReads[0], enquiry);
    assert.equal(f.mail.length, 2); assert.deepEqual(f.patches, [{ city: "Second Mixed Private Town" }]);
    assert.equal((await f.flow.choose("appointments.read")).ok, false);
  } finally { await f.closeTasks(); }
});

test("E2E-381 configured three tasks retain correction and enquiry receipts before a fresh third correction", async () => {
  const f = await correctionTasksFixture({ enquiry: true, maximumTasks: 3 });
  try {
    await f.start(); const first = await f.correct("Three Task First Private Town"); assert.equal(first.status, "committed");
    await f.start("appointments.read"); const enquiry = await read(f); await f.playTaskPresentation();
    await f.start(); const third = await f.correct("Three Task Last Private Town"); assert.equal(third.status, "committed");
    assert.notEqual(third.key, first.key); assert.equal(f.mail.length, 3); assert.equal(f.patches.length, 2);
    assert.deepEqual((await f.state()).actions[first.key], first);
    assert.deepEqual((await f.state()).appointmentReads[0], enquiry);
    assert.equal((await f.flow.choose("appointments.read")).ok, false);
  } finally { await f.closeTasks(); }
});

test("E2E-381 replacing an unplayed enquiry stays within its current task and requires fresh correction authority", async () => {
  const f = await correctionTasksFixture({ enquiry: true });
  try {
    await f.start(); const first = await f.correct("Unplayed First Private Town"); assert.equal(first.status, "committed");
    await f.start("appointments.read"); const enquiry = await read(f);
    await f.start(); const replacement = await f.correct("Unplayed Replacement Private Town"); assert.equal(replacement.status, "committed");
    assert.equal(f.mail.length, 3); assert.equal(f.patches.length, 2);
    assert.deepEqual((await f.state()).actions[first.key], first);
    assert.deepEqual((await f.state()).appointmentReads[0], enquiry);
    assert.equal(completedAppointmentEnquiry(await f.state()), undefined);
    assert.equal((await f.flow.choose("appointments.read")).ok, false);
  } finally { await f.closeTasks(); }
});
