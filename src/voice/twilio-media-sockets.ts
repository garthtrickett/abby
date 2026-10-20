import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { ProviderCallKey } from "../core/model.ts";
import { TWILIO_BINDING_LIFETIME_MS } from "./twilio-signed-ingress.ts";
import type { SignedTwilioUpgrade, SignedTwilioStreamStart } from "./twilio-signed-ingress.ts";

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
export type ActiveCallLease = Readonly<{
  /** Resolves if the cross-process ownership session dies before release. */
  lost: Promise<void>;
  release: () => Promise<void>;
}>;
export type ActiveCallClaims = Readonly<{
  /** A duplicate returns undefined; storage failure rejects and closes the stream. */
  claim: (accountRef: string, providerCallRef: string) => Promise<ActiveCallLease | undefined>;
}>;
export type TwilioAuthenticatedSocketCall = Readonly<{
  key: ProviderCallKey;
  open: (send: (json: string) => "queued" | "notSent" | "uncertain",
    close: (kind?: "normal" | "failure") => void, signal: AbortSignal) => Promise<TwilioWireCall>;
}>;
export type TwilioMediaSocketsConfig = Readonly<{
  authorizeUpgrade: (request: SignedTwilioUpgrade) => boolean;
  authenticateStream: (request: SignedTwilioStreamStart, signal: AbortSignal) => Promise<TwilioAuthenticatedSocketCall | undefined>;
  activeCallClaims?: ActiveCallClaims;
}>;
const header = (v: string | string[] | undefined) => typeof v === "string" ? v : undefined;

function refuseUpgrade(socket: Duplex): void {
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

function runStream(socket: WebSocket, request: IncomingMessage, config: TwilioMediaSocketsConfig,
                   claims: LiveCallClaims): void {
  const upgrade = { method: request.method ?? "", requestTarget: request.url ?? "",
    signature: header(request.headers["x-twilio-signature"]) };
  let connected: string | undefined;
  let call: TwilioWireCall | undefined;
  let tail = Promise.resolve();
  let inFlightMessages = 0;
  let disconnected = false;
  let claimedKey: string | undefined;
  let activeLease: ActiveCallLease | undefined;
  const lifetime = new AbortController();
  const deadline = setTimeout(() => { lifetime.abort(); socket.close(1008); }, startDeadlineMs);
  deadline.unref();
  const disconnect = () => {
    if (disconnected) return;
    disconnected = true; lifetime.abort();
    clearTimeout(deadline);
    if (claimedKey) claims.release(claimedKey);
    if (activeLease) void activeLease.release().catch(() => undefined);
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
    // Admit before chaining behind async authentication/storage/construction.
    // Otherwise a signed peer could fill an unbounded startup promise queue.
    if (inFlightMessages >= 64) { lifetime.abort(); socket.close(1008); return; }
    inFlightMessages += 1;
    let delegated = false;
    tail = tail.then(async () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (isBinary) { socket.close(1003); return; }
      const raw = (Array.isArray(data) ? Buffer.concat(data) :
        data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : data).toString("utf8");
      if (connected === undefined) { connected = raw; return; }
      if (!call) {
        const authenticated = await config.authenticateStream({ ...upgrade, connected, start: raw }, lifetime.signal);
        if (!authenticated) { socket.close(1008); return; }
        if (socket.readyState !== WebSocket.OPEN) return;
        claimedKey = claims.claim(authenticated.key.accountRef, authenticated.key.providerCallRef);
        if (!claimedKey) { socket.close(1008); return; }
        if (config.activeCallClaims) {
          const lease = await config.activeCallClaims.claim(authenticated.key.accountRef, authenticated.key.providerCallRef);
          if (!lease) { socket.close(1008); return; }
          if (socket.readyState !== WebSocket.OPEN) { await lease.release(); return; }
          activeLease = lease;
          void lease.lost.then(() => socket.close(1011), () => socket.close(1011));
        }
        call = await authenticated.open(send, kind => socket.close(kind === "normal" ? 1000 : 1008), lifetime.signal);
        if (socket.readyState !== WebSocket.OPEN) { await call.disconnect(); return; }
        clearTimeout(deadline);
        const first = await call.receive(connected);
        if (!first.ok) { socket.close(1008); return; }
        const second = await call.receive(raw);
        if (!second.ok) socket.close(1008);
        return;
      }
      // Dispatch in wire order without waiting for semantic work. An inbound mark
      // can then release a clear fence awaited by an earlier media message.
      const pending = call.receive(raw);
      delegated = true;
      void pending.then(received => {
        if (!received.ok) socket.close(1008);
      }, () => socket.close(1011)).finally(() => { inFlightMessages -= 1; });
    }).catch(() => socket.close(1011)).finally(() => {
      if (!delegated) inFlightMessages -= 1;
    });
  });
}

/** Shared wire ownership and backpressure. Authentication and typed call
 * construction stay with the inbound or outbound adapter. No private context
 * is retained in the duplicate-claim map. */
export function createTwilioMediaSockets(config: TwilioMediaSocketsConfig): Readonly<{
  handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  close: () => void;
}> {
  const claims = new LiveCallClaims();
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false });
  return Object.freeze({
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      const requestData = { method: request.method ?? "", requestTarget: request.url ?? "",
        signature: header(request.headers["x-twilio-signature"]) };
      let authorized = false;
      try { authorized = config.authorizeUpgrade(requestData) === true; } catch { /* Refuse without provider details. */ }
      if (!authorized) { refuseUpgrade(socket); return; }
      websocket.handleUpgrade(request, socket, head, connection => runStream(connection, request, config, claims));
    },
    close() {
      for (const client of websocket.clients) client.close(1001);
      websocket.close(); claims.clear();
    }
  });
}
