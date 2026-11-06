import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { validateRequest } from "twilio/lib/webhooks/webhooks.js";
import { RehearsalListenerFrames } from "./twilio-rehearsal-listener.ts";

const header = (value: string | string[] | undefined) => typeof value === "string" ? value : undefined;
const deny = (socket: Duplex) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");

/** One signed, exact-run, test-only caller-leg media fork. The WebSocket never
 * sends audio, and its observer exposes aggregate metadata only. */
export function createRehearsalListenerSocket(config: Readonly<{
  accountSid: string; authToken: string; runId: string; publicUrl: string;
  expiresAt: number; now?: () => number;
}>) {
  const url = new URL(config.publicUrl);
  if (!/^AC[0-9a-f]{32}$/i.test(config.accountSid) || !config.authToken ||
      !/^[a-f0-9]{32}$/.test(config.runId) || url.protocol !== "wss:" ||
      url.pathname !== `/voice-rehearsal-media/${config.runId}/` ||
      url.search || url.hash || url.username || url.password ||
      !Number.isSafeInteger(config.expiresAt)) throw Error("Invalid listener socket configuration");
  const frames = new RehearsalListenerFrames(config.accountSid, config.runId);
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false });
  const now = config.now ?? Date.now;
  let claimed = false;
  let settled!: () => void;
  const terminal = new Promise<void>(resolve => { settled = resolve; });
  return {
    bindCall: (callSid: string) => frames.bindCall(callSid),
    summary: () => frames.summary(),
    async waitForTerminal(maxMs: number) {
      if (!claimed) return frames.summary();
      await Promise.race([terminal, delay(maxMs)]);
      return frames.summary();
    },
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      const signature = header(request.headers["x-twilio-signature"]);
      let signed = false;
      try { signed = Boolean(signature && validateRequest(config.authToken, signature, url.href, {})); }
      catch { /* Invalid public upgrade cannot become a stream. */ }
      if (claimed || request.method !== "GET" || request.url !== url.pathname ||
          now() >= config.expiresAt || !signed) { deny(socket); return; }
      claimed = true;
      try {
        websocket.handleUpgrade(request, socket, head, client => {
          client.on("message", (data, binary) => {
            if (binary || !frames.accept(data.toString("utf8"))) client.close(1008);
          });
          client.on("error", () => { frames.finish(); settled(); client.terminate(); });
          client.on("close", () => { frames.finish(); settled(); });
        });
      } catch { frames.finish(); settled(); socket.destroy(); }
    },
    close() {
      for (const client of websocket.clients) client.terminate();
      frames.finish();
      settled();
      websocket.close();
    },
  };
}
