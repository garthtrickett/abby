import { createHmac, timingSafeEqual } from "node:crypto";
import twilio from "twilio";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { AuthenticatedInboundCall } from "./admission.ts";

const accountSidPattern = /^AC[0-9a-f]{32}$/i;
const callSidPattern = /^CA[0-9a-f]{32}$/i;
const streamSidPattern = /^MZ[0-9a-f]{32}$/i;
const phonePattern = /^\+[1-9]\d{1,14}$/;
export const TWILIO_BINDING_LIFETIME_MS = 180_000;
const maxBodyBytes = 16_384;
const maxStartBytes = 16_384;

export type TwilioIngressFailure = Readonly<{
  kind: "invalidTwilioRequest" | "invalidTwilioSignature" | "expiredTwilioBinding" | "fallbackNotConfigured";
}>;
export type TwilioSignedIngressConfig = Readonly<{
  accountSid: string;
  authToken: string;
  /** Exact public HTTPS URL configured as the incoming-call webhook. */
  publicWebhookUrl: string;
  /** Exact public WSS URL emitted in TwiML, including its trailing slash if any. */
  publicStreamUrl: string;
  /** Provider-executed staff routes keyed by the dialed clinic number; independent of Abby's database. */
  fallbackNumbers: Readonly<Record<string, string>>;
  /** Independent HMAC key shared by all Abby instances serving this account. */
  bindingKey: Uint8Array;
  now?: () => Date;
}>;
export type SignedTwilioWebhook = Readonly<{
  method: string;
  requestTarget: string;
  contentType: string | undefined;
  signature: string | undefined;
  body: string;
}>;
export type SignedTwilioStreamStart = Readonly<{
  method: string;
  requestTarget: string;
  signature: string | undefined;
  connected: string;
  start: string;
}>;
export type SignedTwilioUpgrade = Pick<SignedTwilioStreamStart, "method" | "requestTarget" | "signature">;
export type AuthenticatedTwilioStream = Readonly<{
  event: AuthenticatedInboundCall;
  streamStartedAt: string;
  connected: string;
  start: string;
}>;

type Binding = readonly [1, string, string, string, string | null, string, number];

function target(url: URL): string { return `${url.pathname}${url.search}`; }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Authenticates both Twilio entry points before any call owner is constructed. */
export class TwilioSignedIngress {
  private readonly config: TwilioSignedIngressConfig;
  private readonly webhookUrl: URL;
  private readonly streamUrl: URL;
  private readonly now: () => Date;
  private readonly fallbackNumbers: ReadonlyMap<string, string>;

  constructor(config: TwilioSignedIngressConfig) {
    const webhookUrl = new URL(config.publicWebhookUrl);
    const streamUrl = new URL(config.publicStreamUrl);
    if (!accountSidPattern.test(config.accountSid) || !config.authToken ||
        config.bindingKey.byteLength < 32 || webhookUrl.protocol !== "https:" ||
        streamUrl.protocol !== "wss:" || streamUrl.search || streamUrl.hash ||
        webhookUrl.username || webhookUrl.password || streamUrl.username || streamUrl.password) {
      throw new RangeError("invalid Twilio ingress configuration");
    }
    if (!config.fallbackNumbers || typeof config.fallbackNumbers !== "object" ||
        Array.isArray(config.fallbackNumbers)) throw new RangeError("invalid Twilio fallback numbers");
    const fallbackNumbers = Object.entries(config.fallbackNumbers);
    const inboundNumbers = new Set(fallbackNumbers.map(([number]) => number));
    if (fallbackNumbers.length < 1 || fallbackNumbers.length > 1_000 ||
        fallbackNumbers.some(([number, fallback]) => !phonePattern.test(number) ||
          !phonePattern.test(fallback) || inboundNumbers.has(fallback))) {
      throw new RangeError("invalid Twilio fallback numbers");
    }
    this.config = config;
    this.webhookUrl = webhookUrl;
    this.streamUrl = streamUrl;
    this.now = config.now ?? (() => new Date());
    this.fallbackNumbers = new Map(fallbackNumbers);
  }

  private mac(payload: string): Buffer {
    return createHmac("sha256", this.config.bindingKey).update(payload).digest();
  }

