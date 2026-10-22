import assert from "node:assert/strict";
import test from "node:test";
import { twilioStatusDeliveryFixture as fixture } from "../support/twilio-outbound-status-delivery.ts";
import { ClinikoTwilioOutboundUnansweredDelivery } from "../../src/standalone/cliniko-twilio-outbound-unanswered-delivery.ts";
import { NativeRequestAllowance } from "../../src/standalone/internal/native-request-allowance.ts";
import { value } from "../support/outbound-records.ts";

const noAnswer = { CallStatus: "no-answer" };

test("restrictive STOP is retained before no-answer provenance without releasing either hold", async t => {
  const f = await fixture({ unanswered: true }); t.after(f.close);
  assert.equal((await f.receive(noAnswer)).ok, true);
  assert.deepEqual(f.nativePostOrder, [f.recoveryConfig.stop.dnc.source.contactReviewRecallTypeId,
    f.unansweredConfig.config.observations.outboundUnansweredObservationRecallTypeId]);
  assert.equal(f.dncPosts.length, 1); assert.equal(f.unansweredPosts.length, 1); assert.equal(f.notificationPosts.length, 0);
  assert.equal(f.released.size, 0); assert.equal(f.held.size, 1);
});

test("a fresh delivery owner finds retained no-answer provenance without a local note journal or another POST", async t => {
  const f = await fixture({ unanswered: true, missingReport: true }); t.after(f.close);
  assert.equal((await f.receive(noAnswer)).ok, true);
  f.unansweredState.record = false; f.unansweredState.producer = false;
  const cold = value(f.makeDelivery());
  assert.equal((await cold.receiveStatus(f.request(noAnswer), new AbortController().signal)).ok, true);
  assert.equal(f.unansweredPosts.length, 1); assert.equal(f.dncPosts.length, 0);
  assert.ok(f.unansweredQueries.some(q => q.operation === "readOriginalUnansweredHistory"));
  assert.ok(f.unansweredQueries.some(q => q.operation === "readUnansweredObservation" && q.observation));
  assert.equal(f.released.size, 0);
});

for (const denied of ["history", "decoded", "source"] as const) {
  test(`retained no-answer provenance does not bypass withdrawn ${denied} authority`, async t => {
    const f = await fixture({ unanswered: true, missingReport: true }); t.after(f.close);
    assert.equal((await f.receive(noAnswer)).ok, true); f.unansweredState[denied] = false;
    const cold = value(f.makeDelivery());
    assert.equal((await cold.receiveStatus(f.request(noAnswer), new AbortController().signal)).ok, false);
    assert.equal(f.unansweredPosts.length, 1); assert.equal(f.released.size, 0);
  });
}

test("no-answer provenance cannot enter a configured completed-only staff-review workflow", async t => {
  const f = await fixture({ unanswered: true, missingReport: true, staffReview: true }); t.after(f.close);
  assert.equal((await f.receive(noAnswer)).ok, true);
  assert.equal(f.unansweredPosts.length, 1); assert.equal(f.notificationPosts.length, 0); assert.equal(f.staffPosts.length, 0);
  assert.equal(f.released.size, 0); assert.equal(f.held.size, 1);
});

test("one cumulative allowance covers STOP reads, uncertain no-answer POST and cold native recovery", async t => {
  const baseline = await fixture({ unanswered: true, missingReport: true, unansweredAck: "stored" }); t.after(baseline.close);
  const before = baseline.claims; assert.equal((await baseline.receive(noAnswer)).ok, true);
  const required = baseline.claims - before; assert.ok(required > 1);
  const limited = await fixture({ unanswered: true, missingReport: true, unansweredAck: "stored", maximumNativeRequests: required - 1 }); t.after(limited.close);
  const began = limited.claims; assert.equal((await limited.receive(noAnswer)).ok, false);
  assert.equal(limited.claims, began, "the existing STOP preflight rejects this insufficient whole allowance before dispatch"); assert.equal(limited.unansweredPosts.length, 0); assert.equal(limited.released.size, 0);
});

