import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { AuthenticatedTwilioStream } from "./twilio-signed-ingress.ts";
import { TWILIO_BINDING_LIFETIME_MS, TwilioSignedIngress } from "./twilio-signed-ingress.ts";

const maxBodyBytes = 16_384;
const maxBufferedBytes = 512 * 1_024;
const startDeadlineMs = 5_000;
const maxCallClaims = 10_000;

/** Process-local duplicate fence for the first signed binding window. */
class LiveCallClaims {
  private readonly calls = new Map<string, { active: boolean; expiresAt: number }>();
  private readonly cleanup: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanup = setInterval(() => this.sweep(Date.now()), 30_000);
    this.cleanup.unref();
  }

  private sweep(now: number): void {
    for (const [key, claim] of this.calls) {
      if (!claim.active && claim.expiresAt <= now) this.calls.delete(key);
    }
  }

  claim(accountRef: string, providerCallRef: string): string | undefined {
    const key = JSON.stringify([accountRef, providerCallRef]);
    const now = Date.now();
    const prior = this.calls.get(key);
    if (prior && (prior.active || prior.expiresAt > now)) return undefined;
    if (prior) this.calls.delete(key);
    if (this.calls.size >= maxCallClaims) {
      this.sweep(now);
      if (this.calls.size >= maxCallClaims) return undefined;
    }
    this.calls.set(key, { active: true, expiresAt: now + TWILIO_BINDING_LIFETIME_MS });
    return key;
  }

  release(key: string): void {
    const claimed = this.calls.get(key);
    if (!claimed) return;
    if (claimed.expiresAt <= Date.now()) this.calls.delete(key);
    else claimed.active = false;
  }

  clear(): void { clearInterval(this.cleanup); this.calls.clear(); }
}

export type TwilioWireCall = Readonly<{
  receive: (raw: string) => Promise<Readonly<{ ok: boolean }>>;
  disconnect: () => Promise<unknown>;
}>;
export type TwilioIngressServerConfig = Readonly<{
  ingress: TwilioSignedIngress;
  /** Constructs a call owner only after the webhook, upgrade, and start have been authenticated. */
  createCall: (stream: AuthenticatedTwilioStream,
    send: (json: string) => "queued" | "notSent" | "uncertain",
    close: () => void) => Promise<TwilioWireCall>;
}>;

function header(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function body(request: IncomingMessage): Promise<string | undefined> {
  const length = Number(request.headers["content-length"]);
  if (Number.isFinite(length) && length > maxBodyBytes) return undefined;
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
    size += bytes.length;
    if (size > maxBodyBytes) { request.resume(); return undefined; }
    parts.push(bytes);
  }
  return Buffer.concat(parts).toString("utf8");
}

function refuseUpgrade(socket: Duplex): void {
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

function runStream(socket: WebSocket, request: IncomingMessage, config: TwilioIngressServerConfig,
                   claims: LiveCallClaims): void {
  const upgrade = { method: request.method ?? "", requestTarget: request.url ?? "",
    signature: header(request.headers["x-twilio-signature"]) };
  let connected: string | undefined;
  let call: TwilioWireCall | undefined;
  let tail = Promise.resolve();
  let disconnected = false;
  let claimedKey: string | undefined;
  const deadline = setTimeout(() => socket.close(1008), startDeadlineMs);
  deadline.unref();
  const disconnect = () => {
    if (disconnected) return;
    disconnected = true;
    clearTimeout(deadline);
    if (claimedKey) claims.release(claimedKey);
    if (call) void call.disconnect().catch(() => undefined);
  };
  socket.on("close", disconnect);
  socket.on("error", () => socket.close(1011));

  const send = (json: string): "queued" | "notSent" | "uncertain" => {
    if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > maxBufferedBytes) return "notSent";
    try {
      socket.send(json, error => { if (error) socket.close(1011); });
      return "queued";
    } catch { return "uncertain"; }
  };

  socket.on("message", (data, isBinary) => {
    tail = tail.then(async () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (isBinary) { socket.close(1003); return; }
      const raw = (Array.isArray(data) ? Buffer.concat(data) :
        data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : data).toString("utf8");
      if (connected === undefined) { connected = raw; return; }
      if (!call) {
        const authenticated = config.ingress.authenticateStream({ ...upgrade, connected, start: raw });
        if (!authenticated.ok) { socket.close(1008); return; }
        claimedKey = claims.claim(authenticated.value.event.key.accountRef,
          authenticated.value.event.key.providerCallRef);
        if (!claimedKey) { socket.close(1008); return; }
        call = await config.createCall(authenticated.value, send, () => socket.close(1008));
        if (socket.readyState !== WebSocket.OPEN) { await call.disconnect(); return; }
        clearTimeout(deadline);
        const first = await call.receive(authenticated.value.connected);
        if (!first.ok) { socket.close(1008); return; }
        const second = await call.receive(authenticated.value.start);
        if (!second.ok) socket.close(1008);
        return;
      }
      const received = await call.receive(raw);
      if (!received.ok) socket.close(1008);
    }).catch(() => socket.close(1011));
  });
}

/** Node HTTP/WebSocket transport; the caller supplies its privacy-safe voice call composition. */
export function createTwilioIngressServer(config: TwilioIngressServerConfig): Server {
  const claims = new LiveCallClaims();
  const websocket = new WebSocketServer({ noServer: true, maxPayload: maxBodyBytes,
    perMessageDeflate: false });
  const server = createServer((request, response) => {
    void (async () => {
      const raw = await body(request);
      if (raw === undefined) { response.writeHead(413); response.end(); return; }
      const answered = config.ingress.answerWebhook({ method: request.method ?? "",
        requestTarget: request.url ?? "", contentType: header(request.headers["content-type"]),
        signature: header(request.headers["x-twilio-signature"]), body: raw });
      const status = answered.ok ? 200 : answered.error.kind === "fallbackNotConfigured" ? 503 : 403;
      response.writeHead(status, { "content-type": answered.ok ? "application/xml; charset=utf-8" : "text/plain",
        "cache-control": "no-store" });
      response.end(answered.ok ? answered.value : status === 503 ? "Unavailable" : "Forbidden");
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  server.requestTimeout = 10_000;
  server.on("upgrade", (request, socket, head) => {
    const authorized = config.ingress.authorizeUpgrade({ method: request.method ?? "",
      requestTarget: request.url ?? "", signature: header(request.headers["x-twilio-signature"]) });
    if (!authorized.ok) { refuseUpgrade(socket); return; }
    websocket.handleUpgrade(request, socket, head, connection => runStream(connection, request, config, claims));
  });
  server.on("close", () => { for (const client of websocket.clients) client.close(1001); websocket.close(); claims.clear(); });
  return server;
}
