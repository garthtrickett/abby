import assert from "node:assert/strict";
import test from "node:test";
import { classMoveStageRequestCeilings } from "../../src/cliniko/class-move-workload.ts";
import { ClinikoClassAttendanceMove } from "../../src/standalone/cliniko-class-attendance-move.ts";
import { declareClinikoRequestCost } from "../../src/cliniko/request-cost.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { classPassMoveFixture } from "../support/class-pass-move.ts";
import { classMoveFixture } from "../support/class-move.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("E2E-419 pass association and read-only inspection each admit a complete two-request proof ceiling", () => {
  const ceilings = classMoveStageRequestCeilings({ proof: 2, permit: 0, passSelect: 0, passAllow: 0 }, true);
  assert.ok(ceilings);
  assert.equal(ceilings.association, 99);
  assert.equal(ceilings.associationInspection, 97);
  assert.ok(Object.values(ceilings).every(value => value <= 180));
  assert.equal(classMoveStageRequestCeilings({ proof: 2, permit: 0, passSelect: 0, passAllow: 0 }, false)?.associationInspection, undefined);
});

test("E2E-419 complete stage admission cannot borrow a proof floor or unknown callback cost", async () => {
  const f = await classPassMoveFixture();
  try {
    const { stageRequestCosts, ...unknown } = f.config;
    const before = f.claims;
    const mover = resultValue(ClinikoClassAttendanceMove.create({ ...unknown, proofNativeRequestFloor: 1, quotaStaging: { version: "cost-v1" } }));
    assert.equal(mover.prepareStagesOnce(f.request).ok, false);
    assert.equal(f.claims, before); assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
    for (const costs of [undefined, { proof: 1 }, { ...stageRequestCosts, proof: -1 }, { ...stageRequestCosts, proof: NaN },
      { ...stageRequestCosts, proof: 200 }, { ...stageRequestCosts, permit: 200 }]) {
      assert.equal(classMoveStageRequestCeilings(costs, true), undefined);
    }
    let getters = 0;
    assert.equal(classMoveStageRequestCeilings({ ...stageRequestCosts, get proof() { getters++; return 0; } }, true), undefined);
    assert.equal(getters, 0);
    const costs = { ...stageRequestCosts };
    const captured = resultValue(ClinikoClassAttendanceMove.create({ ...f.config, quotaStaging: { version: "cost-v1" }, stageRequestCosts: costs }));
    costs.proof = 200;
    assert.equal(captured.prepareStagesOnce(f.request).ok, true, "capture the exact trusted cost declaration rather than hot-loading its mutable input");
    assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
  } finally { f.lifetime.abort(); }
});

for (const pass of [false, true]) for (const cost of ["unknown", "foreignAccount", "tooLarge"] as const)
test(`E2E-419 ${pass ? "pass" : "ordinary"} caller refuses ${cost} movement cost before a SAM proposal or clinical mutation`, async () => {
  const f = await classMoveFixture(false, false, pass ? {} : undefined, true), at = () => f.config.clock();
  try {
    const original = f.config.permission.allows, binding = { scope: f.scope, credentialFingerprint: clinikoCredentialFingerprint(f.native.config.apiKey), budget: f.config.cliniko.rateBudget };
    const allows = cost === "unknown" ? (...args: Parameters<typeof original>) => original(...args) :
      declareClinikoRequestCost(original, cost === "foreignAccount" ? { ...binding, credentialFingerprint: clinikoCredentialFingerprint("foreign-au5") } : binding,
        cost === "tooLarge" ? 200 : 0);
    Object.assign(f.config.permission, { allows });
    await f.verify();
    resultValue(await f.reception.readReschedulingMenu(f.scope, f.turn("targets"), "targets", "2026-10-08", "2026-10-08", at())); await f.play();
    resultValue(await f.reception.selectReschedulingMenu(f.scope, f.turn("target"), "targets", 1, at())); await f.play();
    resultValue(await f.reception.readReschedulingMenu(f.scope, f.turn("offers"), "offers", "2026-10-09", "2026-10-09", at())); await f.play();
    resultValue(await f.reception.selectReschedulingMenu(f.scope, f.turn("offer"), "offers", 1, at()));
    assert.equal(Object.keys((await f.state()).actions).length, 0);
    assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
  } finally { await f.close(); }
});

for (const when of ["beforeReadback", "afterAffirmation"] as const)
test(`E2E-419 changed callback cost ${when} retires a private stage without another native mutation`, async () => {
  const f = await classMoveFixture(false, false, undefined, true), at = () => f.config.clock();
  try {
    await f.verify(); const initial = await f.prepare(); await f.play(); await f.pause(61);
    resultValue(await f.reception.affirm(f.scope, f.turn("initial-yes", "Yes"), initial.key, initial.digest, at()));
    resultValue(await f.reception.drain(f.scope, f.callId, at())); await f.play(); await f.pause(61);
    if (when === "afterAffirmation") {
      const state = resultValue(await f.reception.continueClassMovement(f.scope, f.turn("continue", "Continue my class move")));
      const current = state.actions[initial.key]!; await f.play();
      resultValue(await f.reception.affirm(f.scope, f.turn("phase-yes", "Yes"), current.key, current.classMovementConsent!.digest, at()));
    }
    const original = f.config.permission.allows;
    Object.assign(f.config.permission, { allows: (...args: Parameters<typeof original>) => original(...args) });
    const before = f.claims;
    const state = when === "beforeReadback" ? resultValue(await f.reception.continueClassMovement(f.scope, f.turn("continue", "Continue my class move"))) :
      resultValue(await f.reception.drain(f.scope, f.callId, at()));
    assert.equal(state.actions[initial.key]!.status, "needsReview");
    assert.equal(f.claims, before, "unknown replacement callback cannot spend the old declaration's allocation");
    assert.equal(f.writes.length, 1); assert.equal(f.native.attendees.find(row => row.id === "101")!.cancelled_at, null);
  } finally { await f.close(); }
});


for (const staged of [false, true]) test(`E2E-419 large cross-case pass menu uses ${staged ? "complete separate phase ceilings" : "the legacy whole-window gate"}`, async () => {
  const f = await classMoveFixture(true, false, { differentCase: true, history: 999, rosterHistory: 201 }, staged);
  const at = () => f.config.clock();
  try {
    await f.verify();
    if (staged) {
      const action = await f.prepare();
      assert.equal(action.status, "awaitingConfirmation");
      assert.match(f.steps.find(step => step.stage === "offers")!.text, /option one/);
    } else {
      resultValue(await f.reception.readReschedulingMenu(f.scope, f.turn("targets"), "targets", "2026-10-08", "2026-10-08", at())); await f.play();
      resultValue(await f.reception.selectReschedulingMenu(f.scope, f.turn("target"), "targets", 1, at())); await f.play();
      resultValue(await f.reception.readReschedulingMenu(f.scope, f.turn("offers"), "offers", "2026-10-09", "2026-10-09", at()));
      assert.match((await f.state()).callerMessages.at(-1)!, /couldn't find an eligible/);
      assert.equal(Object.keys((await f.state()).actions).length, 0);
    }
    assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
    assert.ok(f.windowClaims.every(count => count <= 180));
  } finally { await f.close(); }
});
