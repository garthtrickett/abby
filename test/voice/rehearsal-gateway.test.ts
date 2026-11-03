import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { getExpectedTwilioSignature, validateRequest } from "twilio/lib/webhooks/webhooks.js";
import { createTwilioRehearsalGateway } from "../../src/testing/twilio-rehearsal-gateway.ts";
import { TwilioVoiceRehearsal } from "../../src/testing/twilio-voice-rehearsal.ts";
import { TwilioRehearsalFallback } from "../../src/testing/twilio-rehearsal-fallback.ts";
import { createRehearsalServer } from "../../src/testing/twilio-rehearsal-server.ts";

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address === "object");
  return address.port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("rehearsal gateway forwards only exact public test routes, body and signature", async t => {
  const seen: string[] = [];
  const target = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk.toString();
    seen.push(`target:${request.method}:${request.url}:${request.headers["x-twilio-signature"]}:${body}`);
    response.writeHead(200); response.end("target");
  });
  const caller = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk.toString();
    seen.push(`caller:${request.method}:${request.url}:${request.headers["x-twilio-signature"] ?? ""}:${body}`);
    response.writeHead(request.url === "/healthz" ? 200 : 204); response.end(request.url === "/healthz" ? "run-token" : "");
  });
  const targetPort = await listen(target), callerPort = await listen(caller);
  const gateway = createTwilioRehearsalGateway({ target: targetPort, caller: callerPort });
  const port = await listen(gateway.server);
  t.after(async () => { await gateway.stop(); await close(target); await close(caller); });
  const base = `http://127.0.0.1:${port}`;
  const inbound = await fetch(base + "/twilio/inbound", { method: "POST",
    headers: { "x-twilio-signature": "synthetic-signature" }, body: "CallSid=CA1&From=%2B15550000001" });
  assert.equal(inbound.status, 200); assert.equal(await inbound.text(), "target");
  const health = await fetch(base + "/healthz");
  assert.equal(health.status, 200); assert.equal(await health.text(), "run-token");
  const token = "a".repeat(32);
  for (const path of [`/voice-rehearsal/${token}/0`, `/fallback-ringing/${token}`]) {
    const result = await fetch(base + path, { method: "POST",
      headers: { "x-twilio-signature": "signed-callback" }, body: "CallStatus=ringing" });
    assert.equal(result.status, 204);
  }
  for (const [method, path] of [["GET", "/twilio/inbound"], ["POST", "/healthz"],
    ["POST", `/voice-rehearsal/${token}/0?extra=1`], ["POST", "/private"],
    ["GET", "/twilio/media/"]] as const) {
    assert.equal((await fetch(base + path, { method })).status, 404);
  }
  assert.deepEqual(seen, [
    "target:POST:/twilio/inbound:synthetic-signature:CallSid=CA1&From=%2B15550000001",
    "target:GET:/healthz:undefined:",
    "caller:GET:/healthz::",
    `caller:POST:/voice-rehearsal/${token}/0:signed-callback:CallStatus=ringing`,
    `caller:POST:/fallback-ringing/${token}:signed-callback:CallStatus=ringing`,
  ]);
});

test("rehearsal gateway withholds caller health token while target is unavailable", async t => {
  const target = createServer((_request, response) => { response.writeHead(503); response.end(); });
  let callerHealthReads = 0;
  const caller = createServer((_request, response) => { callerHealthReads++;
    response.writeHead(200); response.end("run-token"); });
  const targetPort = await listen(target), callerPort = await listen(caller);
  const gateway = createTwilioRehearsalGateway({ target: targetPort, caller: callerPort });
  const port = await listen(gateway.server);
  t.after(async () => { await gateway.stop(); await close(target); await close(caller); });
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(response.status, 503); assert.equal(callerHealthReads, 0);
});

