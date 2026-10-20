import { createHash, randomUUID } from "node:crypto";
import { validateRequest } from "twilio/lib/webhooks/webhooks.js";
import VoiceResponse from "twilio/lib/twiml/VoiceResponse.js";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ownedBodyBytes } from "../shared/owned-body-bytes.ts";
import { captureOutboundOriginalSend } from "./outbound-original-send.ts";
import type { OutboundOriginalSend } from "./outbound-original-send.ts";
import type { OutboundProviderBinding, OutboundRuntimeCall, OutboundRuntimeLaunchResult, OutboundVoiceRuntimeAdapter } from "./outbound-runtime.ts";
import { TwilioOutboundContext } from "./twilio-outbound-context.ts";
import type { TwilioOriginalCall } from "./twilio-outbound-context.ts";
import type { SignedTwilioWebhook, SignedTwilioStreamStart, SignedTwilioUpgrade } from "./twilio-signed-ingress.ts";

export type TwilioAbbyOutboundConfig = Readonly<{ ref: string; profileRef: string; accountSid: string; authToken: string; from: string;
  publicAnswerUrl: string; publicStatusUrl: string; publicStreamUrl: string; contextKey: Uint8Array; deadlineMs?: number; now?: () => string }>;
/** Private provider authentication/correlation only. In particular the person
 * at recipientNumber is NOT a verified patient, even when the original native
 * record identifies the intended patient. Do not cast this into inbound input. */
export type AuthenticatedTwilioOutboundCall = Readonly<{ kind: "authenticatedOutboundCall"; accountSid: string; callSid: string;
  clinicNumber: string; recipientNumber: string; receivedAt: string; context: TwilioOriginalCall }>;
type Failure = Readonly<{ kind: "invalidTwilioOutboundRequest" }>;
const invalid = (): Result<never, Failure> => err({ kind: "invalidTwilioOutboundRequest" });
const phone = (s: unknown): s is string => typeof s === "string" && /^\+[1-9][0-9]{7,14}$/.test(s);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const instant = (s: unknown): s is string => typeof s === "string" && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const sid = (s: unknown): s is string => typeof s === "string" && /^CA[0-9a-f]{32}$/.test(s);
const statuses = new Set(["queued", "initiated", "ringing", "in-progress", "completed", "busy", "failed", "no-answer", "canceled"]);
/** This conditional profile admits an answer only within ten minutes of the
 * original attempt. Later queued calls cannot reopen a voice session; their
 * capacity/contact holds remain conservative. Progress authentication alone is
 * a historical fact and never claims current terminal/contact truth. */
export const TWILIO_OUTBOUND_ANSWER_WINDOW_MS = 600000;
const target = (u: URL) => u.pathname + u.search;
function publicUrl(value: string, protocol: "https:" | "wss:"): URL {
  const url = new URL(value);
  if (url.protocol !== protocol || url.username || url.password || url.search || url.hash || url.href !== value) throw Error("Invalid outbound public URL");
  return url;
}

/** One physical POST, explicit native original context, encrypted provider-owned
 * correlation, real Twilio signature checks. No retry, redirect, private local
 * call map, default activation, or invented metadata-list lookup. This first
 * concrete transport deliberately leaves complete terminal/contact inspection
 * unknown: signed progress alone does not prove final ALL-call speech closure. */
