import assert from "node:assert/strict";
import test from "node:test";
import { sign } from "node:crypto";
import { financialBookingObservationPayload, financialBookingObservationMessage, formatFinancialBookingObservation,
  verifyFinancialBookingObservation, financialIntentDigest, authenticateFinancialBookingCitation } from "../../src/cliniko/financial-booking-observation.ts";
import type { ClinikoFinancialBookingObservation } from "../../src/cliniko/financial-booking-observation.ts";
import type { ClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import { intentValue, keys, keyRef, now, uuid, value } from "../support/financial-retention.ts";
const base = intentValue();
const intent: ClinikoFinancialIntent = { ...base, booking: { ...base.booking, kind: "classBook", sessionId: "15" } };
const expected = { intent, intentRecallRef: "cliniko:recall:30", producerKeyRef: keyRef, publicKey: keys.publicKey };
function proof(patientCaseId?: string, consent = true): ClinikoFinancialBookingObservation {
  return { actionRef: uuid(8), financialActionRef: intent.actionRef, intentRecallRef: expected.intentRecallRef, intentDigest: financialIntentDigest(intent)!,
    bookingActionRef: intent.booking.actionRef, targetRef: "cliniko:attendee:92", observedAt: now, producerKeyRef: keyRef,
    ...(consent ? { financialConsent: { presentationRef: uuid(9), presentationDigest: "a".repeat(64), playedAt: now, acceptedAt: now, acceptanceRef: uuid(10) } } : {}),
    classCreationRequest: { sessionId: "15", ...(patientCaseId === undefined ? {} : { patientCaseId }) } };
}
function notes(p = proof(), version: 1 | 2 | 3 = 3) {
  const payload = financialBookingObservationPayload(p); assert.ok(payload);
  const notes = formatFinancialBookingObservation(p, sign(null, financialBookingObservationMessage(payload, version), keys.privateKey).toString("base64url")); assert.ok(notes); return notes;
}
for (const patientCaseId of [undefined, "71"]) for (const consent of [true, false]) {
  test(`v3 authenticates the exact class creation request case=${patientCaseId ?? "not-requested"}, consent=${consent}`, () => {
    const p = proof(patientCaseId, consent), observed = value(verifyFinancialBookingObservation(notes(p), expected));
    assert.deepEqual(observed, p); assert.equal(Object.isFrozen(observed.classCreationRequest), true);
    assert.equal(Object.hasOwn(observed.classCreationRequest!, "patientCaseId"), patientCaseId !== undefined);
    if (consent) assert.equal(Object.isFrozen(observed.financialConsent), true);
  });
}
for (const version of [1, 2] as const) test(`v${version} signature cannot authenticate v3 class evidence`, () => {
  assert.equal(verifyFinancialBookingObservation(notes(proof("71"), version), expected).ok, false);
});
test("edited session, case, consent and target cannot survive producer signature verification", () => {
  const original = notes(proof("71"));
  for (const edited of [original.replace('["15","71"]', '["16","71"]'), original.replace('["15","71"]', '["15","72"]'),
    original.replace('cliniko:attendee:92', 'cliniko:attendee:93'), original.replace('a'.repeat(64), 'b'.repeat(64))]) {
    assert.notEqual(edited, original); assert.equal(authenticateFinancialBookingCitation(edited, expected).ok, false);
  }
});
test("a valid signature for another occurrence or an individual target is insufficient", () => {
  const p = { ...proof(), classCreationRequest: { sessionId: "16" } };
  assert.equal(authenticateFinancialBookingCitation(notes(p), expected).ok, true);
  assert.equal(verifyFinancialBookingObservation(notes(p), expected).ok, false);
  assert.equal(financialBookingObservationPayload({ ...proof(), targetRef: "cliniko:appointment:92" }), undefined);
});
for (const creation of [{ sessionId: "15", patientCaseId: null }, { sessionId: "15", patientCaseId: undefined },
  { sessionId: "15", patientCaseId: "0" }, { sessionId: 15 }, { sessionId: "15", paid: true }, { sessionId: "15", patientCaseId: "71", passUsed: 0 }]) {
  test(`invalid or authority-bearing class creation shape ${JSON.stringify(creation)} is refused`, () => {
    assert.equal(financialBookingObservationPayload({ ...proof(), classCreationRequest: creation } as unknown as ClinikoFinancialBookingObservation), undefined);
  });
}
test("legacy signed observations cannot acquire class creation evidence by a header or payload edit", () => {
  const p = { ...proof() }; delete p.classCreationRequest;
  const legacy = notes(p, 2); assert.equal(verifyFinancialBookingObservation(legacy, expected).ok, true);
  assert.equal(value(verifyFinancialBookingObservation(legacy, expected)).classCreationRequest, undefined);
  assert.equal(authenticateFinancialBookingCitation(legacy.replace('observation v2', 'observation v3'), expected).ok, false);
});
