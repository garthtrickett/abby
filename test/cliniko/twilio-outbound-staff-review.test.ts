import assert from "node:assert/strict";
import test from "node:test";
import { TwilioOutboundTerminalObservationAuthentication } from "../../src/cliniko/twilio-outbound-terminal-observation.ts";
import { decodeOutboundStaffReviewRequest, outboundStaffReviewActionRef, outboundStaffReviewMatchesAttempt } from "../../src/cliniko/outbound-staff-review-request.ts";
import { encodeOutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";
import { NativeRequestAllowance } from "../../src/standalone/internal/native-request-allowance.ts";
import { twilioOutboundStaffReviewFixture } from "../support/twilio-outbound-staff-review.ts";
import { value } from "../support/outbound-records.ts";

test("exact authenticated native original and notification create only pending clinic review inside one physical budget", async () => {
  const f = await twilioOutboundStaffReviewFixture(), before = f.native.claims;
  assert.deepEqual(value(await f.runReview()), { kind: "reviewRetained", evidence: "nativeAck" });
  assert.equal(f.native.claims - before, 13); assert.equal(f.reviewCalls.length, 1);
  const request = value(decodeOutboundStaffReviewRequest(f.native.rows.get("401")!.notes));
  assert.equal(request.actionRef, outboundStaffReviewActionRef(f.context.original.attempt.actionRef));
  const original = value(await f.find()).evidence!.original;
  assert.equal(outboundStaffReviewMatchesAttempt(request, original), true); assert.equal(request.notification.recallRef, "cliniko:recall:30");
  assert.equal(request.state, "needsClinicReview"); assert.equal(Object.hasOwn(request, "contact"), false);
  assert.equal(Object.hasOwn(request, "number"), false);
  for (const method of ["release", "settle", "clearDnc", "dial", "performClinicalAction"]) assert.equal(method in f.review, false);
});

test("lost stored ACK and a fresh producer recover native history without another review POST", async () => {
  const f = await twilioOutboundStaffReviewFixture(); f.reviewState.response = () => { throw Error("synthetic ACK lost"); };
  assert.deepEqual(value(await f.runReview()), { kind: "reviewUncertain" });
  const cold = value(f.makeReview());
  assert.deepEqual(value(await cold.retainForRuntime(f.identity, f.observation.accountSid, new AbortController().signal)), { kind: "reviewRetained", evidence: "nativeHistory" });
  assert.equal(f.reviewCalls.length, 1);
});

test("duplicate concurrent unresolved-contact delivery consumes the original permanent review purpose once", async () => {
  const f = await twilioOutboundStaffReviewFixture(), outcomes = await Promise.all([f.runReview(), f.runReview()]);
  assert.equal(outcomes.filter(r => r.ok && r.value.kind === "reviewRetained" && r.value.evidence === "nativeAck").length, 1);
  assert.ok(outcomes.every(r => r.ok ? r.value.kind === "reviewRetained" : ["alreadyClaimed", "mismatched"].includes(r.error.kind)));
  assert.equal(f.reviewCalls.length, 1);
  assert.deepEqual(value(await f.runReview()), { kind: "reviewRetained", evidence: "nativeHistory" }); assert.equal(f.reviewCalls.length, 1);
});

test("absent or MAC-unverifiable notification supplies no staff-review source or permission", async () => {
  const f = await twilioOutboundStaffReviewFixture(); f.native.rows.delete("30");
  assert.deepEqual(value(await f.runReview()), { kind: "unresolved" }); assert.equal(f.reviewCalls.length, 0);
  const g = await twilioOutboundStaffReviewFixture(), wrong = new TwilioOutboundTerminalObservationAuthentication(Buffer.alloc(32, 29), g.auth.binding());
  const producer = value(g.makeReview(g.reviewConfig, { ...g.reviewPorts, authentication: wrong }));
  assert.equal((await producer.retainForRuntime(g.identity, g.observation.accountSid, new AbortController().signal)).ok, false); assert.equal(g.reviewCalls.length, 0);
});

for (const field of ["allowed", "producer", "live", "historyAllowed", "decoded"] as const) test(`independent staff review ${field} refusal cannot turn source reads into a task POST`, async () => {
  const f = await twilioOutboundStaffReviewFixture(); f.reviewState[field] = false;
  assert.equal((await f.runReview()).ok, false); assert.equal(f.reviewCalls.length, 0);
  assert.equal(f.burned.has(outboundStaffReviewActionRef(f.context.original.attempt.actionRef)!), false);
});

test("revoked source authority during review admission prevents the native write despite separately permissive record grants", async () => {
  const f = await twilioOutboundStaffReviewFixture();
  const producer = value(f.makeReview(f.reviewConfig, { ...f.reviewPorts, records: { ...f.reviewPorts.records,
    producerAdmitted: async () => { f.historyState.live = false; return true; }
  } }));
  assert.equal((await producer.retainForRuntime(f.identity, f.observation.accountSid, new AbortController().signal)).ok, false);
  assert.equal(f.reviewCalls.length, 0); assert.equal(f.burned.has(outboundStaffReviewActionRef(f.context.original.attempt.actionRef)!), false);
});

test("native original drift after review-history inspection cannot be laundered through an earlier authenticated notification", async () => {
  const f = await twilioOutboundStaffReviewFixture(); let reads = 0;
  f.reviewState.beforeRead = () => {
    reads++;
    // First source scan/read/reread uses5 requests, then two review scans.
    if (reads === 8) f.originalRow.notes = value(encodeOutboundLaunchAttempt({ ...f.context.original.attempt, requestDigest: "f".repeat(64) }));
  };
  assert.equal((await f.runReview()).ok, false); assert.equal(f.reviewCalls.length, 0);
});

test("one cumulative caller allowance covers history, exact sources and retention without borrowing a fresh owner budget", async () => {
  const f = await twilioOutboundStaffReviewFixture(), before = f.native.claims;
  const result = await f.review.retainForRuntime(f.identity, f.observation.accountSid, new AbortController().signal, new NativeRequestAllowance(12));
  assert.equal(result.ok, false); assert.equal(f.native.claims - before, 12); assert.equal(f.reviewCalls.length, 0);
  assert.equal(f.burned.has(outboundStaffReviewActionRef(f.context.original.attempt.actionRef)!), true);
  assert.equal((await f.runReview()).ok, false); assert.equal(f.reviewCalls.length, 0);
});

test("a bounded source plan refuses excess work and separate physical budgets cannot construct the producer", async () => {
  const f = await twilioOutboundStaffReviewFixture(), before = f.native.claims;
  const limited = value(f.makeReview({ ...f.reviewConfig, maximumNativeRequests: 5 }));
  assert.equal((await limited.retainForRuntime(f.identity, f.observation.accountSid, new AbortController().signal)).ok, false);
  assert.equal(f.native.claims - before, 5); assert.equal(f.reviewCalls.length, 0);
  assert.equal(f.makeReview({ ...f.reviewConfig, reviews: { ...f.reviewConfig.reviews, rateBudget: { ...f.reviewConfig.reviews.rateBudget } } }).ok, false);
  assert.equal(f.makeReview({ ...f.reviewConfig, reviews: { ...f.reviewConfig.reviews, outboundStaffReviewRecallTypeId: f.reviewConfig.observations.outboundTerminalObservationRecallTypeId } }).ok, false);
});
