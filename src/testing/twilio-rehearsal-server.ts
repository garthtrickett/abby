import { createServer } from "node:http";
import type { TwilioVoiceRehearsal } from "./twilio-voice-rehearsal.ts";
import type { RehearsalRequest } from "./twilio-voice-rehearsal.ts";
const header = (value: string | string[] | undefined) => typeof value === "string" ? value : undefined;

/** Callback listener only: no clinical services or general-purpose conversation. */
export function createRehearsalServer(rehearsal: TwilioVoiceRehearsal, changed: () => void, healthToken: string,
  fallback?: Readonly<{ path: string; accept(request: RehearsalRequest): Readonly<{ status: number }> }>) {
  if (fallback && !/^\/fallback-ringing\/[a-f0-9]{32}$/.test(fallback.path)) throw Error("Invalid fallback callback path");
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/healthz") { response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }); response.end(healthToken); return; }
      const parts: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 16_384) { response.writeHead(413); response.end(); request.resume(); return; }
        parts.push(Buffer.from(chunk));
      }
      const contentType = header(request.headers["content-type"]), signature = header(request.headers["x-twilio-signature"]);
      const input = { method: request.method ?? "", target: request.url ?? "",
        ...(contentType ? { contentType } : {}), ...(signature ? { signature } : {}), body: Buffer.concat(parts).toString("utf8") };
      const result: Readonly<{ status: number; xml?: string }> = fallback && request.url === fallback.path
        ? fallback.accept(input) : rehearsal.accept(input);
      if (result.status === 200 || result.status === 204) changed();
      response.writeHead(result.status, { "cache-control": "no-store", "content-type": "application/xml" });
      response.end(result.xml ?? "");
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}
