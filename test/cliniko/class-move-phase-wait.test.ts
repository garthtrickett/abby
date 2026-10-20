// E2E-419: a native phase quota wait is listening metadata, never consent or a send.
import assert from "node:assert/strict";
import test from "node:test";
import { classMoveFixture } from "../support/class-move.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { ClinikoPatientCandidateReader } from "../../src/cliniko/patients.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { declareClinikoRequestCost } from "../../src/cliniko/request-cost.ts";

async function waitingPassProposal() {
  const f = await classMoveFixture(true, false, { differentCase: true, history: 999, rosterHistory: 201 }, true), at = () => f.config.clock();
  try {
    const binding = { scope: f.scope, credentialFingerprint: clinikoCredentialFingerprint(f.native.config.apiKey), budget: f.config.cliniko.rateBudget };
    const reader = resultValue(ClinikoPatientCandidateReader.create({ scope: f.scope, apiKey: f.native.config.apiKey,
      contactEmail: f.native.config.contactEmail, rateBudget: binding.budget }, f.fetchPort, at));
    const original = f.sessionConfig.lookup.candidates;
    f.sessionConfig.lookup.candidates = declareClinikoRequestCost(async (...args: Parameters<typeof original>) => {
      assert.equal(resultValue(await reader.hasCurrentPhone(f.scope, "482746192837465", f.inbound.presentedCallerNumber!, "61")), true);
      return original(...args);
    }, binding, 1);
    await f.verify();
    resultValue(await f.reception.readReschedulingMenu(f.scope, f.turn("targets"), "targets", "2026-10-08", "2026-10-08", at())); await f.play();
    resultValue(await f.reception.selectReschedulingMenu(f.scope, f.turn("target"), "targets", 1, at())); await f.play();
    const options = resultValue(await f.reception.readReschedulingMenu(f.scope, f.turn("offers"), "offers", "2026-10-09", "2026-10-09", at()));
    const oldMenuAt = Date.parse(at()); await f.play();
    const before = f.claims;
    const waiting = resultValue(await f.reception.selectReschedulingMenu(f.scope, f.turn("choose", "one"), "offers", 1, at()));
    return { f, options, oldMenuAt, before, waiting };
  } catch (error) { await f.close(); throw error; }
}

test("maximum-history pass selection waits before consuming a two-request proof and issues a fresh inspected quote", async () => {
  const { f, options, oldMenuAt, before, waiting } = await waitingPassProposal(), at = () => f.config.clock();
  try {
    assert.equal(f.claims, before, "headroom precedes protected selection/proposal proof");
    const notice = waiting.presentations[waiting.pendingPresentationId!]!;
    assert.ok(notice.kind === "notice" && notice.confirmationWaitSeconds === 60);
    assert.match(notice.approvedText, /wait about 60 seconds.*choose your option again/i);
    assert.equal(Object.keys(waiting.actions).length, 0); assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
    assert.ok(options.pendingPresentationId);
    await f.play(); await f.pause(61);
    const proposed = resultValue(await f.reception.selectReschedulingMenu(f.scope, f.turn("choose-again", "one"), "offers", 1, at()));
    const action = Object.values(proposed.actions).at(-1)!;
    assert.equal(action.status, "awaitingConfirmation"); assert.ok(action.mutation.request.kind === "reschedule");
    assert.ok(Date.parse(action.mutation.request.terms.expiresAt) > oldMenuAt + 120000,
      "fresh native inspection issues a distinct quote, without extending the old menu's selection lifetime");
    await f.play(); await f.pause(61);
    resultValue(await f.reception.affirm(f.scope, f.turn("initial-yes", "Yes"), action.key, action.digest, at()));
    resultValue(await f.reception.drain(f.scope, f.callId, at()));
    assert.equal(f.writes.length, 1); assert.equal((await f.state()).actions[action.key]!.status, "pendingContinuation");
    assert.ok(f.windowClaims.every(count => count <= 180));
  } finally { await f.close(); }
});

for (const fault of ["unplayed", "expiredMenu", "permission", "policy", "fullDestination"] as const)
test(`a staged selection wait cannot bypass ${fault} on the next choice`, async () => {
  const { f } = await waitingPassProposal(), at = () => f.config.clock();
  try {
    if (fault !== "unplayed") await f.play();
    await f.pause(fault === "expiredMenu" ? 121 : 61);
    if (fault === "permission") f.permit(false);
    if (fault === "policy") await f.replaceMove({ revision: "changed-after-wait" });
    if (fault === "fullDestination") f.native.groups.find(row => row.id === "94")!.max_attendees = 0;
    await f.reception.selectReschedulingMenu(f.scope, f.turn("retry-choice", "one"), "offers", 1, at());
    assert.equal(Object.keys((await f.state()).actions).length, 0);
    assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
  } finally { await f.close(); }
});