  private binding(value: Binding): string {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${payload}.${this.mac(payload).toString("base64url")}`;
  }

  private readBinding(token: unknown, accountSid: string, callSid: string):
    Result<AuthenticatedInboundCall, TwilioIngressFailure> {
    if (typeof token !== "string" || token.length > 480 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return err({ kind: "invalidTwilioRequest" });
    const [payload, signature] = token.split(".") as [string, string];
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.length !== 32 || !timingSafeEqual(supplied, this.mac(payload))) {
      return err({ kind: "invalidTwilioSignature" });
    }
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
    catch { return err({ kind: "invalidTwilioRequest" }); }
    if (!Array.isArray(decoded) || decoded.length !== 7 || decoded[0] !== 1 ||
        decoded[1] !== accountSid || decoded[2] !== callSid ||
        typeof decoded[3] !== "string" || !phonePattern.test(decoded[3]) ||
        !(decoded[4] === null || (typeof decoded[4] === "string" && phonePattern.test(decoded[4]))) ||
        typeof decoded[5] !== "string" || !Number.isFinite(Date.parse(decoded[5])) ||
        !Number.isSafeInteger(decoded[6])) return err({ kind: "invalidTwilioRequest" });
    const [,, , dialedNumber, presentedCallerNumber, receivedAt, expiresAt] = decoded as unknown as Binding;
    const current = this.now().getTime();
    if (!Number.isFinite(current) || current > expiresAt || expiresAt - current > TWILIO_BINDING_LIFETIME_MS ||
        expiresAt !== Date.parse(receivedAt) + TWILIO_BINDING_LIFETIME_MS) {
      return err({ kind: "expiredTwilioBinding" });
    }
    return ok({ key: { accountRef: accountSid, providerCallRef: callSid }, dialedNumber,
      ...(presentedCallerNumber ? { presentedCallerNumber } : {}), receivedAt });
  }

  answerWebhook(request: SignedTwilioWebhook): Result<string, TwilioIngressFailure> {
    if (request.method !== "POST" || request.requestTarget !== target(this.webhookUrl) ||
        request.contentType?.split(";")[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded" ||
        Buffer.byteLength(request.body) > maxBodyBytes || !request.signature) {
      return err({ kind: "invalidTwilioRequest" });
    }
    const form: Record<string, string> = Object.create(null) as Record<string, string>;
    const fields = new URLSearchParams(request.body);
    for (const [key, value] of fields) {
      if (Object.hasOwn(form, key)) return err({ kind: "invalidTwilioRequest" });
      form[key] = value;
    }
    if (!twilio.validateRequest(this.config.authToken, request.signature, this.config.publicWebhookUrl, form)) {
      return err({ kind: "invalidTwilioSignature" });
    }
    if (form.AccountSid !== this.config.accountSid || !callSidPattern.test(form.CallSid ?? "") ||
        !phonePattern.test(form.To ?? "")) return err({ kind: "invalidTwilioRequest" });
    const fallback = this.fallbackNumbers.get(form.To!);
    if (!fallback) return err({ kind: "fallbackNotConfigured" });
    const issuedAt = this.now().getTime();
    if (!Number.isSafeInteger(issuedAt)) return err({ kind: "invalidTwilioRequest" });
    const receivedAt = new Date(issuedAt).toISOString();
    const from = phonePattern.test(form.From ?? "") ? form.From! : null;
    const token = this.binding([1, form.AccountSid, form.CallSid!, form.To!, from,
      receivedAt, issuedAt + TWILIO_BINDING_LIFETIME_MS]);
    if (token.length + "abbyBinding".length >= 500) return err({ kind: "invalidTwilioRequest" });
    const response = new twilio.twiml.VoiceResponse();
    response.connect().stream({ url: this.config.publicStreamUrl }).parameter({
      name: "abbyBinding", value: token,
    });
    response.dial(fallback);
    return ok(response.toString());
  }

  authorizeUpgrade(request: SignedTwilioUpgrade): Result<true, TwilioIngressFailure> {
    if (request.method !== "GET" || request.requestTarget !== target(this.streamUrl) || !request.signature) {
      return err({ kind: "invalidTwilioRequest" });
    }
    if (!twilio.validateRequest(this.config.authToken, request.signature, this.config.publicStreamUrl, {})) {
      return err({ kind: "invalidTwilioSignature" });
    }
    return ok(true);
  }

  authenticateStream(request: SignedTwilioStreamStart): Result<AuthenticatedTwilioStream, TwilioIngressFailure> {
    const authorized = this.authorizeUpgrade(request);
    if (!authorized.ok) return authorized;
    if (Buffer.byteLength(request.connected) > maxStartBytes ||
        Buffer.byteLength(request.start) > maxStartBytes) return err({ kind: "invalidTwilioRequest" });
    let connected: unknown;
    let started: unknown;
    try { connected = JSON.parse(request.connected); started = JSON.parse(request.start); }
    catch { return err({ kind: "invalidTwilioRequest" }); }
    if (!record(connected) || connected.event !== "connected" || connected.protocol !== "Call" ||
        connected.version !== "1.0.0" || !record(started) || started.event !== "start" ||
        started.sequenceNumber !== "1" || !streamSidPattern.test(String(started.streamSid)) ||
        !record(started.start) || started.start.streamSid !== started.streamSid ||
        started.start.accountSid !== this.config.accountSid || !callSidPattern.test(String(started.start.callSid)) ||
        !record(started.start.customParameters) ||
        Object.keys(started.start.customParameters).length !== 1) return err({ kind: "invalidTwilioRequest" });
    const bound = this.readBinding(started.start.customParameters.abbyBinding,
      started.start.accountSid, started.start.callSid as string);
    if (!bound.ok) return bound;
    const startTime = this.now().getTime();
    if (!Number.isSafeInteger(startTime)) return err({ kind: "invalidTwilioRequest" });
    const streamStartedAt = new Date(startTime).toISOString();
    return ok({ event: bound.value, streamStartedAt, connected: request.connected, start: request.start });
  }
}
