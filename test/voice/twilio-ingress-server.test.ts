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
    publicStreamUrl: streamUrl, bindingKey: Buffer.alloc(32, 0x37),
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