test("a freshly inspected staged quote still expires without renewal from confirmation or reads", async () => {
  const { f } = await waitingPassProposal(), at = () => f.config.clock();
  try {
    await f.play(); await f.pause(61);
    const state = resultValue(await f.reception.selectReschedulingMenu(f.scope, f.turn("retry-choice", "one"), "offers", 1, at()));
    const action = Object.values(state.actions).at(-1)!; assert.equal(action.status, "awaitingConfirmation");
    const original = structuredClone(action.mutation.request);
    await f.play(); await f.pause(121);
    await f.reception.affirm(f.scope, f.turn("expired-yes", "Yes"), action.key, action.digest, at());
    await f.reception.drain(f.scope, f.callId, at());
    assert.deepEqual((await f.state()).actions[action.key]!.mutation.request, original);
    assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
  } finally { await f.close(); }
});

for (const seconds of [0, 61, NaN]) test(`selection quota notice rejects invalid wait ${seconds} without changing the call`, async () => {
  const f = await classMoveFixture(false, false, undefined, true);
  try {
    await f.play(); const before = await f.state();
    assert.equal((await f.runtime.acceptTurn(f.turn("bad-selection-wait", "one"),
      { kind: "reschedulingMenuWait", seconds }, f.config.clock())).ok, false);
    assert.deepEqual(await f.state(), before); assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test("staged caller waits for actual phase headroom before protected preparation without losing its owner", async () => {
  const f = await classMoveFixture(false, false, undefined, true), signal = new AbortController().signal;
  try {
    await f.verify(); const initial = await f.prepare(); await f.play(); await f.pause(61);
    resultValue(await f.reception.affirm(f.scope, f.turn("initial-yes", "Yes"), initial.key, initial.digest, f.config.clock()));
    resultValue(await f.reception.drain(f.scope, f.callId, f.config.clock())); await f.play();
    let claimed = 0;
    while (await f.config.cliniko.rateBudget.claim() === null) assert.ok(++claimed <= 180);
    const writes = f.writes.length, mail = f.mail.length;
    const next = resultValue(await f.reception.continueClassMovement(f.scope, f.turn("wait", "Continue my class move")));
    const id = next.pendingPresentationId!; assert.ok(id);
    const notice = next.presentations[id]!; assert.equal(notice.kind, "notice");
    assert.ok(notice.kind === "notice" && notice.confirmationWaitSeconds === 60);
    assert.match(notice.approvedText, /wait about 60 seconds.*ask to continue/);
    assert.equal(next.actions[initial.key]!.status, "pendingContinuation");
    assert.equal(next.actions[initial.key]!.classMovementConsent, undefined);
    assert.equal(f.writes.length, writes); assert.equal(f.mail.length, mail);
    await f.play(); await f.pause(61);
    const ready = resultValue(await f.reception.continueClassMovement(f.scope, f.turn("again", "Continue my class move")));
    assert.equal(ready.actions[initial.key]!.status, "awaitingConfirmation");
    assert.equal(f.writes.length, writes);
  } finally { await f.close(); }
});

for (const seconds of [0, 61, NaN]) test(`phase quota notice rejects invalid wait ${seconds} without changing the pending action`, async () => {
  const f = await classMoveFixture(false, false, undefined, true);
  try {
    await f.verify(); const initial = await f.prepare(); await f.play(); await f.pause(61);
    resultValue(await f.reception.affirm(f.scope, f.turn("initial-yes", "Yes"), initial.key, initial.digest, f.config.clock()));
    resultValue(await f.reception.drain(f.scope, f.callId, f.config.clock())); await f.play();
    const before = await f.state();
    const result = await f.runtime.acceptTurn(f.turn("bad-wait", "Continue my class move"),
      { kind: "classMovementPreparation", actionKey: initial.key, preparation: { kind: "quotaWait", seconds } }, f.config.clock());
    assert.equal(result.ok, false); assert.deepEqual(await f.state(), before); assert.equal(f.writes.length, 1);
  } finally { await f.close(); }
});

test("aborting a held phase headroom query preserves the private owner and cannot publish late", { timeout: 10000 }, async () => {
  const f = await classMoveFixture(false, false, undefined, true), external = new AbortController();
  let release!: (value: null) => void;
  const held = new Promise<null>(resolve => { release = resolve; });
  const budget = f.config.cliniko.rateBudget, check = budget.checkHeadroom;
  try {
    await f.verify(); const initial = await f.prepare(); await f.play(); await f.pause(61);
    resultValue(await f.reception.affirm(f.scope, f.turn("initial-yes", "Yes"), initial.key, initial.digest, f.config.clock()));
    resultValue(await f.reception.drain(f.scope, f.callId, f.config.clock())); await f.play(); await f.pause(61);
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    Object.defineProperty(budget, "checkHeadroom", { configurable: true, value: () => { entered(); return held; } });
    const pending = f.host.prepareClassMovementContinuation(initial.key, external.signal);
    await started; const before = await f.state(); external.abort();
    assert.equal((await pending).ok, false); assert.deepEqual(await f.state(), before);
    release(null); await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(await f.state(), before); assert.equal(f.writes.length, 1);
    Object.defineProperty(budget, "checkHeadroom", { configurable: true, value: check });
    assert.equal(resultValue(await f.host.prepareClassMovementContinuation(initial.key, new AbortController().signal)).kind, "ready");
  } finally { release(null); Object.defineProperty(budget, "checkHeadroom", { configurable: true, value: check }); await f.close(); }
});
