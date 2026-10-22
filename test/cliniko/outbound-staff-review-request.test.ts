import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { decodeOutboundStaffReviewRequest, encodeOutboundStaffReviewRequest, outboundStaffReviewActionRef,
  outboundStaffReviewMatchesAttempt, outboundStaffReviewRequestDigest } from "../../src/cliniko/outbound-staff-review-request.ts";
import type { OutboundStaffReviewRequest } from "../../src/cliniko/outbound-staff-review-request.ts";
import { encodeOutboundLaunchAttempt, outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
import { outboundStaffReviewValue as fixture } from "../support/outbound-staff-review.ts";
import { value } from "../support/outbound-records.ts";

test("pending staff review round-trips immutable source references without contact or clinical permission", () => {
  const { possible, request } = fixture(), notes = value(encodeOutboundStaffReviewRequest(request));
  const decoded = value(decodeOutboundStaffReviewRequest(notes)); assert.deepEqual(decoded, request);
  for (const object of [decoded, decoded.scope, decoded.attempt, decoded.notification]) assert.ok(Object.isFrozen(object));
  assert.equal(outboundStaffReviewMatchesAttempt(decoded, possible), true);
  assert.match(outboundStaffReviewRequestDigest(decoded)!, /^[a-f0-9]{64}$/); assert.ok(notes.length <= 1050);
  assert.equal(Object.hasOwn(decoded, "recipient"), false); assert.equal(Object.hasOwn(decoded, "contact"), false);
  assert.equal(notes.includes("+12025550123"), false); assert.equal(notes.includes(possible.attempt.provider.ref), false);
});
test("staff review purposes have fixed vectors independent of policy, verifier and record revisions", () => {
  assert.equal(outboundStaffReviewActionRef("11111111-1111-4111-8111-111111111111"), "e9f21811-50c0-4399-a69c-a7e167d7513d");
  assert.equal(outboundStaffReviewActionRef("22222222-2222-4222-8222-222222222222"), "9d8e4d45-c014-4df5-be94-92b447fb8d64");
  for (const invalid of ["", "patient-private", "a".repeat(64), "11111111-1111-1111-1111-111111111111"]) assert.equal(outboundStaffReviewActionRef(invalid), undefined);
  const { request } = fixture(), revised = { ...request, recordedAt: "2026-11-01T10:05:00.000Z", notification: { ...request.notification, digest: "b".repeat(64) } };
  assert.equal(revised.actionRef, request.actionRef); assert.notEqual(outboundStaffReviewRequestDigest(revised), outboundStaffReviewRequestDigest(request));
});
for (const patch of [
  { state: "reviewed" }, { state: "completeNoStop" }, { reason: "noStopHeard" }, { contact: "noStopRequested" },
  { permission: true }, { releaseContactHold: true }, { doNotCall: "clear" }, { recordingUrl: "https://private.invalid/audio" },
  { transcript: "private spoken material" }, { actionRef: randomUUID() }, { patientId: "patient-private" }, { credentialFingerprint: "bad" },
  { recordedAt: "2026-02-30T00:00:00.000Z" }
]) test(`staff review rejects unselected or malformed ${Object.keys(patch)[0]} ${Object.values(patch)[0]}`, () => {
  const { request } = fixture(); assert.equal(encodeOutboundStaffReviewRequest({ ...request, ...patch } as OutboundStaffReviewRequest).ok, false);
});
test("pending requests cannot alias their original, notification or future contact decisions", () => {
  const { possible, request } = fixture();
  for (const notification of [{ ...request.notification, recallRef: request.attempt.recallRef },
    { ...request.notification, actionRef: request.attempt.actionRef }, { ...request.notification, actionRef: request.actionRef },
    { ...request.notification, digest: "bad" }]) assert.equal(encodeOutboundStaffReviewRequest({ ...request, notification }).ok, false);
  const collision = { ...possible, attempt: { ...possible.attempt, effectRef: request.actionRef } };
  const bound = { ...request, attempt: { ...request.attempt, digest: outboundLaunchAttemptDigest(collision.attempt)! } };
  assert.equal(outboundStaffReviewMatchesAttempt(bound, collision), false);
});
test("pending request matching binds the exact private original rather than a same-patient later call", () => {
  const { possible, request } = fixture();
  for (const patch of [{ patientId: "99" }, { businessId: "99" }, { scope: { ...request.scope, clinicId: "other" } },
    { credentialFingerprint: "e".repeat(64) }, { attempt: { ...request.attempt, digest: "f".repeat(64) } },
    { attempt: { ...request.attempt, recallRef: "cliniko:recall:900" } }, { recordedAt: "2026-11-01T09:00:00.000Z" }]) {
    assert.equal(outboundStaffReviewMatchesAttempt({ ...request, ...patch }, possible), false);
  }
  for (const patch of [{ requestDigest: "f".repeat(64) },
    { provider: { ...possible.attempt.provider, bindingDigest: "c".repeat(64) } }, { actionRef: randomUUID() }]) {
    assert.equal(outboundStaffReviewMatchesAttempt(request, { ...possible, attempt: { ...possible.attempt, ...patch } }), false);
  }
});
test("request codec rejects alternate packing, unknown versions and oversized or extra source fields", () => {
  const { request } = fixture(), notes = value(encodeOutboundStaffReviewRequest(request)), lines = notes.split("\n"), payload = JSON.parse(lines[2]!);
  for (const bad of [null, {}, notes + "\n", notes.replace("request v1", "request v2"), notes.replace(lines[2]!, " " + lines[2]), "x".repeat(1051)]) {
    assert.equal(decodeOutboundStaffReviewRequest(bad).ok, false);
  }
  for (const fingerprint of [request.credentialFingerprint, payload[2] + "=", null]) {
    const changed = structuredClone(payload); changed[2] = fingerprint;
    assert.equal(decodeOutboundStaffReviewRequest([lines[0], lines[1], JSON.stringify(changed), lines[3]].join("\n")).ok, false);
  }
  assert.equal(encodeOutboundStaffReviewRequest({ ...request, notification: { ...request.notification, complete: true } } as OutboundStaffReviewRequest).ok, false);
});
test("every admitted v4 original envelope fits pending review without copying provider or phone fields", () => {
  const { possible, request } = fixture(); let admitted = 0;
  for (let length = 1; length <= 96; length++) for (const providerLength of [1, 48, 96]) {
    const attempt = { ...possible.attempt, businessId: "9999999999999999999", patientId: "9999999999999999999",
      scope: { tenantId: "t".repeat(length), clinicId: "c".repeat(length), locationId: "l".repeat(length) },
      provider: { ...possible.attempt.provider, ref: "p".repeat(providerLength) } };
    if (!encodeOutboundLaunchAttempt(attempt).ok) continue;
    const bound = { ...request, scope: attempt.scope, businessId: attempt.businessId, patientId: attempt.patientId,
      attempt: { ...request.attempt, digest: outboundLaunchAttemptDigest(attempt)! } };
    assert.ok(value(encodeOutboundStaffReviewRequest(bound)).length <= 1050);
    assert.equal(outboundStaffReviewMatchesAttempt(bound, { ...possible, attempt }), true); admitted++;
  }
  assert.ok(admitted > 100);
});
