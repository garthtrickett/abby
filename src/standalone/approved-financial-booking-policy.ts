import type { FinancialBookingAssessment, FinancialBookingPolicy, FinancialBookingSelection } from "./cliniko-financial-booking-preparation.ts";
import type { ClinikoFinancialIntent } from "../cliniko/financial-review-intent.ts";
import { OwnerFileFinancialFeePolicy } from "./owner-file-financial-fee-policy.ts";
import { approvalInstant } from "./owner-file-clinic-approval.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";

/** Current registered patient recipient, admitted for this financial purpose.
 * Caller OTP, marketing flags and a shared mailbox cannot implement this grant. */
export type FinancialBookingRecipient = Readonly<{
  read(selection: FinancialBookingSelection, signal: AbortSignal): Promise<Readonly<{ recipient: ClinikoFinancialIntent["recipient"]; expiresAt: string }> | undefined>;
  currentForSend(selection: FinancialBookingSelection, recipient: ClinikoFinancialIntent["recipient"], signal: AbortSignal): boolean;
}>;
type Pending = { selection: string; assessment: string; approval: string; expiresAt: number; notBefore: number; checkedUntil: number; checkedAt: number; ready: boolean };
const key = (v: unknown) => JSON.stringify(v);
const mailbox = (v: unknown): v is string => typeof v === "string" && v.length <= 254 && /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(v);
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }

/** One call-private quote owner. Public file terms supply exact fee decisions;
 * the separate current native recipient port supplies no financial effect grant.
 * No local persistence, listener or consumer is started by construction. */
