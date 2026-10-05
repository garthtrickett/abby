import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { PrivateWorkflowKeypad } from "../../src/standalone/private-workflow-keypad.ts";
import { bookingCallFlowFixture, cancellationCallFlowFixture, reschedulingCallFlowFixture, intakeCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { intakeDraft, intakeNow } from "../support/intake-edge.ts";
import { verificationNow } from "../support/caller-verification.ts";

async function waitForMail(mail: readonly unknown[]) {
  const deadline = Date.now() + 5000;
  while (!mail.length && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
  assert.equal(mail.length, 1);
}
async function privateVerify(f: { flow: ClinikoCallFlow; mail: { code: string }[]; callId: string; sessionId: string }) {
  const input = new PrivateWorkflowKeypad({ callId: f.callId, sessionId: f.sessionId, owner: () => f.flow });
  assert.equal(input.blocked(), true); assert.equal(input.claim(f.callId, f.sessionId), true); assert.equal(input.start(), true);
  assert.equal(input.blocked(), true); f.flow.beginVerification(); await waitForMail(f.mail);
  for (const digit of f.mail[0]!.code) assert.equal(await input.accept(digit), "pending");
  assert.equal(await input.accept("#"), "verified"); assert.equal(input.blocked(), false); return input;
}
async function affirm(f: Awaited<ReturnType<typeof bookingCallFlowFixture>> | Awaited<ReturnType<typeof cancellationCallFlowFixture>> |
  Awaited<ReturnType<typeof reschedulingCallFlowFixture>>, turnId: string) {
  await f.playPending(); const action = Object.values((await f.state()).actions).at(-1)!; assert.ok(action);
  resultValue(await f.reception.affirm(f.scope, f.turn(turnId, "Yes"), action.key, action.digest, verificationNow));
  resultValue(await f.reception.drain(f.scope, f.callId, verificationNow));
}

test("E2E-297 call flow routes a returning booking through private verification, played menu and separately affirmed reviewed write", async () => {
  const f = await bookingCallFlowFixture();
  try {
    assert.equal(f.flow.workflow, undefined); assert.equal(f.mail.length, 0); assert.equal(f.allTraffic.length, 0);
    const keypad = new PrivateWorkflowKeypad({ callId: f.callId, sessionId: f.sessionId, owner: () => f.flow });
    assert.equal(keypad.claim(f.callId, f.sessionId), true); assert.equal(keypad.start(), true); assert.equal(keypad.blocked(), false);
    const selecting = new AbortController();
    resultValue(await f.reception.startWorkflow(f.scope, f.turn("workflow"), "book", verificationNow, undefined, selecting.signal));
    assert.equal(keypad.blocked(), true); selecting.abort(); // A finished caller turn must not dispose the call owner.
    await waitForMail(f.mail); for (const digit of f.mail[0]!.code) await keypad.accept(digit);
    assert.equal(await keypad.accept("#"), "verified"); await f.playPending();
    resultValue(await f.reception.readBookingMenu(f.scope, f.turn("menu"), "2026-10-08", "2026-10-08", verificationNow)); await f.playPending();
    resultValue(await f.reception.selectBookingMenu(f.scope, f.turn("selection"), 2, verificationNow));
    assert.equal(f.posts, 0); await affirm(f, "confirm"); assert.equal(f.posts, 1); assert.equal(f.recalls.length, 1);
    const state = await f.state(); assert.equal(Object.values(state.actions)[0]!.status, "committed");
    assert.equal(JSON.stringify(state).includes(f.mail[0]!.code), false);
    assert.equal((await f.flow.choose("cancel")).ok, false); assert.equal(f.mail.length, 1);
  } finally { f.flow.dispose(); await f.close(); }
});

test("E2E-297 call flow routes cancellation through its private grant and exact selected target", async () => {
  const f = await cancellationCallFlowFixture();
  try {
    resultValue(await f.flow.choose("cancel")); await privateVerify(f); const proof = await f.flow.cancellationProof(); assert.ok(proof);
    resultValue(await f.reception.checkAppointments(f.scope, f.turn("list"), proof.verificationRef, verificationNow, "2026-10-09T06:00:00.000Z", verificationNow));
    await f.playPending(); resultValue(await f.reception.proposeAppointmentChange(f.scope, f.turn("cancel"),
      { kind: "cancel", verificationRef: proof.verificationRef, targetRef: "selected" }, verificationNow));
    assert.equal(f.patches, 0); await affirm(f, "confirm"); assert.equal(f.patches, 1); assert.equal(f.recalls.length, 1);
    assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
  } finally { f.flow.dispose(); await f.close(); }
});

test("E2E-297 call flow routes rescheduling through played source and destination choices and one reviewed move", async () => {
  const f = await reschedulingCallFlowFixture();
  try {
    resultValue(await f.flow.choose("reschedule")); await privateVerify(f);
    for (const stage of ["targets", "offers"] as const) {
      resultValue(await f.reception.readReschedulingMenu(f.scope, f.turn(`menu-${stage}`), stage,
        stage === "targets" ? verificationNow : "2026-10-08", stage === "targets" ? "2026-10-09T06:00:00.000Z" : "2026-10-08", verificationNow));
      await f.playPending(); resultValue(await f.reception.selectReschedulingMenu(f.scope, f.turn(`select-${stage}`), stage, 1, verificationNow));
      if (stage === "targets") await f.playPending();
    }
    assert.equal(f.patches, 0); await affirm(f, "confirm"); assert.equal(f.patches, 1); assert.equal(f.recalls.length, 1);
    assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
  } finally { f.flow.dispose(); await f.close(); }
});

test("E2E-297 call flow registration retains separate intake acknowledgment, private draft/code and subsequent booking permission", async () => {
  const f = await intakeCallFlowFixture();
  try {
    resultValue(await f.flow.choose("intake")); const owner = f.flow.intake!; assert.ok(owner);
    const opening = resultValue(await owner.begin()); assert.equal(await owner.acknowledgeRecovery(opening.recoveryRef, true), true);
    const draft = resultValue(await owner.collect(intakeDraft, { privacyAccepted: true, intakeAccepted: true }));
    assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, true);
    resultValue(await f.reception.proposeIntake(f.scope, f.turn("intake"), draft.draftRef, intakeNow));
    await f.playPending(); const intake = Object.values((await f.state()).actions)[0]!;
    resultValue(await f.reception.affirm(f.scope, f.turn("confirm-intake", "Yes"), intake.key, intake.digest, intakeNow));
    resultValue(await f.reception.drain(f.scope, f.callId, intakeNow));
    assert.equal(f.provider.patientPosts, 1); assert.equal(f.provider.bookingPosts, 0); await f.playPending();
    resultValue(await f.reception.readBookingMenu(f.scope, f.turn("menu"), "2026-10-08", "2026-10-08", intakeNow)); await f.playPending();
    resultValue(await f.reception.selectBookingMenu(f.scope, f.turn("select"), 2, intakeNow)); await f.playPending();
    const book = Object.values((await f.state()).actions).find(action => action.kind === "book")!;
    resultValue(await f.reception.affirm(f.scope, f.turn("confirm-book", "Yes"), book.key, book.digest, intakeNow));
    resultValue(await f.reception.drain(f.scope, f.callId, intakeNow));
    assert.equal(f.provider.bookingPosts, 1); assert.equal(f.provider.recalls.length, 1); assert.equal(f.mail.length, 1);
    assert.deepEqual(Object.values((await f.state()).actions).map(action => action.status), ["committed", "committed"]);
  } finally { f.flow.dispose(); await f.close(); }
});

test("E2E-297 call flow denies foreign queries, unsupported changes, aborted selection and disconnected private code input", async () => {
  const f = await bookingCallFlowFixture();
  try {
    const query = { scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.config.policyVersion,
      operation: "book" as const, signal: new AbortController().signal };
    for (const patch of [{ callId: "foreign" }, { sessionId: "foreign" }, { policyVersion: "foreign" },
      { scope: { ...f.scope, clinicId: "foreign" } }, { signal: AbortSignal.abort() }]) {
      assert.equal((await f.flow.startWorkflow({ ...query, ...patch })).ok, false);
    }
    assert.equal(f.mail.length, 0); assert.equal(f.allTraffic.length, 0);
    resultValue(await f.flow.choose("book")); const keypad = await privateVerify(f);
    f.lifetime.abort(); assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, false);
    assert.equal(keypad.blocked(), true); assert.equal(await keypad.accept("1"), "failed"); keypad.stop();
    assert.equal((await f.flow.choose("book")).ok, false); assert.equal(f.posts, 0); assert.equal(f.recalls.length, 0);
  } finally { f.flow.dispose(); await f.close(); }
});

test("E2E-298 abandoned workflow construction releases routing immediately and cannot publish a late owner or send mail", { timeout: 15_000 }, async () => {
  const f = await bookingCallFlowFixture(); f.flow.dispose();
  let release: () => void = () => undefined, entered: () => void = () => undefined, heldOnce = false;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const directory = { findByEmail: f.flowConfig.directory.findByEmail.bind(f.flowConfig.directory),
    async findByRef(ref: string) { if (!heldOnce) { heldOnce = true; entered(); await held; } return f.flowConfig.directory.findByRef(ref); } };
  const flow = resultValue(ClinikoCallFlow.create({ ...f.flowConfig, directory })), turn = new AbortController();
  try {
    const pending = flow.choose("book", turn.signal); await started; turn.abort();
    assert.equal((await pending).ok, false); assert.equal(flow.workflow, undefined); assert.equal(f.mail.length, 0);
    resultValue(await flow.choose("book")); assert.equal(flow.workflow, "book"); release();
    const input = await privateVerify({ ...f, flow }); assert.equal(input.blocked(), false); assert.equal(f.mail.length, 1);
    assert.equal(f.posts, 0); assert.equal(f.recalls.length, 0);
  } finally { release(); flow.dispose(); await f.close(); }
});
