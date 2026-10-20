import assert from "node:assert/strict";
import test from "node:test";
import { fixture, intentValue, observation, value, reviewDate, stop, uuid } from "../support/financial-retention.ts";
import { checkoutFixture } from "../support/financial-checkout-owner.ts";
import { financialConsumerFixture } from "../support/financial-consumer.ts";

async function retained() {
  const f = fixture(); f.seedIntent();
  const kept = value(await f.retainer.retainBookingObservationOnce(observation(f.intent), {
    intent: f.intent, intentRecallRef: "cliniko:recall:30" }, reviewDate, stop()));
  assert.equal(kept.kind, "accepted");
  const context = { native: { ...f, intent: { ...intentValue(), actionRef: uuid(99),
    recipient: { kind: "email" as const, address: "template-only@example.invalid" } } }, intent: f.intent,
    binding: { intentRecallRef: "cliniko:recall:30", financialActionRef: f.intent.actionRef,
      observationRecallRef: "cliniko:recall:31", observationActionRef: uuid(8), reviewDate } };
  // Adopting these records must not invoke either old fixture creation path.
  context.native.seedIntent = () => assert.fail("retained caller intent must not be reseeded");
  Object.defineProperty(context.native.retainer, "retainBookingObservationOnce", {
    value: async () => assert.fail("retained caller observation must not be re-signed or replaced") });
  return { f, context, before: [...f.rows].map(([id, row]) => [id, row.notes]) };
}
test("Checkout consumes the exact retained source rather than the fixture's template intent", async () => {
  const { f, context, before } = await retained(), c = await checkoutFixture({ retained: context });
  assert.deepEqual([...f.rows].map(([id, row]) => [id, row.notes]), before);
  const created = value(await c.owner.createOnce(c.binding, stop())); assert.equal(created.kind, "created");
  assert.equal(c.sessions.length, 1);
  assert.equal((c.sessions[0]!.metadata as Record<string, unknown>).abby_financial_action, context.intent.actionRef);
  assert.equal(JSON.stringify(c.requests).includes("template-only@example.invalid"), false);
  assert.deepEqual(before, before.map(([id]) => [id, f.rows.get(String(id))!.notes]));
  assert.deepEqual(await c.owner.createOnce(c.binding, stop()), { ok: false, error: { kind: "alreadyClaimed" } });
  assert.equal(c.sessions.length, 1);
});
test("the periodic financial owner can discover the original retained pair without minting a replacement booking", async t => {
  const { f, context, before } = await retained(), c = await financialConsumerFixture({ checkout: { retained: context } });
  t.after(() => c.consumer.close());
  assert.deepEqual([...f.rows].map(([id, row]) => [id, row.notes]), before);
  const cycle = c.cycle(); c.start(); const first = await cycle;
  assert.equal(first.creationAcknowledged, 1); assert.equal(c.sessions.length, 1);
  assert.equal((c.sessions[0]!.metadata as Record<string, unknown>).abby_financial_action, context.intent.actionRef);
  assert.deepEqual(before, before.map(([id]) => [id, f.rows.get(String(id))!.notes]));
});
