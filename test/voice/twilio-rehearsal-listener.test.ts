import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import WebSocket from "ws";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks.js";
import { RehearsalListenerFrames } from "../../src/testing/twilio-rehearsal-listener.ts";
import { createRehearsalListenerSocket } from "../../src/testing/twilio-rehearsal-listener-socket.ts";
import { createRehearsalServer } from "../../src/testing/twilio-rehearsal-server.ts";
import { createTwilioRehearsalGateway } from "../../src/testing/twilio-rehearsal-gateway.ts";
import { TwilioVoiceRehearsal } from "../../src/testing/twilio-voice-rehearsal.ts";

const accountSid = `AC${"1".repeat(32)}`, callSid = `CA${"2".repeat(32)}`;
const streamSid = `MZ${"3".repeat(32)}`, runId = "4".repeat(32);
const authToken = "synthetic-test-only", base = "https://test.example";
const publicUrl = `wss://test.example/voice-rehearsal-media/${runId}`;
const frame = (event: unknown) => JSON.stringify(event);
const connected = () => frame({ event: "connected", protocol: "Call", version: "1.0.0" });
const start = (sid = callSid) => frame({ event: "start", sequenceNumber: "1", streamSid,
  start: { accountSid, callSid: sid, streamSid, tracks: ["inbound", "outbound"],
    mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
    customParameters: { runId } } });
const media = (sequence: number, track: "inbound" | "outbound", byte: number) => frame({
  event: "media", sequenceNumber: String(sequence), streamSid,
  media: { track, chunk: String(sequence - 1), timestamp: "0", payload: Buffer.alloc(160, byte).toString("base64") } });
const timedMedia = (sequence: number, track: "inbound" | "outbound",
  timestamp: number, byte: number) => frame({ event: "media", sequenceNumber: String(sequence), streamSid,
  media: { track, chunk: String(sequence - 1), timestamp: String(timestamp),
    payload: Buffer.alloc(160, byte).toString("base64") } });
const stop = (sequence: number) => frame({ event: "stop", sequenceNumber: String(sequence), streamSid,
  stop: { accountSid, callSid } });

test("listener keeps only bounded caller-leg energy metadata for an exact complete stream", () => {
  const listener = new RehearsalListenerFrames(accountSid, runId);
  for (const packet of [connected(), start(), media(2, "inbound", 0),
    media(3, "outbound", 0xff), stop(4)]) assert.equal(listener.accept(packet), true);
  listener.bindCall(callSid);
  assert.deepEqual(listener.summary(), { status: "captured", inboundFrames: 1,
    outboundFrames: 1, inboundGaps: 0, outboundGaps: 0,
    inboundActiveMs: 20, outboundActiveMs: 0 });
  assert(!JSON.stringify(listener.summary()).includes(Buffer.alloc(160, 0).toString("base64")));
});

test("listener refuses mismatched caller, missing frames and incomplete stream rather than measuring them", () => {
  const wrong = new RehearsalListenerFrames(accountSid, runId);
  wrong.bindCall(`CA${"9".repeat(32)}`);
  assert.equal(wrong.accept(connected()), true);
  assert.equal(wrong.accept(start()), false);
  assert.deepEqual({ status: wrong.summary().status, reason: wrong.summary().reason },
    { status: "unverified", reason: "callerMismatch" });

  const gap = new RehearsalListenerFrames(accountSid, runId);
  gap.bindCall(callSid); gap.accept(connected()); gap.accept(start());
  assert.equal(gap.accept(media(3, "inbound", 0)), false);
  assert.equal(gap.summary().reason, "sequenceGap");

  const incomplete = new RehearsalListenerFrames(accountSid, runId);
  incomplete.bindCall(callSid); incomplete.accept(connected()); incomplete.accept(start());
  incomplete.accept(media(2, "inbound", 0)); incomplete.finish();
  assert.equal(incomplete.summary().status, "unverified");
  assert.equal(incomplete.summary().reason, "missingStop");
});

test("caller-leg energy yields a timing candidate while keeping audio and outcome qualification separate", () => {
  const listener = new RehearsalListenerFrames(accountSid, runId);
  listener.bindCall(callSid); listener.accept(connected()); listener.accept(start());
  let sequence = 2;
  for (let index = 0; index < 200; index++) {
    const timestamp = index * 20;
    const targetSpeaking = timestamp >= 1_900 && timestamp < 2_260;
    const scriptSpeaking = timestamp < 120 || timestamp >= 2_200 && timestamp < 2_320;
    assert(listener.accept(timedMedia(sequence++, "inbound", timestamp,
      targetSpeaking ? 0 : 0xff)));
    assert(listener.accept(timedMedia(sequence++, "outbound", timestamp,
      scriptSpeaking ? 0 : 0xff)));
  }
  listener.accept(stop(sequence));
  const summary = listener.summary();
  assert.equal(summary.status, "captured");
  assert.deepEqual(summary.silenceCandidate, { secondUtteranceAtMs: 2_200,
    targetActiveBeforeMs: 300, candidateSilenceLagMs: 60 });
  assert(!JSON.stringify(summary).includes("payload"));

  const naturalPause = new RehearsalListenerFrames(accountSid, runId);
  naturalPause.bindCall(callSid); naturalPause.accept(connected()); naturalPause.accept(start());
  sequence = 2;
  for (let index = 0; index < 200; index++) {
    const timestamp = index * 20;
    naturalPause.accept(timedMedia(sequence++, "inbound", timestamp,
      timestamp >= 1_900 && timestamp < 2_060 ? 0 : 0xff));
    naturalPause.accept(timedMedia(sequence++, "outbound", timestamp,
      timestamp < 120 || timestamp >= 2_200 && timestamp < 2_320 ? 0 : 0xff));
  }
  naturalPause.accept(stop(sequence));
  assert.equal(naturalPause.summary().status, "captured");
  assert.equal(naturalPause.summary().silenceCandidate, undefined);
});

