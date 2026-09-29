import assert from "node:assert/strict";
import test from "node:test";
import twilio from "twilio";
import { TwilioMediaStream } from "../../src/voice/twilio-media-stream.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";

const accountSid = `AC${"1".repeat(32)}`;
const callSid = `CA${"2".repeat(32)}`;
const streamSid = `MZ${"3".repeat(32)}`;
const webhookUrl = "https://calls.example.test/twilio/inbound?source=clinic";
const streamUrl = "wss://calls.example.test/twilio/media/";
const authToken = "test-auth-token-never-used-outside-this-fixture";
const dialedNumber = "+6125550199";
const callerNumber = "+6145550101";
const fixed = new Date("2026-09-29T10:00:00.000Z");

function fixture() {
  let clock = fixed.getTime();
  const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl,
    publicStreamUrl: streamUrl, fallbackNumbers: { [dialedNumber]: "+6125550188" },
    bindingKey: Buffer.alloc(32, 0x5a), now: () => new Date(clock) });
  const form = { AccountSid: accountSid, CallSid: callSid, To: dialedNumber, From: callerNumber,
    ExtraFutureParameter: "retained for signature validation" };
  const body = new URLSearchParams(form).toString();
  const signature = twilio.getExpectedTwilioSignature(authToken, webhookUrl, form);
  const webhook = { method: "POST", requestTarget: "/twilio/inbound?source=clinic",
    contentType: "application/x-www-form-urlencoded; charset=utf-8", signature, body };
  const answered = ingress.answerWebhook(webhook);
  assert.ok(answered.ok, answered.ok ? "" : answered.error.kind);
  const binding = answered.value.match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
  assert.ok(binding);
  const connected = JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" });
  const start = (token: string, overrides: object = {}) => JSON.stringify({ event: "start", sequenceNumber: "1",
    streamSid, start: { accountSid, callSid, streamSid, tracks: ["inbound"],
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      customParameters: { abbyBinding: token }, ...overrides } });
  const upgrade = { method: "GET", requestTarget: "/twilio/media/",
    signature: twilio.getExpectedTwilioSignature(authToken, streamUrl, {}), connected, start: start(binding) };
  return { ingress, webhook, answered: answered.value, binding, start, upgrade,
    advance(ms: number) { clock += ms; } };
}

test("E2E-131 synthetic Twilio: signed webhook binds dialed number and caller clue to a signed stream start", () => {
  const { ingress, answered, upgrade } = fixture();
  assert.match(answered, /^<\?xml version="1.0" encoding="UTF-8"\?><Response><Connect><Stream url="wss:\/\/calls\.example\.test\/twilio\/media\/">/);
  assert.ok(!answered.includes(callerNumber));
  assert.ok(!answered.includes(dialedNumber));
  const authenticated = ingress.authenticateStream(upgrade);
  assert.ok(authenticated.ok, authenticated.ok ? "" : authenticated.error.kind);
  assert.deepEqual(authenticated.value.event, { key: { accountRef: accountSid, providerCallRef: callSid },
    dialedNumber, presentedCallerNumber: callerNumber, receivedAt: fixed.toISOString() });
  const stream = new TwilioMediaStream({ accountSid: authenticated.value.event.key.accountRef,
    callSid: authenticated.value.event.key.providerCallRef, sessionId: "session",
    startedAt: authenticated.value.streamStartedAt, send: () => "queued" });
  assert.deepEqual(stream.receive(authenticated.value.connected), { ok: true, value: { kind: "connected" } });
  assert.deepEqual(stream.receive(authenticated.value.start), { ok: true, value: { kind: "started" } });
});

test("E2E-131 synthetic Twilio: tampered HTTP signature, changed body, route and duplicate fields fail closed", () => {
  const { ingress, webhook } = fixture();
  for (const changed of [
    { ...webhook, signature: "forged" },
    { ...webhook, body: webhook.body.replace(callerNumber.replace("+", "%2B"), "%2B6145550102") },
    { ...webhook, requestTarget: "/twilio/other?source=clinic" },
    { ...webhook, body: `${webhook.body}&To=%2B6125550198` },
    { ...webhook, contentType: "application/json" },
  ]) assert.equal(ingress.answerWebhook(changed).ok, false);
});

test("E2E-131 synthetic Twilio: unsigned, mismatched and expired stream bindings fail closed", () => {
  const { ingress, binding, start, upgrade, advance } = fixture();
  const failures = [
    { ...upgrade, signature: "forged" },
    { ...upgrade, requestTarget: "/twilio/media" },
    { ...upgrade, start: start(`${binding.slice(0, -1)}${binding.endsWith("A") ? "B" : "A"}`) },
    { ...upgrade, start: start(binding, { callSid: `CA${"9".repeat(32)}` }) },
    { ...upgrade, start: start(binding, { accountSid: `AC${"9".repeat(32)}` }) },
    { ...upgrade, start: start(binding, { customParameters: { abbyBinding: binding, unexpected: "x" } }) },
  ];
  for (const changed of failures) assert.equal(ingress.authenticateStream(changed).ok, false);
  advance(180_001);
  assert.deepEqual(ingress.authenticateStream(upgrade), { ok: false, error: { kind: "expiredTwilioBinding" } });
});

test("E2E-131 synthetic Twilio: an unknown caller ID is not treated as a trusted patient phone", () => {
  const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl,
    publicStreamUrl: streamUrl, fallbackNumbers: { [dialedNumber]: "+6125550188" },
    bindingKey: Buffer.alloc(32, 0x5a), now: () => fixed });
  const form = { AccountSid: accountSid, CallSid: callSid, To: dialedNumber, From: "anonymous" };
  const answer = ingress.answerWebhook({ method: "POST", requestTarget: "/twilio/inbound?source=clinic",
    contentType: "application/x-www-form-urlencoded", body: new URLSearchParams(form).toString(),
    signature: twilio.getExpectedTwilioSignature(authToken, webhookUrl, form) });
  assert.ok(answer.ok);
  const binding = answer.value.match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
  assert.ok(binding);
  const authenticated = ingress.authenticateStream({ method: "GET", requestTarget: "/twilio/media/",
    signature: twilio.getExpectedTwilioSignature(authToken, streamUrl, {}),
    connected: JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }),
    start: JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
      start: { accountSid, callSid, streamSid, customParameters: { abbyBinding: binding } } }) });
  assert.ok(authenticated.ok);
  assert.equal(authenticated.value.event.presentedCallerNumber, undefined);
});
