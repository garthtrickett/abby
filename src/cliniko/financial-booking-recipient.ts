import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ownedBodyBytes } from "../shared/owned-body-bytes.ts";
import { claimClinikoBudget, observeCliniko429 } from "./read-budget.ts";
import { financialConfigShard, financialSelection } from "./internal/financial-record-context.ts";
import type { ClinikoFinancialReviewConfig, ClinikoFinancialReviewSelection } from "./internal/financial-record-context.ts";
import type { FinancialBookingSelection } from "../standalone/cliniko-financial-booking-preparation.ts";
import type { FinancialBookingRecipient } from "../standalone/approved-financial-booking-policy.ts";
import { approvalInstant, approvalRef } from "../standalone/owner-file-clinic-approval.ts";
import { sameScope, validClinikoId } from "../standalone/appointment-change-authority.ts";

export type FinancialRecipientQuery = Readonly<{
  purpose: "bookingPaymentRecipient"; source: ClinikoFinancialReviewSelection; booking: FinancialBookingSelection;
}>;
/** Exact patient and financial-contact-purpose admission, independent of caller
 * OTP, source-file approval, marketing flags and all payment/clinical effects. */
export type FinancialRecipientAuthority = Readonly<{
  allows(query: FinancialRecipientQuery, signal: AbortSignal): Promise<boolean>;
  current(query: FinancialRecipientQuery, signal: AbortSignal): boolean;
}>;
type Observation = NonNullable<Awaited<ReturnType<FinancialBookingRecipient["read"]>>>;
type Last = { selection: string; query: FinancialRecipientQuery; observation: Observation; at: number };
const mailbox = (v: unknown): v is string => typeof v === "string" && v.length <= 254 && /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function freeze<T>(v: T): T { if (v && typeof v === "object") { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } return v; }
function discard(response: Response | undefined): void { try { void response?.body?.cancel().catch(() => {}); } catch { /* No upstream details escape. */ } }

/** One-call, transient registered patient email reader. It reads one exact ID,
 * never searches patients, follows links, chooses a guardian or accepts a caller
 * destination. Construction starts nothing; no private result is persisted. */
export class ClinikoFinancialBookingRecipient implements FinancialBookingRecipient {
  readonly #config: ClinikoFinancialReviewConfig;
  readonly #source: ClinikoFinancialReviewSelection;
  readonly #base: string;
  readonly #authority: FinancialRecipientAuthority;
  readonly #fetch: typeof fetch;
  #last: Last | undefined;
  #epoch = 0;
  private constructor(config: ClinikoFinancialReviewConfig, authority: FinancialRecipientAuthority, port: typeof fetch, shard: string) {
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }), stripe: Object.freeze({ ...config.stripe }) });
    this.#source = financialSelection(config); this.#base = `https://api.${shard}.cliniko.com/v1`;
    this.#authority = Object.freeze({ allows: authority.allows.bind(authority), current: authority.current.bind(authority) }); this.#fetch = port;
  }
  static create(config: ClinikoFinancialReviewConfig, authority: FinancialRecipientAuthority, port: typeof fetch = fetch): Result<ClinikoFinancialBookingRecipient, Readonly<{ kind: "invalidConfig" }>> {
    const shard = financialConfigShard(config, port);
    return shard && typeof authority?.allows === "function" && typeof authority.current === "function"
      ? ok(new ClinikoFinancialBookingRecipient(config, authority, port, shard)) : err({ kind: "invalidConfig" });
  }
  #now() { return approvalInstant((this.#config.clock ?? (() => new Date().toISOString()))()); }
  async read(input: FinancialBookingSelection, external: AbortSignal): Promise<Observation | undefined> {
    const epoch = ++this.#epoch; this.#last = undefined;
    if (!(external instanceof AbortSignal) || external.aborted) return undefined;
    const deadline = new AbortController(), ms = this.#config.deadlineMs ?? 15_000, timer = setTimeout(() => deadline.abort(), ms);
    const signal = AbortSignal.any([external, deadline.signal]), started = performance.now();
    let responseOwned: Response | undefined, bodyOwned = false;
    try {
      const booking = freeze(structuredClone(input)), began = this.#now(), expires = approvalInstant(booking.expiresAt);
      if (!sameScope(booking.scope, this.#source.scope) || booking.businessId !== this.#source.businessId || booking.credentialFingerprint !== this.#source.credentialFingerprint ||
          ![booking.patientId, booking.practitionerId, booking.appointmentTypeId].every(validClinikoId) ||
          ![booking.callId, booking.sessionId, booking.policyVersion, booking.verificationRef, booking.offerRef].every(approvalRef) ||
          approvalInstant(booking.startsAt) === undefined || approvalInstant(booking.endsAt) === undefined || booking.endsAt <= booking.startsAt ||
          began === undefined || expires === undefined || expires <= began || !["book", "classBook"].includes(booking.bookingKind) ||
          booking.bookingKind === "classBook" && !validClinikoId(booking.classSessionId)) return undefined;
      const query = freeze({ purpose: "bookingPaymentRecipient" as const, source: this.#source, booking });
      const active = () => !signal.aborted && performance.now() - started <= ms;
      const wait = async <T>(task: Promise<T>): Promise<T | undefined> => { const found = await awaitUntilAbort(task, signal); return active() ? found : undefined; };
      const permit = async () => await wait(Promise.resolve().then(() => this.#authority.allows(query, signal))) === true;
      if (!await permit()) return undefined;
      const quota = await wait(claimClinikoBudget(this.#config.rateBudget));
      if (quota !== null || !await permit() || !active() || this.#authority.current(query, signal) !== true) return undefined;
      const dispatchAt = this.#now();
      if (dispatchAt === undefined || dispatchAt < began || dispatchAt >= expires) return undefined;
      const response = await wait(this.#fetch(`${this.#base}/patients/${booking.patientId}`, { method: "GET", redirect: "error", signal,
        headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${this.#config.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${this.#config.contactEmail})` }
      }).then(value => { responseOwned = value; if (signal.aborted) discard(value); return value; }));
      if (!response) return undefined;
      if (response.status === 429) { await wait(observeCliniko429(this.#config.rateBudget, response.headers.get("X-RateLimit-Reset"))); return undefined; }
      if (response.status !== 200) return undefined;
      bodyOwned = true;
      const bytes = await ownedBodyBytes(response.body, 1_000_000, signal);
      const row: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!object(row) || row.id !== booking.patientId || row.archived_at !== null || !mailbox(row.email) || !await permit()) return undefined;
      const end = this.#now();
      if (!active() || end === undefined || end < began || end >= expires || epoch !== this.#epoch || this.#authority.current(query, signal) !== true) return undefined;
      const observation = freeze({ recipient: { kind: "email" as const, address: row.email }, expiresAt: booking.expiresAt });
      this.#last = { selection: JSON.stringify(booking), query, observation, at: end }; return observation;
    } catch { return undefined; }
    finally { clearTimeout(timer); deadline.abort(); if (!bodyOwned) discard(responseOwned); }
  }
  /** Continuation only; current policy must still reread native contact before
   * each asynchronous host stage. It grants no representative contact rights. */
  currentForSend(selection: FinancialBookingSelection, recipient: Observation["recipient"], signal: AbortSignal): boolean {
    try {
      const last = this.#last, now = this.#now();
      return !!last && !signal.aborted && now !== undefined && now >= last.at && now < Date.parse(last.observation.expiresAt) &&
        JSON.stringify(selection) === last.selection && recipient.kind === "email" && recipient.address === last.observation.recipient.address &&
        this.#authority.current(last.query, signal) === true;
    } catch { return false; }
  }
}
