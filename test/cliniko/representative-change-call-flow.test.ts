import assert from "node:assert/strict";
import test from "node:test";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { representativeChangeCallFixture } from "../support/representative-change-call.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { syntheticTaskSequence } from "../support/call-task-sequence.ts";

async function fixture(operation: "cancel" | "reschedule") {
  const f = await representativeChangeCallFixture(operation);
  const reception = new TextReception(f.f.ledger, f.f.policies, f.flow, undefined, {
    list: (...args) => f.flow.appointments!.list(...args), select: (...args) => f.flow.appointments!.select!(...args) });
  const agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.f.scope }, f.f.policies, reception,
    undefined, undefined, undefined, f.f.ledger);
  const verify = async () => {
    resultValue(await reception.startWorkflow(f.f.scope, f.f.turn("related-start", "Change an appointment for my partner"), operation,
      verificationNow, (await f.f.state()).conversationRevision, undefined, false, undefined, true)); await f.play();
    const owner = f.flow.representativeInputOwner; assert.ok(owner); assert.equal(owner.beginCallerVerification(), true); await f.waitForMail(1);
    assert.equal((await owner.submitCallerCode(f.mail[0]!.code)).verified, true);
    resultValue(await owner.selectPatient(f.r.identity)); assert.equal(owner.beginPatientVerification(), true); await f.waitForMail(2);
    assert.equal((await f.flow.submitCode(f.mail[1]!.code)).verified, true); return owner;
  };
  const propose = async () => {
    if (operation === "cancel") {
      const grant = await f.flow.cancellationProof(); assert.ok(grant);
      resultValue(await agent.submit({ kind: "appointments.read.v1", turn: f.f.turn("related-appointments"), verificationRef: grant.verificationRef,
        from: verificationNow, to: "2026-10-09T06:00:00.000Z", now: verificationNow })); await f.play();
      resultValue(await agent.submit({ kind: "appointments.change.propose.v1", turn: f.f.turn("related-cancel"),
        selection: { kind: "cancel", verificationRef: grant.verificationRef, targetRef: "selected" }, now: verificationNow }));
    } else {
      for (const stage of ["targets", "offers"] as const) {
        resultValue(await agent.submit({ kind: "rescheduling.menu.read.v1", turn: f.f.turn(`related-${stage}`), stage,
          from: stage === "targets" ? verificationNow : "2026-10-08", to: stage === "targets" ? "2026-10-09T06:00:00.000Z" : "2026-10-08", now: verificationNow }));
        assert.match((await f.f.state()).callerMessages.at(-1)!, /Option one/i); await f.play();
        resultValue(await agent.submit({ kind: "rescheduling.menu.select.v1", turn: f.f.turn(`related-choice-${stage}`), stage, choice: 1, now: verificationNow }));
        if (stage === "targets") await f.play();
      }
    }
    const action = Object.values((await f.f.state()).actions).at(-1)!; assert.ok(action); assert.equal(action.status, "awaitingConfirmation");
    return action;
  };
  return { ...f, reception, verify, propose };
}

