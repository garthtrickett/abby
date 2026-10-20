import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { twilioOutboundStopRecoveryFixture } from "../support/twilio-outbound-stop-recovery.ts";
import { value } from "../support/outbound-records.ts";
import { decodeOutboundContactReview } from "../../src/cliniko/outbound-contact-review.ts";
import { encodeOutboundLaunchAttempt, outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
import { encodeTwilioOutboundReport } from "../../src/cliniko/twilio-outbound-report.ts";

test("signed Twilio correlation plus an authentic retained pre-terminal stop writes one restrictive Cliniko decision", async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close);
  assert.equal(value(await f.recover()).kind, "accepted"); assert.equal(f.dncPosts.length, 1);
  const review = value(decodeOutboundContactReview(f.dncPosts[0]!.notes));
  assert.equal(review.actionRef, f.attempt.dncReferences!.actionRef); assert.equal(review.consent, "unknown");
  assert.equal(review.doNotCall, "blocked"); assert.equal(review.recipient.number, f.context.number);
  assert.equal(review.reconsentApprovalRef, null); assert.equal(f.calls.length, 1); assert.equal(f.held.size, 1); assert.equal(f.released.size, 0);
  assert.ok(f.reportQueries.some(q => q.operation === "readProviderReport" && q.report));
  assert.equal(value(await f.recover()).kind, "existingDecision"); assert.equal(f.dncPosts.length, 1);
});

for (const denial of ["signature", "reportAbsent", "reportMac", "broad", "decoded", "current", "policy", "producer"] as const)
test(`cold recovery ${denial} never consumes a DNC decision or releases holds`, async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close);
  if (denial === "reportAbsent") f.contactControls.rows.splice(f.contactControls.rows.indexOf(f.reportRow), 1);
  if (denial === "reportMac") f.reportRow.notes = value(encodeTwilioOutboundReport({ ...f.report, authentication: "f".repeat(64) }));
  if (denial === "broad") f.reportState.broad = false;
  if (denial === "decoded") f.reportState.decoded = false;
  if (denial === "current") f.reportState.live = false;
  if (denial === "policy") await f.replaceStopPolicy({ enabled: false });
  if (denial === "producer") f.stopState.producer = false;
  const request = f.request();
  const result = denial === "signature" ? await value(f.makeRecovery()).recoverStatus({ ...request, signature: "foreign" }, new AbortController().signal) : await f.recover();
  if (denial === "reportAbsent") assert.deepEqual(value(result), { kind: "unresolved" }); else assert.equal(result.ok, false);
  assert.equal(f.dncBurned.size, 0); assert.equal(f.dncPosts.length, 0); assert.equal(f.held.size, 1); assert.equal(f.released.size, 0);
});

