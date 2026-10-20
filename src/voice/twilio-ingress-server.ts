import { TwilioOutboundIngress } from "./twilio-outbound-ingress.ts";
import { createTwilioMediaSockets } from "./twilio-media-sockets.ts";
import type { TwilioWireCall, ActiveCallClaims } from "./twilio-media-sockets.ts";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AuthenticatedInboundCall } from "./admission.ts";
import type { AuthenticatedTwilioStream } from "./twilio-signed-ingress.ts";
import { validOperationalCounts, validOperationalDailyCounts } from "./operational-counts.ts";
import type { OperationalCounts, OperationalDailyCounts } from "./operational-counts.ts";
import { TwilioSignedIngress } from "./twilio-signed-ingress.ts";

const maxBodyBytes = 16_384;

export type { TwilioWireCall, ActiveCallLease, ActiveCallClaims } from "./twilio-media-sockets.ts";
export type TwilioIngressServerConfig = Readonly<{
  ingress: TwilioSignedIngress;
  /** Explicit optional outbound router; default inbound composition stays unchanged. */
  outbound?: TwilioOutboundIngress;
  activeCallClaims?: ActiveCallClaims;
  /** Explicit owning host only. Preserve raw bytes for independent Stripe authentication. */
  stripeWebhook?: (request: IncomingMessage, response: ServerResponse) => void;
  /** Optional operational probe; it cannot authorize a call. */
  health?: () => Promise<boolean>;
  /** Checked after signature verification and before returning stream TwiML. */
  /** No event means a general readiness probe, which a restricted test gate must refuse. */
  admitWebhook?: (event?: AuthenticatedInboundCall) => Promise<boolean>;
  operationalRead?: Readonly<{ tokenHex: string; snapshot: () => OperationalCounts | Promise<OperationalCounts>;
    daily?: () => OperationalDailyCounts | Promise<OperationalDailyCounts> }>;
  /** Constructs a call owner only after the webhook, upgrade, and start have been authenticated. */
  createCall: (stream: AuthenticatedTwilioStream,
    send: (json: string) => "queued" | "notSent" | "uncertain",
    close: (kind?: "normal" | "failure") => void) => Promise<TwilioWireCall>;
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

/** Node HTTP/WebSocket transport; the caller supplies its privacy-safe voice call composition. */
export function createTwilioIngressServer(config: TwilioIngressServerConfig): Server {
  if (config.stripeWebhook !== undefined && typeof config.stripeWebhook !== "function") {
    throw new RangeError("invalid financial webhook handler");
  }
  const stripeWebhook = config.stripeWebhook;
  const outbound = config.outbound;
  if (outbound !== undefined && (!(outbound instanceof TwilioOutboundIngress) || outbound.paths().some(path =>
    Object.values(config.ingress.paths()).includes(path)))) throw new RangeError("conflicting Twilio ingress paths");
  if (config.operationalRead && !/^[a-f0-9]{64}$/i.test(config.operationalRead.tokenHex)) {
    throw new RangeError("invalid operational read token");
  }
  const operationalToken = config.operationalRead ? Buffer.from(config.operationalRead.tokenHex, "hex") : undefined;
  const media = createTwilioMediaSockets({
    ...(config.activeCallClaims ? { activeCallClaims: config.activeCallClaims } : {}),
    authorizeUpgrade: request => config.ingress.authorizeUpgrade(request).ok,
    async authenticateStream(request) {
      const authenticated = config.ingress.authenticateStream(request);
      if (!authenticated.ok || config.admitWebhook && !await config.admitWebhook(authenticated.value.event).catch(() => false)) return;
      return { key: authenticated.value.event.key,
        open: (send, close) => config.createCall(authenticated.value, send, close) };
    }
  });
  const server = createServer((request, response) => {
    void (async () => {
      if (outbound && await outbound.handleHttp(request, response)) return;
      if (request.url === "/stripe/webhook" && stripeWebhook) {
        stripeWebhook(request, response); return;
      }
      if (request.url === "/internal/operations" || request.url === "/internal/operations/daily") {
        const daily = request.url === "/internal/operations/daily";
        const supplied = header(request.headers.authorization)?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
        if (!operationalToken) {
          response.writeHead(404, { "cache-control": "no-store" }); response.end(); return;
        }
        if (request.method !== "GET" || !supplied ||
            !timingSafeEqual(Buffer.from(supplied, "hex"), operationalToken)) {
          response.writeHead(403, { "cache-control": "no-store" }); response.end(); return;
        }
        const result = await Promise.resolve().then(() => daily
          ? config.operationalRead!.daily?.() : config.operationalRead!.snapshot()).catch(() => undefined);
        if (daily ? !validOperationalDailyCounts(result) : !validOperationalCounts(result)) {
          response.writeHead(503, { "cache-control": "no-store" }); response.end(); return;
        }
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify(result));
        return;
      }
      if (request.method === "GET" && request.url === "/healthz" && config.health) {
        const healthy = await config.health().catch(() => false);
        response.writeHead(healthy ? 200 : 503, { "content-type": "text/plain", "cache-control": "no-store" });
        response.end(healthy ? "ok" : "unavailable");
        return;
      }
      if (request.method === "GET" && request.url === "/readyz" &&
          (config.health || config.admitWebhook)) {
        const ready = (!config.health || await config.health().catch(() => false)) &&
          (!config.admitWebhook || await config.admitWebhook().catch(() => false));
        response.writeHead(ready ? 200 : 503, { "content-type": "text/plain", "cache-control": "no-store" });
        response.end(ready ? "ready" : "unavailable");
        return;
      }
      const raw = await body(request);
      if (raw === undefined) { response.writeHead(413); response.end(); return; }
      const answered = config.ingress.authenticateWebhook({ method: request.method ?? "",
        requestTarget: request.url ?? "", contentType: header(request.headers["content-type"]),
        signature: header(request.headers["x-twilio-signature"]), body: raw });
      if (answered.ok && config.admitWebhook && !await config.admitWebhook(answered.value.event).catch(() => false)) {
        response.writeHead(503, { "content-type": "text/plain", "cache-control": "no-store" });
        response.end("Unavailable");
        return;
      }
      const status = answered.ok ? 200 : answered.error.kind === "fallbackNotConfigured" ? 503 : 403;
      response.writeHead(status, { "content-type": answered.ok ? "application/xml; charset=utf-8" : "text/plain",
        "cache-control": "no-store" });
      response.end(answered.ok ? answered.value.twiml : status === 503 ? "Unavailable" : "Forbidden");
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  server.requestTimeout = 10_000;
  server.on("upgrade", (request, socket, head) => {
    if (outbound?.handleUpgrade(request, socket, head)) return;
    media.handleUpgrade(request, socket, head);
  });
  const closeHttp = server.close.bind(server);
  server.close = callback => {
    // Upgraded sockets can keep the HTTP server open, so its "close" event is
    // too late to start draining live calls. Close them before waiting for HTTP.
    outbound?.close(); media.close();
    return closeHttp(callback);
  };
  return server;
}
