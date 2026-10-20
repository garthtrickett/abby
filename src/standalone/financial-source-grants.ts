import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { financialRecordOwnerBinding } from "../cliniko/financial-record-retention.ts";
import type { FinancialRecordAuthority, FinancialRecordRetentionConfig, FinancialRecordQuery } from "../cliniko/financial-record-retention.ts";
import type { ClinikoFinancialReviewPermission, ClinikoFinancialReviewSelection } from "../cliniko/financial-review-read.ts";
import type { FinancialPendingAuthority, FinancialPendingAccountQuery } from "../cliniko/financial-pending-discovery.ts";
import type { FinancialDiscoveryAuthority, FinancialDiscoveryAccountQuery, FinancialDiscoveryRecordQuery } from "../cliniko/financial-work-discovery.ts";
import { OwnerFileFinancialSource, financialSourceSelection } from "./owner-file-financial-source.ts";
import type { FinancialContentPolicy } from "./owner-file-financial-source.ts";
import { sameScope } from "./appointment-change-authority.ts";

export type FinancialNativeGrants = Readonly<{
  review: ClinikoFinancialReviewPermission;
  records: FinancialRecordAuthority;
  pending: FinancialPendingAuthority;
  history: FinancialDiscoveryAuthority;
}>;

/** Compose current source definition with, never in place of, independently
 * supplied exact-patient/record, collection and producer grants. Native owners
 * retain their own validation, budgets, final permits and known-result rules. */
export function bindFinancialSourceGrants(config: FinancialRecordRetentionConfig, contentPolicy: FinancialContentPolicy,
  definition: OwnerFileFinancialSource, independent: FinancialNativeGrants): Result<FinancialNativeGrants, Readonly<{ kind: "unavailable" }>> {
  try {
    const selected = financialSourceSelection(config, contentPolicy), owner = financialRecordOwnerBinding(config);
    if (!selected.ok || !owner.ok || !(definition instanceof OwnerFileFinancialSource) ||
        [independent?.review?.allows, independent?.records?.allows, independent?.records?.producerAdmitted, independent?.records?.current,
          independent?.pending?.allowsPendingRead, independent?.pending?.allowsRecordRead, independent?.pending?.current,
          independent?.history?.allowsAccountRead, independent?.history?.allowsRecordRead, independent?.history?.current].some(v => typeof v !== "function"))
      return err({ kind: "unavailable" });
    const selection = selected.value, currentSource = definition.currentFor.bind(definition), deadlineMs = config.deadlineMs ?? 15_000;
    const matches = (query: ClinikoFinancialReviewSelection): boolean => {
      try {
        return sameScope(query.scope, selection.scope) && query.businessId === selection.businessId &&
          query.credentialFingerprint === selection.credentialFingerprint && query.recallTypeId === selection.recallTypeId &&
          query.stripe.accountRef === selection.stripe.accountRef && query.stripe.livemode === selection.stripe.livemode &&
          (!("ownerBinding" in query) || query.ownerBinding === owner.value);
      } catch { return false; }
    };
    // A source approval includes independently provisioned admin lookups. Do not
    // inherit an upstream callback's native ceiling across those extra calls.
    // The host may declare a reviewed cost for the complete composed port.
    const wrap = <Q extends ClinikoFinancialReviewSelection>(grant: (q: Q, signal: AbortSignal) => Promise<boolean>) =>
      async (query: Q, external: AbortSignal): Promise<boolean> => {
        if (!(external instanceof AbortSignal) || external.aborted || !matches(query)) return false;
        const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), deadlineMs), began = performance.now();
        const signal = AbortSignal.any([external, deadline.signal]);
        const sourceCurrent = async () => {
          const found = await awaitUntilAbort(Promise.resolve().then(() => currentSource(selection, signal)), signal);
          return found?.ok === true && found.value === true && !signal.aborted && performance.now() - began <= deadlineMs;
        };
        try {
          if (!await sourceCurrent()) return false;
          // Preserve the owning adapter's operation context for grants whose
          // synchronous current check is bound to that same signal. The inner
          // deadline bounds this observation, never proves upstream quiescence.
          const permitted = await awaitUntilAbort(Promise.resolve().then(() => grant(query, external)), signal);
          return permitted === true && matches(query) && await sourceCurrent();
        } catch { return false; }
        finally { clearTimeout(timer); deadline.abort(); }
      };
    const bind = <Q>(method: (q: Q, signal: AbortSignal) => Promise<boolean>, context: object) =>
      method.bind(context);
    const recordsCurrent = independent.records.current.bind(independent.records), pendingCurrent = independent.pending.current.bind(independent.pending),
      historyCurrent = independent.history.current.bind(independent.history);
    return ok(Object.freeze({
      review: Object.freeze({ allows: wrap(bind(independent.review.allows, independent.review)) }),
      records: Object.freeze({ allows: wrap(bind(independent.records.allows, independent.records)),
        producerAdmitted: wrap(bind(independent.records.producerAdmitted, independent.records)),
        current: (q: FinancialRecordQuery, signal: AbortSignal) => !signal.aborted && matches(q) && recordsCurrent(q, signal) === true }),
      pending: Object.freeze({ allowsPendingRead: wrap(bind(independent.pending.allowsPendingRead, independent.pending)),
        allowsRecordRead: wrap(bind(independent.pending.allowsRecordRead, independent.pending)),
        current: (q: FinancialPendingAccountQuery | FinancialDiscoveryRecordQuery, signal: AbortSignal) => !signal.aborted && matches(q) && pendingCurrent(q, signal) === true }),
      history: Object.freeze({ allowsAccountRead: wrap(bind(independent.history.allowsAccountRead, independent.history)),
        allowsRecordRead: wrap(bind(independent.history.allowsRecordRead, independent.history)),
        current: (q: FinancialDiscoveryAccountQuery | FinancialDiscoveryRecordQuery, signal: AbortSignal) => !signal.aborted && matches(q) && historyCurrent(q, signal) === true }),
    }));
  } catch { return err({ kind: "unavailable" }); }
}
