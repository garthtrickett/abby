import assert from "node:assert/strict";
import test from "node:test";
import { decodeAdministrativeMemo, administrativeMemoActionRef } from "../../src/cliniko/administrative-memo.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { appointmentChangeMemoFixture } from "../support/appointment-change-memo.ts";

for (const kind of ["cancel", "reschedule"] as const) for (const mode of ["accepted", "lostStored", "lostUnstored", "nonexact"] as const)
test(`${kind} actual approved session retains one independent best-effort memo after known outcome: ${mode}`, async t => {
  const f = await appointmentChangeMemoFixture(kind, { mode }); t.after(f.close); await f.prepare();
  assert.equal(f.memoPosts.length, 0); await f.drain(); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
  assert.equal(f.patches, 1); assert.equal(f.memoPosts.length, 1); assert.equal(f.outcomes[0]!.kind, mode === "accepted" ? "accepted" : "uncertain");
  const memo = decodeAdministrativeMemo(f.memoPosts[0]!.content), review = decodeClinikoReview(f.recalls[0]!.notes); assert.ok(memo.ok && review.ok);
  assert.equal(memo.value.sourceActionRef, review.value.marker); assert.equal(memo.value.actionRef, administrativeMemoActionRef(review.value.marker));
  assert.equal(memo.value.outcome.kind, kind === "cancel" ? "cancellationObserved" : "reschedulingObserved");
  assert.equal(memo.value.outcome.verification.basis, "acknowledgedAndObservedBestEffort");
  assert.equal(memo.value.outcome.verification.observedAt, memo.value.occurredAt); assert.equal(memo.value.patientId, review.value.request.patientId);
  assert.deepEqual(memo.value.scope, f.scope);
  await f.drain(); assert.equal(f.patches, 1); assert.equal(f.memoPosts.length, 1);
});

for (const kind of ["cancel", "reschedule"] as const)
test(`${kind} independent memo grant denial preserves its existing successful clinical result`, async t => {
  const f = await appointmentChangeMemoFixture(kind); t.after(f.close); await f.prepare(); f.gates.producer = false;
  await f.drain(); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed"); assert.equal(f.patches, 1);
  assert.equal(f.memoPosts.length, 0); assert.equal(f.outcomes[0]!.kind, "unavailable");
});

for (const kind of ["cancel", "reschedule"] as const) for (const clinicalFault of kind === "cancel"
  ? ["responseLost", "reviewLost", "foreignInspection"] as const : ["responseLost", "reviewLost", "foreignInspection", "conflict"] as const)
test(`${kind} ${clinicalFault} cannot manufacture an observed-success memo or clinical replay`, async t => {
  const f = await appointmentChangeMemoFixture(kind, { clinicalFault }); t.after(f.close); await f.prepare(); await f.drain();
  assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed"); assert.equal(f.memoPosts.length, 0); assert.equal(f.consumed.size, 0);
  const before = f.patches; await f.drain(); assert.equal(f.patches, before); assert.equal(f.memoPosts.length, 0);
});

test("actual approved practitioner-only move retains both original and observed practitioner without inventing a time change", async t => {
  const f = await appointmentChangeMemoFixture("reschedule", { practitionerOnly: true }); t.after(f.close); await f.prepare(); await f.drain();
  assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed"); assert.equal(f.outcomes[0]!.kind, "accepted");
  const memo = decodeAdministrativeMemo(f.memoPosts[0]!.content); assert.ok(memo.ok && memo.value.outcome.kind === "reschedulingObserved");
  assert.equal(memo.value.outcome.startsAt, memo.value.outcome.previous.startsAt);
  assert.equal(memo.value.outcome.practitionerRef, "cliniko:practitioner:23"); assert.equal(memo.value.outcome.previous.practitionerRef, "cliniko:practitioner:22");
});

for (const kind of ["cancel", "reschedule"] as const)
test(`${kind} held memo permission cannot delay a known clinical response or prolong clinical authority`, async t => {
  const f = await appointmentChangeMemoFixture(kind); t.after(f.close); await f.prepare(); let release!: () => void;
  f.gates.hold = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.drainClinical(); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed"); assert.equal(f.outcomes.length, 0);
    f.owner.dispose(); release(); await f.memoSettled; assert.equal(f.outcomes[0]!.kind, "accepted"); assert.equal(f.patches, 1);
  } finally { release(); }
});

for (const kind of ["cancel", "reschedule"] as const)
test(`${kind} memo physical quota refusal cannot change or repeat its existing native result`, async t => {
  const f = await appointmentChangeMemoFixture(kind); t.after(f.close); await f.prepare();
  f.gates.onAllowed = async () => { for (let n = 0; n < 180; n++) if (await f.budget.claim() !== null) break; };
  await f.drain(); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed"); assert.equal(f.patches, 1);
  assert.equal(f.memoPosts.length, 0); assert.equal(f.consumed.size, 1); assert.equal(f.outcomes[0]!.kind, "unavailable");
});
