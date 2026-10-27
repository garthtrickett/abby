import assert from "node:assert/strict";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { representativeCallOwnerFixture, representativeInputOptions } from "./representative-call-owner.ts";
import { syntheticMultiTaskBookingProvider, syntheticTaskSequence } from "./call-task-sequence.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { verificationNow } from "./caller-verification.ts";
import type { ClinikoBookingMemoConfig } from "../../src/standalone/cliniko-booking-memo.ts";

export async function representativeTaskSequenceFixture(mode = "independentlyVerifiedPatients", supplied?: Readonly<{
  caller: Awaited<ReturnType<typeof representativeCallOwnerFixture>>; memo?: ClinikoBookingMemoConfig; clock: () => string
}>) {
  const f = supplied?.caller ?? await representativeCallOwnerFixture({ multiplePatients: true }); f.flow.dispose();
  const clock = supplied?.clock ?? (() => verificationNow);
  const turn = (id: string, text?: string) => ({ ...f.f.turn(id, text), at: clock() });
  const play = async () => {
    if (!supplied) return f.play();
    const pending = (await f.f.state()).pendingPresentationId!; assert.ok(pending);
    resultValue(await f.f.runtime.startPresentation(f.f.callId, pending, f.f.sessionId, clock()));
    resultValue(await f.f.runtime.resolvePresentation(f.f.callId, pending, "played", f.f.sessionId, clock()));
  };
  const native = syntheticMultiTaskBookingProvider();
  const source = await syntheticTaskSequence({ ...f.flowConfig, ...(supplied ? { ...(supplied.memo ? { memo: supplied.memo } : {}), clock } : {}), representativeInput: representativeInputOptions(f), fetchPort: native.wrap(f.flowConfig.fetchPort) }, f.f.folder);
  await source.replace({ patientSelection: mode });
  const flow = resultValue(ClinikoCallFlow.create(source.config)), reception = new TextReception(f.f.ledger, f.f.policies, flow, undefined, undefined, undefined, undefined, supplied?.clock);
  let sequence = 0;
  const start = async () => {
    const startedTurn = turn(`representative-task-${++sequence}`, "Book for another person");
    const result = await reception.startWorkflow(f.f.scope, startedTurn, "book", clock(), (await f.f.state()).conversationRevision,
      undefined, false, undefined, true);
    resultValue(result); await play();
    const owner = flow.representativeInputOwner; assert.ok(owner); return owner;
  };
  const verify = async (id: "43" | "44", verifySubject = true) => {
    const owner = await start(), count = f.mail.length;
    assert.equal(owner.beginCallerVerification(), true); await f.waitForMail(count + 1);
    assert.equal((await owner.submitCallerCode(f.mail.at(-1)!.code)).verified, true);
    const patient = f.r.patients.get(id)!;
    resultValue(await owner.selectPatient({ firstName: patient.first_name, lastName: patient.last_name, dateOfBirth: patient.date_of_birth }));
    assert.equal(owner.beginPatientVerification(), true); await f.waitForMail(count + 2);
    if (verifySubject) assert.equal((await flow.submitCode(f.mail.at(-1)!.code)).verified, true); return owner;
  };
  const book = async () => {
    resultValue(await reception.readBookingMenu(f.f.scope, turn(`menu-${sequence}`), "2026-10-08", "2026-10-08", clock())); await play();
    resultValue(await reception.selectBookingMenu(f.f.scope, turn(`choice-${sequence}`), 1, clock())); await play();
    const action = Object.values((await f.f.state()).actions).at(-1)!; assert.equal(action.status, "awaitingConfirmation");
    resultValue(await reception.affirm(f.f.scope, turn(`yes-${sequence}`, "Yes"), action.key, action.digest, clock()));
    resultValue(await reception.drain(f.f.scope, f.f.callId, clock())); await play();
    return (await f.f.state()).actions[action.key]!;
  };
  return { ...f, flow, reception, source, native, start, verify, book, play, closeSequence: async () => { flow.dispose(); await f.close(); } };
}
