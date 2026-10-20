import { ClinikoFinancialReviewReader } from "../cliniko/financial-review-read.ts";
import type { ClinikoFinancialReviewContext, ClinikoFinancialReviewSelection } from "../cliniko/financial-review-read.ts";
import { ClinikoFinancialRecordRetainer, financialRecordOwnerBinding } from "../cliniko/financial-record-retention.ts";
import type { FinancialRecordRetentionConfig, FinancialRecordAuthority, FinancialBookingObservationContext } from "../cliniko/financial-record-retention.ts";
import type { FinancialCheckoutAttempt } from "../cliniko/financial-checkout-attempt.ts";
import type { FinancialEffectBarrier } from "./financial-effect-barrier.ts";
import { financialSelection } from "../cliniko/internal/financial-record-context.ts";
import { ClinikoFinancialWorkDiscovery } from "../cliniko/financial-work-discovery.ts";
import type { FinancialDiscoveryAccountQuery } from "../cliniko/financial-work-discovery.ts";
import { validRecallMarker } from "../cliniko/recall-note.ts";

export type FinancialLifecycleBinding = Readonly<{
  intentRecallRef: string; financialActionRef: string; observationRecallRef: string; observationActionRef: string;
  checkoutAttemptRecallRef: string; checkoutAttemptActionRef: string; checkoutRef: string;
}>;
export type FinancialLifecycleSources = Readonly<{
  intent: ClinikoFinancialReviewContext; booking: FinancialBookingObservationContext;
  creation: Readonly<{ recallRef: string; recalled: boolean; archivedAt: string | null; attempt: FinancialCheckoutAttempt }>;
}>;
export type FinancialLifecycleSourceQuery = ClinikoFinancialReviewSelection & Readonly<{
  purpose: "financialLifecycleSource"; operation: "checkoutExpiry" | "clinicalExpiry"; ownerBinding: string;
  binding: FinancialLifecycleBinding; record: Readonly<{ recallRef: string; actionRef: string; includeArchived: boolean }>;
}>;
export type FinancialLifecycleSourceAuthority = Readonly<{
  allows(query: FinancialLifecycleSourceQuery, signal: AbortSignal): Promise<boolean>;
  allowsHistory(query: FinancialDiscoveryAccountQuery, signal: AbortSignal): Promise<boolean>;
  current(query: FinancialLifecycleSourceQuery | FinancialDiscoveryAccountQuery, signal: AbortSignal): boolean;
}>;
export type FinancialLifecycleOperation = Readonly<{ signal: AbortSignal; wait<T>(task: Promise<T>): Promise<T> }>;
export function freezeFinancialContext<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freezeFinancialContext(child); Object.freeze(value); }
  return value;
}
export function validFinancialLifecycleBinding(b: FinancialLifecycleBinding): boolean {
  return !!b && Object.keys(b).sort().join(",") === "checkoutAttemptActionRef,checkoutAttemptRecallRef,checkoutRef,financialActionRef,intentRecallRef,observationActionRef,observationRecallRef" &&
    [b.intentRecallRef, b.observationRecallRef, b.checkoutAttemptRecallRef].every(v => typeof v === "string" && /^cliniko:recall:[1-9][0-9]{0,18}$/.test(v)) &&
    new Set([b.intentRecallRef, b.observationRecallRef, b.checkoutAttemptRecallRef]).size === 3 &&
    [b.financialActionRef, b.observationActionRef, b.checkoutAttemptActionRef].every(validRecallMarker) &&
    new Set([b.financialActionRef, b.observationActionRef, b.checkoutAttemptActionRef]).size === 3 &&
    typeof b.checkoutRef === "string" && /^cs_(?:test_|live_)?[A-Za-z0-9]{1,200}$/.test(b.checkoutRef);
}
export function financialLifecycleSourceData(s: FinancialLifecycleSources) {
  const { observedAt: _readAt, ...intent } = s.intent; return { ...s, intent };
}

/** Private common source/history seam for expiry owners. Nothing here supplies
 * money, clinical authority or permission to send an effect. Every actual
 * native read still uses the configured shared physical-account budget. */
