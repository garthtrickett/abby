import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ClinikoFinancialInvoiceReader } from "../cliniko/financial-invoice-read.ts";
import type { FinancialInvoiceAuthority, FinancialInvoiceBinding } from "../cliniko/financial-invoice-read.ts";
import { ClinikoFinancialWaiverReader } from "../cliniko/financial-waiver-read.ts";
import type { FinancialWaiverBinding, FinancialWaiverReadAuthority } from "../cliniko/financial-waiver-read.ts";
import type { ClinikoFinancialIntent } from "../cliniko/financial-review-intent.ts";
import { encodeClinikoFinancialIntent } from "../cliniko/financial-review-intent.ts";
import { financialRecordInstant, financialSelection } from "../cliniko/internal/financial-record-context.ts";
import type { ClinikoFinancialReviewConfig } from "../cliniko/financial-review-read.ts";
import { financialIntentDigest } from "../cliniko/financial-booking-observation.ts";
import { sameScope } from "./appointment-change-authority.ts";
import type { ApprovedFinancialWaiverIssuer } from "./approved-financial-waiver-issuer.ts";

export type FinancialSettlementPurpose = "collect" | "sendLink" | "expireCheckout" | "cancelClinical";
export type FinancialSettlementContext = Readonly<{ intent: ClinikoFinancialIntent; intentRecallRef: string; targetRef: string }>;
export type FinancialSettlementBindings = Readonly<{ targetRef: string; invoice: FinancialInvoiceBinding; waiver?: FinancialWaiverBinding }>;
/** The current clinic owner supplies an exact approved invoice/target mapping.
 * Missing waiver selection means unknown, not no waiver. The separate existing
 * effect grant must still establish complete manual-payment/waiver decisions. */
export type FinancialSettlementBindingSource = Readonly<{
  resolve(context: FinancialSettlementContext, purpose: FinancialSettlementPurpose, signal: AbortSignal): Promise<FinancialSettlementBindings | undefined>;
  current(context: FinancialSettlementContext, purpose: FinancialSettlementPurpose, binding: FinancialSettlementBindings, signal: AbortSignal): boolean;
}>;
type Ports = Readonly<{
  bindings: FinancialSettlementBindingSource; invoices: FinancialInvoiceAuthority;
  waivers?: Readonly<{ config: ClinikoFinancialReviewConfig; issuer: ApprovedFinancialWaiverIssuer; authority: FinancialWaiverReadAuthority }>;
  native?: typeof fetch;
}>;
type Failure = Readonly<{ kind: "unavailable" }>;
function freeze<T>(v: T): T { if (v && typeof v === "object") { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } return v; }

/** Concrete fresh native evidence composed with, never in place of, existing
 * financial grants. It does not derive outstanding money from an open invoice
 * or absence of a selected waiver, change an amount, cache a private decision,
 * reserve quota, or provide permission to replay a financial/clinical effect. */
