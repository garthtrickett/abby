import test from "node:test";
import assert from "node:assert/strict";
import { encodeClinikoFinancialIntent, decodeClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import type { ClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import { encodeClinikoReview, decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { formatRecallNote, validRecallSummary } from "../../src/cliniko/recall-note.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const intent: ClinikoFinancialIntent = {
  actionRef: id(1), scope: { tenantId: "fixture-tenant", clinicId: "fixture-clinic", locationId: "fixture-location" },
  patientId: "11", businessId: "12", credentialFingerprint: "a".repeat(64),
  booking: { kind: "book", actionRef: id(2), practitionerId: "13", appointmentTypeId: "14",
    startsAt: "2026-11-02T09:00:00.000Z", endsAt: "2026-11-02T09:30:00.000Z" },
  stripe: { accountRef: "acct_fixture", livemode: false },
  payment: { amount: 5000, currency: "gbp", policyVersion: "fees-1", termsVersion: "terms-1", deadline: "2026-11-01T12:00:00.000Z" },
  recipient: { kind: "email", address: "fixture@example.invalid" },
  effects: { checkout: id(3), linkDelivery: id(4), receiptDelivery: id(5), checkoutExpiry: id(6), clinicalExpiry: id(7) },
  createdAt: "2026-11-01T09:00:00.000Z",
};
function encoded(value: ClinikoFinancialIntent = intent): string {
  const result = encodeClinikoFinancialIntent(value); assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Fixture encoding failed"); return result.value;
}

test("financial intent retains exact private individual and class context within the recall contract", () => {
  for (const value of [intent, { ...intent, booking: { ...intent.booking, kind: "classBook" as const, sessionId: "15" } }]) {
    const notes = encoded(value);
    assert.equal(validRecallSummary(notes.split("\n").slice(1).join("\n")), true);
    assert.deepEqual(decodeClinikoFinancialIntent(notes), { ok: true, value });
    assert.match(notes, /No collection or clinical action authorized/);
    assert.equal(decodeClinikoReview(notes).ok, false);
  }
  const bookingReview = encodeClinikoReview(id(8), {
    scope: intent.scope, patientId: intent.patientId, businessId: intent.businessId,
    credentialFingerprint: intent.credentialFingerprint, policyVersion: "policy-1", termsVersion: "terms-1",
    timeZone: "Europe/London", createdAt: intent.createdAt,
    operation: { kind: "book", practitionerId: "13", appointmentTypeId: "14", startsAt: intent.booking.startsAt, endsAt: intent.booking.endsAt },
  });
  assert.equal(bookingReview.ok, true);
  if (bookingReview.ok) assert.equal(decodeClinikoFinancialIntent(bookingReview.value).ok, false);
});

test("financial intent refuses malformed identity, money, time, recipient and aliased effect context", () => {
  const changes: unknown[] = [
    { actionRef: "patient-11" }, { actionRef: id(2) }, { patientId: "0" }, { businessId: "1e2" },
    { credentialFingerprint: "key-secret" }, { scope: { ...intent.scope, locationId: "" } },
    { stripe: { ...intent.stripe, accountRef: "cs_fixture" } }, { stripe: { ...intent.stripe, livemode: "false" } },
    ...[0, -1, 0.5, 100_000_000, Number.MAX_SAFE_INTEGER, NaN, Infinity, "5000"].map(amount => ({ payment: { ...intent.payment, amount } })),
    { payment: { ...intent.payment, currency: "GBP" } }, { payment: { ...intent.payment, policyVersion: "" } },
    { payment: { ...intent.payment, deadline: intent.createdAt } },
    { payment: { ...intent.payment, deadline: "2026-11-31T12:00:00.000Z" } },
    { createdAt: "2026-11-01T09:00:00Z" }, { createdAt: "2026-11-01T09:60:00.000Z" },
    { booking: { ...intent.booking, endsAt: intent.booking.startsAt } },
    { booking: { ...intent.booking, kind: "reschedule" } }, { booking: { ...intent.booking, kind: "classBook" } },
    { booking: { ...intent.booking, sessionId: "15" } },
    { recipient: { kind: "email", address: "fixture@example.invalid\nBcc:other@example.invalid" } },
    { recipient: { kind: "sms", address: "+441234567890" } },
    { effects: { ...intent.effects, checkout: id(1) } }, { effects: { ...intent.effects, receiptDelivery: id(4) } },
    { effects: { ...intent.effects, clinicalExpiry: "unknown" } },
    { effects: { ...intent.effects, clinicalExpiry: id(6) } },
  ];
  for (const patch of changes) {
    const value = { ...intent, ...patch as object } as ClinikoFinancialIntent;
    assert.equal(encodeClinikoFinancialIntent(value).ok, false, JSON.stringify(patch));
  }
});

test("financial context cannot carry extra financial truth, retry authority or private prose", () => {
  for (const field of ["paid", "received", "bookingAcknowledged", "recalled", "retry", "transcript", "receiptUrl"]) {
    assert.equal(encodeClinikoFinancialIntent({ ...intent, [field]: "forged" } as ClinikoFinancialIntent).ok, false);
    for (const nested of ["scope", "booking", "stripe", "payment", "recipient", "effects"] as const) {
      assert.equal(encodeClinikoFinancialIntent({ ...intent, [nested]: { ...intent[nested], [field]: "forged" } }).ok, false);
    }
  }
});

test("untrusted native notes reject alternate envelopes, payload shapes and noncanonical encodings", () => {
  const notes = encoded(), lines = notes.split("\n"), payload: unknown[] = JSON.parse(lines[2]!);
  const alter = (value: unknown) => [lines[0], lines[1], JSON.stringify(value), lines[3]].join("\n");
  const malformed = [null, undefined, {}, "", notes + "\n", notes.replace("intent v1", "intent v2"),
    notes.replace(id(1), "bad-id"), notes.replace(lines[3]!, "Paid. Retry approved."),
    alter(payload.slice(1)), alter([...payload, "paid"]), alter({ intent: payload }),
    alter(payload.map((v, n) => n === 0 ? [...v as unknown[], "extra"] : v)),
    alter(payload.map((v, n) => n === 4 ? [...v as unknown[], "15"] : v)),
    notes.replace(lines[2]!, " " + lines[2]), notes.replace(lines[2]!, "{"),
    notes.replace("acct_fixture", "acct_\u0001fixture"), "x".repeat(1_000_000)];
  for (const value of malformed) assert.equal(decodeClinikoFinancialIntent(value).ok, false);
  // A schema-valid edited native record is still context, never authenticated history.
  const edited = encoded({ ...intent, payment: { ...intent.payment, amount: 6000 } });
  assert.equal(decodeClinikoFinancialIntent(edited).ok, true);
});

test("the full 1000-character summary boundary refuses oversized context without truncation", () => {
  let boundary: string | undefined;
  const largeScope = { tenantId: "t".repeat(100), clinicId: "c".repeat(100), locationId: "l".repeat(100) };
  for (let size = 1; size <= 128; size++) {
    const value = { ...intent, scope: largeScope, payment: { ...intent.payment, termsVersion: "v".repeat(size) } };
    const result = encodeClinikoFinancialIntent(value);
    if (result.ok) {
      assert.deepEqual(decodeClinikoFinancialIntent(result.value), { ok: true, value });
      boundary = result.value;
    } else {
      assert.ok(boundary); assert.equal(boundary.split("\n").slice(1).join("\n").length, 1000); break;
    }
  }
  assert.ok(boundary);
  assert.equal(encodeClinikoFinancialIntent({ ...intent, scope: largeScope,
    payment: { ...intent.payment, termsVersion: "v".repeat(128) } }).ok, false);
  assert.equal(decodeClinikoFinancialIntent(formatRecallNote(id(1), "x".repeat(1001))).ok, false);
});
