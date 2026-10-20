import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, randomBytes } from "node:crypto";
import { encodeOutboundLaunchAttempt, outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
import { decodeTwilioOutboundReport, encodeTwilioOutboundReport, TwilioOutboundReportAuthentication } from "../../src/cliniko/twilio-outbound-report.ts";
import { twilioOutboundFinalityFixture } from "../support/twilio-outbound-finality.ts";
import { value } from "../support/outbound-records.ts";

test("one complete recovery purpose cannot reset180 native dispatches when the physical minute rolls over", async t => {
  const f = await twilioOutboundFinalityFixture(); t.after(f.close); await f.speakStop();
  const report = value(decodeTwilioOutboundReport(f.reportPosts[0]!.notes)), authentication = new TwilioOutboundReportAuthentication(f.key, f.attempt.provider);
  const original = f.contactControls.rows.find(row => String(row.id) === f.original().original.recallRef.split(":").at(-1))!;
  const nativeReport = f.contactControls.rows.find(row => String(row.id) === "250")!;
  // A valid independently authorized account history can be expensive even
  // though only one pair is selected. Keep every native500/selected50 bound.
  for (let n = 0; n < 35; n++) {
    const originId = String(500 + 2 * n), reportId = String(501 + 2 * n);
    const attempt = { ...f.attempt, actionRef: randomUUID(), effectRef: randomUUID(), capacityAllocationRef: randomUUID(),
      contactReferences: { ...f.attempt.contactReferences!, allocationRef: randomUUID(), outcomeActionRef: randomUUID() },
      dncReferences: { ...f.attempt.dncReferences!, actionRef: randomUUID(), approvalRef: randomUUID() } };
    const { authentication: _, ...unsigned } = report;
    const other = value(authentication.sign({ ...unsigned, actionRef: randomUUID(), callSid: "CA" + randomBytes(16).toString("hex"),
      original: { recallRef: `cliniko:recall:${originId}`, actionRef: attempt.actionRef, digest: outboundLaunchAttemptDigest(attempt)! } }));
    f.contactControls.rows.push({ ...original, id: originId, links: { self: `https://api.au5.cliniko.com/v1/recalls/${originId}` }, notes: value(encodeOutboundLaunchAttempt(attempt)) },
      { ...nativeReport, id: reportId, links: { self: `https://api.au5.cliniko.com/v1/recalls/${reportId}` }, notes: value(encodeTwilioOutboundReport(other)) });
  }
  f.state.now = "2026-11-02T00:01:04.000Z"; let rolled = false;
  f.finalityState.beforeProvider = () => { if (!rolled) { rolled = true; f.state.now = "2026-11-02T00:02:05.000Z"; } };
  const before = f.finalityNativeCalls, result = value(await f.recoverFinality());
  assert.equal(rolled, true, "first complete native read reached the actual provider phase before quota rollover");
  assert.equal(value(result.contact).kind, "held"); assert.equal(f.finalityNativeCalls - before, 180);
  assert.equal(f.outcomePosts.length, 0); assert.equal(f.contactHeld.size, 1); assert.equal(f.callHeld.size, 1); assert.equal(f.carrierCalls, 1);
});