export class ClinikoFinancialSettlementReview {
  readonly #config: ClinikoFinancialReviewConfig;
  readonly #bindings: FinancialSettlementBindingSource;
  readonly #invoices: ClinikoFinancialInvoiceReader;
  readonly #waivers: ClinikoFinancialWaiverReader | undefined;
  private constructor(config: ClinikoFinancialReviewConfig, bindings: FinancialSettlementBindingSource, invoices: ClinikoFinancialInvoiceReader,
    waivers: ClinikoFinancialWaiverReader | undefined) {
    const selection = financialSelection(config);
    this.#config = Object.freeze({ ...config, scope: selection.scope, stripe: selection.stripe,
      ...(config.clock ? { clock: config.clock.bind(config) } : {}) });
    this.#bindings = Object.freeze({ resolve: bindings.resolve.bind(bindings), current: bindings.current.bind(bindings) });
    this.#invoices = invoices; this.#waivers = waivers;
  }
  static create(config: ClinikoFinancialReviewConfig, ports: Ports): Result<ClinikoFinancialSettlementReview, Failure> {
    try {
      if (typeof ports?.bindings?.resolve !== "function" || typeof ports.bindings.current !== "function") return err({ kind: "unavailable" });
      const invoices = ClinikoFinancialInvoiceReader.create(config, ports.invoices, ports.native);
      const selected = ports.waivers;
      if (selected && (!sameScope(config.scope, selected.config.scope) || config.apiKey !== selected.config.apiKey || config.businessId !== selected.config.businessId ||
          config.rateBudget !== selected.config.rateBudget || config.stripe.accountRef !== selected.config.stripe.accountRef || config.stripe.livemode !== selected.config.stripe.livemode)) return err({ kind: "unavailable" });
      const waivers = selected ? ClinikoFinancialWaiverReader.create(selected.config, selected.issuer, selected.authority, ports.native) : undefined;
      return invoices.ok && (!waivers || waivers.ok) ? ok(new ClinikoFinancialSettlementReview(config, ports.bindings, invoices.value, waivers?.value)) : err({ kind: "unavailable" });
    } catch { return err({ kind: "unavailable" }); }
  }
  matches(config: ClinikoFinancialReviewConfig): boolean {
    try {
      const actual = financialSelection(config), wanted = financialSelection(this.#config);
      return sameScope(actual.scope, wanted.scope) && actual.businessId === wanted.businessId && actual.credentialFingerprint === wanted.credentialFingerprint &&
        actual.recallTypeId === wanted.recallTypeId && actual.stripe.accountRef === wanted.stripe.accountRef && actual.stripe.livemode === wanted.stripe.livemode &&
        config.rateBudget === this.#config.rateBudget;
    } catch { return false; }
  }
  /** Grant/current closures retain the owning protocol's original query,
   * receiver and signal. Their complete financial authority is never inferred
   * from the context or from these native observations. */
  async allows(input: FinancialSettlementContext, purpose: FinancialSettlementPurpose, external: AbortSignal,
    independentGrant: () => Promise<boolean>, independentCurrent: () => boolean): Promise<boolean> {
    if (!(external instanceof AbortSignal) || external.aborted) return false;
    const controller = new AbortController(), ms = this.#config.deadlineMs ?? 15_000, timer = setTimeout(() => controller.abort(), ms);
    const signal = AbortSignal.any([external, controller.signal]), start = performance.now();
    try {
      const context = freeze(structuredClone(input)), i = context.intent, source = financialSelection(this.#config);
      const began = financialRecordInstant(this.#config.clock?.() ?? new Date().toISOString());
      if (!began || !encodeClinikoFinancialIntent(i).ok || !sameScope(i.scope, source.scope) || i.businessId !== source.businessId ||
          i.credentialFingerprint !== source.credentialFingerprint || i.stripe.accountRef !== source.stripe.accountRef || i.stripe.livemode !== source.stripe.livemode ||
          !/^cliniko:recall:[1-9][0-9]{0,18}$/.test(context.intentRecallRef) ||
          !/^cliniko:(?:appointment|attendee):[1-9][0-9]{0,18}$/.test(context.targetRef) ||
          !context.targetRef.startsWith(i.booking.kind === "book" ? "cliniko:appointment:" : "cliniko:attendee:") ||
          !["collect", "sendLink", "expireCheckout", "cancelClinical"].includes(purpose)) return false;
      const active = () => {
        const now = financialRecordInstant(this.#config.clock?.() ?? new Date().toISOString());
        return !!now && now >= began && !signal.aborted && performance.now() - start <= ms && independentCurrent() === true;
      };
      const wait = async <T>(task: Promise<T>) => { const value = await awaitUntilAbort(task, signal); return active() ? value : undefined; };
      if (!active() || await wait(Promise.resolve().then(independentGrant)) !== true) return false;
      const candidate = await wait(this.#bindings.resolve(context, purpose, signal)); if (!candidate) return false;
      const binding = freeze(structuredClone(candidate));
      const keys = Object.keys(binding).sort().join(","), invoice = binding.invoice, waiver = binding.waiver;
      if ((keys !== "invoice,targetRef" && keys !== "invoice,targetRef,waiver") || binding.targetRef !== context.targetRef ||
          invoice.financialActionRef !== i.actionRef || invoice.patientId !== i.patientId || invoice.bookingKind !== i.booking.kind || invoice.currency !== i.payment.currency ||
          i.booking.kind === "classBook" && context.targetRef !== `cliniko:attendee:${invoice.attendeeId}` ||
          !this.#bindings.current(context, purpose, binding, signal)) return false;
      if (waiver && (!this.#waivers || financialIntentDigest(waiver.intent) !== financialIntentDigest(i) || waiver.intentRecallRef !== context.intentRecallRef ||
          waiver.targetRef !== context.targetRef)) return false;
      const observed = await wait(this.#invoices.read(invoice, signal));
      if (!observed?.ok || !this.#bindings.current(context, purpose, binding, signal)) return false;
      // Closing an old payment link is a separate independently approved
      // consequence; it does not mean unpaid or permit clinical cancellation.
      if (purpose !== "expireCheckout" && observed.value.state !== "open") return false;
      if (waiver) {
        const decision = await wait(this.#waivers!.read(waiver, signal));
        if (!decision?.ok || !this.#bindings.current(context, purpose, binding, signal)) return false;
        // The existing immutable Checkout amount cannot silently become the
        // balance after a partial waiver; fresh terms/quote are needed instead.
        if (purpose !== "expireCheckout") return false;
      }
      return active() && this.#bindings.current(context, purpose, binding, signal) === true;
    } catch { return false; }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
