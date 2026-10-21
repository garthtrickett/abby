import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ClinikoClassAttendanceMove } from "../../src/standalone/cliniko-class-attendance-move.ts";
import { classPassMoveFixture } from "../support/class-pass-move.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

for (const lost of [undefined, "original", "replacement", "review"] as const)
test(`native move reports retain original owned source and honest uncertainty after ${lost ?? "success"}`, async t => {
  const f = await classPassMoveFixture(); t.after(() => f.lifetime.abort()); if (lost) f.lose(lost);
  const original = structuredClone(f.request);
  if (!lost) f.onWrite(() => { (f.request as { patientId: string }).patientId = "43"; (f.request as { actionId: string }).actionId = randomUUID(); });
  const value = resultValue(await f.run()), source = f.mover.reportSource(value);
  if (lost === "review") { assert.equal(source, undefined); return; }
  assert.ok(source); assert.deepEqual(source.request, original);
  assert.equal(source.completion, lost ? "needsReview" : "moved");
  assert.equal(source.outcome.original, lost === "original" ? "uncertain" : lost === "replacement" ? "notSent" : "inspectedCancelled");
  assert.equal(f.mover.reportSource(structuredClone(value)), undefined);
  const other = resultValue(ClinikoClassAttendanceMove.create(f.config)); assert.equal(other.reportSource(value), undefined);
  assert.throws(() => { (source.request as { patientId: string }).patientId = "43"; });
  assert.throws(() => { (f.mover as any).reportSource = () => source; });
  (f.request as { actionId: string }).actionId = randomUUID(); assert.equal(source.request.actionId, original.actionId);
  (value as { original: string }).original = "forged"; assert.equal(f.mover.reportSource(value), undefined);
});

test("native paused movement report is tied to the actual stage object, not a public progress clone", async t => {
  const f = await classPassMoveFixture(); t.after(() => f.lifetime.abort()); const version = "memo-stages-v1";
  const mover = resultValue(ClinikoClassAttendanceMove.create({ ...f.config, quotaStaging: { version } }));
  const stages = resultValue(mover.prepareStagesOnce(f.request));
  const result = resultValue(await stages.advanceOnce({ contractVersion: version, confirmationRef: randomUUID(), expiresAt: f.request.expiresAt,
    verificationRef: f.request.verificationRef }, f.lifetime.signal, f.permit));
  assert.equal(result.kind, "staged"); const source = mover.reportSource(result); assert.ok(source);
  assert.equal(source.completion, "pending"); assert.equal(source.outcome.original, "notSent"); assert.equal(source.outcome.replacement, "inspectedActive");
  assert.equal(mover.reportSource(structuredClone(result)), undefined);
  assert.equal(mover.reportSource(result.kind === "staged" ? result.observation : undefined), undefined);
  assert.equal(f.writes.length, 1);
});
