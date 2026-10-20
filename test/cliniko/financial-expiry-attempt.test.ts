import assert from "node:assert/strict";
import test from "node:test";
import { encodeFinancialExpiryAttempt, decodeFinancialExpiryAttempt, expiryAttemptMatchesIntent } from "../../src/cliniko/financial-expiry-attempt.ts";
import type { FinancialExpiryAttempt } from "../../src/cliniko/financial-expiry-attempt.ts";
import { pendingFinancialFixture } from "../support/financial-pending-discovery.ts";
import { fixture, intentValue, observation, value, now, reviewDate, stop, uuid } from "../support/financial-retention.ts";
import { financialIntentDigest } from "../../src/cliniko/financial-booking-observation.ts";

function attempt(purpose: FinancialExpiryAttempt["purpose"] = "checkoutExpiry"): FinancialExpiryAttempt {
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
test("Checkout and clinical expiry possible-expiry evidence has canonical bounded native encoding without a delivery/money claim", () => {
  for (const purpose of ["checkoutExpiry", "clinicalExpiry"] as const) {
    const a = attempt(purpose), notes = value(encodeFinancialExpiryAttempt(a));
    assert.ok(notes.length <= 1050); assert.deepEqual(value(decodeFinancialExpiryAttempt(notes)), a);
    assert.ok(expiryAttemptMatchesIntent(a, intentValue(), a.intentRecallRef));
    assert.doesNotMatch(notes, /private-retention@example|patient_id|accepted|paid|receipt_url|checkout\.stripe/);
  }
});
for (const [name, patch] of Object.entries({ unknownPurpose: { purpose: "linkDelivery" }, foreignAction: { financialActionRef: uuid(91) },
  wrongEffect: { effectRef: uuid(90) }, wrongDigest: { intentDigest: "b".repeat(64) }, sourceCollision: { observationRecallRef: "cliniko:recall:30" },
  wrongTarget: { targetRef: "cliniko:attendee:91" }, foreignSource: { intentRecallRef: "cliniko:recall:39" },
  privateUrl: { checkoutRef: "https://private.invalid" }, malformedDigest: { payloadDigest: "private payload" }, reusedAction: { actionRef: uuid(3) },
  noncanonicalTime: { attemptedAt: now.replace(".000Z", "Z") }, priorIntent: { attemptedAt: "2025-01-01T00:00:00.000Z" }, extraPayload: { email: "private@example.invalid" } }))
test(`expiry binding refuses ${name}`, () => {
  const a = { ...attempt(), ...patch } as FinancialExpiryAttempt;
  assert.equal(expiryAttemptMatchesIntent(a, intentValue(), "cliniko:recall:30"), false);
});
test("native possible-expiry retention and exact read use independent native grants, without consuming the expiry effect", async () => {
  const f = fixture(), source = await retained(f), a = attempt();
  const stored = value(await f.retainer.retainExpiryAttemptOnce(a, source, reviewDate, stop())); assert.equal(stored.kind, "accepted");
  const read = value(await f.retainer.readExpiryAttempt({ recallRef: "cliniko:recall:32", actionRef: a.actionRef, intentRecallRef: a.intentRecallRef }, f.intent, stop()));
  assert.deepEqual(read.attempt, a); assert.equal(read.recalled, false); assert.equal(f.burned.has(a.actionRef), true);
  assert.equal(f.burned.has(f.intent.effects.checkoutExpiry), false); assert.equal(f.rows.size, 3);
  assert.equal((await f.retainer.retainExpiryAttemptOnce(a, source, reviewDate, stop())).ok, false);
  f.deny(); assert.equal((await f.retainer.readExpiryAttempt({ recallRef: read.recallRef, actionRef: a.actionRef, intentRecallRef: a.intentRecallRef }, f.intent, stop())).ok, false);
});
test("unknown native attempt acknowledgement retains possible evidence and cannot be replayed", async () => {
  const f = fixture({ response: (row, method) => { if (method === "POST" && String(row.notes).includes("financial expiry attempt")) throw new Error("Synthetic lost ACK"); return Response.json(row, { status: method === "POST" ? 201 : 200 }); } });
  const source = await retained(f), a = attempt();
  assert.equal(value(await f.retainer.retainExpiryAttemptOnce(a, source, reviewDate, stop())).kind, "uncertain");
  assert.equal(value(decodeFinancialExpiryAttempt(f.rows.get("32")!.notes)).effectRef, a.effectRef);
  assert.equal((await f.retainer.retainExpiryAttemptOnce(a, source, reviewDate, stop())).ok, false);
  assert.equal(f.rows.size, 3); assert.equal(f.burned.has(f.intent.effects.checkoutExpiry), false);
});
test("cold native pending discovery preserves possible-expiry evidence and legacy output when absent", async () => {
  const f = pendingFinancialFixture(), source = await retained(f), a = attempt();
  for (const r of f.rows.values()) r.recalled_at = null;
  const before = value(await f.scan()); assert.equal("expiryAttempts" in before, false);
  value(await f.retainer.retainExpiryAttemptOnce(a, source, reviewDate, stop())); f.rows.get("32")!.recalled_at = null;
  const found = value(await f.scan()); assert.equal(found.work.length, 1); assert.equal(found.attempts.length, 0);
  assert.equal(found.expiryAttempts?.length, 1); assert.ok(found.expiryAttempts); assert.deepEqual(found.expiryAttempts[0]!.attempt, a);
  f.rows.set("33", { ...structuredClone(f.rows.get("32")!), id: "33", links: { self: "https://api.au5.cliniko.com/v1/recalls/33" } });
  assert.equal((await f.scan()).ok, false); // duplicate native attempt never releases partial work
});