test("rehearsal gateway preserves real Twilio callback signatures across one public origin", async t => {
  const accountSid = "AC" + "1".repeat(32), callerSid = "CA" + "2".repeat(32);
  const parentSid = "CA" + "3".repeat(32), childSid = "CA" + "4".repeat(32);
  const authToken = "synthetic-only", runId = "a".repeat(32);
  const publicOrigin = "https://fresh-test.example";
  const callbackUrl = `${publicOrigin}/fallback-ringing/${runId}`;
  const from = "+15555550101", to = "+15555550102", fallback = "+15555550103";
  const expiresAt = Date.now() + 300_000;
  const rehearsal = new TwilioVoiceRehearsal({ accountSid, authToken, from, to,
    callbackBase: publicOrigin, runId, expiresAt });
  rehearsal.bindCall(callerSid);
  const events = new TwilioRehearsalFallback({ accountSid, authToken, callbackUrl, fallback, expiresAt });
  const target = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk.toString();
    const fields = Object.fromEntries(new URLSearchParams(body));
    const valid = validateRequest(authToken, String(request.headers["x-twilio-signature"] ?? ""),
      `${publicOrigin}/twilio/inbound`, fields);
    response.writeHead(valid ? 200 : 403); response.end();
  });
  const caller = createRehearsalServer(rehearsal, () => {}, runId,
    { path: `/fallback-ringing/${runId}`, accept: request => events.accept(request) });
  const targetPort = await listen(target), callerPort = await listen(caller);
  const gateway = createTwilioRehearsalGateway({ target: targetPort, caller: callerPort });
  const port = await listen(gateway.server);
  t.after(async () => { await gateway.stop(); await close(target); await close(caller); });
  const local = `http://127.0.0.1:${port}`;
  const send = (path: string, fields: Record<string, string>, url: string) => fetch(local + path, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": getExpectedTwilioSignature(authToken, url, fields) },
    body: new URLSearchParams(fields),
  });
  const inbound = { AccountSid: accountSid, CallSid: parentSid, From: from, To: to };
  assert.equal((await send("/twilio/inbound", inbound, `${publicOrigin}/twilio/inbound`)).status, 200);
  const speech = { AccountSid: accountSid, CallSid: callerSid, From: from, To: to,
    Direction: "outbound-api", CallStatus: "in-progress", SpeechResult: "Abby test" };
  const answer = await send(`/voice-rehearsal/${runId}/0`, speech,
    `${publicOrigin}/voice-rehearsal/${runId}/0`);
  assert.equal(answer.status, 200); assert.match(await answer.text(), /<Gather/);
  const ringing = { AccountSid: accountSid, CallSid: childSid, ParentCallSid: parentSid,
    To: fallback, CallbackSource: "call-progress-events", Direction: "outbound-dial",
    CallStatus: "ringing", SequenceNumber: "1" };
  events.bindTarget(parentSid);
  const forged = await fetch(local + `/fallback-ringing/${runId}`, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "forged" },
    body: new URLSearchParams(ringing) });
  assert.equal(forged.status, 403); assert.equal(events.ringing(childSid), false);
  assert.equal((await send(`/fallback-ringing/${runId}`, ringing, callbackUrl)).status, 204);
  assert.equal(events.ringing(childSid), true);
});

test("rehearsal gateway carries only the target media WebSocket and closes it on shutdown", async t => {
  const target = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const wss = new WebSocketServer({ noServer: true });
  let upgradedPath = "", signature = "";
  target.on("upgrade", (request, socket, head) => {
    upgradedPath = request.url ?? ""; signature = String(request.headers["x-twilio-signature"] ?? "");
    wss.handleUpgrade(request, socket, head, client => { client.send("media-ready"); });
  });
  const caller = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const targetPort = await listen(target), callerPort = await listen(caller);
  const gateway = createTwilioRehearsalGateway({ target: targetPort, caller: callerPort });
  const port = await listen(gateway.server);
  t.after(async () => { await gateway.stop().catch(() => {}); await close(target); await close(caller);
    await new Promise<void>(done => wss.close(() => done())); });
  const socket = new WebSocket(`ws://127.0.0.1:${port}/twilio/media/`, {
    headers: { "x-twilio-signature": "signed-stream" } });
  const messageReceived = once(socket, "message");
  await once(socket, "open");
  const [message] = await messageReceived;
  assert.equal(message.toString(), "media-ready");
  assert.equal(upgradedPath, "/twilio/media/"); assert.equal(signature, "signed-stream");
  const closed = once(socket, "close");
  await gateway.stop(); await closed;
  assert.equal(socket.readyState, WebSocket.CLOSED);
});

test("rehearsal gateway refuses shared or invalid local listeners", () => {
  for (const ports of [{ target: 3120, caller: 3120 }, { target: 0, caller: 3121 },
    { target: 3120, caller: 65536 }, { target: 3120.5, caller: 3121 }]) {
    assert.throws(() => createTwilioRehearsalGateway(ports), RangeError);
  }
});
