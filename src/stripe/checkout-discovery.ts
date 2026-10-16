import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { StripeApiRead, ReadError, record, ref, money } from "./internal/api-read.ts";
import type { StripeReadConfig, StripeReadFailure } from "./internal/api-read.ts";

export type StripeCheckoutDiscoveryBinding = Readonly<{
  actionRef: string; amount: number; currency: string;
  /** Inclusive provider-created UTC seconds enclosing the original attempt. */
  createdFrom: number; createdTo: number;
}>;
export type StripeCheckoutDiscoveryResult = Readonly<{ observedAt: string }> & (
  | Readonly<{ kind: "observed"; checkoutRef: string }>
  | Readonly<{ kind: "notObserved" }>
);

/** Exact readonly discovery after uncertain creation. A complete bounded scan
 * may yield one candidate, never permission to POST again or a creation/payment
 * acknowledgement. The owner still needs independent producer quiescence and
 * fresh exact inspection; a list is not a snapshot of every concurrent actor.
 * No phone/latest-row fallback or unsupported metadata filter is used. */
export class StripeCheckoutDiscovery {
  readonly #api: StripeApiRead;
  readonly #livemode: boolean;
  constructor(config: StripeReadConfig, port: typeof fetch = fetch) {
    this.#api = new StripeApiRead(config, port); this.#livemode = config.livemode;
  }

  async find(binding: StripeCheckoutDiscoveryBinding, signal: AbortSignal): Promise<Result<StripeCheckoutDiscoveryResult, StripeReadFailure>> {
    const wanted = Object.freeze({ actionRef: binding?.actionRef, amount: binding?.amount, currency: binding?.currency,
      createdFrom: binding?.createdFrom, createdTo: binding?.createdTo });
    if (typeof wanted.actionRef !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(wanted.actionRef) ||
        !money(wanted.amount) || wanted.amount < 1 || typeof wanted.currency !== "string" || !/^[a-z]{3}$/.test(wanted.currency) ||
        !Number.isSafeInteger(wanted.createdFrom) || wanted.createdFrom < 0 || !Number.isSafeInteger(wanted.createdTo) ||
        wanted.createdTo < wanted.createdFrom || wanted.createdTo - wanted.createdFrom > 3_600) return err({ kind: "invalidBinding" });
    const result = await this.#api.run<string | null>(signal, async get => {
      let cursor: string | undefined, candidate: string | null = null;
      const seen = new Set<string>();
      for (let page = 0; page < 10; page++) {
        const query = new URLSearchParams({ limit: "100", "created[gte]": String(wanted.createdFrom), "created[lte]": String(wanted.createdTo) });
        if (cursor) query.set("starting_after", cursor);
        const list = await get("checkout/sessions?" + query);
        if (list.object !== "list" || list.url !== "/v1/checkout/sessions" || !Array.isArray(list.data) ||
            list.data.length > 100 || typeof list.has_more !== "boolean" || list.has_more && list.data.length === 0) throw new ReadError("malformed");
        for (const item of list.data) {
          const row = record(item);
          if (!row || row.object !== "checkout.session" || !ref(row.id, "cs") || typeof row.id !== "string" ||
              seen.has(row.id) || !Number.isSafeInteger(row.created) || Number(row.created) < wanted.createdFrom ||
              Number(row.created) > wanted.createdTo || row.client_reference_id !== null && typeof row.client_reference_id !== "string" ||
              row.mode !== "payment" && row.mode !== "subscription" && row.mode !== "setup") throw new ReadError("malformed");
          if (row.livemode !== this.#livemode) throw new ReadError("mismatched");
          seen.add(row.id); cursor = row.id;
          if (row.client_reference_id !== wanted.actionRef) continue;
          if (row.mode !== "payment" || row.amount_total !== wanted.amount || row.currency !== wanted.currency) throw new ReadError("mismatched");
          if (candidate !== null) throw new ReadError("ambiguous");
          candidate = row.id;
        }
        if (!list.has_more) return candidate;
      }
      throw new ReadError("unavailable"); // An incomplete scan never yields its partial candidate.
    });
    if (!result.ok) return result;
    return ok(Object.freeze(result.value.data === null ? { kind: "notObserved", observedAt: result.value.observedAt }
      : { kind: "observed", checkoutRef: result.value.data, observedAt: result.value.observedAt }));
  }
}