export class FinancialLifecycleSourceReader {
  readonly records: ClinikoFinancialRecordRetainer;
  readonly #config: FinancialRecordRetentionConfig;
  readonly #authority: FinancialLifecycleSourceAuthority;
  readonly #native: typeof fetch;
  readonly #selection: ClinikoFinancialReviewSelection;
  readonly #binding: string;
  constructor(config: FinancialRecordRetentionConfig, authority: FinancialLifecycleSourceAuthority,
    recordsAuthority: FinancialRecordAuthority, barrier: FinancialEffectBarrier, native: typeof fetch) {
    const owner = financialRecordOwnerBinding(config), records = ClinikoFinancialRecordRetainer.create(config, recordsAuthority, barrier, native);
    if (!owner.ok || !records.ok || [authority?.allows, authority?.allowsHistory, authority?.current].some(v => typeof v !== "function"))
      throw new TypeError("Invalid financial source reader");
    this.#selection = financialSelection(config); this.#config = Object.freeze({ ...config, scope: this.#selection.scope,
      stripe: this.#selection.stripe, producer: Object.freeze({ ...config.producer }) });
    this.records = records.value; this.#binding = owner.value; this.#native = native;
    this.#authority = Object.freeze({ allows: authority.allows.bind(authority), allowsHistory: authority.allowsHistory.bind(authority), current: authority.current.bind(authority) });
  }
  #query(binding: FinancialLifecycleBinding, operation: FinancialLifecycleSourceQuery["operation"], recallRef: string, actionRef: string, includeArchived = false) {
    return freezeFinancialContext({ ...this.#selection, ownerBinding: this.#binding, purpose: "financialLifecycleSource" as const,
      operation, binding, record: { recallRef, actionRef, includeArchived } });
  }
  async #permit(q: FinancialLifecycleSourceQuery, op: FinancialLifecycleOperation): Promise<boolean> {
    if (await op.wait(Promise.resolve().then(() => this.#authority.allows(q, op.signal))) !== true || this.#authority.current(q, op.signal) !== true)
      throw new Error("Financial source forbidden"); return true;
  }
  async read(b: FinancialLifecycleBinding, operation: FinancialLifecycleSourceQuery["operation"], op: FinancialLifecycleOperation): Promise<FinancialLifecycleSources> {
    if (!validFinancialLifecycleBinding(b)) throw new Error("Invalid financial source");
    const grant = this.#query(b, operation, b.intentRecallRef, b.financialActionRef);
    const reader = ClinikoFinancialReviewReader.create(this.#config, { allows: q =>
      q.recallRef === b.intentRecallRef && q.actionRef === b.financialActionRef && !q.includeArchived ? this.#permit(grant, op) : Promise.resolve(false) }, this.#native);
    if (!reader.ok) throw new Error("Financial source unavailable");
    const intent = await op.wait(reader.value.read({ recallRef: b.intentRecallRef, actionRef: b.financialActionRef }, op.signal));
    if (!intent.ok || intent.value.recalled || intent.value.archivedAt !== null) throw new Error("Financial source forbidden");
    const bookingGrant = this.#query(b, operation, b.observationRecallRef, b.observationActionRef); await this.#permit(bookingGrant, op);
    const booking = await op.wait(this.records.readBookingObservation({ recallRef: b.observationRecallRef, actionRef: b.observationActionRef,
      intentRecallRef: b.intentRecallRef }, intent.value.intent, op.signal)); await this.#permit(bookingGrant, op);
    if (!booking.ok || booking.value.recalled || booking.value.archivedAt !== null) throw new Error("Financial source forbidden");
    const creationGrant = this.#query(b, operation, b.checkoutAttemptRecallRef, b.checkoutAttemptActionRef); await this.#permit(creationGrant, op);
    const creation = await op.wait(this.records.readCheckoutAttempt({ recallRef: b.checkoutAttemptRecallRef, actionRef: b.checkoutAttemptActionRef,
      intentRecallRef: b.intentRecallRef }, intent.value.intent, op.signal)); await this.#permit(creationGrant, op);
    if (!creation.ok || creation.value.recalled || creation.value.archivedAt !== null || creation.value.attempt.actionRef !== b.checkoutAttemptActionRef ||
        creation.value.attempt.observationRecallRef !== b.observationRecallRef || creation.value.attempt.observationActionRef !== b.observationActionRef ||
        creation.value.attempt.targetRef !== booking.value.observation.targetRef) throw new Error("Financial source mismatched");
    await this.#permit(grant, op);
    return freezeFinancialContext({ intent: intent.value, booking: booking.value, creation: creation.value });
  }
  async history(b: FinancialLifecycleBinding, operation: FinancialLifecycleSourceQuery["operation"], sources: FinancialLifecycleSources,
    now: string, op: FinancialLifecycleOperation) {
    const discovery = ClinikoFinancialWorkDiscovery.create(this.#config, {
      allowsAccountRead: async q => await op.wait(Promise.resolve().then(() => this.#authority.allowsHistory(q, op.signal))) === true && this.#authority.current(q, op.signal) === true,
      allowsRecordRead: q => this.#permit(this.#query(b, operation, q.recallRef, q.actionRef, true), op),
      current: q => this.#authority.current("recallRef" in q ? this.#query(b, operation, q.recallRef, q.actionRef, true) : q, op.signal),
    }, this.#native);
    if (!discovery.ok) throw new Error("Financial history unavailable");
    const found = await op.wait(discovery.value.scanPatient({ patientId: sources.intent.intent.patientId,
      createdFrom: new Date(Math.min(Date.parse(sources.intent.intent.createdAt), Date.parse(sources.intent.createdAt)) - 30_000).toISOString(),
      createdThrough: new Date(Date.parse(now) + 30_000).toISOString() }, op.signal));
    if (!found.ok) throw new Error("Financial history unavailable");
    return found.value;
  }
}
