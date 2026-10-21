import assert from "node:assert/strict";
import test from "node:test";
import { decodeAdministrativeMemo, administrativeMemoActionRef } from "../../src/cliniko/administrative-memo.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { classCancellationMemoFixture } from "../support/class-cancellation-memo.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

for (const mode of ["accepted", "lostStored", "lostUnstored", "nonexact"] as const)
test(`actual admitted ordinary class cancellation retains one independently permitted observed memo: ${mode}`, async t => {
  const f = await classCancellationMemoFixture({ mode }); t.after(f.close); const action = await f.prepare(); await f.drain();
  assert.equal((await f.state()).actions[action.key]!.status, "committed"); assert.equal(f.writes.length, 1); assert.equal(f.memoPosts.length, 1);
  assert.equal(f.outcomes[0]!.kind, mode === "accepted" ? "accepted" : "uncertain"); assert.equal(f.memoRows.length, mode === "lostUnstored" ? 0 : 1);
  const memo = decodeAdministrativeMemo(f.memoPosts[0]!.content), review = decodeClinikoReview(f.recalls[0]!.notes); assert.ok(memo.ok && review.ok);
  assert.equal(memo.value.sourceActionRef, review.value.marker); assert.equal(memo.value.actionRef, administrativeMemoActionRef(review.value.marker));
  assert.equal(memo.value.outcome.kind, "classCancellationObserved"); assert.equal(memo.value.outcome.appointmentRef, "cliniko:booking:91");
  assert.equal(memo.value.outcome.attendeeRef, "cliniko:attendee:101"); assert.equal(memo.value.outcome.verification.basis, "acknowledgedAndObservedBestEffort");
  assert.equal(memo.value.outcome.verification.observedAt, memo.value.occurredAt); assert.equal(memo.value.patientId, verificationCanaries[2]);
  assert.equal(String(f.memoPosts[0]!.content).includes(f.pass.caseId), false); assert.equal(memo.value.direction, "inbound");
  await f.drain(); assert.equal(f.writes.length, 1); assert.equal(f.memoPosts.length, 1);
});

for (const denial of ["allowed", "producer"] as const)
test(`ordinary class cancellation remains known when its independent memo ${denial} grant is denied`, async t => {
  const f = await classCancellationMemoFixture(); t.after(f.close); const action = await f.prepare(); f.gates[denial] = false;
  await f.drain(); assert.equal((await f.state()).actions[action.key]!.status, "committed"); assert.equal(f.writes.length, 1);
  assert.equal(f.memoPosts.length, 0); assert.equal(f.consumed.size, 0); assert.equal(f.outcomes[0]!.kind, "unavailable");
});

for (const fault of ["lostWrite", "lostReview", "foreignInspection"] as const)
test(`class cancellation ${fault} cannot become an observed-success memo or another native write`, async t => {
  const f = await classCancellationMemoFixture({ foreignInspection: fault === "foreignInspection" }); t.after(f.close); const action = await f.prepare();
  if (fault === "lostWrite") f.loseWrite(); if (fault === "lostReview") f.loseReview();
  await f.drain(); assert.notEqual((await f.state()).actions[action.key]!.status, "committed"); assert.equal(f.memoPosts.length, 0); assert.equal(f.consumed.size, 0);
  const writes = f.writes.length; await f.drain(); assert.equal(f.writes.length, writes);
});

test("held class-cancellation memo permission cannot delay the known clinical response or prolong the verifier", async t => {
  const f = await classCancellationMemoFixture(); t.after(f.close); const action = await f.prepare(); let release!: () => void;
  f.gates.hold = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.drainClinical(); assert.equal((await f.state()).actions[action.key]!.status, "committed"); assert.equal(f.outcomes.length, 0);
    f.session.dispose(); release(); await f.memoSettled; assert.equal(f.outcomes[0]!.kind, "accepted"); assert.equal(f.writes.length, 1);
  } finally { release(); }
});

for (const passes of ["releaseOne", "unchanged", "consumeOne"] as const)
test(`historical200 source profile preserves ${passes} cancellation without claiming a pass effect in its memo`, async t => {
  const f = await classCancellationMemoFixture({ passes, budgetLimit: 200 }); t.after(f.close); const action = await f.prepare(); await f.drain();
  assert.equal((await f.state()).actions[action.key]!.status, "committed"); assert.equal(f.outcomes[0]!.kind, "accepted");
  const memo = decodeAdministrativeMemo(f.memoPosts[0]!.content); assert.ok(memo.ok); assert.equal(memo.value.outcome.kind, "classCancellationObserved");
  assert.equal(String(f.memoPosts[0]!.content).includes(f.pass.caseId), false);
});

for (const passes of ["releaseOne", "unchanged", "consumeOne"] as const)
test(`required real180 admitted ${passes} pass cancellation must complete with an independently permitted observed memo`, async t => {
  const f = await classCancellationMemoFixture({ passes, budgetLimit: 180 }); t.after(f.close); const action = await f.prepare(); await f.drain();
  assert.equal((await f.state()).actions[action.key]!.status, "committed", "actual180 completion must be fixed; historical200 source proof cannot satisfy this gate");
  assert.equal(f.outcomes[0]!.kind, "accepted"); assert.equal(f.writes.length, 1); assert.equal(f.memoPosts.length, 1);
});
