import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { CommandGateway, GatewayCommand } from "../../reference/command-gateway.ts";

const maxCommandBytes = 10_000;
const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Abby clinic dashboard</title><link rel="stylesheet" href="/style.css"></head><body><main id="app"></main><script type="module" src="/app.js"></script></body></html>`;

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}

function asset(response: ServerResponse, type: string, body: string): void {
  response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
  response.end(body);
}

async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > maxCommandBytes) throw new Error("command too large");
    parts.push(bytes);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Local reference server. A deploying host must bind an authenticated actor before exposing these routes. */
export async function createDashboardServer(gateway: CommandGateway, bundlePath: string): Promise<Server> {
  const [bundle, stylesheet] = await Promise.all([
    readFile(bundlePath, "utf8"), readFile(new URL("./style.css", import.meta.url), "utf8"),
  ]);
  return createServer((request, response) => { void handle(request, response, gateway, bundle, stylesheet); });
}

async function handle(request: IncomingMessage, response: ServerResponse, gateway: CommandGateway, bundle: string, stylesheet: string): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/") return asset(response, "text/html; charset=utf-8", document);
    if (request.method === "GET" && url.pathname === "/app.js") return asset(response, "text/javascript; charset=utf-8", bundle);
    if (request.method === "GET" && url.pathname === "/style.css") return asset(response, "text/css; charset=utf-8", stylesheet);
    if (request.method === "GET" && url.pathname === "/api/capabilities") {
      return json(response, 200, { ok: true, value: gateway.listPermitted().filter(item => item.id !== "booking.propose.v1") });
    }
    let command: GatewayCommand | undefined;
    if (request.method === "GET" && url.pathname === "/api/settings") command = { kind: "settings.read.v1" };
    if (request.method === "GET" && url.pathname.startsWith("/api/calls/")) {
      const callId = decodeURIComponent(url.pathname.slice("/api/calls/".length));
      if (!callId || callId.length > 256 || callId.includes("/")) return json(response, 400, { ok: false, error: { kind: "invalid" } });
      command = { kind: "calls.read.v1", callId };
    }
    if (request.method === "POST" && url.pathname === "/api/settings/booking-enabled") {
      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}`) return json(response, 403, { ok: false, error: { kind: "forbidden" } });
      if (!request.headers["content-type"]?.startsWith("application/json")) return json(response, 415, { ok: false, error: { kind: "invalid" } });
      const input = record(await body(request));
      if (!input || typeof input.expectedVersion !== "string" || typeof input.enabled !== "boolean") {
        return json(response, 400, { ok: false, error: { kind: "invalid" } });
      }
      command = { kind: "settings.appointments.booking.enabled.change.v1", expectedVersion: input.expectedVersion, enabled: input.enabled };
    }
    if (!command) return json(response, 404, { ok: false, error: { kind: "notFound" } });
    const result = await gateway.submit(command);
    const status = result.ok ? 200 : result.error.kind === "forbidden" ? 403 : result.error.kind === "versionConflict" ? 409 : result.error.kind === "callUnknown" ? 404 : 400;
    return json(response, status, result);
  } catch {
    return json(response, 400, { ok: false, error: { kind: "invalid" } });
  }
}
