import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ownedBodyBytes } from "../shared/owned-body-bytes.ts";
import { claimClinikoBudget, observeCliniko429 } from "./read-budget.ts";
import { encodeClinikoFinancialIntent } from "./financial-review-intent.ts";
import { financialConfigShard, financialSelection, financialRecordInstant } from "./internal/financial-record-context.ts";
import type { ClinikoFinancialReviewConfig, ClinikoFinancialReviewSelection } from "./internal/financial-record-context.ts";
import type { FinancialWaiverExpected, FinancialWaiverDecision } from "./financial-waiver-decision.ts";
import { ApprovedFinancialWaiverIssuer } from "../standalone/approved-financial-waiver-issuer.ts";
import { sameScope } from "../standalone/appointment-change-authority.ts";
import { validRecallDate, validRecallMarker } from "./recall-note.ts";

export type FinancialWaiverBinding = FinancialWaiverExpected & Readonly<{ waiverRecallRef: string; decisionRef: string }>;
export type FinancialWaiverReadQuery = Readonly<{
  purpose: "inspectApprovedFinancialWaiver"; source: ClinikoFinancialReviewSelection; binding: FinancialWaiverBinding;
}>;
export type FinancialWaiverReadAuthority = Readonly<{
  allows(query: FinancialWaiverReadQuery, signal: AbortSignal): Promise<boolean>;
  current(query: FinancialWaiverReadQuery, signal: AbortSignal): boolean;
}>;
type Failure = Readonly<{ kind: "invalidConfig" | "invalidQuery" | "forbidden" | "unavailable" | "mismatched" }>;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const link = (v: unknown): unknown => record(v) && record(v.links) ? v.links.self : undefined;
function freeze<T>(v: T): T { if (v && typeof v === "object") { for (const x of Object.values(v)) freeze(x); Object.freeze(v); } return v; }
function discard(r: Response | undefined): void { try { void r?.body?.cancel().catch(() => {}); } catch { /* Private body never escapes. */ } }

/** Exact positive waiver observation only. A missing/closed/recalled/unknown
 * record cannot prove no waiver or permit collection/expiry. Nothing is written
 * to native systems, a local private queue, SQL or any public/model channel. */