test("E2E-389 an enquiry followed by another patients cancellation gets fresh operation proof and preserves the first read", async () => {
  const f = await representativeChangeCallFixture("appointments.read"); f.flow.dispose();
  const source = await syntheticTaskSequence(f.flowConfig, f.f.folder);
  await source.replace({ patientSelection: "independentlyVerifiedPatients" });
  const flow = resultValue(ClinikoCallFlow.create(source.config));
  const reception = new TextReception(f.f.ledger, f.f.policies, flow, undefined, {
    list: (...args) => flow.appointments!.list(...args), select: (...args) => flow.appointments!.select!(...args) });
  const agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.f.scope }, f.f.policies, reception,
    undefined, undefined, undefined, f.f.ledger);
  try {
    let firstRead: unknown;
    for (const [index, operation] of (["appointments.read", "cancel"] as const).entries()) {
      resultValue(await reception.startWorkflow(f.f.scope, f.f.turn(`mixed-start-${index}`, "Check or cancel for another person"), operation,
        verificationNow, (await f.f.state()).conversationRevision, undefined, false, undefined, true)); await f.play();
      const owner = flow.representativeInputOwner; assert.ok(owner); assert.equal(owner.beginCallerVerification(), true); await f.waitForMail(index * 2 + 1);
      assert.equal((await owner.submitCallerCode(f.mail.at(-1)!.code)).verified, true);
      const patient = f.r.patients.get(index === 0 ? "43" : "44")!;
      resultValue(await owner.selectPatient({ firstName: patient.first_name, lastName: patient.last_name, dateOfBirth: patient.date_of_birth }));
      assert.equal(owner.beginPatientVerification(), true); await f.waitForMail(index * 2 + 2);
      assert.equal((await flow.submitCode(f.mail.at(-1)!.code)).verified, true);
      if (operation === "appointments.read") {
        resultValue(await reception.enquireAppointments(f.f.scope, f.f.turn("mixed-read"), { from: verificationNow, to: "2026-10-09T06:00:00.000Z" }, verificationNow));
        assert.equal((await f.f.state()).appointmentReads.at(-1)!.status, "shown"); await f.play();
        firstRead = structuredClone((await f.f.state()).appointmentReads.at(-1));
      } else {
        assert.equal((await flow.choose("reschedule")).ok, false, "cancel proof cannot authorize a move");
        const grant = await flow.cancellationProof(); assert.ok(grant);
        resultValue(await agent.submit({ kind: "appointments.read.v1", turn: f.f.turn("mixed-cancel-list"), verificationRef: grant.verificationRef,
          from: verificationNow, to: "2026-10-09T06:00:00.000Z", now: verificationNow })); await f.play();
        resultValue(await agent.submit({ kind: "appointments.change.propose.v1", turn: f.f.turn("mixed-cancel-propose"),
          selection: { kind: "cancel", verificationRef: grant.verificationRef, targetRef: "selected" }, now: verificationNow }));
        const action = Object.values((await f.f.state()).actions).at(-1)!; assert.equal(action.status, "awaitingConfirmation"); assert.equal(f.patches.length, 0);
        await f.play(); resultValue(await reception.affirm(f.f.scope, f.f.turn("mixed-cancel-yes", "Yes"), action.key, action.digest, verificationNow));
        resultValue(await reception.drain(f.f.scope, f.f.callId, verificationNow));
        assert.equal((await f.f.state()).actions[action.key]!.status, "committed");
      }
    }
    assert.deepEqual((await f.f.state()).appointmentReads[0], firstRead); assert.equal(f.mail.length, 4);
    assert.deepEqual(f.patches.map(row => ({ id: row.id, kind: row.kind })), [{ id: "92", kind: "cancel" }]);
    assert.equal(f.rows.get("91")!.cancelled_at, null); assert.equal(f.rows.get("93")!.cancelled_at, null);
  } finally { flow.dispose(); await f.close(); }
});

for (const operation of ["cancel", "reschedule"] as const) {
  test(`E2E-389 related-person CallFlow ${operation} separately verifies and confirms one native target without changing caller appointment`, async () => {
    const f = await fixture(operation), originalCaller = structuredClone(f.rows.get("93"));
    try {
      await f.verify(); const action = await f.propose(); assert.equal(f.patches.length, 0);
      await f.play(); resultValue(await f.reception.affirm(f.f.scope, f.f.turn("related-yes", "Yes"), action.key, action.digest, verificationNow));
      resultValue(await f.reception.drain(f.f.scope, f.f.callId, verificationNow));
      assert.equal((await f.f.state()).actions[action.key]!.status, "committed"); assert.equal(f.patches.length, 1);
      assert.equal(f.patches[0]!.id, "91"); assert.equal(f.patches[0]!.kind, operation); assert.deepEqual(f.rows.get("93"), originalCaller);
      assert.equal(f.f.recalls.length, 1); assert.equal(f.mail.length, 2);
    } finally { await f.close(); }
  });
  test(`E2E-389 related-person ${operation} unknown response preserves the target outcome as uncertain and cannot replay`, async () => {
    const f = await fixture(operation);
    try {
      await f.verify(); const action = await f.propose(); f.loseResponse();
      await f.play(); resultValue(await f.reception.affirm(f.f.scope, f.f.turn("unknown-yes", "Yes"), action.key, action.digest, verificationNow));
      resultValue(await f.reception.drain(f.f.scope, f.f.callId, verificationNow));
      const retained = (await f.f.state()).actions[action.key]!; assert.ok(["uncertain", "needsReview"].includes(retained.status));
      assert.equal(f.patches.length, 1); assert.equal((await f.flow.choose(operation)).ok, false);
      assert.equal((await f.reception.affirm(f.f.scope, f.f.turn("unknown-retry", "Yes"), action.key, action.digest, verificationNow)).ok, false);
      assert.equal(f.patches.length, 1); assert.deepEqual((await f.f.state()).actions[action.key], retained);
    } finally { await f.close(); }
  });
  test(`E2E-389 related-person ${operation} current caller permission withdrawn after proposal denies native mutation`, async () => {
    const f = await fixture(operation), before = structuredClone(f.rows.get("91"));
    try {
      await f.verify(); const action = await f.propose(); f.revokeActor();
      await f.play(); resultValue(await f.reception.affirm(f.f.scope, f.f.turn("revoked-yes", "Yes"), action.key, action.digest, verificationNow));
      resultValue(await f.reception.drain(f.f.scope, f.f.callId, verificationNow));
      assert.notEqual((await f.f.state()).actions[action.key]!.status, "committed");
      assert.equal(f.patches.length, 0); assert.deepEqual(f.rows.get("91"), before);
    } finally { await f.close(); }
  });
}
