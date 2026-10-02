import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { CommandGateway } from "../../reference/command-gateway.ts";
import type { GatewayCommand, HostActor } from "../../reference/command-gateway.ts";
import { capabilityDescriptor } from "../../reference/capability-catalogue.ts";
import { matchesSchema } from "../../reference/schema-shapes.ts";
import { publicSpeechGateStatus } from "../speech-gate-public-status.ts";

const maxCommandBytes = 24_000;
const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Abby clinic dashboard</title><link rel="stylesheet" href="/style.css"></head><body><main><div id="app"></div><div id="availability-setup"></div><div id="speech-gate"></div><div id="operational-daily"></div></main><script type="module" src="/app.js"></script></body></html>`;
const setupCommands = new Set([
  "clinic.availability.businesses.list.v1", "clinic.availability.practitioners.list.v1",
  "clinic.availability.types.list.v1", "clinic.availability.selection.inspect.v1",
  "clinic.availability.approval.read.v1", "clinic.availability.approval.change.v1",
  "clinic.availability.route.check.v1",
  "clinic.availability.approval.change.v2",
  "clinic.availability.approval.revoke.v1",
]);

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
  return createServer((request, response) => {
    if (request.socket.localAddress !== "127.0.0.1") {
      return json(response, 403, { ok: false, error: { kind: "forbidden" } });
    }
    void handle(request, response, gateway, bundle, stylesheet);
  });
}

/** The embedding host authenticates each request and constructs its scoped gateway. */
export type HostDashboardIdentity = Readonly<{
  publicOrigin: string;
  /** Limit a local setup listener to the routes and capabilities its UI exposes. */
  surface?: "full" | "availabilitySetup";
  resolveActor: (request: IncomingMessage) => HostActor | null | Promise<HostActor | null>;
  gatewayFor: (actor: HostActor) => CommandGateway | Promise<CommandGateway>;
  /** Optional owner report reader; the response is reduced to fixed aggregate fields. */
  readSpeechGate?: () => Promise<unknown>;
  /** The host may challenge an absent identity; other authorization failures remain forbidden. */
  unauthorized?: (response: ServerResponse) => void;
}>;

export async function createHostAuthenticatedDashboardServer(identity: HostDashboardIdentity,
                                                              bundlePath: string): Promise<Server> {
  let origin: URL;
  try { origin = new URL(identity.publicOrigin); }
  catch { throw new RangeError("invalid dashboard origin"); }
  if ((origin.protocol !== "https:" && !(origin.protocol === "http:" && origin.hostname === "127.0.0.1")) ||
      origin.origin !== identity.publicOrigin || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash ||
      typeof identity.resolveActor !== "function" || typeof identity.gatewayFor !== "function" ||
      (identity.surface !== undefined && !["full", "availabilitySetup"].includes(identity.surface)) ||
      (identity.unauthorized !== undefined && typeof identity.unauthorized !== "function") ||
      (identity.readSpeechGate !== undefined && typeof identity.readSpeechGate !== "function")) {
    throw new RangeError("invalid dashboard identity configuration");
  }
  const [bundle, stylesheet] = await Promise.all([
    readFile(bundlePath, "utf8"), readFile(new URL("./style.css", import.meta.url), "utf8"),
  ]);
  return createServer((request, response) => { void (async () => {
    try {
      if (request.headers.host !== origin.host ||
          (origin.protocol === "http:" && request.socket.localAddress !== "127.0.0.1")) {
        return json(response, 403, { ok: false, error: { kind: "forbidden" } });
      }
      const actor = await identity.resolveActor(request);
      if (!actor) return identity.unauthorized
        ? identity.unauthorized(response)
        : json(response, 403, { ok: false, error: { kind: "forbidden" } });
      const gateway = await identity.gatewayFor(actor);
      if (!(gateway instanceof CommandGateway) || !gateway.matchesActor(actor)) {
        return json(response, 403, { ok: false, error: { kind: "forbidden" } });
      }
      return handle(request, response, gateway, bundle, stylesheet, origin.origin, identity.surface,
        identity.readSpeechGate, actor.role === "clinicAdmin");
    } catch { return json(response, 403, { ok: false, error: { kind: "forbidden" } }); }
  })(); });
}

async function handle(request: IncomingMessage, response: ServerResponse, gateway: CommandGateway,
                      bundle: string, stylesheet: string, authenticatedOrigin?: string,
                      surface: "full" | "availabilitySetup" = "full",
                      readSpeechGate?: () => Promise<unknown>, speechGateAdmin = false): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (surface === "availabilitySetup" && !(
      (request.method === "GET" && ["/", "/app.js", "/style.css", "/api/capabilities", "/api/settings",
        "/api/speech-gate", "/api/operations/daily"].includes(url.pathname)) ||
      (request.method === "POST" && url.pathname === "/api/clinic-availability/command"))) {
      return json(response, 404, { ok: false, error: { kind: "notFound" } });
    }
    if (authenticatedOrigin && request.method === "POST" && url.pathname.startsWith("/api/") &&
        (request.headers.origin !== authenticatedOrigin ||
          request.headers.host !== new URL(authenticatedOrigin).host)) {
      return json(response, 403, { ok: false, error: { kind: "forbidden" } });
    }
    if (request.method === "GET" && url.pathname === "/") return asset(response, "text/html; charset=utf-8", document);
    if (request.method === "GET" && url.pathname === "/app.js") return asset(response, "text/javascript; charset=utf-8", bundle);
    if (request.method === "GET" && url.pathname === "/style.css") return asset(response, "text/css; charset=utf-8", stylesheet);
    if (request.method === "GET" && url.pathname === "/api/speech-gate") {
      if (!readSpeechGate) return json(response, 404, { ok: false, error: { kind: "notFound" } });
      if (!speechGateAdmin) return json(response, 403, { ok: false, error: { kind: "forbidden" } });
      const current = await Promise.resolve().then(readSpeechGate).catch(() => undefined);
      const publicStatus = publicSpeechGateStatus(current);
      return publicStatus
        ? json(response, 200, { ok: true, value: publicStatus })
        : json(response, 503, { ok: false, error: { kind: "statusUnavailable" } });
    }
    if (request.method === "GET" && url.pathname === "/api/capabilities") {
      return json(response, 200, { ok: true, value: gateway.listPermitted().filter(item =>
        surface === "availabilitySetup" ? item.id === "settings.read.v1" || item.id.startsWith("clinic.availability.")
          : item.id !== "booking.propose.v2") });
    }
    let command: GatewayCommand | undefined;
    if (request.method === "POST" && url.pathname === "/api/clinic-availability/command") {
      const address = response.socket?.localAddress;
      const port = response.socket?.localPort;
      if (!authenticatedOrigin && (address !== "127.0.0.1" ||
          request.headers.host !== `127.0.0.1:${port}` ||
          request.headers.origin !== `http://127.0.0.1:${port}`)) {
        return json(response, 403, { ok: false, error: { kind: "forbidden" } });
      }
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        return json(response, 415, { ok: false, error: { kind: "invalid" } });
      }
      const input = record(await body(request));
      if (!input || typeof input.kind !== "string" || !setupCommands.has(input.kind)) {
        return json(response, 400, { ok: false, error: { kind: "invalid" } });
      }
      command = input as GatewayCommand;
    }
    if (request.method === "GET" && url.pathname === "/api/knowledge") command = { kind: "knowledge.list.v1" };
    if (request.method === "GET" && url.pathname === "/api/settings") command = { kind: "settings.read.v1" };
    if (request.method === "GET" && url.pathname === "/api/operations/daily") command = { kind: "operations.daily.v1" };
    if (request.method === "GET" && url.pathname === "/api/writes/stop") {
      const afterEffectId = url.searchParams.get("after");
      if (afterEffectId !== null && (!afterEffectId || afterEffectId.length > 512)) return json(response, 400, { ok: false, error: { kind: "invalid" } });
      command = { kind: "calls.writes.stop.read.v1", ...(afterEffectId === null ? {} : { afterEffectId }) };
    }
    if (request.method === "GET" && url.pathname === "/api/writes/stop-audit") {
      const cursor = url.searchParams.get("after");
      if (cursor !== null && (!/^(0|[1-9][0-9]*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) return json(response, 400, { ok: false, error: { kind: "invalid" } });
      command = { kind: "calls.writes.stop.audit.v1", ...(cursor === null ? {} : { afterVersion: Number(cursor) }) };
    }
    if (request.method === "GET" && url.pathname === "/api/settings/automation-audit") {
      const cursor = url.searchParams.get("after");
      if (cursor !== null && (!/^(0|[1-9][0-9]*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) return json(response, 400, { ok: false, error: { kind: "invalid" } });
      command = { kind: "settings.automation.audit.v1", ...(cursor === null ? {} : { afterVersion: Number(cursor) }) };
    }
    if (request.method === "GET" && url.pathname === "/api/settings/booking-audit") {
      const cursor = url.searchParams.get("after");
      if (cursor !== null && (!/^(0|[1-9][0-9]*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) return json(response, 400, { ok: false, error: { kind: "invalid" } });
      command = { kind: "settings.appointments.booking.audit.v1", ...(cursor === null ? {} : { afterVersion: Number(cursor) }) };
    }
    if (request.method === "GET" && url.pathname === "/api/settings/after-hours-audit") {
      const cursor = url.searchParams.get("after");
      if (cursor !== null && (!/^(0|[1-9][0-9]*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) return json(response, 400, { ok: false, error: { kind: "invalid" } });
      command = { kind: "settings.routing.afterHours.audit.v1", ...(cursor === null ? {} : { afterVersion: Number(cursor) }) };
    }
    if (request.method === "GET" && url.pathname === "/api/settings/urgent-audit") {
      const cursor = url.searchParams.get("after");
      if (cursor !== null && (!/^(0|[1-9][0-9]*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) return json(response, 400, { ok: false, error: { kind: "invalid" } });
      command = { kind: "settings.routing.urgent.audit.v1", ...(cursor === null ? {} : { afterVersion: Number(cursor) }) };
    }
    if (request.method === "GET" && url.pathname === "/api/settings/staff-schedule-audit") {
      const cursor = url.searchParams.get("after");
      if (cursor !== null && (!/^(0|[1-9][0-9]*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) return json(response, 400, { ok: false, error: { kind: "invalid" } });
      command = { kind: "settings.routing.staffSchedule.audit.v1",
        ...(cursor === null ? {} : { afterVersion: Number(cursor) }) };
    }
    if (request.method === "GET" && url.pathname === "/api/staff") {
      const afterTaskKey = url.searchParams.get("after");
      if (afterTaskKey !== null && (!afterTaskKey || afterTaskKey.length > 256)) return json(response, 400, { ok: false, error: { kind: "invalid" } });
      command = { kind: "staff.list.v1", ...(afterTaskKey === null ? {} : { afterTaskKey }) };
    }
    if (request.method === "GET" && url.pathname === "/api/call-outcomes") {
      const afterCallId = url.searchParams.get("after");
      if (afterCallId !== null && (!afterCallId || afterCallId.length > 256)) return json(response, 400, { ok: false, error: { kind: "invalid" } });
      command = { kind: "calls.outcomes.v1", ...(afterCallId === null ? {} : { afterCallId }) };
    }
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
    if (request.method === "POST" && url.pathname === "/api/settings/after-hours") {
      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}`) return json(response, 403, { ok: false, error: { kind: "forbidden" } });
      if (!request.headers["content-type"]?.startsWith("application/json")) return json(response, 415, { ok: false, error: { kind: "invalid" } });
      const input = record(await body(request));
      if (!input || typeof input.expectedVersion !== "string" ||
          (input.mode !== "staffRequest" && input.mode !== "approvedInfoAndRequest") ||
          (input.infoVersion !== undefined && typeof input.infoVersion !== "string") ||
          (input.approvedText !== undefined && typeof input.approvedText !== "string")) {
        return json(response, 400, { ok: false, error: { kind: "invalid" } });
      }
      command = { kind: "settings.routing.afterHours.change.v1", expectedVersion: input.expectedVersion,
        mode: input.mode, ...(input.infoVersion === undefined ? {} : { infoVersion: input.infoVersion }),
        ...(input.approvedText === undefined ? {} : { approvedText: input.approvedText }) };
    }
    if (request.method === "POST" && url.pathname === "/api/settings/urgent") {
      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}`) return json(response, 403, { ok: false, error: { kind: "forbidden" } });
      if (!request.headers["content-type"]?.startsWith("application/json")) return json(response, 415, { ok: false, error: { kind: "invalid" } });
      const input = record(await body(request));
      if (!input || typeof input.expectedVersion !== "string" || typeof input.enabled !== "boolean" ||
          (input.enabled && (Object.keys(input).sort().join(",") !==
            "approvedText,effectiveFrom,effectiveUntil,enabled,expectedVersion,scriptVersion" ||
            typeof input.scriptVersion !== "string" || typeof input.approvedText !== "string" ||
            typeof input.effectiveFrom !== "string" || typeof input.effectiveUntil !== "string")) ||
          (!input.enabled && Object.keys(input).sort().join(",") !== "enabled,expectedVersion"))
        return json(response, 400, { ok: false, error: { kind: "invalid" } });
      command = input.enabled
        ? { kind: "settings.routing.urgent.change.v1", expectedVersion: input.expectedVersion, enabled: true,
          scriptVersion: input.scriptVersion as string, approvedText: input.approvedText as string,
          effectiveFrom: input.effectiveFrom as string, effectiveUntil: input.effectiveUntil as string }
        : { kind: "settings.routing.urgent.change.v1", expectedVersion: input.expectedVersion, enabled: false };
    }
    if (request.method === "POST" && url.pathname === "/api/settings/staff-schedule") {
      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}`) return json(response, 403, { ok: false, error: { kind: "forbidden" } });
      if (!request.headers["content-type"]?.startsWith("application/json")) return json(response, 415, { ok: false, error: { kind: "invalid" } });
      const input = record(await body(request));
      if (!input || !matchesSchema(capabilityDescriptor("settings.routing.staffSchedule.change.v1").inputSchema, input)) {
        return json(response, 400, { ok: false, error: { kind: "invalid" } });
      }
      command = input as GatewayCommand;
    }
    if (request.method === "POST" && ["/api/knowledge/draft", "/api/knowledge/approve", "/api/knowledge/revoke"].includes(url.pathname)) {
      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}`) return json(response, 403, { ok: false, error: { kind: "forbidden" } });
      if (!request.headers["content-type"]?.startsWith("application/json")) return json(response, 415, { ok: false, error: { kind: "invalid" } });
      const input = record(await body(request));
      if (!input || typeof input.sourceRef !== "string" || typeof input.expectedVersion !== "string") return json(response, 400, { ok: false, error: { kind: "invalid" } });
      if (url.pathname === "/api/knowledge/draft") {
        if (typeof input.ownerRef !== "string" || typeof input.text !== "string" ||
            typeof input.effectiveFrom !== "string" || typeof input.effectiveUntil !== "string") return json(response, 400, { ok: false, error: { kind: "invalid" } });
        command = { kind: "knowledge.draft.save.v1", sourceRef: input.sourceRef, expectedVersion: input.expectedVersion,
          ownerRef: input.ownerRef, text: input.text, effectiveFrom: input.effectiveFrom, effectiveUntil: input.effectiveUntil };
      } else command = { kind: url.pathname === "/api/knowledge/approve" ? "knowledge.approve.v1" : "knowledge.revoke.v1",
        sourceRef: input.sourceRef, expectedVersion: input.expectedVersion };
    }
    if (request.method === "POST" && url.pathname === "/api/settings/automation-enabled") {
      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}`) return json(response, 403, { ok: false, error: { kind: "forbidden" } });
      if (!request.headers["content-type"]?.startsWith("application/json")) return json(response, 415, { ok: false, error: { kind: "invalid" } });
      const input = record(await body(request));
      if (!input || typeof input.expectedVersion !== "string" || typeof input.enabled !== "boolean") {
        return json(response, 400, { ok: false, error: { kind: "invalid" } });
      }
      command = { kind: "settings.automation.enabled.change.v1", expectedVersion: input.expectedVersion, enabled: input.enabled };
    }
    if (request.method === "POST" && url.pathname === "/api/writes/stop") {
      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}`) return json(response, 403, { ok: false, error: { kind: "forbidden" } });
      if (!request.headers["content-type"]?.startsWith("application/json")) return json(response, 415, { ok: false, error: { kind: "invalid" } });
      const input = record(await body(request));
      if (!input || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1_000) {
        return json(response, 400, { ok: false, error: { kind: "invalid" } });
      }
      command = { kind: "calls.writes.stop.v1", reason: input.reason };
    }
    if (request.method === "POST" && url.pathname === "/api/writes/resume") {
      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}`) return json(response, 403, { ok: false, error: { kind: "forbidden" } });
      if (!request.headers["content-type"]?.startsWith("application/json")) return json(response, 415, { ok: false, error: { kind: "invalid" } });
      const input = record(await body(request));
      if (!input || typeof input.expectedVersion !== "string" || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1_000) {
        return json(response, 400, { ok: false, error: { kind: "invalid" } });
      }
      command = { kind: "calls.writes.resume.v1", expectedVersion: input.expectedVersion, reason: input.reason };
    }
    if (request.method === "POST" && url.pathname === "/api/staff/change") {
      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}`) return json(response, 403, { ok: false, error: { kind: "forbidden" } });
      if (!request.headers["content-type"]?.startsWith("application/json")) return json(response, 415, { ok: false, error: { kind: "invalid" } });
      const input = record(await body(request));
      const change = record(input?.change);
      if (!input || typeof input.callId !== "string" || typeof input.taskKey !== "string" ||
          !Number.isSafeInteger(input.expectedVersion) || !change ||
          !["acknowledge", "resolve", "reassign"].includes(String(change.kind)) ||
          (change.kind === "reassign" && !["staff", "operator"].includes(String(change.target)))) {
        return json(response, 400, { ok: false, error: { kind: "invalid" } });
      }
      const typedChange = change.kind === "reassign"
        ? { kind: "reassign" as const, target: change.target as "staff" | "operator" }
        : { kind: change.kind as "acknowledge" | "resolve" };
      command = { kind: "staff.change.v1", callId: input.callId, taskKey: input.taskKey,
        expectedVersion: input.expectedVersion as number, change: typedChange, now: new Date().toISOString() };
    }
    if (!command) return json(response, 404, { ok: false, error: { kind: "notFound" } });
    const result = await gateway.submit(command);
    const status = result.ok ? 200 : ["forbidden", "scopeMismatch"].includes(result.error.kind) ? 403 :
      command.kind === "operations.daily.v1" &&
        ["commandOutcomeUnknown", "responseContractViolation"].includes(result.error.kind) ? 503 :
      result.error.kind === "versionConflict" ? 409 : result.error.kind === "callUnknown" ? 404 : 400;
    return json(response, status, result);
  } catch {
    return json(response, 400, { ok: false, error: { kind: "invalid" } });
  }
}
