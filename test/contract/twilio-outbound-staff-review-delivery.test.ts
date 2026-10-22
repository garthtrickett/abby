import assert from "node:assert/strict";
import test from "node:test";
import { twilioStatusDeliveryFixture as fixture } from "../support/twilio-outbound-status-delivery.ts";
import { decodeOutboundStaffReviewRequest } from "../../src/cliniko/outbound-staff-review-request.ts";
import { TwilioOutboundStatusDelivery } from "../../src/standalone/twilio-outbound-status-delivery.ts";
import { value } from "../support/outbound-records.ts";

test("optional signed completed delivery retains notification then pending clinic review while contact stays blocked", async t => {
  const f = await fixture({ missingReport: true, staffReview: true }); t.after(f.close);
  assert.equal((await f.receive()).ok, true); assert.equal(f.notificationPosts.length, 1); assert.equal(f.staffPosts.length, 1);
  assert.equal(f.dncPosts.length, 0); assert.equal(f.held.size, 1); assert.equal(f.released.size, 0); assert.equal(f.calls.length, 1);
  assert.equal(f.contactHeld?.size, 1); assert.equal(f.contactReleased?.size, 0);
  const request = value(decodeOutboundStaffReviewRequest(f.staffPosts[0]!.notes));
  assert.equal(request.attempt.actionRef, f.attempt.actionRef); assert.equal(request.state, "needsClinicReview");
  assert.equal(request.notification.recallRef, "cliniko:recall:900");
  assert.equal((await f.receive()).ok, true); assert.equal(f.notificationPosts.length, 1); assert.equal(f.staffPosts.length, 1);
});

test("MAC-protected no-stop assertion is still reviewed when whole-call contact completeness is not established", async t => {
  const f = await fixture({ staffReview: true }); t.after(f.close);
  f.replaceReport({ contact: { kind: "completeNoStop" }, terminal: { endedAt: f.state.now, observedAt: f.state.now } });
  assert.equal((await f.receive()).ok, true); assert.equal(f.staffPosts.length, 1); assert.equal(f.dncPosts.length, 0);
  assert.equal(f.held.size, 1); assert.equal(f.released.size, 0);
  assert.equal(f.contactHeld?.size, 1); assert.equal(f.contactReleased?.size, 0);
});

test("restrictive positive STOP retention runs first and needs no unrelated pending review write grant", async t => {
  const f = await fixture({ staffReview: true }); t.after(f.close); f.staffState.producer = false;
  assert.equal((await f.receive()).ok, true); assert.equal(f.dncPosts.length, 1); assert.equal(f.notificationPosts.length, 1);
  assert.equal(f.staffPosts.length, 0); assert.equal(f.released.size, 0); assert.equal(f.held.size, 1);
  assert.equal(f.contactHeld?.size, 1); assert.equal(f.contactReleased?.size, 0);
});

for (const ack of ["stored", "unstored"] as const) test(`pending clinic review ${ack} ACK loss recovers only exact native history without duplicate POST`, async t => {
  const f = await fixture({ missingReport: true, staffReview: true, staffReviewAck: ack }); t.after(f.close);
  assert.equal((await f.receive()).ok, false); assert.equal(f.staffPosts.length, 1); assert.equal(f.notificationPosts.length, 1);
  const cold = value(f.makeDelivery());
  assert.equal((await cold.receiveStatus(f.request(), new AbortController().signal)).ok, ack === "stored");
  assert.equal(f.staffPosts.length, 1); assert.equal(f.notificationPosts.length, 1); assert.equal(f.released.size, 0); assert.equal(f.held.size, 1);
  assert.equal(f.contactHeld?.size, 1); assert.equal(f.contactReleased?.size, 0);
});

test("pending staff permission can be approved later without repeating prior retained notification", async t => {
  const f = await fixture({ missingReport: true, staffReview: true }); t.after(f.close); f.staffState.producer = false;
  assert.equal((await f.receive()).ok, false); assert.equal(f.notificationPosts.length, 1); assert.equal(f.staffPosts.length, 0);
  f.staffState.producer = true; assert.equal((await f.receive()).ok, true); assert.equal(f.notificationPosts.length, 1); assert.equal(f.staffPosts.length, 1);
});

test("forged/progress/failed status cannot fabricate completed staff-review work or spend its purpose", async t => {
  const f = await fixture({ missingReport: true, staffReview: true }); t.after(f.close); const before = f.claims;
  assert.equal((await f.delivery.receiveStatus({ ...f.request(), signature: "forged" }, new AbortController().signal)).ok, false);
  assert.equal((await f.receive({ CallStatus: "ringing" })).ok, true); assert.equal(f.claims, before);
  assert.equal((await f.receive({ CallStatus: "failed" })).ok, false);
  assert.equal(f.notificationPosts.length, 0); assert.equal(f.staffPosts.length, 0); assert.equal(f.held.size, 1);
});

test("staff review configuration cannot change the shared physical budget, original family or notification authentication", async t => {
  const f = await fixture({ missingReport: true, staffReview: true }); t.after(f.close); const c = f.deliveryConfig;
  assert.ok(c.staffReview); const r = c.staffReview;
  for (const patch of [
    { reviews: { ...r.config.reviews, outboundStaffReviewRecallTypeId: c.stop.config.stop.dnc.source.contactReviewRecallTypeId } },
    { observations: { ...r.config.observations, terminalObservationPolicyDigest: "e".repeat(64) } },
    { attempts: { ...r.config.attempts, attemptPolicyDigest: "e".repeat(64) } },
    { reviews: { ...r.config.reviews, rateBudget: { ...r.config.reviews.rateBudget } } }
  ]) assert.equal(TwilioOutboundStatusDelivery.create({ ...c, staffReview: { ...r, config: { ...r.config, ...patch } } }).ok, false);
  assert.equal(f.staffPosts.length, 0);
});
