import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ownedBodyBytes } from "../shared/owned-body-bytes.ts";
import { claimClinikoBudget, observeCliniko429 } from "./read-budget.ts";
import { financialConfigShard, financialSelection, financialRecordInstant } from "./internal/financial-record-context.ts";
import type { ClinikoFinancialReviewConfig, ClinikoFinancialReviewSelection } from "./internal/financial-record-context.ts";
import { validClinikoId } from "../standalone/appointment-change-authority.ts";
import { validRecallMarker } from "./recall-note.ts";

/** Supplied by the independent financial owner, never discovered by matching
 * notes, nearest appointments or numeric aliases between native resources. */
export type FinancialInvoiceBinding = Readonly<{
  financialActionRef: string; invoiceRef: string; patientId: string; bookingId: string;
  attendeeId?: string; expectedTotalMinor: number; currency: string; expiresAt: string;
}>;
export type FinancialInvoiceQuery = Readonly<{
  purpose: "inspectRecordedFinancialInvoice"; source: ClinikoFinancialReviewSelection; binding: FinancialInvoiceBinding;
}>;
/** Includes exact obligation/invoice mapping and current account currency.
 * The native invoice schema supplies neither a currency nor an Abby action ID.
 * Read permission supplies no collection, waiver or clinical-effect grant. */
export type FinancialInvoiceAuthority = Readonly<{
  allows(query: FinancialInvoiceQuery, signal: AbortSignal): Promise<boolean>;
  current(query: FinancialInvoiceQuery, signal: AbortSignal): boolean;
}>;
export type FinancialInvoiceObservation = Readonly<{
  state: "open" | "recordedPaid" | "closed" | "openCredit";
  totalMinor: number; currency: string; observedAt: string; updatedAt: string;
}>;
type Failure = Readonly<{ kind: "invalidConfig" | "invalidQuery" | "forbidden" | "unavailable" | "mismatched" }>;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const link = (v: unknown): unknown => object(v) && object(v.links) ? v.links.self : undefined;
const currencies = ["aud", "gbp", "nzd", "cad", "usd", "eur"];
function minor(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,2})?$/.test(value)) return undefined;
  const negative = value.startsWith("-"), [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return result <= 99_999_999 ? (negative ? -result : result) : undefined;
}
function binding(value: FinancialInvoiceBinding): FinancialInvoiceBinding | undefined {
  const b = structuredClone(value), fields = Object.keys(b).sort().join(",");
  if (fields !== "bookingId,currency,expectedTotalMinor,expiresAt,financialActionRef,invoiceRef,patientId" &&
      fields !== "attendeeId,bookingId,currency,expectedTotalMinor,expiresAt,financialActionRef,invoiceRef,patientId") return undefined;
  if (!validRecallMarker(b.financialActionRef) || ![b.invoiceRef, b.patientId, b.bookingId].every(validClinikoId) ||
      b.attendeeId !== undefined && !validClinikoId(b.attendeeId) || !currencies.includes(b.currency) ||
      !Number.isSafeInteger(b.expectedTotalMinor) || Math.abs(b.expectedTotalMinor) > 99_999_999 ||
      !financialRecordInstant(b.expiresAt)) return undefined;
  return Object.freeze(b);
}
function discard(r: Response | undefined): void { try { void r?.body?.cancel().catch(() => {}); } catch { /* Private details stay private. */ } }

/** One exact native GET. A recorded paid invoice is not a Stripe settlement,
 * receipt, unreversed-payment proof or waiver. Open/closed/credit observations
 * never establish no manual payment, no waiver or permission to cancel. */
