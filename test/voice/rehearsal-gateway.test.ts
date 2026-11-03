import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { createTwilioRehearsalGateway } from "../../src/testing/twilio-rehearsal-gateway.ts";

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
    "caller:GET:/healthz::",
    `caller:POST:/voice-rehearsal/${token}/0:signed-callback:CallStatus=ringing`,
    `caller:POST:/fallback-ringing/${token}:signed-callback:CallStatus=ringing`,
  ]);
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
