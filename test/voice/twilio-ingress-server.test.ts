import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import twilio from "twilio";
import WebSocket from "ws";
import { createTwilioIngressServer } from "../../src/voice/twilio-ingress-server.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";

const accountSid = `AC${"1".repeat(32)}`;
const callSid = `CA${"2".repeat(32)}`;
const streamSid = `MZ${"3".repeat(32)}`;
const authToken = "synthetic-twilio-test-token";
const webhookUrl = "https://calls.example.test/twilio/inbound";
const streamUrl = "wss://calls.example.test/twilio/media/";

test("E2E-131 local transport: a signed webhook and upgrade reach one authenticated call owner in wire order", async () => {
  const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl,
    publicStreamUrl: streamUrl, fallbackNumbers: { "+6125550199": "+6125550188" },
    bindingKey: Buffer.alloc(32, 0x37),
    now: () => new Date("2026-09-29T10:00:00.000Z") });
  const delivered: string[] = [];
  let created = 0;
  let disconnected = 0;
  const server = createTwilioIngressServer({ ingress, async createCall(stream, send) {
    created += 1;
    assert.deepEqual(stream.event.key, { accountRef: accountSid, providerCallRef: callSid });
    assert.equal(stream.event.dialedNumber, "+6125550199");
    return { async receive(raw) {
      delivered.push(JSON.parse(raw).event as string);
      if (delivered.length === 2) assert.equal(send(JSON.stringify({ event: "ready" })), "queued");
      return { ok: true };
    }, async disconnect() { disconnected += 1; } };
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const socketUrl = `ws://127.0.0.1:${address.port}/twilio/media/`;
  let socket: WebSocket | undefined;
  try {
    const form = { AccountSid: accountSid, CallSid: callSid, To: "+6125550199", From: "+6145550101" };
    const response = await fetch(`${base}/twilio/inbound`, { method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, form),
    }, body: new URLSearchParams(form).toString() });
    assert.equal(response.status, 200);
    const xml = await response.text();
    const binding = xml.match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
    assert.ok(binding);
    const unsigned = new WebSocket(socketUrl);
    const rejected = await new Promise<string>(resolve => unsigned.once("error", error => resolve(error.message)));
    assert.match(rejected, /403/);
    assert.equal(created, 0);

    socket = new WebSocket(socketUrl, { headers: {
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, streamUrl, {}),
    } });
    await once(socket, "open");
    const ready = once(socket, "message");
    socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    socket.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
      start: { accountSid, callSid, streamSid, tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { abbyBinding: binding } } }));
    const [ack] = await ready;
    assert.deepEqual(JSON.parse(ack.toString()), { event: "ready" });
    assert.deepEqual(delivered, ["connected", "start"]);
    assert.equal(created, 1);
    socket.close();
    await once(socket, "close");
    assert.equal(disconnected, 1);
  } finally {
    socket?.terminate();
    server.close();
    await once(server, "close");
  }
});

