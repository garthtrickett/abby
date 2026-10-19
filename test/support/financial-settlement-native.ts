import assert from "node:assert/strict";
import { financialSourceApprovalFixture } from "./financial-source-approval.ts";
import { waiverFixture, issuerKey } from "./financial-waiver.ts";
import { base, value, stop } from "./financial-retention.ts";
import { financialIntentDigest } from "../../src/cliniko/financial-booking-observation.ts";
import { OwnerFileFinancialSource, financialSourceSelection } from "../../src/standalone/owner-file-financial-source.ts";
import { ApprovedFinancialWaiverIssuer, financialWaiverContentPolicy } from "../../src/standalone/approved-financial-waiver-issuer.ts";
import { ClinikoFinancialSettlementReview } from "../../src/standalone/cliniko-financial-settlement-review.ts";
import type { FinancialSettlementContext } from "../../src/standalone/cliniko-financial-settlement-review.ts";
import type { ClinikoFinancialReviewConfig } from "../../src/cliniko/financial-review-read.ts";
import type { ClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";

/** Synthetic independently selected exact native mapping and current signed
 * waiver source. This is evidence for consumer composition, not a deployed
 * clinic manual-payment policy or absence-of-waiver decision. */
export async function settlementNative(config: ClinikoFinancialReviewConfig, intent: ClinikoFinancialIntent, transport: typeof fetch,
  runtime = { ClinikoFinancialSettlementReview, OwnerFileFinancialSource, ApprovedFinancialWaiverIssuer }) {
  const signed = waiverFixture(), source = await financialSourceApprovalFixture();
  try {
    source.state.now = config.clock!();
    source.state.account = { ...source.state.account!, actor: { ...source.state.account!.actor, scope: intent.scope } };
    const waiverConfig = { ...config, recallTypeId: "49" };
    const selection = value(financialSourceSelection({ ...waiverConfig, producer: issuerKey }, financialWaiverContentPolicy));
    const { scope: _scope, ...selected } = selection;
    await source.replace({ scope: intent.scope, source: selected });
    const definition = value(await runtime.OwnerFileFinancialSource.capture({ ...source.config, scope: intent.scope }, stop()));
    const issuer = value(runtime.ApprovedFinancialWaiverIssuer.create(waiverConfig, issuerKey, definition));
    const targetRef = intent.booking.kind === "book" ? "cliniko:appointment:91" : "cliniko:attendee:91";
    const decision = { ...signed.decision, financialActionRef: intent.actionRef, intentDigest: financialIntentDigest(intent)!, targetRef,
      amount: intent.payment.amount, currency: intent.payment.currency };
    const state = { status: 10, invoiceReads: 0, waiverReads: 0, waived: false, live: true, changeAfterInvoice: 0, waiverAmount: intent.payment.amount };
    const native: typeof fetch = async (input, init) => {
      if (String(input) === `${base}/invoices/72`) {
        assert.equal(init?.method, "GET"); state.invoiceReads++;
        if (state.changeAfterInvoice && state.invoiceReads >= state.changeAfterInvoice) state.status = 20;
        return Response.json({ id: "72", links: { self: `${base}/invoices/72` }, patient: { links: { self: `${base}/patients/${intent.patientId}` } },
          business: { links: { self: `${base}/businesses/${intent.businessId}` } }, booking: { links: { self: `${base}/bookings/91` } },
          ...(intent.booking.kind === "classBook" ? { attendee: { links: { self: `${base}/attendees/91` } } } : {}),
          total_amount: (intent.payment.amount / 100).toFixed(2), status: state.status, archived_at: null, deleted_at: null,
          created_at: intent.createdAt, updated_at: intent.createdAt });
      }
      if (String(input) === `${base}/recalls/71`) {
        assert.equal(init?.method, "GET"); state.waiverReads++;
        return Response.json({ id: "71", links: { self: `${base}/recalls/71` }, patient: { links: { self: `${base}/patients/${intent.patientId}` } },
          recall_type: { links: { self: `${base}/recall_types/49` } }, notes: signed.format({ ...decision, amount: state.waiverAmount }), recalled: false, recalled_at: null,
          archived_at: null, recall_at: "2026-11-02", created_at: decision.approvedAt, updated_at: decision.approvedAt });
      }
      return transport(input, init);
    };
    const resolve = async (context: FinancialSettlementContext) => ({ targetRef: context.targetRef, invoice: {
      financialActionRef: intent.actionRef, invoiceRef: "72", patientId: intent.patientId, bookingId: "91", bookingKind: intent.booking.kind,
      ...(intent.booking.kind === "classBook" ? { attendeeId: "91" } : {}), expectedTotalMinor: intent.payment.amount,
      currency: intent.payment.currency, expiresAt: new Date(Date.parse(config.clock!()) + 60_000).toISOString() },
      ...(state.waived ? { waiver: { intent, intentRecallRef: context.intentRecallRef, targetRef: context.targetRef,
        waiverRecallRef: "cliniko:recall:71", decisionRef: decision.actionRef } } : {}) });
    const review = value(runtime.ClinikoFinancialSettlementReview.create(config, { bindings: { resolve, current: () => state.live },
      invoices: { allows: async () => true, current: () => state.live },
      waivers: { config: waiverConfig, issuer, authority: { allows: async () => true, current: () => state.live } }, native }));
    return { review, native, state, close: source.close };
  } catch (error) { await source.close(); throw error; }
}
