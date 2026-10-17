import assert from "node:assert/strict";
import test from "node:test";
import { sign } from "node:crypto";
import { financialBookingObservationPayload, financialBookingObservationMessage, formatFinancialBookingObservation,
  verifyFinancialBookingObservation, financialIntentDigest } from "../../src/cliniko/financial-booking-observation.ts";
import { intentValue, keys, keyRef, now, uuid, value } from "../support/financial-retention.ts";
const intent = intentValue();
function proof() { return { actionRef: uuid(8), financialActionRef: intent.actionRef, intentRecallRef: "cliniko:recall:30", intentDigest: financialIntentDigest(intent)!,
  bookingActionRef: intent.booking.actionRef, targetRef: "cliniko:appointment:91", observedAt: now, producerKeyRef: keyRef,
  financialConsent: { presentationRef: uuid(9), presentationDigest: "a".repeat(64), playedAt: now, acceptedAt: now, acceptanceRef: uuid(10) } }; }
const expected = { intent, intentRecallRef: "cliniko:recall:30", producerKeyRef: keyRef, publicKey: keys.publicKey };
function notes(p = proof(), version: 1 | 2 = 2) { const payload = financialBookingObservationPayload(p); assert.ok(payload); return formatFinancialBookingObservation(p, sign(null, financialBookingObservationMessage(payload, version), keys.privateKey).toString("base64url"))!; }
test("v2 signature binds the played and separately accepted financial receipt to the complete intent", () => {
  const p = proof(), result = value(verifyFinancialBookingObservation(notes(p), expected)); assert.deepEqual(result.financialConsent, p.financialConsent);
  assert.equal(verifyFinancialBookingObservation(notes(p).replace(uuid(10), uuid(11)), expected).ok, false);
});
test("a v1 domain signature cannot authenticate a v2 financial consent observation", () => { assert.equal(verifyFinancialBookingObservation(notes(proof(), 1), expected).ok, false); });
for (const [name, mutate] of Object.entries({ answerBeforePlayback: (p: ReturnType<typeof proof>) => { p.financialConsent.acceptedAt = "2026-11-01T09:59:59.999Z"; },
  futureAnswer: (p: ReturnType<typeof proof>) => { p.financialConsent.acceptedAt = "2026-11-01T10:00:00.001Z"; },
  duplicateAction: (p: ReturnType<typeof proof>) => { p.financialConsent.acceptanceRef = p.actionRef; },
  extraField: (p: ReturnType<typeof proof>) => { Object.assign(p.financialConsent, { text: "private terms" }); } })) test(`invalid financial receipt ${name} cannot be signed as a valid observation`, () => {
  const p = proof(); mutate(p); assert.equal(financialBookingObservationPayload(p), undefined);
});
test("financial receipt UUIDs cannot alias any intent effect", () => { const p = proof(); p.financialConsent.acceptanceRef = intent.effects.checkout; assert.equal(verifyFinancialBookingObservation(notes(p), expected).ok, false); });