test("listener upgrade needs the exact signed public WSS URL and cannot accept another stream", async t => {
  const listener = createRehearsalListenerSocket({ accountSid, authToken, runId,
    publicUrl, expiresAt: Date.now() + 60_000 });
  const server = createServer();
  server.on("upgrade", (request, socket, head) => listener.handleUpgrade(request, socket, head));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address === "object");
  const local = `ws://127.0.0.1:${address.port}/voice-rehearsal-media/${runId}`;
  t.after(async () => { listener.close(); await new Promise<void>(done => server.close(() => done())); });

  const forged = new WebSocket(local, { headers: { "x-twilio-signature": "forged" } });
  forged.on("error", () => {});
  const rejected = once(forged, "unexpected-response");
  const [request, response] = await rejected;
  assert.equal(response.statusCode, 403); request.destroy();

  const signature = getExpectedTwilioSignature(authToken, publicUrl, {});
  const valid = new WebSocket(local, { headers: { "x-twilio-signature": signature } });
  await once(valid, "open");
  for (const packet of [connected(), start(), media(2, "inbound", 0),
    media(3, "outbound", 0xff), stop(4)]) valid.send(packet);
  listener.bindCall(callSid);
  valid.close(); await once(valid, "close");
  assert.equal(listener.summary().status, "captured");

  const duplicate = new WebSocket(local, { headers: { "x-twilio-signature": signature } });
  duplicate.on("error", () => {});
  const [, duplicateResponse] = await once(duplicate, "unexpected-response");
  assert.equal(duplicateResponse.statusCode, 403);
});

test("only the opt-in interruption script forks both caller-leg tracks", () => {
  const config = { accountSid, authToken, from: "+15555550101", to: "+15555550102",
    callbackBase: base, runId, expiresAt: 300_000, now: () => 1000 };
  const plain = new TwilioVoiceRehearsal({ ...config, scenario: "interruption" });
  const observed = new TwilioVoiceRehearsal({ ...config, scenario: "interruption",
    listenerStreamUrl: publicUrl });
  assert(!plain.initialTwiml().includes("<Stream"));
  assert.match(observed.initialTwiml(), /<Start><Stream[^>]*track="both_tracks"/);
  assert.match(observed.initialTwiml(), /<Parameter name="runId"/);
  assert.throws(() => new TwilioVoiceRehearsal({ ...config, scenario: "dialogue",
    listenerStreamUrl: publicUrl }));
});

test("one public rehearsal gateway routes signed caller media to the isolated listener", async t => {
  const target = createServer((_request, response) => { response.writeHead(200); response.end(); });
  target.listen(0, "127.0.0.1"); await once(target, "listening");
  const targetAddress = target.address(); assert(targetAddress && typeof targetAddress === "object");
  const listener = createRehearsalListenerSocket({ accountSid, authToken, runId,
    publicUrl, expiresAt: Date.now() + 60_000 });
  const rehearsal = new TwilioVoiceRehearsal({ accountSid, authToken,
    from: "+15555550101", to: "+15555550102", callbackBase: base,
    runId, expiresAt: Date.now() + 60_000, scenario: "interruption", listenerStreamUrl: publicUrl });
  const caller = createRehearsalServer(rehearsal, () => {}, runId, undefined, listener);
  caller.listen(0, "127.0.0.1"); await once(caller, "listening");
  const callerAddress = caller.address(); assert(callerAddress && typeof callerAddress === "object");
  const gateway = createTwilioRehearsalGateway({ target: targetAddress.port, caller: callerAddress.port });
  gateway.server.listen(0, "127.0.0.1"); await once(gateway.server, "listening");
  const gatewayAddress = gateway.server.address(); assert(gatewayAddress && typeof gatewayAddress === "object");
  t.after(async () => { listener.close(); await gateway.stop();
    await new Promise<void>(done => caller.close(() => done()));
    await new Promise<void>(done => target.close(() => done())); });

  const socket = new WebSocket(`ws://127.0.0.1:${gatewayAddress.port}/voice-rehearsal-media/${runId}`,
    { headers: { "x-twilio-signature": getExpectedTwilioSignature(authToken, publicUrl, {}) } });
  await once(socket, "open");
  for (const packet of [connected(), start(), media(2, "inbound", 0),
    media(3, "outbound", 0xff), stop(4)]) socket.send(packet);
  listener.bindCall(callSid);
  socket.close(); await once(socket, "close");
  assert.equal(listener.summary().status, "captured");
});
