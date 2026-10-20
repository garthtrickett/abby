import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { encodeOutboundContactReview, decodeOutboundContactReview, outboundContactReviewDigest } from "../../src/cliniko/outbound-contact-review.ts";
import type { OutboundContactReview } from "../../src/cliniko/outbound-contact-review.ts";
import { evaluateOutboundContactHistory } from "../../src/cliniko/outbound-contact-lineage.ts";
const now = "2026-11-02T00:00:00.000Z";
function review(): OutboundContactReview {
  return { actionRef: randomUUID(), approvalRef: randomUUID(), reviewerRef: "clinic-reviewer",
    scope: { tenantId: "tenant", clinicId: "clinic", locationId: "location" }, businessId: "11", credentialFingerprint: "a".repeat(64),
    contactRecallTypeId: "91", policy: { version: "contact-v1", digest: "b".repeat(64) }, patientId: "21",
    recipient: { kind: "voice", number: "+6145550101" }, purposes: ["followUp", "sickDay"], consent: "granted", doNotCall: "clear",
    revision: 1, predecessor: null, reconsentApprovalRef: null, reviewedAt: "2026-11-01T00:00:00.000Z",
    effectiveFrom: "2026-11-01T00:00:00.000Z", effectiveUntil: "2026-12-01T00:00:00.000Z" };
}
function next(previous: OutboundContactReview, changes: Partial<OutboundContactReview> = {}): OutboundContactReview {
  return { ...previous, actionRef: randomUUID(), approvalRef: randomUUID(), revision: previous.revision + 1,
    predecessor: { actionRef: previous.actionRef, digest: outboundContactReviewDigest(previous)! }, reconsentApprovalRef: null, ...changes };
}
function evaluate(rows: readonly OutboundContactReview[], head = rows.at(-1)!, at = now) {
  return evaluateOutboundContactHistory(rows, { actionRef: head.actionRef, digest: outboundContactReviewDigest(head)! }, at);
}
test("canonical private contact decision round-trips and freezes every nested field", () => {
  const r = review(), encoded = encodeOutboundContactReview(r); assert.ok(encoded.ok); assert.ok(encoded.value.length <= 1050);
  const decoded = decodeOutboundContactReview(encoded.value); assert.ok(decoded.ok); assert.deepEqual(decoded.value, r);
  for (const value of [decoded.value, decoded.value.scope, decoded.value.policy, decoded.value.recipient, decoded.value.purposes]) assert.ok(Object.isFrozen(value));
  assert.equal(evaluate([r]).ok, true);
});
for (const [name, changes] of Object.entries({
  "marketing field": { accepted_sms_marketing: true }, "unknown grant": { contactAllowed: true }, "bad action": { actionRef: "not-random" },
  "aliased approval": { approvalRef: "alias" }, "bad scope": { scope: { tenantId: "tenant", clinicId: "clinic" } },
  "bad patient": { patientId: "021" }, "bad type": { contactRecallTypeId: "0" }, "bad credential": { credentialFingerprint: "a" },
  "bad number": { recipient: { kind: "voice", number: "0412345678" } }, "marketing medium": { recipient: { kind: "sms", number: "+6145550101" } },
  "missing consent": { consent: undefined }, "inferred DNC": { doNotCall: false }, "empty purposes": { purposes: [] },
  "duplicate purposes": { purposes: ["followUp", "followUp"] }, "unordered purposes": { purposes: ["sickDay", "followUp"] },
  "unsupported purpose": { purposes: ["marketing"] }, "root predecessor": { predecessor: { actionRef: randomUUID(), digest: "c".repeat(64) } },
  "root reconsent": { reconsentApprovalRef: randomUUID() }, "missing predecessor": { revision: 2 }, "excess revision": { revision: 51 },
  "offset instant": { reviewedAt: "2026-11-01T00:00:00+00:00" }, "invalid date": { reviewedAt: "2026-02-30T00:00:00.000Z" },
  "review after effective": { reviewedAt: "2026-11-03T00:00:00.000Z" }, "empty interval": { effectiveUntil: "2026-11-01T00:00:00.000Z" },
  "extra policy field": { policy: { version: "v1", digest: "b".repeat(64), launchAllowed: true } },
})) test(`contact codec refuses ${name}`, () => {
  const value = { ...review(), ...changes } as OutboundContactReview;
  if (name === "aliased approval") (value as { approvalRef: string }).approvalRef = value.actionRef;
  assert.equal(encodeOutboundContactReview(value).ok, false); assert.equal(outboundContactReviewDigest(value), undefined);
});
test("wire decoding refuses reformatted, extra, foreign and oversized private records", () => {
  const encoded = encodeOutboundContactReview(review()); assert.ok(encoded.ok);
  for (const wire of [encoded.value + "\n", encoded.value.replace('["', '[ "'), encoded.value.replace('review v1', 'review v2'),
    encoded.value.replace('voice contact review', 'financial review'), "x".repeat(1051), null]) assert.equal(decodeOutboundContactReview(wire).ok, false);
});
for (const consent of ["granted", "withdrawn", "unknown"] as const) for (const doNotCall of ["clear", "blocked", "unknown"] as const)
  test(`decision requires affirmative consent and clear DNC: ${consent}/${doNotCall}`, () => {
    const found = evaluate([{ ...review(), consent, doNotCall }]); assert.ok(found.ok);
    assert.equal(found.value.disposition, consent === "granted" && doNotCall === "clear" ? "eligibleEvidence" : "blocked");
  });
