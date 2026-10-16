// E2E-419: typed partial, terminal and retired stage receipts; admitted serving remains separate.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { classMovementOutcomeText, classMovementSummary, readClassMovementReceipt, stopClassMovement, uncertainClassMovement } from "../../src/core/class-movement-continuation.ts";
import type { ClassMovementState, PendingClassMovementStage } from "../../src/core/class-movement-continuation.ts";
import type { ClassMovementProgress, ClassMovementStage } from "../../src/core/class-movement-progress.ts";

const replacement: ClassMovementProgress = { original: "notSent", replacement: "inspectedActive", caseAssociation: "unlinked" };
const cancelled: ClassMovementProgress = { ...replacement, original: "inspectedCancelled" };
const next = (stage: ClassMovementStage, ordinal: number): PendingClassMovementStage => ({
  ref: `class-move-stage:${randomUUID()}`, contractVersion: "staged-contract-v1", ordinal, stage,
});
const receipt = (progress: ClassMovementProgress, stage: ClassMovementStage, ordinal: number) => ({
  kind: "classMovement", actionKey: "owned-action", outcome: "pending", progress, continuation: next(stage, ordinal),
});
function read(value: unknown, previous?: ClassMovementState) {
  const record = readClassMovementReceipt(value, previous); assert.ok(record); return record;
}

test("reader summaries retain fixed observations while withholding every live continuation reference", () => {
  const pending = read(receipt(replacement, "original", 1)).movement;
  const summary = classMovementSummary(pending);
  assert.deepEqual(summary, { outcome: "pending", progress: replacement });
  assert.ok(summary); assert.equal(Object.isFrozen(summary), true);
  assert.deepEqual(classMovementSummary(stopClassMovement(pending)), { outcome: "needsReview", progress: replacement });
  assert.equal(JSON.stringify(summary).includes("class-move-stage:"), false);
  assert.equal(classMovementSummary({ ...pending, progress: { ...replacement, nativePatientId: "private-canary" } }), undefined);
  let executed = 0;
  assert.equal(classMovementSummary({ ...pending, outcome: { toString() { executed++; return "moved"; } } }), undefined);
  const getter = { ...pending, get progress() { executed++; return replacement; } };
  assert.equal(classMovementSummary(getter), undefined);
  assert.equal(executed, 0);
});

test("result readers refuse terminal claims that contradict the native observations", () => {
  for (const progress of [replacement, cancelled, { ...cancelled, replacement: "uncertain" }])
    assert.equal(classMovementSummary({ outcome: "moved", progress }), undefined);
  for (const progress of [replacement, cancelled, { ...replacement, replacement: "inspectedCancelled", caseAssociation: "inspectedLinked" }])
    assert.equal(classMovementSummary({ outcome: "restored", progress }), undefined);
  for (const caseAssociation of ["inspectedLinked", "notApplicable"])
    assert.deepEqual(classMovementSummary({ outcome: "moved", progress: { ...cancelled, caseAssociation } }),
      { outcome: "moved", progress: { ...cancelled, caseAssociation } });
  assert.deepEqual(classMovementSummary({ outcome: "restored", progress: { ...replacement, replacement: "inspectedCancelled" } }),
    { outcome: "restored", progress: { ...replacement, replacement: "inspectedCancelled" } });
});

test("no-pass completion inspects both attendances without pretending a membership association", () => {
  const ordinary: ClassMovementProgress = { ...replacement, caseAssociation: "notApplicable" };
  const original = read(receipt(ordinary, "original", 1)).movement;
  const final = { kind: "classMovement", actionKey: "owned-action", outcome: "moved",
    progress: { ...ordinary, original: "inspectedCancelled" }, hostRef: "ordinary-native-receipt" };
  assert.equal(read(final, original).movement.outcome, "moved");
  assert.equal(read(final).movement.outcome, "needsReview");
  assert.equal(read({ ...final, progress: { ...final.progress, caseAssociation: "inspectedLinked" } }, original).movement.outcome, "needsReview");
  const pass = read(receipt(replacement, "original", 1)).movement;
  assert.equal(read(final, pass).movement.outcome, "needsReview", "a pass move cannot skip association by changing its mode");
  assert.equal(read(receipt({ ...ordinary, original: "inspectedCancelled", caseAssociation: "unlinked" }, "association", 2), original).movement.outcome, "needsReview");
});

test("movement receipts require distinct sequential stage references and final joint inspection", () => {
  const first = read(receipt(replacement, "original", 1));
  assert.equal(first.movement.outcome, "pending");
  const second = read(receipt(cancelled, "association", 2), first.movement);
  assert.equal(second.movement.outcome, "pending");
  const final = { kind: "classMovement", actionKey: "owned-action", outcome: "moved", progress: { ...cancelled, caseAssociation: "inspectedLinked" }, hostRef: "native-move-receipt" };
  assert.equal(read(final, second.movement).movement.outcome, "moved");
  assert.equal(read(final, second.movement).hostRef, "native-move-receipt");
  assert.equal(read(final, first.movement).movement.outcome, "needsReview", "an original cancellation acknowledgement cannot skip the membership stage");
  assert.equal(read(final).movement.outcome, "needsReview", "final-looking observations do not replace the owned stage sequence");
  assert.equal(read({ ...final, progress: cancelled }, second.movement).movement.outcome, "needsReview");
});

