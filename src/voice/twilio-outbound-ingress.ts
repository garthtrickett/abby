import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { LocationScope } from "../core/model.ts";
import type { OutboundEffectBarrier } from "../core/outbound-effect-barrier.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { createTwilioMediaSockets } from "./twilio-media-sockets.ts";
import type { ActiveCallClaims, TwilioWireCall } from "./twilio-media-sockets.ts";
import type { OutboundProviderBinding } from "./outbound-runtime.ts";
import { TwilioAbbyOutboundRuntime } from "./twilio-outbound-runtime.ts";
import type { AuthenticatedTwilioOutboundCall } from "./twilio-outbound-runtime.ts";

export type TwilioOutboundStream = Readonly<{ call: AuthenticatedTwilioOutboundCall; streamSid: string; streamStartedAt: string }>;
export type TwilioOutboundIngressQuery = Readonly<{
  operation: "answer" | "startConversation" | "observeProgress";
  call: AuthenticatedTwilioOutboundCall;
  provider: OutboundProviderBinding;
}>;
export type TwilioOutboundIngressConfig = Readonly<{
  runtime: TwilioAbbyOutboundRuntime;
  /** Independent current clinic/source/producer/restore admission. An authentic
   * provider callback alone is neither this grant nor original-patient proof. */
  authority: Readonly<{ allows(query: TwilioOutboundIngressQuery, signal: AbortSignal): Promise<boolean>;
    current(query: TwilioOutboundIngressQuery, signal: AbortSignal): boolean }>;
  sessionEffects: (scope: LocationScope, ownerBinding: string) => OutboundEffectBarrier;
  activeCallClaims?: ActiveCallClaims;
  createCall: (stream: TwilioOutboundStream, send: (json: string) => "queued" | "notSent" | "uncertain",
    close: (kind?: "normal" | "failure") => void, signal: AbortSignal) => Promise<TwilioWireCall>;
  /** Historical progress only. This port cannot attest final speech, no-stop,
   * all-call closure or patient/clinical authority. */
  observeProgress?: (event: Readonly<{ call: AuthenticatedTwilioOutboundCall; status: string }>, signal: AbortSignal) => Promise<void>;
  deadlineMs?: number;
}>;
const header = (v: string | string[] | undefined) => typeof v === "string" ? v : undefined;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function pathname(target: string | undefined): string | undefined {
  try { return new URL(target ?? "", "https://invalid.local").pathname; } catch { return; }
}
function readBody(request: IncomingMessage, signal: AbortSignal): Promise<string | undefined> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []; let size = 0, done = false;
    const finish = (value?: string) => {
      if (done) return; done = true;
      request.off("data", data); request.off("end", end); request.off("error", failed); request.off("aborted", failed);
      signal.removeEventListener("abort", failed); resolve(value);
    };
    const failed = () => { request.once("error", () => {}); request.resume(); finish(); };
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > 16_384) { failed(); return; }
      chunks.push(Buffer.from(bytes));
    };
    const end = () => finish(Buffer.concat(chunks).toString("utf8"));
    if (signal.aborted || Number(request.headers["content-length"]) > 16_384) { failed(); return; }
    request.on("data", data); request.once("end", end); request.once("error", failed); request.once("aborted", failed);
    signal.addEventListener("abort", failed, { once: true });
  });
}

/** Explicit optional outbound routes. Private provider correlation never enters
 * the inbound-call type. A permanent opaque session exclusion precedes one
 * conversation owner; raw status does not release any workflow hold. */
