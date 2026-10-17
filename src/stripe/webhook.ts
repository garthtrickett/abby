import { createHmac, timingSafeEqual } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { StripeBodyError, stripeBodyBytes } from "./internal/body-bytes.ts";
import type { StripeBodyStream } from "./internal/body-bytes.ts";

const checkoutEvents = ["checkout.session.completed", "checkout.session.expired",
  "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed"] as const;
export type StripeCheckoutEvent = typeof checkoutEvents[number];
export type StripeCheckoutNotification = Readonly<{
  eventRef: string; type: StripeCheckoutEvent; checkoutRef: string;
  accountRef: string | null; livemode: boolean; apiVersion: string;
}>;
export type StripeWebhookFailure = Readonly<{ kind: "invalidWebhook" | "foreignEndpoint" | "unsupportedVersion" | "unavailable" }>;
type Config = Readonly<{
  endpointSecret: string;
  /** null means a direct-account endpoint with its own account-specific secret. */
  accountRef: string | null;
  livemode: boolean;
  apiVersion: string;
  clock?: () => number;
  bodyDeadlineMs?: number;
}>;
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Authenticates a bounded v1 snapshot and returns only a reference for fresh
 * provider inspection. A signature establishes no payment, action permission,
 * deduplication or durable processing acknowledgement. No patient body escapes.
 * Protocol: https://docs.stripe.com/webhooks#verify-manually */
export class StripeWebhookVerifier {
  readonly #config: Config;
  constructor(config: Config) {
    if (!config || typeof config.endpointSecret !== "string" || !/^whsec_[\x21-\x7e]{16,506}$/.test(config.endpointSecret) ||
        config.accountRef !== null && (typeof config.accountRef !== "string" || !/^acct_[A-Za-z0-9]{1,128}$/.test(config.accountRef)) ||
        typeof config.livemode !== "boolean" || typeof config.apiVersion !== "string" ||
        !/^\d{4}-\d{2}-\d{2}(?:\.[a-z]+)?$/.test(config.apiVersion) ||
        config.clock !== undefined && typeof config.clock !== "function" || config.bodyDeadlineMs !== undefined &&
        (!Number.isSafeInteger(config.bodyDeadlineMs) || config.bodyDeadlineMs < 1 || config.bodyDeadlineMs > 10_000)) throw new TypeError("invalid Stripe webhook configuration");
    this.#config = Object.freeze({ ...config });
  }

  /** Authenticates captured transport bytes, without parsing/re-encoding them.
   * Returns the same reference-only result; no HTTP acknowledgement, financial
   * permission or durable handoff is established by this method. */
  async verifyStream(body: StripeBodyStream | null, header: string | null, external: AbortSignal):
    Promise<Result<StripeCheckoutNotification | null, StripeWebhookFailure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), this.#config.bodyDeadlineMs ?? 10_000);
    const signal = AbortSignal.any([external, deadline.signal]);
    try {
      const bytes = await stripeBodyBytes(body, 262_144, signal);
      return signal.aborted ? err({ kind: "unavailable" }) : this.verify(bytes, header);
    } catch (error) {
      return err({ kind: error instanceof StripeBodyError && error.kind === "malformed" ? "invalidWebhook" : "unavailable" });
    } finally { clearTimeout(timer); }
  }

  /** Caller must bound the transport stream before allocating these bytes.
   * null success means an authentic, correctly scoped event outside Checkout. */
  verify(raw: Uint8Array, header: string | null): Result<StripeCheckoutNotification | null, StripeWebhookFailure> {
    try {
      if (!(raw instanceof Uint8Array) || raw.byteLength < 1 || raw.byteLength > 262_144 ||
          typeof header !== "string" || !header || header.length > 4_096) return err({ kind: "invalidWebhook" });
      const bytes = Buffer.from(raw);
      let timestamp: string | undefined;
      const signatures: Buffer[] = [];
      for (const item of header.split(",")) {
        const at = item.indexOf("=");
        if (at < 1) return err({ kind: "invalidWebhook" });
        const name = item.slice(0, at).trim(), value = item.slice(at + 1).trim();
        if (name === "t") {
          if (timestamp !== undefined || !/^(?:0|[1-9][0-9]{0,15})$/.test(value)) return err({ kind: "invalidWebhook" });
          timestamp = value;
        } else if (name === "v1") {
          if (!/^[a-fA-F0-9]{64}$/.test(value) || signatures.length >= 8) return err({ kind: "invalidWebhook" });
          signatures.push(Buffer.from(value, "hex"));
        }
      }
      const now = (this.#config.clock ?? Date.now)();
      if (timestamp === undefined || !signatures.length || !Number.isSafeInteger(now) || now < 0 ||
          !Number.isSafeInteger(Number(timestamp)) || Math.abs(Math.floor(now / 1_000) - Number(timestamp)) > 300) {
        return err({ kind: "invalidWebhook" });
      }
      const expected = createHmac("sha256", this.#config.endpointSecret).update(timestamp + ".").update(bytes).digest();
      let matches = false;
      for (const signature of signatures) matches = timingSafeEqual(expected, signature) || matches;
      if (!matches) return err({ kind: "invalidWebhook" });
      const event = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      if (!event || event.object !== "event" || typeof event.id !== "string" || !/^evt_[A-Za-z0-9]{1,128}$/.test(event.id) ||
          typeof event.type !== "string" || event.type.length > 128 || !/^[a-z0-9_.]+$/.test(event.type) ||
          !Number.isSafeInteger(event.created) || Number(event.created) < 0) return err({ kind: "invalidWebhook" });
      if ((event.account ?? null) !== this.#config.accountRef || event.livemode !== this.#config.livemode) return err({ kind: "foreignEndpoint" });
      if (!(checkoutEvents as readonly string[]).includes(event.type)) return ok(null);
      if (event.api_version !== this.#config.apiVersion) return err({ kind: "unsupportedVersion" });
      const object = record(record(event.data)?.object);
      if (!object || object.object !== "checkout.session" || typeof object.id !== "string" ||
          !/^cs_(?:test_|live_)?[A-Za-z0-9]{1,200}$/.test(object.id)) return err({ kind: "invalidWebhook" });
      return ok(Object.freeze({ eventRef: event.id, type: event.type as StripeCheckoutEvent, checkoutRef: object.id,
        accountRef: this.#config.accountRef, livemode: this.#config.livemode, apiVersion: this.#config.apiVersion }));
    } catch { return err({ kind: "invalidWebhook" }); }
  }
}
