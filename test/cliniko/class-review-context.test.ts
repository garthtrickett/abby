import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { decodeClinikoReview, encodeClinikoReview } from "../../src/cliniko/review-request.ts";
import type { ClinikoReviewRequest } from "../../src/cliniko/review-request.ts";
import { bookingConfirmation } from "../../src/core/booking-menu.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const request: ClinikoReviewRequest = { scope: {tenantId:"class-review-tenant",clinicId:"clinic",locationId:"location"}, patientId:"42",businessId:"11",credentialFingerprint:"a".repeat(64),
  policyVersion:"policy-1",termsVersion:"class-terms-1",timeZone:"Australia/Sydney",createdAt:"2026-10-04T06:00:00.000Z",
  operation:{kind:"classBook",sessionId:"91",attendanceActionId:randomUUID(),practitionerId:"22",appointmentTypeId:"33",startsAt:"2026-10-08T04:00:00.000Z",endsAt:"2026-10-08T05:00:00.000Z"}};

test("E2E-392 class review retains distinct occurrence and attendee identities without becoming a replay permit",()=>{
  for(const operation of [request.operation,{kind:"classCancel" as const,sessionId:"91",attendeeId:"101",cancellationReason:50 as const,practitionerId:"22",appointmentTypeId:"33",startsAt:"2026-10-08T04:00:00.000Z",endsAt:"2026-10-08T05:00:00.000Z"}]){
    const marker=randomUUID(),encoded=resultValue(encodeClinikoReview(marker,{...request,operation}));
    assert.match(encoded,/Abby class attendance review v1/);assert.match(encoded,/Do not replay automatically/);
    assert.deepEqual(resultValue(decodeClinikoReview(encoded)),{marker,request:{...request,operation}});
    assert.equal(decodeClinikoReview(encoded.replace("class attendance review v1","appointment review v2")).ok,false);
  }
});

test("E2E-392 malformed or expanded class review cannot enter the owned recall protocol",()=>{
  for(const patch of [{sessionId:"0"},{attendanceActionId:"caller-supplied-marker"},{appointmentId:"91"},{transcript:"private transcript"},{endsAt:"2026-10-08T03:00:00.000Z"}])
    assert.equal(encodeClinikoReview(randomUUID(),{...request,operation:{...request.operation,...patch}} as ClinikoReviewRequest).ok,false);
});

test("E2E-406 pass review retains exact private case, entitlement and before-use evidence in a distinct non-replayable version", () => {
  if (request.operation.kind !== "classBook") assert.fail("expected class booking fixture");
  const operation = { ...request.operation, kind: "classBook" as const, sessionId: "91", attendanceActionId: randomUUID(),
    pass: { patientCaseId: "811222333444555666", entitlementRef: "approved-pass-1", usageFingerprint: "a".repeat(64), maximum: 2, used: 1 } };
  const encoded = resultValue(encodeClinikoReview(randomUUID(), { ...request, operation }));
  assert.match(encoded, /class attendance review v2/);
  assert.deepEqual(resultValue(decodeClinikoReview(encoded)).request.operation, operation);
  assert.equal(decodeClinikoReview(encoded.replace("class attendance review v2", "class attendance review v1")).ok, false);
  for (const patch of [{ patientCaseId: "0" }, { entitlementRef: "private arbitrary text" }, { usageFingerprint: "forged" }, { maximum: 301 }, { used: 2 }, { used: -1 }, { paid: true }])
    assert.equal(encodeClinikoReview(randomUUID(), { ...request, operation: { ...operation, pass: { ...operation.pass, ...patch } } }).ok, false);
});