export class ClinikoFinancialInvoiceReader {
  readonly #config: ClinikoFinancialReviewConfig;
  readonly #source: ClinikoFinancialReviewSelection;
  readonly #base: string;
  readonly #authority: FinancialInvoiceAuthority;
  readonly #fetch: typeof fetch;
  private constructor(config: ClinikoFinancialReviewConfig, authority: FinancialInvoiceAuthority, port: typeof fetch, shard: string) {
    this.#source = financialSelection(config);
    this.#config = Object.freeze({ scope: this.#source.scope, apiKey: config.apiKey, contactEmail: config.contactEmail,
      businessId: config.businessId, recallTypeId: config.recallTypeId, stripe: this.#source.stripe, rateBudget: config.rateBudget,
      ...(config.clock ? { clock: config.clock.bind(config) } : {}), ...(config.deadlineMs === undefined ? {} : { deadlineMs: config.deadlineMs }) });
    this.#base = `https://api.${shard}.cliniko.com/v1`; this.#fetch = port;
    this.#authority = Object.freeze({ allows: authority.allows.bind(authority), current: authority.current.bind(authority) });
  }
  static create(config: ClinikoFinancialReviewConfig, authority: FinancialInvoiceAuthority, port: typeof fetch = fetch): Result<ClinikoFinancialInvoiceReader, Failure> {
    try {
      const shard = financialConfigShard(config, port);
      if (!shard || typeof authority?.allows !== "function" || typeof authority.current !== "function") return err({ kind: "invalidConfig" });
      return ok(new ClinikoFinancialInvoiceReader(config, authority, port, shard));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async read(input: FinancialInvoiceBinding, external: AbortSignal): Promise<Result<FinancialInvoiceObservation, Failure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const deadline = new AbortController(), ms = this.#config.deadlineMs ?? 15_000, timer = setTimeout(() => deadline.abort(), ms);
    const signal = AbortSignal.any([external, deadline.signal]), start = performance.now();
    let response: Response | undefined, bodyOwned = false;
    try {
      const selected = binding(input); if (!selected) return err({ kind: "invalidQuery" });
      const began = financialRecordInstant(this.#config.clock?.() ?? new Date().toISOString()), expires = Date.parse(selected.expiresAt);
      if (!began || Date.parse(began) >= expires) return err({ kind: "invalidQuery" });
      const query = Object.freeze({ purpose: "inspectRecordedFinancialInvoice" as const, source: this.#source, binding: selected });
      const active = () => {
        const now = financialRecordInstant(this.#config.clock?.() ?? new Date().toISOString());
        return !!now && now >= began && Date.parse(now) < expires && !signal.aborted && performance.now() - start <= ms;
      };
      const wait = async <T>(task: Promise<T>) => { const found = await awaitUntilAbort(task, signal); return active() ? found : undefined; };
      const permit = async () => await wait(Promise.resolve().then(() => this.#authority.allows(query, signal))) === true && this.#authority.current(query, signal) === true;
      if (!await permit()) return err({ kind: "forbidden" });
      if (await wait(claimClinikoBudget(this.#config.rateBudget)) !== null) return err({ kind: "unavailable" });
      if (!await permit() || !active()) return err({ kind: "forbidden" });
      const received = await wait(this.#fetch(`${this.#base}/invoices/${selected.invoiceRef}`, { method: "GET", redirect: "error", signal,
        headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${this.#config.apiKey}:`).toString("base64")}`,
          "User-Agent": `Abby (${this.#config.contactEmail})` } }).then(r => { response = r; if (signal.aborted) discard(r); return r; }));
      if (!received) return err({ kind: "unavailable" });
      if (received.status === 429) { await wait(observeCliniko429(this.#config.rateBudget, received.headers.get("X-RateLimit-Reset"))); return err({ kind: "unavailable" }); }
      if (received.status === 401 || received.status === 403) return err({ kind: "forbidden" });
      if (received.status !== 200) return err({ kind: "unavailable" });
      bodyOwned = true;
      const bytes = await ownedBodyBytes(received.body, 1_000_000, signal), row: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!await permit()) return err({ kind: "forbidden" });
      const states = { 10: "open", 20: "recordedPaid", 30: "closed", 40: "openCredit" } as const;
      if (!object(row) || row.id !== selected.invoiceRef || link({ links: row.links }) !== `${this.#base}/invoices/${selected.invoiceRef}` ||
          link(row.patient) !== `${this.#base}/patients/${selected.patientId}` || link(row.business) !== `${this.#base}/businesses/${this.#source.businessId}` ||
          link(row.booking) !== `${this.#base}/bookings/${selected.bookingId}` || selected.attendeeId !== undefined && link(row.attendee) !== `${this.#base}/attendees/${selected.attendeeId}` ||
          row.archived_at !== null || row.deleted_at !== null || minor(row.total_amount) !== selected.expectedTotalMinor ||
          typeof row.status !== "number" || !Object.hasOwn(states, row.status)) return err({ kind: "mismatched" });
      const updated = financialRecordInstant(row.updated_at), created = financialRecordInstant(row.created_at);
      const observed = financialRecordInstant(this.#config.clock?.() ?? new Date().toISOString());
      if (!updated || !created || updated < created || !observed || updated > observed || !active() || this.#authority.current(query, signal) !== true) return err({ kind: "unavailable" });
      return ok(Object.freeze({ state: states[row.status as keyof typeof states], totalMinor: selected.expectedTotalMinor,
        currency: selected.currency, observedAt: observed, updatedAt: updated }));
    } catch { return err({ kind: "unavailable" }); }
    finally { clearTimeout(timer); deadline.abort(); if (!bodyOwned) discard(response); }
  }
}