test("completed signed progress without retained speech evidence stays unresolved", async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close);
  f.contactControls.rows.splice(f.contactControls.rows.indexOf(f.reportRow), 1);
  assert.deepEqual(value(await f.recover()), { kind: "unresolved" }); assert.equal(f.dncPosts.length, 0); assert.equal(f.released.size, 0);
});
for (const patch of [{ callSid: "CA" + "c".repeat(32) }, { number: "+12025550999" }, { actionRef: randomUUID() }])
test(`even a signed foreign report ${Object.keys(patch)[0]} cannot authorize a DNC write`, async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close); f.replaceReport(patch);
  assert.equal((await f.recover()).ok, false); assert.equal(f.dncPosts.length, 0); assert.equal(f.dncBurned.size, 0);
});
test("immutable pre-send digest refuses a canonical but edited native possible-attempt", async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close);
  f.row.notes = value(encodeOutboundLaunchAttempt({ ...f.attempt, dncReferences: { actionRef: randomUUID(), approvalRef: randomUUID() } }));
  assert.equal((await f.recover()).ok, false); assert.equal(f.dncPosts.length, 0); assert.equal(f.reportQueries.length, 0);
});
test("report grant withdrawn during native decision preparation prevents the POST", async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close);
  f.stopState.beforeRecord = () => { f.reportState.live = false; };
  assert.equal((await f.recover()).ok, false); assert.equal(f.dncPosts.length, 0);
});
test("known exact DNC ACK survives report grant loss at the native response", async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close);
  f.stopState.response = row => { f.reportState.live = false; return Response.json(row, { status: 201 }); };
  assert.equal(value(await f.recover()).kind, "accepted"); assert.equal(f.dncPosts.length, 1);
});
test("lost native DNC ACK is discovered by a cold recovery without another POST", async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close);
  f.stopState.response = () => { throw Error("Synthetic lost DNC ACK"); };
  assert.equal(value(await f.recover()).kind, "uncertain");
  assert.equal(value(await f.recover()).kind, "existingDecision"); assert.equal(f.dncPosts.length, 1);
});
test("changed patient telephone cannot erase the stop at the actual dialled number", async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close);
  f.contactControls.patient.patient_phone_numbers = [{ number: "+12025550999", phone_type: "Mobile" }];
  assert.equal(value(await f.recover()).kind, "accepted");
  assert.equal(value(decodeOutboundContactReview(f.dncPosts[0]!.notes)).recipient.number, f.context.number);
});
test("report scans and the decision share one bounded physical native request allowance", async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close);
  f.recoveryConfig.stop.maximumNativeRequests = 2;
  const before = f.claims;
  assert.equal((await f.recover()).ok, false); assert.equal(f.claims - before, 2); assert.equal(f.dncPosts.length, 0);
});
test("abort during report history grant does not append a late decision", async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close); const controller = new AbortController();
  f.recoveryPorts.reports.allowsHistoryRead = async () => { controller.abort(); await new Promise<void>(() => {}); return true; };
  assert.equal((await f.recover(controller.signal)).ok, false); assert.equal(f.dncPosts.length, 0);
});
test("authentic complete no-stop evidence supplies no DNC or hold-release authority", async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close);
  f.replaceReport({ terminal: { endedAt: f.state.now, observedAt: f.state.now }, contact: { kind: "completeNoStop" } });
  assert.deepEqual(value(await f.recover()), { kind: "unresolved" }); assert.equal(f.dncPosts.length, 0); assert.equal(f.released.size, 0);
});
test("a validly signed callback for another physical call cannot borrow retained stop evidence", async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close);
  assert.equal((await value(f.makeRecovery()).recoverStatus(f.request({ CallSid: "CA" + "d".repeat(32) }), new AbortController().signal)).ok, false);
  assert.equal(f.dncBurned.size, 0); assert.equal(f.dncPosts.length, 0);
});
test("concurrent cold native report recoveries retain one DNC decision", async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close);
  const results = await Promise.all([f.recover(), f.recover()]);
  assert.equal(results.filter(r => r.ok && r.value.kind === "accepted").length, 1); assert.equal(f.dncPosts.length, 1);
  assert.equal(f.dncBurned.size, 1); assert.equal(f.released.size, 0);
});
test("an uncertain unobserved DNC write is never replayed by a cold native recovery", async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close);
  f.stopState.beforeStore = () => { throw Error("Synthetic write never observed"); };
  assert.equal(value(await f.recover()).kind, "uncertain"); assert.equal((await f.recover()).ok, false); assert.equal(f.dncPosts.length, 1);
});
test("closed archived original and report rows remain recoverable under separate native grants", async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close);
  for (const row of [f.row, f.requestRow, f.reportRow]) { row.recalled = true; row.recalled_at = f.state.now; row.archived_at = f.state.now; row.updated_at = f.state.now; }
  assert.equal(value(await f.recover()).kind, "accepted"); assert.equal(f.dncPosts.length, 1);
});
test("capture does not let replaced report grants or policy methods become new authority", async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close);
  f.reportState.live = false; const captured = value(f.makeRecovery());
  f.recoveryPorts.reports.current = () => true;
  assert.equal((await captured.recoverStatus(f.request(), new AbortController().signal)).ok, false); assert.equal(f.dncPosts.length, 0);
  f.reportState.live = true; const original = f.policy.currentFor;
  f.policy.currentFor = async () => ({ ok: true, value: f.policyApproval });
  assert.equal((await captured.recoverStatus(f.request(), new AbortController().signal)).ok, false); assert.equal(f.dncPosts.length, 0);
  f.policy.currentFor = original;
});
test("an internal producer can recover its retained authentic report without fabricating a provider callback", async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close);
  const result = value(await value(f.makeRecovery()).recoverRetainedReport(f.context, f.carrier.accountSid, f.callSid, new AbortController().signal));
  assert.equal(result.evidence, "stop"); assert.equal(result.outcome.kind, "accepted"); assert.equal(f.dncPosts.length, 1);
  assert.equal(f.released.size, 0);
});
test("internal correlation without a retained authentic report is never a positive stop authority", async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close);
  f.contactControls.rows.splice(f.contactControls.rows.indexOf(f.reportRow), 1);
  assert.deepEqual(value(await value(f.makeRecovery()).recoverRetainedReport(f.context, f.carrier.accountSid, f.callSid, new AbortController().signal)),
    { evidence: "missing", outcome: { kind: "unresolved" } });
  assert.equal(f.dncPosts.length, 0); assert.equal(f.dncBurned.size, 0);
});
test("internal recovery refuses a different configured Twilio account before native access", async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close);
  const before = f.claims;
  assert.equal((await value(f.makeRecovery()).recoverRetainedReport(f.context, "AC" + "f".repeat(32), f.callSid, new AbortController().signal)).ok, false);
  assert.equal(f.claims, before); assert.equal(f.reportQueries.length, 0); assert.equal(f.dncPosts.length, 0);
});
test("caller-supplied edited internal context cannot redirect an authentic original report", async t => {
  const f = await twilioOutboundStopRecoveryFixture(); t.after(f.close);
  const attempt = { ...f.context.original.attempt, dncReferences: { actionRef: randomUUID(), approvalRef: randomUUID() } };
  const context = { ...f.context, original: { ...f.context.original, attempt }, attemptDigest: outboundLaunchAttemptDigest(attempt)! };
  assert.equal((await value(f.makeRecovery()).recoverRetainedReport(context, f.carrier.accountSid, f.callSid, new AbortController().signal)).ok, false);
  assert.equal(f.dncPosts.length, 0); assert.equal(f.dncBurned.size, 0);
});