test("invalid continuation metadata retains native facts and cannot revive a retired stage", () => {
  const pending = read(receipt(replacement, "original", 1)).movement;
  assert.equal(pending.outcome, "pending");
  if (pending.outcome !== "pending") throw new Error("missing pending stage");
  const candidate = receipt(cancelled, "association", 2);
  for (const continuation of [
    { ...candidate.continuation, ref: pending.continuation.ref },
    { ...candidate.continuation, ordinal: 1 },
    { ...candidate.continuation, ordinal: 21 },
    { ...candidate.continuation, contractVersion: "changed-policy" },
    { ...candidate.continuation, stage: "compensation" },
    { ...candidate.continuation, verificationRef: "private-proof-canary" },
  ]) {
    const rejected = read({ ...candidate, continuation }, pending);
    assert.equal(rejected.movement.outcome, "needsReview");
    assert.deepEqual(rejected.movement.progress, cancelled);
    assert.equal(Object.hasOwn(rejected.movement, "continuation"), false);
    assert.equal(JSON.stringify(rejected).includes("private-proof-canary"), false);
  }
  const stopped = stopClassMovement(pending);
  assert.equal(stopped.outcome, "needsReview");
  assert.equal(Object.hasOwn(stopped, "continuation"), false);
  assert.deepEqual(stopped.progress, pending.progress);
  assert.equal(read(candidate, stopped).movement.outcome, "needsReview");
  const ended = readClassMovementReceipt(candidate, pending, false); assert.ok(ended);
  assert.equal(ended.movement.outcome, "needsReview");
  assert.deepEqual(ended.movement.progress, cancelled);
});

test("restoration is confirmed only after separately inspecting compensation", () => {
  const initial = read(receipt(replacement, "original", 1)).movement;
  const compensation = read(receipt(replacement, "compensation", 2), initial).movement;
  const uncertain: ClassMovementProgress = { ...replacement, replacement: "uncertain" };
  const inspection = read(receipt(uncertain, "compensationInspection", 3), compensation).movement;
  const restored = { kind: "classMovement", actionKey: "owned-action", outcome: "restored", progress: { ...replacement, replacement: "inspectedCancelled" } };
  assert.equal(read(restored, compensation).movement.outcome, "needsReview");
  const final = read(restored, inspection).movement;
  assert.equal(final.outcome, "restored");
  assert.match(classMovementOutcomeText(final), /original attendance was inspected as active.*replacement attendance as cancelled/);
  assert.equal(stopClassMovement(final), final, "a terminal inspection stays recorded after the call stops");
  assert.equal(read({ ...restored, progress: { ...replacement, original: "uncertain" } }, inspection).movement.outcome, "needsReview");
});

test("review wording retains partial effects without claiming completion, rollback, a refund or staff receipt", () => {
  const pending = read(receipt(replacement, "original", 1)).movement;
  assert.match(classMovementOutcomeText(pending), /fresh, separate confirmation/);
  const reviewed = stopClassMovement(pending), text = classMovementOutcomeText(reviewed);
  assert.match(text, /replacement attendance was last inspected as active/);
  assert.match(text, /clinic needs to review/);
  assert.doesNotMatch(text, /fresh, separate confirmation|Your class move is confirmed|No change was made|refund|charged|staff.*received/);
});

test("a possibly-sent next stage replaces obsolete not-sent claims without preserving resume authority", () => {
  const pending = read(receipt(replacement, "original", 1)).movement;
  const stopped = stopClassMovement(pending);
  for (const source of [pending, stopped]) {
    const uncertain = uncertainClassMovement(source);
    assert.equal(uncertain.outcome, "needsReview");
    assert.equal(uncertain.progress.original, "uncertain");
    assert.equal(uncertain.progress.replacement, "inspectedActive");
    assert.equal(Object.hasOwn(uncertain, "continuation"), false);
    const text = classMovementOutcomeText(uncertain);
    assert.match(text, /cannot confirm whether the original attendance was cancelled/);
    assert.doesNotMatch(text, /have not sent a cancellation/);
  }
  const association = read(receipt(cancelled, "association", 2), pending).movement;
  assert.equal(uncertainClassMovement(association).progress.caseAssociation, "uncertain");
  const compensation = read(receipt(replacement, "compensation", 2), pending).movement;
  assert.equal(uncertainClassMovement(compensation).progress.replacement, "uncertain");
  const inspection = read(receipt({ ...replacement, replacement: "uncertain" }, "compensationInspection", 3), compensation).movement;
  assert.deepEqual(uncertainClassMovement(inspection).progress, inspection.progress, "an interrupted read does not imply another mutation");
});
