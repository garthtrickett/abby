import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AvailabilityTextRequest, PreparedAvailabilityText, AvailabilityTextFailure } from "../availability-text-runner.ts";
import type { Result, TransitionFailure } from "../../core/model.ts";

type AvailabilityRunner = Readonly<{
  prepare(request: AvailabilityTextRequest): Promise<Result<PreparedAvailabilityText, AvailabilityTextFailure>>;
  confirmWritten(prepared: Pick<PreparedAvailabilityText, "callId" | "presentationId">): Promise<Result<true, TransitionFailure>>;
}>;

const maxRequestBytes = 8_192;
const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Abby availability</title><link rel="stylesheet" href="/style.css"></head><body><main id="app"></main><script type="module" src="/app.js"></script></body></html>`;
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" };

function send(response: ServerResponse, status: number, type: string, value: string, onWritten?: () => void): void {
  response.writeHead(status, { ...headers, "Content-Type": type });
  response.end(value, onWritten);
}

function json(response: ServerResponse, status: number, value: unknown, onWritten?: () => void): void {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(value), onWritten);
}

async function readRequest(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > maxRequestBytes) throw new Error("invalid input");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function availabilityRequest(value: unknown): value is AvailabilityTextRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return Object.keys(fields).length === 3 && typeof fields.text === "string" &&
    typeof fields.from === "string" && typeof fields.to === "string";
}

/** Local text probe. The caller question and offered times are sent to the browser, never logged here. */
export async function createAvailabilityConsoleServer(runner: AvailabilityRunner, bundlePath: string): Promise<Server> {
  const [bundle, stylesheet] = await Promise.all([
    readFile(bundlePath, "utf8"), readFile(new URL("./style.css", import.meta.url), "utf8"),
  ]);
  return createServer((request, response) => { void handle(request, response, runner, bundle, stylesheet); });
}

async function handle(request: IncomingMessage, response: ServerResponse, runner: AvailabilityRunner,
                      bundle: string, stylesheet: string): Promise<void> {
  try {
    const address = response.socket?.localAddress;
    const port = response.socket?.localPort;
    if (address !== "127.0.0.1" || request.headers.host !== `127.0.0.1:${port}`) {
      json(response, 403, { ok: false, error: { kind: "forbidden" } }); return;
    }
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && path === "/") {
      send(response, 200, "text/html; charset=utf-8", document); return;
    }
    if (request.method === "GET" && path === "/app.js") {
      send(response, 200, "text/javascript; charset=utf-8", bundle); return;
    }
    if (request.method === "GET" && path === "/style.css") {
      send(response, 200, "text/css; charset=utf-8", stylesheet); return;
    }
    if (request.method !== "POST" || path !== "/api/availability") {
      json(response, 404, { ok: false, error: { kind: "notFound" } }); return;
    }
    if (request.headers.origin !== `http://127.0.0.1:${port}`) {
      json(response, 403, { ok: false, error: { kind: "forbidden" } }); return;
    }
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      json(response, 415, { ok: false, error: { kind: "invalidInput" } }); return;
    }
    let input: unknown;
    try { input = await readRequest(request); }
    catch { json(response, 400, { ok: false, error: { kind: "invalidInput" } }); return; }
    if (!availabilityRequest(input)) {
      json(response, 400, { ok: false, error: { kind: "invalidInput" } }); return;
    }
    const prepared = await runner.prepare(input);
    if (!prepared.ok) {
      json(response, prepared.error.kind === "invalidInput" ? 400 : 503,
        { ok: false, error: { kind: prepared.error.kind === "invalidInput" ? "invalidInput" : "unavailable" } });
      return;
    }
    json(response, 200, { ok: true, value: { status: prepared.value.status, message: prepared.value.message } },
      () => { void runner.confirmWritten(prepared.value).catch(() => { /* response already written */ }); });
  } catch {
    if (!response.headersSent) json(response, 503, { ok: false, error: { kind: "unavailable" } });
  }
}