test("E2E-407 cancellation pass reviews retain exact before-use and approved counter effect without payment or replay authority", () => {
  const operation = { kind: "classCancel" as const, sessionId: "91", attendeeId: "101", cancellationReason: 50 as const, practitionerId: "22", appointmentTypeId: "33",
    startsAt: "2026-10-08T04:00:00.000Z", endsAt: "2026-10-08T05:00:00.000Z",
    pass: { patientCaseId: "811222333444555666", entitlementRef: "approved-cancel-1", usageFingerprint: "a".repeat(64), maximum: 1, used: 2, effect: "releaseOne" as const } };
  for (const effect of ["releaseOne", "unchanged", "consumeOne"] as const) {
    const selected = { ...operation, pass: { ...operation.pass, effect } }, encoded = resultValue(encodeClinikoReview(randomUUID(), { ...request, operation: selected }));
    assert.match(encoded, /class cancellation pass review v1/); assert.deepEqual(resultValue(decodeClinikoReview(encoded)).request.operation, selected);
    assert.equal(decodeClinikoReview(encoded.replace("class cancellation pass review v1", "class attendance review v1")).ok, false);
  }
  for (const patch of [{ effect: "refund" }, { used: -1 }, { used: 0, effect: "releaseOne" }, { used: 1000, effect: "consumeOne" }, { paid: true }, { usageFingerprint: "forged" }])
    assert.equal(encodeClinikoReview(randomUUID(), { ...request, operation: { ...operation, pass: { ...operation.pass, ...patch } } } as ClinikoReviewRequest).ok, false);
});

test("E2E-397 movement reviews retain both exact occurrences, root marker and explicit compensation boundary", () => {
  const operation = { kind: "classMove" as const, sessionId: "91", attendeeId: "101", newSessionId: "94", attendanceActionId: randomUUID(),
    practitionerId: "22", appointmentTypeId: "33", newPractitionerId: "23", newAppointmentTypeId: "34", startsAt: "2026-10-08T04:00:00.000Z", endsAt: "2026-10-08T05:00:00.000Z",
    newStartsAt: "2026-10-09T04:00:00.000Z", newEndsAt: "2026-10-09T04:30:00.000Z", cancellationReason: 50 as const, compensation: "cancelReplacementIfOriginalUnsent" as const };
  const marker = randomUUID(), move = { ...request, operation }, encoded = resultValue(encodeClinikoReview(marker, move));
  assert.match(encoded, /Abby class movement review v1/); assert.deepEqual(resultValue(decodeClinikoReview(encoded)), { marker, request: move });
  assert.equal(decodeClinikoReview(encoded.replace("class movement review v1", "class attendance review v1")).ok, false);
  for (const patch of [{ newSessionId: "91" }, { attendeeId: "0" }, { attendanceActionId: "forged" }, { newPractitionerId: "22" },
    { newAppointmentTypeId: "33" }, { newEndsAt: operation.newStartsAt }, { compensation: "alwaysRollback" }, { apply_to_repeats: true }, { transcript: "private transcript" }])
    assert.equal(encodeClinikoReview(marker, { ...move, operation: { ...operation, ...patch } } as ClinikoReviewRequest).ok, false);
});

test("E2E-392 optional approved booking terms bind the same expiry and retain legacy wording",()=>{
  const offer={scope:request.scope,offerRef:"offer",serviceRef:"class",startsAt:"2026-10-08T04:00:00.000Z",expiresAt:"2026-10-04T06:02:00.000Z"};
  assert.equal(resultValue(bookingConfirmation(offer,"en-AU")),`Please confirm the class appointment at ${offer.startsAt}.`);
  const terms={version:"terms-1",approvedText:"The class costs 12 pounds.",expiresAt:offer.expiresAt};
  assert.match(resultValue(bookingConfirmation({...offer,terms},"en-AU")),/The class costs 12 pounds/);
  for(const patch of [{version:""},{approvedText:""},{approvedText:"Injected\ntext"},{expiresAt:"2026-10-04T06:03:00.000Z"}])
    assert.equal(bookingConfirmation({...offer,terms:{...terms,...patch}},"en-AU").ok,false);
});
