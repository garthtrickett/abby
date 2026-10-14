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

test("E2E-392 optional approved booking terms bind the same expiry and retain legacy wording",()=>{
  const offer={scope:request.scope,offerRef:"offer",serviceRef:"class",startsAt:"2026-10-08T04:00:00.000Z",expiresAt:"2026-10-04T06:02:00.000Z"};
  assert.equal(resultValue(bookingConfirmation(offer,"en-AU")),`Please confirm the class appointment at ${offer.startsAt}.`);
  const terms={version:"terms-1",approvedText:"The class costs 12 pounds.",expiresAt:offer.expiresAt};
  assert.match(resultValue(bookingConfirmation({...offer,terms},"en-AU")),/The class costs 12 pounds/);
  for(const patch of [{version:""},{approvedText:""},{approvedText:"Injected\ntext"},{expiresAt:"2026-10-04T06:03:00.000Z"}])
    assert.equal(bookingConfirmation({...offer,terms:{...terms,...patch}},"en-AU").ok,false);
});
