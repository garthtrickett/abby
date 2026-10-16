import { err, ok } from "../../core/model.ts";
import type { Result } from "../../core/model.ts";

export type StripeReadFailureKind = "invalidBinding" | "unavailable" | "forbidden" | "malformed" | "mismatched" | "ambiguous";
export type StripeReadFailure = Readonly<{ kind: StripeReadFailureKind }>;
export type StripeReadConfig = Readonly<{ apiKey: string; accountRef: string; connected: boolean; livemode: boolean; apiVersion: string;
  clock?: () => number; deadlineMs?: number }>;
export class ReadError extends Error {
  readonly kind: StripeReadFailureKind;
  constructor(kind: StripeReadFailureKind) { super("Stripe read failed"); this.kind = kind; }
}
export const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
export const ref = (v: unknown, prefix: string) => typeof v === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,200}$`).test(v);
export const money = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 99_999_999;

/** Internal shared read operation: one account scope, clock/deadline and bounded
 * body owner. Public money inspection and creation discovery use this together. */
export class StripeApiRead {
  readonly #config: StripeReadConfig;
  readonly #fetch: typeof fetch;
  constructor(config: StripeReadConfig, port: typeof fetch) {
    if (!config || typeof config.apiKey !== "string" || !/^(?:sk|rk)_(?:test|live)_[\x21-\x7e]{8,500}$/.test(config.apiKey) ||
        !ref(config.accountRef, "acct") || typeof config.connected !== "boolean" || typeof config.livemode !== "boolean" ||
        typeof config.apiVersion !== "string" || !/^\d{4}-\d{2}-\d{2}(?:\.[a-z]+)?$/.test(config.apiVersion) ||
        config.clock !== undefined && typeof config.clock !== "function" || typeof port !== "function" ||
        config.deadlineMs !== undefined && (!Number.isSafeInteger(config.deadlineMs) || config.deadlineMs < 1 || config.deadlineMs > 10_000)) {
      throw new TypeError("invalid Stripe reader configuration");
    }
    this.#config = Object.freeze({ ...config }); this.#fetch = port;
  }

  async run<T>(external: AbortSignal, consume: (get: (path: string) => Promise<Record<string, unknown>>) => Promise<T>):
    Promise<Result<Readonly<{ data: T; observedAt: string }>, StripeReadFailure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const config = this.#config, deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), config.deadlineMs ?? 10_000);
    const signal = AbortSignal.any([external, deadline.signal]);
    let onAbort = () => {};
    const aborted = new Promise<undefined>(resolve => { onAbort = () => resolve(undefined); signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort(); });
    const wait = async <T>(task: Promise<T>): Promise<T> => {
      const value = await Promise.race([task, aborted]);
      if (value === undefined || signal.aborted) throw new ReadError("unavailable"); return value;
    };
    const get = async (path: string) => {
      const response = await wait(this.#fetch("https://api.stripe.com/v1/" + path, { method: "GET", redirect: "error", signal,
        headers: { Authorization: `Bearer ${config.apiKey}`, "Stripe-Version": config.apiVersion,
          ...(config.connected ? { "Stripe-Account": config.accountRef } : {}) } }));
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        throw new ReadError(response.status === 401 || response.status === 403 ? "forbidden" : "unavailable");
      }
      if (!response.body) throw new ReadError("malformed");
      const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
      try {
        while (true) {
          const next = await wait(reader.read()); if (next.done) break;
          size += next.value.byteLength; if (size > 1_000_000) throw new ReadError("malformed");
          chunks.push(Buffer.from(next.value));
        }
        let value: unknown;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { throw new ReadError("malformed"); }
        const object = record(value); if (!object) throw new ReadError("malformed"); return object;
      } finally {
        void reader.cancel().catch(() => {});
        try { reader.releaseLock(); } catch { /* Cancellation retires a held read. */ }
      }
    };
    try {
      const started = (config.clock ?? Date.now)();
      if (!Number.isSafeInteger(started) || started < 0) throw new ReadError("unavailable");
      const account = await get("account");
      if (account.object !== "account" || account.id !== config.accountRef) throw new ReadError("mismatched");
      const data = await consume(get);
      const ended = (config.clock ?? Date.now)();
      if (!Number.isSafeInteger(ended) || ended < started || ended - started > (config.deadlineMs ?? 10_000) || signal.aborted) throw new ReadError("unavailable");
      return ok(Object.freeze({ data, observedAt: new Date(ended).toISOString() }));
    } catch (error) { return err({ kind: error instanceof ReadError ? error.kind : "unavailable" }); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
  }
}
