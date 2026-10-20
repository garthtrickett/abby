// E2E-419: fixed public observations and safe next-stage predicates; admitted serving remains separate.
import assert from "node:assert/strict";
import test from "node:test";
import { classMovementCanContinue, classMovementProgressText, readClassMovementProgress } from "../../src/core/class-movement-progress.ts";
import type { ClassMovementProgress, ClassMovementStage } from "../../src/core/class-movement-progress.ts";

const empty: ClassMovementProgress = { original: "notSent", replacement: "notSent", caseAssociation: "notSent" };
const replacement: ClassMovementProgress = { original: "notSent", replacement: "inspectedActive", caseAssociation: "unlinked" };
const originalCancelled: ClassMovementProgress = { ...replacement, original: "inspectedCancelled" };
const stages: readonly ClassMovementStage[] = ["replacement", "original", "association", "associationInspection", "compensation", "compensationInspection"];

test("a no-pass move has no association stage or invented membership uncertainty", () => {
  const ordinary: ClassMovementProgress = { ...replacement, caseAssociation: "notApplicable" };
  assert.deepEqual(stages.filter(stage => classMovementCanContinue(ordinary, stage)), ["original", "compensation"]);
  assert.deepEqual(stages.filter(stage => classMovementCanContinue({ ...ordinary, original: "inspectedCancelled" }, stage)), []);
  assert.deepEqual(stages.filter(stage => classMovementCanContinue({ ...ordinary, replacement: "uncertain" }, stage)), ["compensationInspection"]);
  assert.match(classMovementProgressText(ordinary), /no membership case association stage/);
  assert.doesNotMatch(classMovementProgressText(ordinary), /membership association is not confirmed|cannot confirm whether the membership association/);
});

test("class movement progress distinguishes replacement creation, original cancellation and membership association", () => {
  assert.deepEqual(stages.filter(stage => classMovementCanContinue(empty, stage)), ["replacement"]);
  assert.deepEqual(stages.filter(stage => classMovementCanContinue(replacement, stage)), ["original", "compensation"],
    "the live host must independently choose its actual next stage; public observations do not choose a mutation");
  assert.deepEqual(stages.filter(stage => classMovementCanContinue(originalCancelled, stage)), ["association"]);
  assert.deepEqual(stages.filter(stage => classMovementCanContinue({ ...originalCancelled, caseAssociation: "uncertain" }, stage)), ["associationInspection"],
    "only the private accepted-link owner can offer read-only inspection; these public facts cannot replay association");
  assert.deepEqual(stages.filter(stage => classMovementCanContinue({ ...originalCancelled, caseAssociation: "inspectedLinked" }, stage)), [],
    "finished observations are not authority to repeat the membership mutation");
  for (const progress of [empty, replacement, originalCancelled, { ...originalCancelled, caseAssociation: "inspectedLinked" }]) {
    assert.match(classMovementProgressText(progress), /overall class move is not confirmed/);
  }
  assert.match(classMovementProgressText(replacement), /have not sent a cancellation for the original/);
  assert.match(classMovementProgressText(originalCancelled), /original attendance was last inspected as cancelled/);
  assert.match(classMovementProgressText(originalCancelled), /without its new membership association/);
});

test("an unknown original cancellation blocks both another cancellation and compensation", () => {
  const progress: ClassMovementProgress = { ...replacement, original: "uncertain" };
  assert.deepEqual(stages.filter(stage => classMovementCanContinue(progress, stage)), []);
  const text = classMovementProgressText(progress);
  assert.match(text, /cannot confirm whether the original attendance was cancelled/);
  assert.match(text, /replacement attendance was last inspected as active/);
  assert.doesNotMatch(text, /original.*remains unchanged|No change was made|move is confirmed|refund|charged|staff.*received/);
});

test("compensation inspection remains separate from another attendance mutation", () => {
  const pending: ClassMovementProgress = { ...replacement, replacement: "uncertain" };
  assert.deepEqual(stages.filter(stage => classMovementCanContinue(pending, stage)), ["compensationInspection"]);
  const inspected: ClassMovementProgress = { ...replacement, replacement: "inspectedCancelled" };
  assert.deepEqual(stages.filter(stage => classMovementCanContinue(inspected, stage)), []);
  assert.match(classMovementProgressText(pending), /cannot confirm the replacement attendance status/);
  assert.match(classMovementProgressText(inspected), /replacement attendance was last inspected as cancelled/);
  assert.match(classMovementProgressText(inspected), /have not sent a cancellation for the original/);
});

test("unexpected native facts remain recordable but cannot authorize another stage", () => {
  const externalChange: ClassMovementProgress = { original: "inspectedCancelled", replacement: "inspectedCancelled", caseAssociation: "uncertain" };
  assert.deepEqual(readClassMovementProgress(externalChange), externalChange);
  assert.deepEqual(stages.filter(stage => classMovementCanContinue(externalChange, stage)), []);
  const text = classMovementProgressText(externalChange);
  assert.match(text, /original attendance was last inspected as cancelled/);
  assert.match(text, /replacement attendance was last inspected as cancelled/);
  assert.match(text, /cannot confirm whether the membership association was changed/);
});

test("public movement records exclude native identifiers, hidden values and executable accessors", () => {
  const privateValue = "private-movement-proof-canary";
  let getterReads = 0;
  const accessor = { ...replacement };
  Object.defineProperty(accessor, "original", { enumerable: true, get() { getterReads++; return "notSent"; } });
  const hidden = { ...replacement };
  Object.defineProperty(hidden, "verificationRef", { enumerable: false, value: privateValue });
  const symbol = { ...replacement, [Symbol("nativeOwner")]: privateValue };
  const inherited = Object.assign(Object.create({ verificationRef: privateValue }), replacement);
  for (const value of [undefined, null, [], {}, { ...replacement, verificationRef: privateValue }, hidden, symbol, inherited, accessor,
    { ...replacement, replacement: privateValue }, { ...replacement, caseAssociation: "accepted" },
    { kind: "needsReview", ...replacement, replacementAttendeeRef: privateValue }]) {
    assert.equal(readClassMovementProgress(value), undefined);
    for (const stage of stages) assert.equal(classMovementCanContinue(value, stage), false);
    const text = classMovementProgressText(value);
    assert.match(text, /clinic needs to review/);
    assert.equal(text.includes(privateValue), false);
  }
  assert.equal(getterReads, 0);
});

test("public observations are copied before callers can mutate their native source", () => {
  const source = { ...replacement };
  const observed = readClassMovementProgress(source); assert.ok(observed);
  assert.notEqual(observed, source); assert.equal(Object.isFrozen(observed), true);
  source.original = "uncertain";
  assert.equal(observed.original, "notSent");
  assert.equal(classMovementCanContinue(observed, "original"), true);
  assert.equal(classMovementCanContinue(source, "original"), false);
});