export class TwilioOutboundIngress {
  readonly #runtime: TwilioAbbyOutboundRuntime;
  readonly #provider: OutboundProviderBinding;
  readonly #paths: Readonly<{ answer: string; status: string; stream: string }>;
  readonly #authority: TwilioOutboundIngressConfig["authority"];
  readonly #effects: TwilioOutboundIngressConfig["sessionEffects"];
  readonly #create: TwilioOutboundIngressConfig["createCall"];
  readonly #progress: TwilioOutboundIngressConfig["observeProgress"];
  readonly #deadline: number;
  readonly #media: ReturnType<typeof createTwilioMediaSockets>;
  readonly #sessionBinding: string;
  #closed = false;
  constructor(config: TwilioOutboundIngressConfig) {
    if (!(config.runtime instanceof TwilioAbbyOutboundRuntime) || typeof config.authority?.allows !== "function" ||
        typeof config.authority.current !== "function" || typeof config.sessionEffects !== "function" || typeof config.createCall !== "function" ||
        config.observeProgress !== undefined && typeof config.observeProgress !== "function" ||
        !Number.isSafeInteger(config.deadlineMs ?? 5000) || (config.deadlineMs ?? 5000) < 1 || (config.deadlineMs ?? 5000) > 10_000) throw Error("Invalid outbound ingress configuration");
    this.#runtime = config.runtime; this.#provider = freeze(structuredClone(config.runtime.binding())); this.#paths = config.runtime.paths();
    if (new Set(Object.values(this.#paths)).size !== 3 || Object.values(this.#paths).some(p =>
      ["/stripe/webhook", "/healthz", "/readyz", "/internal/operations", "/internal/operations/daily"].includes(p))) throw Error("Conflicting outbound ingress paths");
    this.#authority = Object.freeze({ allows: config.authority.allows.bind(config.authority), current: config.authority.current.bind(config.authority) });
    this.#effects = config.sessionEffects.bind(config); this.#create = config.createCall.bind(config);
    this.#progress = config.observeProgress?.bind(config); this.#deadline = config.deadlineMs ?? 5000;
    this.#sessionBinding = createHash("sha256").update(JSON.stringify(["abby.twilio-outbound-session.v1", this.#provider])).digest("hex");
    this.#media = createTwilioMediaSockets({ ...(config.activeCallClaims ? { activeCallClaims: config.activeCallClaims } : {}),
      authorizeUpgrade: request => this.#selected() && this.#runtime.authorizeUpgrade(request).ok,
      authenticateStream: async (request, signal) => {
        const decoded = this.#runtime.authenticateStream(request);
        if (!decoded.ok || !this.#selected()) return;
        const stream = freeze(structuredClone(decoded.value)), query = this.#query("startConversation", stream.call);
        if (!await this.#allows(query, signal)) return;
        return { key: Object.freeze({ accountRef: stream.call.accountSid, providerCallRef: stream.call.callSid }),
          open: async (send, close, active) => {
            if (!await this.#allows(query, active)) throw Error("Unavailable outbound session");
            const scope = stream.call.context.original.attempt.scope, effects = this.#effects(scope, this.#sessionBinding);
            if (effects.matches(scope, this.#sessionBinding) !== true) throw Error("Unavailable outbound session");
            const result = await awaitUntilAbort(effects.claimOnce(stream.call.context.sessionActionRef), active);
            if (!result?.ok || result.value.claimed !== true || !await this.#allows(query, active)) throw Error("Unavailable outbound session");
            // Fresh grant/current checks follow the actual storage wait. The
            // independent report action remains unconsumed if this owner dies.
            const owner = await this.#create(stream, send, close, active);
            if (!this.#current(query, active) || typeof owner?.receive !== "function" || typeof owner.disconnect !== "function") {
              try { await owner?.disconnect(); } catch { /* No private exception escapes. */ }
              throw Error("Unavailable outbound session");
            }
            return owner;
          } };
      }
    });
  }
  paths(): readonly string[] { return Object.freeze(Object.values(this.#paths)); }
  sessionOwnerBinding(): string { return this.#sessionBinding; }
  #selected(): boolean { try { return !this.#closed && isDeepStrictEqual(this.#runtime.binding(), this.#provider); } catch { return false; } }
  #query(operation: TwilioOutboundIngressQuery["operation"], call: AuthenticatedTwilioOutboundCall): TwilioOutboundIngressQuery {
    return freeze({ operation, call: structuredClone(call), provider: this.#provider });
  }
  #current(query: TwilioOutboundIngressQuery, signal: AbortSignal): boolean {
    try { return !signal.aborted && this.#selected() && this.#authority.current(query, signal) === true; } catch { return false; }
  }
  async #allows(query: TwilioOutboundIngressQuery, signal: AbortSignal): Promise<boolean> {
    try { return !signal.aborted && this.#selected() && await awaitUntilAbort(Promise.resolve().then(() => this.#authority.allows(query, signal)), signal) === true && this.#current(query, signal); }
    catch { return false; }
  }
  async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = pathname(request.url);
    if (path !== this.#paths.answer && path !== this.#paths.status) return false;
    const lifetime = new AbortController(), timer = setTimeout(() => lifetime.abort(), this.#deadline);
    const abort = () => lifetime.abort(); request.once("aborted", abort); response.once("close", abort);
    const reply = (status: number, text = "", xml = false) => {
      response.writeHead(status, { "content-type": xml ? "application/xml; charset=utf-8" : "text/plain", "cache-control": "no-store" }); response.end(text);
    };
    try {
      const raw = await readBody(request, lifetime.signal);
      if (raw === undefined) { reply(lifetime.signal.aborted ? 503 : 413); return true; }
      const input = { method: request.method ?? "", requestTarget: request.url ?? "", contentType: header(request.headers["content-type"]),
        signature: header(request.headers["x-twilio-signature"]), body: raw };
      if (path === this.#paths.answer) {
        const answer = this.#runtime.authenticateAnswer(input);
        if (!answer.ok) { reply(403); return true; }
        const query = this.#query("answer", answer.value.call);
        if (!await this.#allows(query, lifetime.signal)) { reply(503); return true; }
        reply(200, answer.value.twiml, true);
      } else {
        const status = this.#runtime.authenticateStatus(input);
        if (!status.ok) { reply(403); return true; }
        const query = this.#query("observeProgress", status.value.call);
        if (!await this.#allows(query, lifetime.signal)) { reply(503); return true; }
        if (this.#progress) await awaitUntilAbort(this.#progress(freeze(structuredClone(status.value)), lifetime.signal), lifetime.signal);
        if (!this.#current(query, lifetime.signal)) { reply(503); return true; }
        reply(204);
      }
    } catch { if (!response.headersSent) reply(503); else response.end(); }
    finally { clearTimeout(timer); lifetime.abort(); request.off("aborted", abort); response.off("close", abort); }
    return true;
  }
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (pathname(request.url) !== this.#paths.stream) return false;
    this.#media.handleUpgrade(request, socket, head); return true;
  }
  close(): void { if (this.#closed) return; this.#closed = true; this.#media.close(); }
}
