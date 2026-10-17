import assert from "node:assert/strict";
import test from "node:test";
import { encodeFinancialMessageAttempt, decodeFinancialMessageAttempt, messageAttemptMatchesIntent } from "../../src/cliniko/financial-message-attempt.ts";
import type { FinancialMessageAttempt } from "../../src/cliniko/financial-message-attempt.ts";
import { pendingFinancialFixture } from "../support/financial-pending-discovery.ts";
import { fixture, intentValue, observation, value, now, reviewDate, stop, uuid } from "../support/financial-retention.ts";
import { financialIntentDigest } from "../../src/cliniko/financial-booking-observation.ts";

function attempt(purpose: FinancialMessageAttempt["purpose"] = "linkDelivery"): FinancialMessageAttempt {
  const i = intentValue();
  return { actionRef: uuid(9), financialActionRef: i.actionRef, effectRef: i.effects[purpose], purpose,
    intentRecallRef: "cliniko:recall:30", intentDigest: financialIntentDigest(i)!, observationRecallRef: "cliniko:recall:31",
    observationActionRef: uuid(8), targetRef: "cliniko:appointment:91", checkoutRef: "cs_test_exact", payloadDigest: "a".repeat(64), attemptedAt: now };
}
async function retained(f: ReturnType<typeof fixture> | ReturnType<typeof pendingFinancialFixture>) {
  f.seedIntent();
  value(await f.retainer.retainBookingObservationOnce(observation(f.intent), { intent: f.intent, intentRecallRef: "cliniko:recall:30" }, reviewDate, stop()));
  const source = value(await f.retainer.readBookingObservation({ recallRef: "cliniko:recall:31", actionRef: uuid(8), intentRecallRef: "cliniko:recall:30" }, f.intent, stop()));
  return { intent: f.intent, intentRecallRef: "cliniko:recall:30", observationRecallRef: source.recallRef, observation: source.observation };
}
test("link and receipt possible-message evidence has canonical bounded native encoding without a delivery/money claim", () => {
  for (const purpose of ["linkDelivery", "receiptDelivery"] as const) {
    const a = attempt(purpose), notes = value(encodeFinancialMessageAttempt(a));
    assert.ok(notes.length <= 1050); assert.deepEqual(value(decodeFinancialMessageAttempt(notes)), a);
    assert.ok(messageAttemptMatchesIntent(a, intentValue(), a.intentRecallRef));
    assert.doesNotMatch(notes, /private-retention@example|patient_id|accepted|paid|receipt_url|checkout\.stripe/);
  }
});
for (const [name, patch] of Object.entries({ unknownPurpose: { purpose: "clinicalExpiry" }, foreignAction: { financialActionRef: uuid(91) },
  wrongEffect: { effectRef: uuid(90) }, wrongDigest: { intentDigest: "b".repeat(64) }, sourceCollision: { observationRecallRef: "cliniko:recall:30" },
  wrongTarget: { targetRef: "cliniko:attendee:91" }, foreignSource: { intentRecallRef: "cliniko:recall:39" },
  privateUrl: { checkoutRef: "https://private.invalid" }, malformedDigest: { payloadDigest: "private payload" }, reusedAction: { actionRef: uuid(3) },
  noncanonicalTime: { attemptedAt: now.replace(".000Z", "Z") }, priorIntent: { attemptedAt: "2025-01-01T00:00:00.000Z" }, extraPayload: { email: "private@example.invalid" } }))
test(`message binding refuses ${name}`, () => {
  const a = { ...attempt(), ...patch } as FinancialMessageAttempt;
  assert.equal(messageAttemptMatchesIntent(a, intentValue(), "cliniko:recall:30"), false);
});
test("native possible-message retention and exact read use independent native grants, without consuming the message effect", async () => {
  const f = fixture(), source = await retained(f), a = attempt();
  const stored = value(await f.retainer.retainMessageAttemptOnce(a, source, reviewDate, stop())); assert.equal(stored.kind, "accepted");
  const read = value(await f.retainer.readMessageAttempt({ recallRef: "cliniko:recall:32", actionRef: a.actionRef, intentRecallRef: a.intentRecallRef }, f.intent, stop()));
  assert.deepEqual(read.attempt, a); assert.equal(read.recalled, false); assert.equal(f.burned.has(a.actionRef), true);
  assert.equal(f.burned.has(f.intent.effects.linkDelivery), false); assert.equal(f.rows.size, 3);
  assert.equal((await f.retainer.retainMessageAttemptOnce(a, source, reviewDate, stop())).ok, false);
  f.deny(); assert.equal((await f.retainer.readMessageAttempt({ recallRef: read.recallRef, actionRef: a.actionRef, intentRecallRef: a.intentRecallRef }, f.intent, stop())).ok, false);
});
test("unknown native attempt acknowledgement retains possible evidence and cannot be replayed", async () => {
  const f = fixture({ response: (row, method) => { if (method === "POST" && String(row.notes).includes("financial message attempt")) throw new Error("Synthetic lost ACK"); return Response.json(row, { status: method === "POST" ? 201 : 200 }); } });
  const source = await retained(f), a = attempt();
  assert.equal(value(await f.retainer.retainMessageAttemptOnce(a, source, reviewDate, stop())).kind, "uncertain");
  assert.equal(value(decodeFinancialMessageAttempt(f.rows.get("32")!.notes)).effectRef, a.effectRef);
  assert.equal((await f.retainer.retainMessageAttemptOnce(a, source, reviewDate, stop())).ok, false);
  assert.equal(f.rows.size, 3); assert.equal(f.burned.has(f.intent.effects.linkDelivery), false);
});
test("cold native pending discovery preserves possible-message evidence and legacy output when absent", async () => {
  const f = pendingFinancialFixture(), source = await retained(f), a = attempt();
  for (const r of f.rows.values()) r.recalled_at = null;
  const before = value(await f.scan()); assert.equal("messageAttempts" in before, false);
  value(await f.retainer.retainMessageAttemptOnce(a, source, reviewDate, stop())); f.rows.get("32")!.recalled_at = null;
  const found = value(await f.scan()); assert.equal(found.work.length, 1); assert.equal(found.attempts.length, 0);
  assert.equal(found.messageAttempts?.length, 1); assert.ok(found.messageAttempts); assert.deepEqual(found.messageAttempts[0]!.attempt, a);
  f.rows.set("33", { ...structuredClone(f.rows.get("32")!), id: "33", links: { self: "https://api.au5.cliniko.com/v1/recalls/33" } });
  assert.equal((await f.scan()).ok, false); // duplicate native attempt never releases partial work
});
