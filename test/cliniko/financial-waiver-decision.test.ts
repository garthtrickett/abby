import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { waiverFixture, issuerKey, waiverKeys } from "../support/financial-waiver.ts";
import { uuid } from "../support/financial-retention.ts";
import { verifyFinancialWaiverDecision, financialWaiverPayload, financialWaiverMessage, formatFinancialWaiverDecision } from "../../src/cliniko/financial-waiver-decision.ts";

test("canonical current waiver authenticates only the exact approved intent/target/amount", () => {
  const f = waiverFixture(), result = verifyFinancialWaiverDecision(f.format(), f.expected, issuerKey, "2026-11-02T00:00:00.000Z");
  assert.ok(result.ok); assert.deepEqual(result.value, f.decision); assert.ok(Object.isFrozen(result.value));
  assert.equal(Object.hasOwn(result.value, "paid"), false); assert.equal(Object.hasOwn(result.value, "clinicalPermission"), false);
});
test("a partial approved waiver is explicit and cannot silently become a full waived amount", () => {
  const f = waiverFixture(), decision = { ...f.decision, amount: 1000 };
  const result = verifyFinancialWaiverDecision(f.format(decision), f.expected, issuerKey, "2026-11-02T00:00:00.000Z");
  assert.ok(result.ok); assert.equal(result.value.amount, 1000); assert.notEqual(result.value.amount, f.intent.payment.amount);
});
for (const patch of [{ amount: 5001 }, { currency: "aud" }, { financialActionRef: uuid(90) }, { intentRecallRef: "cliniko:recall:31" },
  { intentDigest: "a".repeat(64) }, { targetRef: "cliniko:appointment:92" }, { issuerKeyRef: "another-issuer" },
  { actionRef: uuid(3) }, { approvedAt: "2026-10-31T00:00:00.000Z" }, { approvedAt: "2026-11-02T00:00:00.001Z" },
  { expiresAt: "2026-11-02T00:00:00.000Z" }])
test("even a genuine issuer signature cannot approve changed, expired or unrelated financial context", () => {
  const f = waiverFixture();
  assert.equal(verifyFinancialWaiverDecision(f.format({ ...f.decision, ...patch }), f.expected, issuerKey, "2026-11-02T00:00:00.000Z").ok, false);
});
for (const patch of [{ amount: 0 }, { amount: 1.1 }, { paid: true }, { clinicalPermission: true }, { privateNotes: "private" },
  { expiresAt: "2026-11-01T09:00:00.000Z" }, { financialActionRef: uuid(80) }])
test("waiver schema cannot carry money flags, private prose, grants or ambiguous amounts", () => {
  const f = waiverFixture(); assert.equal(financialWaiverPayload({ ...f.decision, ...patch }), undefined);
});
test("edited notes, noncanonical arrays, forged keys and other signing domains refuse", () => {
  const f = waiverFixture(), notes = f.format(), time = "2026-11-02T00:00:00.000Z";
  assert.equal(verifyFinancialWaiverDecision(notes.replace('5000', '4000'), f.expected, issuerKey, time).ok, false);
  assert.equal(verifyFinancialWaiverDecision(f.format(f.decision, generateKeyPairSync("ed25519").privateKey), f.expected, issuerKey, time).ok, false);
  const payload = financialWaiverPayload(f.decision)!;
  const wrongDomain = sign(null, Buffer.from(payload), waiverKeys.privateKey).toString("base64url");
  assert.equal(verifyFinancialWaiverDecision(formatFinancialWaiverDecision(f.decision, wrongDomain), f.expected, issuerKey, time).ok, false);
  const spaced = payload.replace('[', '[ '), lines = notes.split("\n"); lines[2] = spaced;
  lines[3] = sign(null, financialWaiverMessage(spaced), waiverKeys.privateKey).toString("base64url");
  assert.equal(verifyFinancialWaiverDecision(lines.join("\n"), f.expected, issuerKey, time).ok, false);
});
