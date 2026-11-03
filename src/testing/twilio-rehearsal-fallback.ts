import { validateRequest } from "twilio/lib/webhooks/webhooks.js";
import type { RehearsalRequest } from "./twilio-voice-rehearsal.ts";

type FallbackConfig = Readonly<{
  accountSid: string; authToken: string; callbackUrl: string; fallback: string;
  expiresAt: number; now?: () => number;
}>;
type Event = Readonly<{ child: string; parent: string; status: string; sequence: number }>;
const callSid = /^CA[0-9a-f]{32}$/;
const statuses = new Set(["initiated", "queued", "ringing", "in-progress", "completed", "busy", "failed", "no-answer", "canceled"]);

/** Finite signed event collection, including callbacks that beat target binding.
 * Only a subsequently bound exact parent/child can supply ringing evidence.
 * Provider readback and caller terminal remain separate required observations. */
export class TwilioRehearsalFallback {
  private readonly config: FallbackConfig;
  private readonly url: URL;
  private readonly now: () => number;
  private readonly events = new Map<string, Event>();
  private parent: string | undefined;
  private conflicted = false;

  constructor(config: FallbackConfig) {
    const url = new URL(config.callbackUrl), now = config.now ?? Date.now;
    if (!/^AC[0-9a-f]{32}$/.test(config.accountSid) || !config.authToken ||
        !/^\+[1-9]\d{7,14}$/.test(config.fallback) || url.protocol !== "https:" ||
        url.username || url.password || url.search || url.hash ||
        !/^\/fallback-ringing\/[a-f0-9]{32}$/.test(url.pathname) ||
        !Number.isSafeInteger(config.expiresAt) || config.expiresAt <= now() ||
        config.expiresAt > now() + 300_000) throw Error("Invalid rehearsal fallback configuration");
    this.config = Object.freeze({ ...config }); this.url = url; this.now = now;
  }

  bindTarget(parent: string): void {
    if (this.parent || !callSid.test(parent)) throw Error("Invalid rehearsal target binding");
    this.parent = parent;
  }

  accept(request: RehearsalRequest): Readonly<{ status: number }> {
    if (request.method !== "POST" || request.target !== this.url.pathname ||
        request.contentType?.split(";")[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded" ||
        !request.signature || Buffer.byteLength(request.body) > 16_384 || this.now() >= this.config.expiresAt)
      return { status: 403 };
    const fields: Record<string, string> = Object.create(null);
    for (const [key, value] of new URLSearchParams(request.body)) {
      if (Object.hasOwn(fields, key)) return { status: 403 };
      fields[key] = value;
    }
    if (!validateRequest(this.config.authToken, request.signature, this.url.href, fields) ||
        fields.AccountSid !== this.config.accountSid || fields.CallbackSource !== "call-progress-events" ||
        fields.Direction !== "outbound-dial" ||
        fields.To !== this.config.fallback || !callSid.test(fields.CallSid ?? "") ||
        !callSid.test(fields.ParentCallSid ?? "") || fields.CallSid === fields.ParentCallSid ||
        !statuses.has(fields.CallStatus ?? "") || !/^(0|[1-9]\d?)$/.test(fields.SequenceNumber ?? "") ||
        this.parent && fields.ParentCallSid !== this.parent) return { status: 403 };
    const event: Event = { child: fields.CallSid!, parent: fields.ParentCallSid!,
      status: fields.CallStatus!, sequence: Number(fields.SequenceNumber) };
    const key = `${event.child}:${event.sequence}`, prior = this.events.get(key);
    if (prior) {
      if (prior.parent === event.parent && prior.status === event.status) return { status: 204 };
      this.conflicted = true; return { status: 409 };
    }
    if (this.events.size >= 16) { this.conflicted = true; return { status: 409 }; }
    this.events.set(key, event); return { status: 204 };
  }

  ringing(child: string): boolean {
    return !this.conflicted && callSid.test(child) && this.parent !== undefined &&
      [...this.events.values()].some(event => event.parent === this.parent && event.child === child && event.status === "ringing");
  }
}