test("E2E-164 graceful shutdown closes an active signed stream and releases its call owner",
  { timeout: 10_000 }, async () => {
  const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl,
    publicStreamUrl: streamUrl, fallbackNumbers: { "+6125550199": "+6125550188" },
    bindingKey: Buffer.alloc(32, 0x40),
    now: () => new Date("2026-09-29T10:00:00.000Z") });
  let started!: () => void;
  const callStarted = new Promise<void>(resolve => { started = resolve; });
  let released!: () => void;
  const ownerReleased = new Promise<void>(resolve => { released = resolve; });
  let disconnected = 0;
  const server = createTwilioIngressServer({ ingress, async createCall() {
    return { async receive(raw) {
      if (JSON.parse(raw).event === "start") started();
      return { ok: true };
    }, async disconnect() { disconnected += 1; released(); } };
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let socket: WebSocket | undefined;
  let serverClosed = false;
  try {
    const form = { AccountSid: accountSid, CallSid: callSid, To: "+6125550199", From: "+6145550101" };
    const response = await fetch(`http://127.0.0.1:${address.port}/twilio/inbound`, { method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, form),
    }, body: new URLSearchParams(form).toString() });
    assert.equal(response.status, 200);
    const binding = (await response.text()).match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
    assert.ok(binding);
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/twilio/media/`, { headers: {
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, streamUrl, {}),
    } });
    await once(socket, "open");
    socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    socket.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
      start: { accountSid, callSid, streamSid, tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { abbyBinding: binding } } }));
    await callStarted;
    const socketClosed = once(socket, "close");
    const closing = once(server, "close");
    server.close();
    serverClosed = true;
    assert.equal((await socketClosed)[0], 1001);
    await ownerReleased;
    await closing;
    assert.equal(disconnected, 1);
  } finally {
    socket?.terminate();
    if (!serverClosed) { server.close(); await once(server, "close"); }
  }
});

test("E2E-135 local transport: concurrent and later replays cannot construct a second call owner",
  { timeout: 15_000 }, async () => {
  let clockMs = Date.parse("2026-09-29T10:00:00.000Z");
  const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl,
    publicStreamUrl: streamUrl, fallbackNumbers: { "+6125550199": "+6125550188" },
    bindingKey: Buffer.alloc(32, 0x38),
    now: () => new Date(clockMs) });
  let created = 0;
  let disconnected = 0;
  let entered!: () => void;
  let release!: () => void;
  const firstEntered = new Promise<void>(resolve => { entered = resolve; });
  const firstReleased = new Promise<void>(resolve => { release = resolve; });
  const failedSid = `CA${"5".repeat(32)}`;
  const server = createTwilioIngressServer({ ingress, async createCall(stream, send) {
    created += 1;
    if (created === 1) { entered(); await firstReleased; }
    if (stream.event.key.providerCallRef === failedSid) throw new Error("synthetic call factory failure");
    return { async receive(raw) {
      if (JSON.parse(raw).event === "start") send(JSON.stringify({ event: "ready" }));
      return { ok: true };
    }, async disconnect() { disconnected += 1; } };
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const socketUrl = `ws://127.0.0.1:${address.port}/twilio/media/`;
  const sockets: WebSocket[] = [];
  const signature = twilio.getExpectedTwilioSignature(authToken, streamUrl, {});
  async function bindingFor(providerCallSid: string): Promise<string> {
    const form = { AccountSid: accountSid, CallSid: providerCallSid, To: "+6125550199", From: "+6145550101" };
    const response = await fetch(`${base}/twilio/inbound`, { method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, form),
    }, body: new URLSearchParams(form).toString() });
    assert.equal(response.status, 200);
    const token = (await response.text()).match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
    assert.ok(token);
    return token;
  }
  async function openSocket(): Promise<WebSocket> {
    const socket = new WebSocket(socketUrl, { headers: { "x-twilio-signature": signature } });
    sockets.push(socket);
    await once(socket, "open");
    return socket;
  }
  function start(socket: WebSocket, providerCallSid: string, token: string): void {
    socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    socket.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
      start: { accountSid, callSid: providerCallSid, streamSid, tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { abbyBinding: token } } }));
  }
  try {
    const token = await bindingFor(callSid);
    const first = await openSocket();
    const readyFirst = once(first, "message");
    start(first, callSid, token);
    await firstEntered;
    const concurrent = await openSocket();
    const concurrentClosed = once(concurrent, "close");
    start(concurrent, callSid, token);
    const [code] = await concurrentClosed;
    assert.equal(code, 1008);
    assert.equal(created, 1);
    release();
    assert.deepEqual(JSON.parse((await readyFirst)[0].toString()), { event: "ready" });
    const firstClosed = once(first, "close");
    first.close();
    await firstClosed;
    assert.equal(disconnected, 1);

    clockMs += 1_000;
    const retryToken = await bindingFor(callSid);
    assert.notEqual(retryToken, token);
    const replay = await openSocket();
    const replayClosed = once(replay, "close");
    start(replay, callSid, retryToken);
    assert.equal((await replayClosed)[0], 1008);
    assert.equal(created, 1);

    const otherSid = `CA${"4".repeat(32)}`;
    const otherToken = await bindingFor(otherSid);
    const other = await openSocket();
    const readyOther = once(other, "message");
    start(other, otherSid, otherToken);
    assert.deepEqual(JSON.parse((await readyOther)[0].toString()), { event: "ready" });
    assert.equal(created, 2);
    const otherClosed = once(other, "close");
    other.close();
    await otherClosed;
    assert.equal(disconnected, 2);

    const failedToken = await bindingFor(failedSid);
    const failed = await openSocket();
    const failedClosed = once(failed, "close");
    start(failed, failedSid, failedToken);
    assert.equal((await failedClosed)[0], 1011);
    assert.equal(created, 3);
    const failedReplay = await openSocket();
    const failedReplayClosed = once(failedReplay, "close");
    start(failedReplay, failedSid, failedToken);
    assert.equal((await failedReplayClosed)[0], 1008);
    assert.equal(created, 3);
  } finally {
    release();
    for (const socket of sockets) socket.terminate();
    server.close();
    await once(server, "close");
  }
});

test("E2E-136 local webhook: Twilio receives a distinct static post-stream clinic fallback", async () => {
  const inboundA = "+6125550199";
  const inboundB = "+6125550177";
  const fallbackA = "+6125550188";
  const fallbackB = "+6125550166";
  const baseConfig = { accountSid, authToken, publicWebhookUrl: webhookUrl,
    publicStreamUrl: streamUrl, bindingKey: Buffer.alloc(32, 0x39),
    now: () => new Date("2026-09-29T10:00:00.000Z") };
  for (const fallbackNumbers of [{}, { [inboundA]: inboundA }, { [inboundA]: inboundB, [inboundB]: fallbackB },
    { [inboundA]: "not-a-phone" }]) {
    assert.throws(() => new TwilioSignedIngress({ ...baseConfig, fallbackNumbers }), RangeError);
  }
  const fallbackNumbers = { [inboundA]: fallbackA, [inboundB]: fallbackB };
  const ingress = new TwilioSignedIngress({ ...baseConfig, fallbackNumbers });
  fallbackNumbers[inboundA] = "+6125550144";
  let constructed = 0;
  const server = createTwilioIngressServer({ ingress, async createCall() {
    constructed += 1;
    throw new Error("webhook must not create a call owner");
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    for (const [dialed, fallback] of [[inboundA, fallbackA], [inboundB, fallbackB]] as const) {
      const form = { AccountSid: accountSid, CallSid: callSid, To: dialed, From: "+6145550101" };
      const response: Response = await fetch(`http://127.0.0.1:${address.port}/twilio/inbound`, { method: "POST", headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, form),
      }, body: new URLSearchParams(form).toString() });
      assert.equal(response.status, 200);
      const xml = await response.text();
      assert.ok(xml.endsWith(`</Connect><Dial>${fallback}</Dial></Response>`));
      assert.equal(xml.includes("+6145550101"), false);
      assert.equal(xml.includes(dialed), false);
    }
    const unknown = { AccountSid: accountSid, CallSid: callSid, To: "+6125550155", From: "+6145550101" };
    const refused = await fetch(`http://127.0.0.1:${address.port}/twilio/inbound`, { method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, unknown),
    }, body: new URLSearchParams(unknown).toString() });
    assert.equal(refused.status, 503);
    assert.equal(await refused.text(), "Unavailable");
    assert.equal(constructed, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});