test("history order and provider timestamps cannot choose an older consenting head", () => {
  const first = review(), stop = next(first, { doNotCall: "blocked" });
  const found = evaluate([stop, first], stop); assert.ok(found.ok); assert.equal(found.value.disposition, "blocked");
  assert.equal(evaluate([first, stop], first).ok, false);
});
test("an exact independently approved reconsent preserves and supersedes DNC history", () => {
  const first = review(), stop = next(first, { doNotCall: "blocked" }), renew = next(stop, { doNotCall: "clear", reconsentApprovalRef: randomUUID() });
  const found = evaluate([renew, first, stop], renew); assert.ok(found.ok); assert.equal(found.value.disposition, "eligibleEvidence");
  assert.deepEqual(found.value.reconsentApprovals, [renew.reconsentApprovalRef]); assert.ok(Object.isFrozen(found.value.reconsentApprovals));
  assert.ok(Object.isFrozen(found.value.head.predecessor));
  assert.equal(evaluate([first, stop, { ...renew, reconsentApprovalRef: null }]).ok, false);
});
test("missing, duplicated, forked, aliased or changed predecessor history refuses", () => {
  const first = review(), second = next(first), third = next(second);
  const histories = [[first, third], [first, first], [first, second, next(first)], [first, { ...second, approvalRef: first.approvalRef }],
    [first, { ...second, predecessor: { ...second.predecessor!, digest: "f".repeat(64) } }],
    [{ ...first, doNotCall: "blocked" as const }, second], [first, { ...second, reviewedAt: "2026-10-31T00:00:00.000Z", effectiveFrom: "2026-10-31T00:00:00.000Z" }]];
  for (const rows of histories) assert.equal(evaluate(rows).ok, false);
});
for (const field of ["patientId", "businessId", "credentialFingerprint", "contactRecallTypeId", "scope", "policy"] as const)
  test(`different ${field} cannot join an existing patient history`, () => {
    const first = review(), second = next(first), values = { patientId: "22", businessId: "12", credentialFingerprint: "c".repeat(64), contactRecallTypeId: "92",
      scope: { ...first.scope, clinicId: "elsewhere" }, policy: { ...first.policy, version: "new-policy" } };
    assert.equal(evaluate([first, { ...second, [field]: values[field] }]).ok, false);
  });
for (const changed of [{ recipient: { kind: "voice" as const, number: "+6145550199" } }, { purposes: ["followUp" as const] }])
  test("number or purpose changes require explicit exact-predecessor reconsent", () => {
    const first = review(), second = next(first, changed); assert.equal(evaluate([first, second]).ok, false);
    const found = evaluate([first, { ...second, reconsentApprovalRef: randomUUID() }]); assert.ok(found.ok); assert.equal(found.value.disposition, "eligibleEvidence");
  });
test("temporal validity is half-open and cannot resurrect expired old consent", () => {
  const first = review();
  for (const at of ["2026-10-31T23:59:59.999Z", first.effectiveUntil]) { const found = evaluate([first], first, at); assert.ok(found.ok); assert.equal(found.value.disposition, "blocked"); }
  assert.equal(evaluate([first], first, "invalid").ok, false);
  assert.equal(evaluateOutboundContactHistory([first], { actionRef: first.actionRef, digest: "d".repeat(64) }, now).ok, false);
});
test("fifty complete revisions qualify; over-bound history refuses without truncation", () => {
  const rows = [review()]; for (let i = 1; i < 50; i++) rows.push(next(rows.at(-1)!));
  const found = evaluate(rows); assert.ok(found.ok); assert.equal(found.value.head.revision, 50);
  assert.equal(evaluate([...rows, rows.at(-1)!]).ok, false);
});