export class TwilioAbbyOutboundRuntime implements OutboundVoiceRuntimeAdapter {
  readonly #config: TwilioAbbyOutboundConfig;
  readonly #binding: OutboundProviderBinding;
  readonly #context: TwilioOutboundContext;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;
  readonly #answer: URL;
  readonly #status: URL;
  readonly #stream: URL;
  constructor(input: TwilioAbbyOutboundConfig, port: typeof fetch = fetch) {
    this.#answer = publicUrl(input.publicAnswerUrl, "https:"); this.#status = publicUrl(input.publicStatusUrl, "https:");
    this.#stream = publicUrl(input.publicStreamUrl, "wss:");
    if (![input.ref, input.profileRef].every(s => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(s)) ||
        !/^AC[0-9a-f]{32}$/.test(input.accountSid) || !input.authToken || input.authToken.length > 256 || !phone(input.from) ||
        input.contextKey.byteLength !== 32 || typeof port !== "function" ||
        !Number.isSafeInteger(input.deadlineMs ?? 15000) || (input.deadlineMs ?? 15000) < 1 || (input.deadlineMs ?? 15000) > 30000 ||
        this.#answer.href === this.#status.href) throw Error("Invalid Twilio outbound configuration");
    this.#config = Object.freeze({ ...input, contextKey: Buffer.from(input.contextKey) }); this.#fetch = port;
    this.#now = input.now?.bind(input) ?? (() => new Date().toISOString());
    const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
    this.#binding = Object.freeze({ ref: input.ref, profileRef: input.profileRef, bindingDigest: hash(JSON.stringify([
      "abby.twilio-abby-outbound.v1", input.ref, input.profileRef, input.accountSid, hash(input.authToken), input.from,
      input.publicAnswerUrl, input.publicStatusUrl, input.publicStreamUrl, hash(input.contextKey), input.deadlineMs ?? 15000])) });
    this.#context = new TwilioOutboundContext(input.contextKey, this.#binding, input.accountSid, input.from);
  }
  binding(): OutboundProviderBinding { return this.#binding; }
  async inspectTerminal(): Promise<Readonly<{ kind: "unknown" }>> { return { kind: "unknown" }; }

  async launchOnce(input: OutboundRuntimeCall, external: AbortSignal, beforeSend: () => Promise<boolean>,
    acknowledged: (ref: string) => void, original?: OutboundOriginalSend): Promise<OutboundRuntimeLaunchResult> {
    if (!(external instanceof AbortSignal) || external.aborted) return { kind: "definitiveUnsent" };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.#config.deadlineMs ?? 15000);
    const signal = AbortSignal.any([external, controller.signal]); let dispatched = false, acceptedRef: string | undefined, response: Response | undefined;
    try {
      if (!input || Object.keys(input).sort().join(",") !== "capacityAllocationRef,effectRef,number,profileRef" || !phone(input.number) ||
          input.profileRef !== this.#binding.profileRef || typeof beforeSend !== "function" || typeof acknowledged !== "function" || !original) return { kind: "definitiveUnsent" };
      const call = Object.freeze({ ...input }), captured = captureOutboundOriginalSend(original, call, this.#binding);
      if (!captured?.attempt.contactReferences || !captured.attempt.dncReferences) return { kind: "definitiveUnsent" };
      const token = this.#context.sealLaunch(captured, call, randomUUID());
      const answer = new URL(this.#answer), status = new URL(this.#status);
      answer.searchParams.set("abbyContext", token); status.searchParams.set("abbyContext", token);
      if (answer.href.length > 4096 || status.href.length > 4096) return { kind: "definitiveUnsent" };
      const form = new URLSearchParams({ To: call.number, From: this.#config.from, Url: answer.href, Method: "POST",
        StatusCallback: status.href, StatusCallbackMethod: "POST" });
      for (const event of ["initiated", "ringing", "answered", "completed"]) form.append("StatusCallbackEvent", event);
      const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${this.#config.accountSid}/Calls.json`;
      const request: RequestInit = { method: "POST", redirect: "error", signal, body: form.toString(),
        headers: { Authorization: `Basic ${Buffer.from(`${this.#config.accountSid}:${this.#config.authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } };
      const allowed = await awaitUntilAbort(Promise.resolve().then(() => !signal.aborted && beforeSend()), signal);
      const at = this.#now();
      if (allowed !== true || signal.aborted || !instant(at) || at < captured.attempt.attemptedAt || at >= captured.attempt.dispatchNotAfter) return { kind: "definitiveUnsent" };
      // No asynchronous preparation between the final fence and this dispatch.
      dispatched = true;
      const pending = this.#fetch(endpoint, request);
      void pending.then(late => { if (signal.aborted) void late.body?.cancel().catch(() => {}); }, () => {});
      response = await awaitUntilAbort(pending, signal);
      if (!response || signal.aborted || response.status !== 201 || response.redirected || response.url && response.url !== endpoint ||
          response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return { kind: "unknown" };
      const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await ownedBodyBytes(response.body, 32768, signal)));
      if (!object(raw) || raw.account_sid !== this.#config.accountSid || !sid(raw.sid) || raw.to !== call.number || raw.from !== this.#config.from ||
          raw.direction !== "outbound-api" || raw.parent_call_sid !== null || typeof raw.status !== "string" || !statuses.has(raw.status) ||
          raw.uri !== `/2010-04-01/Accounts/${this.#config.accountSid}/Calls/${raw.sid}.json`) return { kind: "unknown" };
      acceptedRef = call.effectRef; acknowledged(call.effectRef); return { kind: "accepted", effectRef: call.effectRef };
    } catch { return acceptedRef ? { kind: "accepted", effectRef: acceptedRef } : { kind: dispatched ? "unknown" : "definitiveUnsent" }; }
    finally {
      clearTimeout(timer); controller.abort(); try { void response?.body?.cancel().catch(() => {}); } catch { /* Own body only. */ }
    }
  }

  #authenticate(request: SignedTwilioWebhook, base: URL): Readonly<{ form: Record<string, string>; call: AuthenticatedTwilioOutboundCall; token: string }> | undefined {
    try {
      if (request.method !== "POST" || request.contentType?.split(";")[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded" ||
          Buffer.byteLength(request.body) > 16384 || !request.signature || request.requestTarget.length > 8192) return;
      const url = new URL(request.requestTarget, base);
      if (url.origin !== base.origin || url.pathname !== base.pathname || url.hash || url.username || url.password ||
          target(url) !== request.requestTarget || [...url.searchParams.keys()].join(",") !== "abbyContext") return;
      const token = url.searchParams.get("abbyContext"); if (!token) return;
      const form: Record<string, string> = Object.create(null);
      for (const [key, v] of new URLSearchParams(request.body)) { if (Object.hasOwn(form, key)) return; form[key] = v; }
      if (!validateRequest(this.#config.authToken, request.signature, url.href, form) || form.AccountSid !== this.#config.accountSid ||
          !sid(form.CallSid) || form.Direction !== "outbound-api" || form.From !== this.#config.from || !phone(form.To) ||
          form.ParentCallSid || !form.CallStatus || !statuses.has(form.CallStatus)) return;
      const context = this.#context.openLaunch(token), receivedAt = this.#now();
      if (!context || context.number !== form.To || !instant(receivedAt) || receivedAt < context.original.attempt.attemptedAt) return;
      return { form, token, call: Object.freeze({ kind: "authenticatedOutboundCall", accountSid: this.#config.accountSid,
        callSid: form.CallSid, clinicNumber: this.#config.from, recipientNumber: form.To, receivedAt, context }) };
    } catch { return; }
  }
  authenticateAnswer(request: SignedTwilioWebhook): Result<Readonly<{ call: AuthenticatedTwilioOutboundCall; twiml: string }>, Failure> {
    const result = this.#authenticate(request, this.#answer);
    if (!result || result.form.CallStatus !== "in-progress" ||
        Date.parse(result.call.receivedAt) - Date.parse(result.call.context.original.attempt.attemptedAt) > TWILIO_OUTBOUND_ANSWER_WINDOW_MS) return invalid();
    try {
      const token = this.#context.sealStream(result.token, result.call.callSid, result.call.receivedAt);
      const response = new VoiceResponse(), stream = response.connect().stream({ url: this.#stream.href });
      const chunks = token.match(/.{1,380}/g)!; if (chunks.length > 16) return invalid();
      chunks.forEach((part, index) => stream.parameter({ name: `abbyOutbound${index}`, value: part }));
      response.hangup(); return ok(Object.freeze({ call: result.call, twiml: response.toString() }));
    } catch { return invalid(); }
  }
  authenticateStatus(request: SignedTwilioWebhook): Result<Readonly<{ call: AuthenticatedTwilioOutboundCall; status: string }>, Failure> {
    const result = this.#authenticate(request, this.#status);
    return result ? ok(Object.freeze({ call: result.call, status: result.form.CallStatus! })) : invalid();
  }
  authorizeUpgrade(request: SignedTwilioUpgrade): Result<true, Failure> {
    try {
      return request.method === "GET" && request.requestTarget === target(this.#stream) && !!request.signature &&
        validateRequest(this.#config.authToken, request.signature, this.#stream.href, {}) ? ok(true) : invalid();
    } catch { return invalid(); }
  }
  authenticateStream(request: SignedTwilioStreamStart): Result<Readonly<{ call: AuthenticatedTwilioOutboundCall; streamSid: string; streamStartedAt: string }>, Failure> {
    try {
      if (!this.authorizeUpgrade(request).ok || Buffer.byteLength(request.connected) > 16384 || Buffer.byteLength(request.start) > 16384) return invalid();
      const connected: unknown = JSON.parse(request.connected), start: unknown = JSON.parse(request.start);
      if (!object(connected) || connected.event !== "connected" || connected.protocol !== "Call" || connected.version !== "1.0.0" ||
          !object(start) || start.event !== "start" || start.sequenceNumber !== "1" || !object(start.start) ||
          typeof start.streamSid !== "string" || !/^MZ[0-9a-f]{32}$/.test(start.streamSid) || start.start.streamSid !== start.streamSid ||
          start.start.accountSid !== this.#config.accountSid || !sid(start.start.callSid) || !object(start.start.customParameters)) return invalid();
      const parameters = start.start.customParameters, keys = Object.keys(parameters), parts: string[] = [];
      if (!keys.length || keys.length > 16) return invalid();
      for (let i = 0; i < keys.length; i++) { const part = parameters[`abbyOutbound${i}`];
        if (typeof part !== "string" || !part.length || part.length > 380 || i < keys.length - 1 && part.length !== 380) return invalid(); parts.push(part); }
      const at = this.#now(), decoded = this.#context.openStream(parts.join(""), start.start.callSid, at);
      if (!decoded) return invalid();
      return ok(Object.freeze({ call: Object.freeze({ kind: "authenticatedOutboundCall", accountSid: this.#config.accountSid, callSid: start.start.callSid,
        clinicNumber: this.#config.from, recipientNumber: decoded.call.number, receivedAt: decoded.receivedAt, context: decoded.call }), streamSid: start.streamSid, streamStartedAt: at }));
    } catch { return invalid(); }
  }
}