test("decoded no-answer authority withdrawal prevents a retained-record acknowledgement", async t => {
  const f = await fixture({ unanswered: true, missingReport: true }); t.after(f.close);
  assert.equal((await f.receive(noAnswer)).ok, true);
  const history = f.unansweredConfig.ports.history;
  f.unansweredConfig.ports.history = { ...history, allowsObservationRead: async q => { if (q.observation) f.unansweredState.current = false; return true; } };
  const cold = value(f.makeDelivery());
  assert.equal((await cold.receiveStatus(f.request(noAnswer), new AbortController().signal)).ok, false);
  assert.equal(f.unansweredPosts.length, 1); assert.equal(f.released.size, 0);
});

test("duplicate native no-answer records are ambiguous rather than resolved by insertion order", async t => {
  const f = await fixture({ unanswered: true, missingReport: true }); t.after(f.close);
  assert.equal((await f.receive(noAnswer)).ok, true);
  const row = f.contactControls.rows.find(row => String((row.recall_type as { links: { self: string } }).links.self).endsWith("/67"))!;
  f.contactControls.rows.push({ ...structuredClone(row), id: "2000", links: { self: "https://api.au5.cliniko.com/v1/recalls/2000" } });
  assert.equal((await f.receive(noAnswer)).ok, false); assert.equal(f.unansweredPosts.length, 1);
});

test("changed original native version during cold no-answer reconciliation cannot acknowledge stale evidence", async t => {
  const f = await fixture({ unanswered: true, missingReport: true }); t.after(f.close);
  assert.equal((await f.receive(noAnswer)).ok, true);
  const call = value(f.recoveryPorts.runtime.authenticateStatus(f.request(noAnswer))).call;
  const id = call.context.original.recallRef.split(":").at(-1)!;
  const row = f.contactControls.rows.find(row => row.id === id)!;
  const native = f.unansweredConfig.ports.native; let reads = 0;
  f.unansweredConfig.ports.native = async (input, init) => {
    const response = await native(input, init);
    if (init?.method === "GET" && new URL(String(input)).pathname === `/v1/recalls/${id}` && ++reads === 1) {
      row.recalled = true; row.recalled_at = f.state.now;
    }
    return response;
  };
  const cold = value(f.makeDelivery());
  assert.equal((await cold.receiveStatus(f.request(noAnswer), new AbortController().signal)).ok, false);
  assert.equal(reads, 2); assert.equal(f.unansweredPosts.length, 1);
});

for (const changed of ["physical", "credential", "family", "attempt-policy"] as const) {
  test(`optional no-answer capture refuses mismatched ${changed} selection`, async t => {
    const f = await fixture({ unanswered: true, missingReport: true }); t.after(f.close); const u = f.unansweredConfig.config;
    if (changed === "physical") u.observations.rateBudget = { claim: async () => null, observe429: async () => ({ kind: "rateLimited" }) };
    if (changed === "credential") u.observations.apiKey = "foreign-au5";
    if (changed === "family") u.observations.outboundUnansweredObservationRecallTypeId = f.deliveryConfig.notifications.config.observations.outboundTerminalObservationRecallTypeId;
    if (changed === "attempt-policy") {
      const original = u.attempts.attemptPolicyDigest; u.attempts.attemptPolicyDigest = "e".repeat(64);
      assert.notEqual(u.attempts.attemptPolicyDigest, original, "the challenge must actually change the selected policy");
    }
    assert.equal(f.makeDelivery().ok, false); assert.equal(f.unansweredPosts.length, 0);
  });
}


test("uncertain no-answer retention cannot reset an already partly spent delivery allowance during recovery", async t => {
  const f = await fixture({ unanswered: true, missingReport: true, unansweredAck: "stored" }); t.after(f.close);
  const allowance = new NativeRequestAllowance(4); assert.equal(allowance.take(), true);
  const owner = value(ClinikoTwilioOutboundUnansweredDelivery.create(f.unansweredConfig.config, f.unansweredConfig.ports));
  const before = f.claims;
  assert.equal((await owner.receiveStatus(f.request(noAnswer), new AbortController().signal, allowance)).ok, false);
  assert.equal(f.unansweredPosts.length, 1, "the stored write must precede this recovery shortage");
  assert.equal(allowance.hasHeadroom(1), false); assert.ok(f.claims - before <= 3);
  assert.ok(f.unansweredQueries.some(q => q.operation === "readOriginalUnansweredHistory"));
  assert.equal(f.released.size, 0); assert.equal(f.dncPosts.length, 0);
});
