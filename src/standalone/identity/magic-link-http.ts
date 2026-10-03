import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { HostDashboardIdentity } from "../dashboard/server.ts";
import { MagicLinkIdentity, newIdentitySecret, validIdentitySecret } from "./magic-link.ts";

type IdentityBinding = Pick<HostDashboardIdentity, "publicOrigin" | "resolveActor" | "unauthorized" | "signOutPath">;
export type MagicLinkHttp = Readonly<{ handle: RequestListener; close: () => Promise<void> }>;

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}
function failure(response: ServerResponse, status: number): void {
  json(response, status, { ok: false, error: { kind: status === 503 ? "identityUnavailable" : "invalidSignInLink" } });
}
export function identityCookieNames(origin: string): Readonly<{ session: string; csrf: string }> {
  return new URL(origin).protocol === "https:" ? { session: "__Host-abby_session", csrf: "__Host-abby_login" }
    : { session: "abby_test_session", csrf: "abby_test_login" };
}
function cookie(request: IncomingMessage, name: string): string | undefined {
  const values = (request.headers.cookie ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  const value = values[0]!.slice(name.length + 1);
  return validIdentitySecret(value) ? value : undefined;
}
function setCookie(origin: string, name: string, value: string, seconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${new URL(origin).protocol === "https:" ? "; Secure" : ""}`;
}
async function input(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) throw new Error("invalid input");
  const parts: Buffer[] = []; let size = 0;
  const deadline = setTimeout(() => request.destroy(), 5_000);
  try {
    for await (const part of request) {
      const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
      size += bytes.length; if (size > 2_048) throw new Error("invalid input"); parts.push(bytes);
    }
    const value: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid input");
    return value as Record<string, unknown>;
  } finally { clearTimeout(deadline); }
}
function validCsrf(request: IncomingMessage, value: unknown, name: string): boolean {
  const expected = cookie(request, name);
  return !!expected && validIdentitySecret(value) && timingSafeEqual(Buffer.from(expected), Buffer.from(value));
}

/** Application-owned, bounded transient work; HTTP account discovery cannot time the directory or mail provider. */
class SignInRequests {
  private readonly identity: MagicLinkIdentity;
  private readonly pending: { email: string; client: string }[] = [];
  private readonly active = new Set<Promise<void>>();
  private closed = false;
  constructor(identity: MagicLinkIdentity) { this.identity = identity; }
  submit(email: string, client: string): void {
    if (this.closed || this.pending.length + this.active.size >= 20) return;
    this.pending.push({ email, client }); this.pump();
  }
  private pump(): void {
    while (!this.closed && this.active.size < 4 && this.pending.length) {
      const next = this.pending.shift()!;
      const work = this.identity.requestLink(next.email, next.client).catch(() => {}).finally(() => {
        this.active.delete(work); this.pump();
      });
      this.active.add(work);
    }
  }
  async close(): Promise<void> { this.closed = true; this.pending.length = 0; await Promise.all(this.active); }
}

/** The existing host boundary owns authorization; this adapter resolves only current sign-in identity. */
export function magicLinkDashboardIdentity(identity: MagicLinkIdentity): IdentityBinding {
  const names = identityCookieNames(identity.origin);
  return { publicOrigin: identity.origin, signOutPath: "/sign-in/logout",
    resolveActor: async request => {
      const result = await identity.resolveSession(cookie(request, names.session));
      if (!result.ok) throw new Error("identity unavailable");
      return result.value ?? null;
    }, unauthorized: (response, request) => {
      if (request?.method === "GET" && request.url === "/") {
        response.writeHead(303, { Location: "/sign-in", "Cache-Control": "no-store" }); response.end();
      } else json(response, 403, { ok: false, error: { kind: "forbidden" } });
    } };
}

/** Composes public sign-in with an already prepared dashboard; startup retains the dashboard's typed failures. */
export async function createMagicLinkHttp(identity: MagicLinkIdentity,
  dashboard: RequestListener, bundlePath: string): Promise<MagicLinkHttp> {
  const origin = new URL(identity.origin), names = identityCookieNames(identity.origin);
  const bundle = await readFile(bundlePath, "utf8"), requests = new SignInRequests(identity);
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.host !== origin.host || (origin.protocol === "http:" && request.socket.localAddress !== "127.0.0.1")) return failure(response, 403);
    let url: URL;
    try { url = new URL(request.url ?? "/", identity.origin); } catch { return failure(response, 400); }
    if (url.origin !== identity.origin) return failure(response, 403);
    if (!url.pathname.startsWith("/sign-in")) { dashboard(request, response); return; }
    if (url.search) return failure(response, 400);
    if (request.method === "GET" && url.pathname === "/sign-in/app.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(bundle); return;
    }
    if (request.method === "GET" && ["/sign-in", "/sign-in/confirm", "/sign-in/logout"].includes(url.pathname)) {
      const csrf = newIdentitySecret(), mode = url.pathname === "/sign-in/confirm" ? "confirm" : url.pathname === "/sign-in/logout" ? "logout" : "request";
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff", "Set-Cookie": setCookie(identity.origin, names.csrf, csrf, 600),
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in to Abby</title></head><body><main id="sign-in" data-mode="${mode}" data-csrf="${csrf}"></main><script type="module" src="/sign-in/app.js"></script></body></html>`); return;
    }
    if (request.method !== "POST" || !["/sign-in/request", "/sign-in/inspect", "/sign-in/redeem", "/sign-in/logout"].includes(url.pathname)) return failure(response, 404);
    if (request.headers.origin !== identity.origin) return failure(response, 403);
    let body: Record<string, unknown>;
    try { body = await input(request); } catch { return failure(response, 400); }
    if (url.pathname === "/sign-in/logout") {
      if (Object.keys(body).length) return failure(response, 400);
      const result = await identity.logout(cookie(request, names.session));
      if (!result.ok) return failure(response, 503);
      response.setHeader("Set-Cookie", setCookie(identity.origin, names.session, "", 0)); json(response, 200, { ok: true }); return;
    }
    if (!validCsrf(request, body.csrf, names.csrf)) return failure(response, 403);
    if (url.pathname === "/sign-in/request") {
      if (Object.keys(body).sort().join(",") !== "csrf,email" || typeof body.email !== "string" || body.email.length > 254) return failure(response, 400);
      json(response, 200, { ok: true, message: "If this account can sign in, check your email for a link." });
      requests.submit(body.email, request.socket.remoteAddress ?? "unknown-peer"); return;
    }
    if (Object.keys(body).sort().join(",") !== "csrf,secret") return failure(response, 400);
    if (url.pathname === "/sign-in/inspect") {
      const result = await identity.inspectLink(body.secret);
      if (!result.ok) return failure(response, result.error.kind === "identityUnavailable" ? 503 : 400);
      json(response, 200, { ok: true, email: result.value.email }); return;
    }
    const result = await identity.redeemLink(body.secret);
    if (!result.ok) return failure(response, result.error.kind === "identityUnavailable" ? 503 : 400);
    response.setHeader("Set-Cookie", [setCookie(identity.origin, names.session, result.value, 28_800), setCookie(identity.origin, names.csrf, "", 0)]);
    json(response, 200, { ok: true });
  }
  return { handle: (request, response) => { void handle(request, response).catch(() => failure(response, 503)); }, close: () => requests.close() };
}
