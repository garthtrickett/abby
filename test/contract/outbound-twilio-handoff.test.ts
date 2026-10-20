import assert from "node:assert/strict";
import test from "node:test";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks.js";
import { outboundContactLifecycleFixture } from "../support/outbound-contact-lifecycle.ts";
import { value } from "../support/outbound-records.ts";
import { ClinikoOutboundLaunchOwner } from "../../src/standalone/cliniko-outbound-launch-owner.ts";
import { TwilioAbbyOutboundRuntime } from "../../src/voice/twilio-outbound-runtime.ts";
import { bindOutboundVoiceRuntime } from "../../src/voice/outbound-runtime.ts";
import { outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";

test("actual clinic launch supplies the ACKed original context through the selected Twilio adapter and cold signed recovery", async t => {
  const f = await outboundContactLifecycleFixture(); t.after(f.close);
  const config = { ref: f.controls.providerRef, profileRef: "generic-clinic-greeting", accountSid: `AC${"a".repeat(32)}`, authToken: "synthetic-outbound-token",
    from: "+61255550100", publicAnswerUrl: "https://example.invalid/outbound/answer", publicStatusUrl: "https://example.invalid/outbound/status",
    publicStreamUrl: "wss://example.invalid/outbound/stream", contextKey: new Uint8Array(32).fill(7), now: () => f.state.now };
  let requests = 0, form!: URLSearchParams; const sid = `CA${"b".repeat(32)}`;
  const port: typeof fetch = async (_url, init) => {
    requests++; assert.equal(f.posts, 1); assert.equal(f.contactHeld.size, 1); assert.equal(f.held.size, 1);
    const { attempt } = f.retained(); assert.equal(f.burned.has(attempt.effectRef), true);
    form = new URLSearchParams(String(init?.body)); assert.equal(form.get("To"), f.request.recipient.number);
    return Response.json({ account_sid: config.accountSid, sid, to: form.get("To"), from: config.from, direction: "outbound-api", status: "queued",
      parent_call_sid: null, uri: `/2010-04-01/Accounts/${config.accountSid}/Calls/${sid}.json` }, { status: 201 });
  };
  const adapter = new TwilioAbbyOutboundRuntime(config, port), runtime = value(bindOutboundVoiceRuntime(adapter));
  const owner = value(ClinikoOutboundLaunchOwner.create(f.config, { ...f.ports, provider: runtime.launch }));
  assert.deepEqual(value(await owner.launchOnce(f.binding, new AbortController().signal)), { kind: "accepted", capacity: "held" });
  const { row, attempt } = f.retained(), url = new URL(form.get("Url")!);
  const fields = { AccountSid: config.accountSid, CallSid: sid, Direction: "outbound-api", From: config.from, To: f.request.recipient.number, CallStatus: "in-progress" };
  const cold = new TwilioAbbyOutboundRuntime(config, async () => { throw Error("no dispatch on callback"); });
  const answer = value(cold.authenticateAnswer({ method: "POST", requestTarget: url.pathname + url.search, contentType: "application/x-www-form-urlencoded",
    signature: getExpectedTwilioSignature(config.authToken, url.href, fields), body: new URLSearchParams(fields).toString() }));
  assert.equal(answer.call.context.original.recallRef, `cliniko:recall:${row.id}`);
  assert.equal(answer.call.context.attemptDigest, outboundLaunchAttemptDigest(attempt));
  assert.deepEqual(answer.call.context.original.attempt.contactReferences, attempt.contactReferences);
  assert.equal((await owner.launchOnce(f.binding, new AbortController().signal)).ok, false); assert.equal(requests, 1);
  assert.equal(f.contactHeld.size, 1); assert.equal(f.held.size, 1);
});
