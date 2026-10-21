import assert from "node:assert/strict";
import test from "node:test";
import { decodeAdministrativeMemo, administrativeMemoActionRef } from "../../src/cliniko/administrative-memo.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { classMovementMemoFixture } from "../support/class-movement-memo.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

for (const passes of [false, true]) test(`actual staged ${passes ? "pass" : "ordinary"} move publishes one final independently permitted workflow report`, async t => {
  const f = await classMovementMemoFixture({ passes, admitted: true }); t.after(f.close); const action = await f.initial();
  assert.equal((await f.state()).actions[action.key]!.status, "pendingContinuation"); assert.equal(f.memoPosts.length, 0); assert.equal(f.consumed.size, 0);
  for (const stage of passes ? ["original", "association", "associationInspection"] : ["original"]) {
    await f.next(action.key);
    if (stage !== (passes ? "associationInspection" : "original")) { assert.equal(f.memoPosts.length, 0); assert.equal(f.consumed.size, 0); }
  }
  assert.equal((await f.state()).actions[action.key]!.status, "committed"); await f.memoSettled;
  const memo = resultValue(decodeAdministrativeMemo(f.memoPosts[0]!.content)); assert.ok(memo.outcome.kind === "classMovementReported");
  assert.equal(memo.outcome.completion, "moved"); assert.equal(memo.outcome.progress.original, "inspectedCancelled");
  assert.equal(memo.outcome.progress.caseAssociation, passes ? "inspectedLinked" : "notApplicable");
  const review = resultValue(decodeClinikoReview(f.recalls[0]!.notes)).request.operation; assert.ok(review.kind === "classMove");
  assert.equal(memo.sourceActionRef, review.attendanceActionId); assert.equal(memo.actionRef, administrativeMemoActionRef(review.attendanceActionId));
  assert.equal(f.memoPosts.length, 1); f.host.dispose(); await f.host.reconcile(action.mutation); assert.equal(f.memoPosts.length, 1);
});

for (const mode of ["accepted", "lostStored", "lostUnstored", "nonexact"] as const)
test(`disposing a paused move retains partial truth without another clinical effect: ${mode}`, async t => {
  const f = await classMovementMemoFixture({ passes: true, mode }); t.after(f.close); const action = await f.initial();
  assert.equal(f.writes.length, 1); assert.equal(f.memoPosts.length, 0); await f.pause(61); f.host.dispose(); await f.memoSettled;
  const memo = resultValue(decodeAdministrativeMemo(f.memoPosts[0]!.content)); assert.ok(memo.outcome.kind === "classMovementReported");
  assert.equal(memo.outcome.completion, "needsReview"); assert.equal(memo.outcome.progress.original, "notSent");
  assert.equal(memo.outcome.progress.replacement, "inspectedActive"); assert.equal(memo.outcome.progress.caseAssociation, "unlinked");
  assert.equal(f.outcomes[0]!.kind, mode === "accepted" ? "accepted" : "uncertain");
  assert.equal(f.native.attendees.find(row => row.id === "101")!.cancelled_at, null);
  const count = f.writes.length; await f.reception.drain(f.scope, f.callId, f.config.clock()); assert.equal(f.writes.length, count);
  assert.equal(f.memoPosts.length, 1); assert.notEqual((await f.state()).actions[action.key]!.status, "committed");
});

for (const lost of ["original", "replacement"] as const)
test(`lost ${lost} response is a review report, never a completed move memo or replay`, async t => {
  const f = await classMovementMemoFixture({ passes: true }); t.after(f.close); if (lost === "replacement") f.lose(lost);
  const action = await f.initial();
  if (lost === "original") { f.lose(lost); await f.next(action.key); }
  await f.memoSettled; const memo = resultValue(decodeAdministrativeMemo(f.memoPosts[0]!.content)); assert.ok(memo.outcome.kind === "classMovementReported");
  assert.equal(memo.outcome.completion, "needsReview"); assert.equal(memo.outcome.progress[lost], "uncertain");
  const writes = f.writes.length; await f.reception.drain(f.scope, f.callId, f.config.clock()); assert.equal(f.writes.length, writes);
  assert.notEqual((await f.state()).actions[action.key]!.status, "committed"); assert.equal(f.memoPosts.length, 1);
});

for (const denied of ["producer", "allowed"] as const)
test(`independent ${denied} denial preserves the partial move without a memo`, async t => {
  const f = await classMovementMemoFixture(); t.after(f.close); await f.initial(); await f.pause(61); f.gates[denied] = false; f.host.dispose(); await f.memoSettled;
  assert.equal(f.memoPosts.length, 0); assert.equal(f.writes.length, 1); assert.equal(f.consumed.size, 0);
});

test("a completed move returns while memo permission is held; disposal cannot send another stage", async t => {
  const f = await classMovementMemoFixture(); t.after(f.close); const action = await f.initial(); let release!: () => void;
  f.gates.hold = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.next(action.key); assert.equal((await f.state()).actions[action.key]!.status, "committed"); assert.equal(f.outcomes.length, 0);
    f.host.dispose(); release(); await f.memoSettled; assert.equal(f.outcomes[0]!.kind, "accepted"); assert.equal(f.writes.length, 2);
  } finally { release(); }
});

for (const result of ["moved", "restored", "lostOriginal", "lostCompensation"] as const)
test(`non-staged actual admitted movement memo retains ${result} without changing the clinical result`, async t => {
  const f = await classMovementMemoFixture({ staged: false, admitted: true }); t.after(f.close);
  if (result === "restored" || result === "lostCompensation") f.phasePermission(phase => phase !== "cancelOriginal");
  if (result === "lostOriginal") f.lose("original"); if (result === "lostCompensation") f.lose("compensation");
  const action = await f.initial(); await f.memoSettled;
  const memo = resultValue(decodeAdministrativeMemo(f.memoPosts[0]!.content)); assert.ok(memo.outcome.kind === "classMovementReported");
  assert.equal(memo.outcome.completion, result === "moved" || result === "restored" ? result : "needsReview");
  assert.equal((await f.state()).actions[action.key]!.status, result === "moved" ? "committed" : result === "restored" ? "rejected" : "uncertain");
  assert.equal(f.writes.length, 2); assert.equal(f.memoPosts.length, 1);
});

test("disposal during an actual original PATCH waits for that owned uncertainty report without another clinical stage", async t => {
  const f = await classMovementMemoFixture({ passes: true }); t.after(f.close); const action = await f.initial();
  f.onWrite(phase => { if (phase === "original") f.host.dispose(); });
  await f.next(action.key); await f.memoSettled;
  const memo = resultValue(decodeAdministrativeMemo(f.memoPosts[0]!.content)); assert.ok(memo.outcome.kind === "classMovementReported");
  assert.equal(memo.outcome.completion, "needsReview"); assert.equal(memo.outcome.progress.original, "uncertain");
  assert.equal(f.writes.length, 2); assert.equal(f.memoPosts.length, 1);
  assert.notEqual((await f.state()).actions[action.key]!.status, "committed");
});

test("no owned clinical effect means no memo or spent purpose after an unknown review", async t => {
  const f = await classMovementMemoFixture(); t.after(f.close); f.lose("review"); await f.initial(); f.host.dispose();
  assert.equal(f.writes.length, 0); assert.equal(f.memoPosts.length, 0); assert.equal(f.consumed.size, 0); assert.equal(f.outcomes.length, 0);
});