export class ApprovedFinancialBookingPolicy implements FinancialBookingPolicy {
  readonly #fees: OwnerFileFinancialFeePolicy;
  readonly #recipient: FinancialBookingRecipient;
  readonly #clock: () => string;
  #pending: Pending | undefined;
  #epoch = 0;
  constructor(config: Readonly<{ fees: OwnerFileFinancialFeePolicy; recipient: FinancialBookingRecipient; clock?: () => string }>) {
    if (!(config.fees instanceof OwnerFileFinancialFeePolicy) || typeof config.recipient?.read !== "function" ||
        typeof config.recipient.currentForSend !== "function" || config.clock !== undefined && typeof config.clock !== "function") throw new TypeError("Invalid financial booking policy");
    this.#fees = config.fees; this.#recipient = Object.freeze({ read: config.recipient.read.bind(config.recipient), currentForSend: config.recipient.currentForSend.bind(config.recipient) });
    this.#clock = config.clock?.bind(config) ?? (() => new Date().toISOString());
  }
  async quote(input: FinancialBookingSelection, signal: AbortSignal): Promise<FinancialBookingAssessment | undefined> {
    const epoch = ++this.#epoch; this.#pending = undefined;
    try {
      const selection = freeze(structuredClone(input)), began = approvalInstant(this.#clock()), offerEnd = approvalInstant(selection.expiresAt), start = approvalInstant(selection.startsAt);
      if (signal.aborted || began === undefined || offerEnd === undefined || start === undefined || offerEnd <= began || start <= began) return undefined;
      const found = await this.#fees.currentFor(selection, signal); if (!found.ok || !found.value) return undefined;
      const approval = found.value, terms = approval.terms;
      let assessment: FinancialBookingAssessment;
      if (terms.kind === "notRequired") assessment = { kind: "notRequired", version: terms.version,
        expiresAt: new Date(Math.min(offerEnd, Date.parse(approval.effectiveUntil))).toISOString() };
      else {
        const destination = await awaitUntilAbort(this.#recipient.read(selection, signal), signal);
        const until = destination && approvalInstant(destination.expiresAt), recipient = destination?.recipient;
        if (!recipient || recipient.kind !== "email" || !mailbox(recipient.address) || until === undefined || until <= began ||
            !this.#recipient.currentForSend(selection, recipient, signal)) return undefined;
        const deadlineMs = Math.floor((began + terms.paymentWindowMinutes * 60_000) / 1000) * 1000;
        // Preserve the approved window rather than silently shortening terms.
        // Native creation later rechecks its own >30min/<=24h requirement.
        if (deadlineMs > Date.parse(approval.effectiveUntil) || deadlineMs > start || deadlineMs - began <= 1_800_000 || deadlineMs - began > 86_400_000) return undefined;
        const deadline = new Date(deadlineMs).toISOString();
        const parts = new Intl.DateTimeFormat("en", { timeZone: selection.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(deadline));
        const part = (name: string) => parts.find(p => p.type === name)!.value;
        assessment = { kind: "required", payment: { amount: terms.amount, currency: terms.currency, policyVersion: terms.policyVersion, termsVersion: terms.termsVersion, deadline },
          recipient: { kind: "email", address: recipient.address }, approvedTerms: terms.approvedTerms,
          reviewDate: `${part("year")}-${part("month")}-${part("day")}`, expiresAt: new Date(Math.min(offerEnd, Date.parse(approval.effectiveUntil), until, deadlineMs - 1_800_000)).toISOString() };
      }
      const again = await this.#fees.currentFor(selection, signal), end = approvalInstant(this.#clock());
      if (!again.ok || !again.value || key(again.value) !== key(approval) || signal.aborted || epoch !== this.#epoch || end === undefined || end < began || end >= Date.parse(assessment.expiresAt) || assessment.kind === "required" && !this.#recipient.currentForSend(selection, assessment.recipient, signal)) return undefined;
      const result = freeze(assessment);
      this.#pending = { selection: key(selection), assessment: key(result), approval: key(approval), expiresAt: Date.parse(result.expiresAt), notBefore: began, checkedUntil: began, checkedAt: began, ready: false };
      return result;
    } catch { return undefined; }
  }
  async current(input: FinancialBookingSelection, raw: FinancialBookingAssessment, signal: AbortSignal): Promise<boolean> {
    const epoch = ++this.#epoch, pending = this.#pending; if (pending) pending.ready = false;
    try {
      const selection = freeze(structuredClone(input)), assessment = freeze(structuredClone(raw)), began = approvalInstant(this.#clock());
      if (!pending || signal.aborted || began === undefined || (began < pending.checkedAt || began >= pending.expiresAt) || key(selection) !== pending.selection || key(assessment) !== pending.assessment) return false;
      const found = await this.#fees.currentFor(selection, signal); if (!found.ok || !found.value || key(found.value) !== pending.approval) return false;
      let checkedUntil = pending.expiresAt;
      if (assessment.kind === "required") {
        const recipient = await awaitUntilAbort(this.#recipient.read(selection, signal), signal);
        if (!recipient || key(recipient.recipient) !== key(assessment.recipient) || approvalInstant(recipient.expiresAt) === undefined || Date.parse(recipient.expiresAt) <= began ||
            !this.#recipient.currentForSend(selection, assessment.recipient, signal)) return false;
        checkedUntil = Math.min(checkedUntil, Date.parse(recipient.expiresAt));
      }
      const again = await this.#fees.currentFor(selection, signal), end = approvalInstant(this.#clock());
      if (!again.ok || !again.value || key(again.value) !== pending.approval || signal.aborted || this.#pending !== pending || epoch !== this.#epoch ||
          end === undefined || end < began || end >= checkedUntil || assessment.kind === "required" && !this.#recipient.currentForSend(selection, assessment.recipient, signal)) return false;
      pending.checkedAt = end; pending.checkedUntil = checkedUntil; pending.ready = true; return true;
    } catch { return false; }
  }
  /** Synchronous continuation fence after current(). It performs no fresh file
   * or native read; each async host stage must still call current(). */
  currentForSend(selection: FinancialBookingSelection, assessment: FinancialBookingAssessment, signal: AbortSignal): boolean {
    try {
      const pending = this.#pending, now = approvalInstant(this.#clock());
      return !!pending?.ready && !signal.aborted && now !== undefined && now >= pending.checkedAt && now < pending.checkedUntil && key(selection) === pending.selection && key(assessment) === pending.assessment &&
        (assessment.kind === "notRequired" || this.#recipient.currentForSend(selection, assessment.recipient, signal));
    } catch { return false; }
  }
}