export class ClinikoFinancialWaiverReader {
  readonly #config: ClinikoFinancialReviewConfig;
  readonly #source: ClinikoFinancialReviewSelection;
  readonly #issuer: ApprovedFinancialWaiverIssuer;
  readonly #authority: FinancialWaiverReadAuthority;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  private constructor(config: ClinikoFinancialReviewConfig, issuer: ApprovedFinancialWaiverIssuer, authority: FinancialWaiverReadAuthority, port: typeof fetch, shard: string) {
    this.#source = financialSelection(config); this.#issuer = issuer;
    this.#config = Object.freeze({ scope: this.#source.scope, apiKey: config.apiKey, contactEmail: config.contactEmail, businessId: config.businessId,
      recallTypeId: config.recallTypeId, stripe: this.#source.stripe, rateBudget: config.rateBudget,
      ...(config.clock ? { clock: config.clock.bind(config) } : {}), ...(config.deadlineMs === undefined ? {} : { deadlineMs: config.deadlineMs }) });
    this.#authority = Object.freeze({ allows: authority.allows.bind(authority), current: authority.current.bind(authority) });
    this.#fetch = port; this.#base = `https://api.${shard}.cliniko.com/v1`;
  }
  static create(config: ClinikoFinancialReviewConfig, issuer: ApprovedFinancialWaiverIssuer, authority: FinancialWaiverReadAuthority,
    port: typeof fetch = fetch): Result<ClinikoFinancialWaiverReader, Failure> {
    try {
      const shard = financialConfigShard(config, port);
      if (!shard || !(issuer instanceof ApprovedFinancialWaiverIssuer) || !issuer.matches(config) ||
          typeof authority?.allows !== "function" || typeof authority.current !== "function") return err({ kind: "invalidConfig" });
      return ok(new ClinikoFinancialWaiverReader(config, issuer, authority, port, shard));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async read(input: FinancialWaiverBinding, external: AbortSignal): Promise<Result<Readonly<{ decision: FinancialWaiverDecision; observedAt: string }>, Failure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const deadline = new AbortController(), ms = this.#config.deadlineMs ?? 15_000, timer = setTimeout(() => deadline.abort(), ms);
    const signal = AbortSignal.any([external, deadline.signal]), start = performance.now();
    let response: Response | undefined, bodyOwned = false;
    try {
      const binding = freeze(structuredClone(input)), intent = binding.intent;
      const nativeId = /^cliniko:recall:([1-9][0-9]{0,18})$/.exec(binding.waiverRecallRef)?.[1];
      if (Object.keys(binding).sort().join(",") !== "decisionRef,intent,intentRecallRef,targetRef,waiverRecallRef" || !nativeId || !validRecallMarker(binding.decisionRef) ||
          !/^cliniko:recall:[1-9][0-9]{0,18}$/.test(binding.intentRecallRef) || binding.waiverRecallRef === binding.intentRecallRef || !encodeClinikoFinancialIntent(intent).ok ||
          !sameScope(intent.scope, this.#source.scope) || intent.businessId !== this.#source.businessId || intent.credentialFingerprint !== this.#source.credentialFingerprint ||
          intent.stripe.accountRef !== this.#source.stripe.accountRef || intent.stripe.livemode !== this.#source.stripe.livemode ||
          !/^cliniko:(?:appointment|attendee):[1-9][0-9]{0,18}$/.test(binding.targetRef) ||
          !binding.targetRef.startsWith(intent.booking.kind === "book" ? "cliniko:appointment:" : "cliniko:attendee:")) return err({ kind: "invalidQuery" });
      const began = financialRecordInstant(this.#config.clock?.() ?? new Date().toISOString());
      if (!began) return err({ kind: "unavailable" });
      const query = freeze({ purpose: "inspectApprovedFinancialWaiver" as const, source: this.#source, binding });
      const wait = async <T>(task: Promise<T>) => {
        const value = await awaitUntilAbort(task, signal), now = financialRecordInstant(this.#config.clock?.() ?? new Date().toISOString());
        return value !== undefined && now && now >= began && !signal.aborted && performance.now() - start <= ms ? value : undefined;
      };
      const permit = async () => await wait(Promise.resolve().then(() => this.#authority.allows(query, signal))) === true &&
        this.#authority.current(query, signal) === true && await wait(this.#issuer.current(signal)) === true &&
        this.#authority.current(query, signal) === true;
      if (!await permit()) return err({ kind: "forbidden" });
      if (await wait(claimClinikoBudget(this.#config.rateBudget)) !== null) return err({ kind: "unavailable" });
      if (!await permit()) return err({ kind: "forbidden" });
      const received = await wait(this.#fetch(`${this.#base}/recalls/${nativeId}`, { method: "GET", redirect: "error", signal,
        headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${this.#config.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${this.#config.contactEmail})` }
      }).then(r => { response = r; if (signal.aborted) discard(r); return r; }));
      if (!received) return err({ kind: "unavailable" });
      if (received.status === 429) { await wait(observeCliniko429(this.#config.rateBudget, received.headers.get("X-RateLimit-Reset"))); return err({ kind: "unavailable" }); }
      if (received.status === 401 || received.status === 403) return err({ kind: "forbidden" });
      if (received.status !== 200) return err({ kind: "unavailable" });
      bodyOwned = true;
      const bytes = await ownedBodyBytes(received.body, 1_000_000, signal), row: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!record(row) || row.id !== nativeId || link(row) !== `${this.#base}/recalls/${nativeId}` || link(row.patient) !== `${this.#base}/patients/${intent.patientId}` ||
          link(row.recall_type) !== `${this.#base}/recall_types/${this.#source.recallTypeId}` || row.recalled !== false || row.recalled_at !== null || row.archived_at !== null ||
          !validRecallDate(row.recall_at)) return err({ kind: "mismatched" });
      const created = financialRecordInstant(row.created_at), updated = financialRecordInstant(row.updated_at);
      if (!created || !updated || updated < created || !await permit()) return err({ kind: "forbidden" });
      const verified = await wait(this.#issuer.verifyCurrent(row.notes, binding, signal));
      const observed = financialRecordInstant(this.#config.clock?.() ?? new Date().toISOString());
      if (!verified?.ok || verified.value.actionRef !== binding.decisionRef || verified.value.approvedAt > updated ||
          !observed || updated > observed || verified.value.expiresAt <= observed || this.#authority.current(query, signal) !== true || signal.aborted) return err({ kind: "unavailable" });
      return ok(Object.freeze({ decision: verified.value, observedAt: observed }));
    } catch { return err({ kind: "unavailable" }); }
    finally { clearTimeout(timer); deadline.abort(); if (!bodyOwned) discard(response); }
  }
}
