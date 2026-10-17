import assert from "node:assert/strict";
import { checkoutFixture, value, now, stop } from "./financial-checkout-owner.ts";
import { decodeFinancialCheckoutAttempt } from "../../src/cliniko/financial-checkout-attempt.ts";
import { ClinikoFinancialMessageOwner } from "../../src/standalone/cliniko-financial-message-owner.ts";
import type { FinancialMessageAuthority, FinancialMessageBinding, FinancialMessageQuery } from "../../src/standalone/cliniko-financial-message-owner.ts";
import type { FinancialMail, FinancialMessageDelivery } from "../../src/standalone/smtp-financial-message-delivery.ts";
import type { FinancialMessagePurpose } from "../../src/cliniko/financial-message-attempt.ts";

export async function financialMessageFixture(options: { checkout?: Parameters<typeof checkoutFixture>[0];
  authority?: Partial<FinancialMessageAuthority>; send?: FinancialMessageDelivery["send"]; deadlineMs?: number } = {}) {
  const response = options.checkout?.native?.response;
  const f = await checkoutFixture({ ...options.checkout, native: { ...options.checkout?.native, response: async (row, method) => {
    if (method === "POST") row.recalled_at = null;
    return response ? response(row, method) : Response.json(row, { status: method === "POST" ? 201 : 200 });
  } } });
  const created = value(await f.owner.createOnce(f.binding, stop()));
  for (const row of f.rows.values()) row.recalled_at = null;
  const possible = value(decodeFinancialCheckoutAttempt(f.rows.get("32")!.notes));
  const messageBinding: FinancialMessageBinding = { intentRecallRef: f.binding.intentRecallRef, financialActionRef: f.binding.financialActionRef,
    observationRecallRef: f.binding.observationRecallRef, observationActionRef: f.binding.observationActionRef,
    checkoutAttemptRecallRef: created.attemptRecallRef, checkoutAttemptActionRef: possible.actionRef, checkoutRef: "cs_test_owner" };
  let source = true, history = true, allowed = true, admitted = true, live = true;
  let approvedCheckout: string | undefined = created.kind === "created" ? created.checkoutRef : undefined;
  let approvedRecipient = f.intent.recipient.address;
  let selected = { sender: "clinic@example.test", template: "clinicFinancial.v1" as const, timeZone: "Australia/Sydney" };
  const messages: { mail: FinancialMail; ref: string }[] = [], queries: FinancialMessageQuery[] = [], nativeCalls: { url: URL; method: string }[] = [], stripeReads: URL[] = [];
  const nativePort: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET"; nativeCalls.push({ url, method });
    if (method === "GET" && url.pathname === "/v1/recalls") {
      const filters = url.searchParams.getAll("q[]"), after = filters.find(v => v.startsWith("created_at:>="))?.slice(13), before = filters.find(v => v.startsWith("created_at:<="))?.slice(13);
      const patient = filters.find(v => v.startsWith("patient_id:="))?.slice(12);
      const rows = [...f.rows.values()].filter(r => (!after || String(r.created_at) >= after) && (!before || String(r.created_at) <= before) &&
        (!patient || (r.patient as { links: { self: string } }).links.self.endsWith(`/patients/${patient}`)) &&
        (!filters.includes("recalled_at:!?") || r.recalled_at === null) && (!filters.includes("archived_at:!?") || r.archived_at === null)).sort((a, b) => Number(a.id) - Number(b.id));
      const page = Number(url.searchParams.get("page")); return Response.json({ total_entries: rows.length, recalls: rows.slice((page - 1) * 100, page * 100) });
    }
    return f.nativePort(input, init);
  };
  const stripePort: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); stripeReads.push(url); assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
    const headers = new Headers(init.headers); assert.equal(headers.get("Stripe-Version"), f.config.stripe.apiVersion); assert.equal(headers.get("Stripe-Account"), f.config.stripe.accountRef);
    assert.ok(url.pathname === "/v1/account" || url.pathname === "/v1/checkout/sessions/cs_test_owner");
    return Response.json(url.pathname === "/v1/account" ? { object: "account", id: f.config.stripe.accountRef } : f.sessions[0]);
  };
  const delivery: FinancialMessageDelivery = { selection: () => selected, send: options.send ?? (async (mail, signal, ref) => {
    assert.equal(signal.aborted, false); messages.push({ mail: structuredClone(mail), ref }); return { kind: "accepted", messageRef: ref };
  }) };
  const authority: FinancialMessageAuthority = { sourceAuthorized: async () => source, attemptScanAuthorized: async () => history,
    // Known actual creation ACK or an independent, explicit recovered approval;
    // a metadata/session read cannot write either approval variable.
    providerBindingAuthorized: async q => q.binding.checkoutRef === approvedCheckout,
    messageAuthorized: async q => { queries.push(q); return allowed && q.message.email === approvedRecipient; },
    producerAdmitted: async () => admitted, current: () => live, ...options.authority };
  const config = { cliniko: f.config.cliniko, stripe: f.config.stripe, ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }) };
  const make = () => ClinikoFinancialMessageOwner.create(config, authority, f.authority, f.barrier, delivery, nativePort, stripePort);
  const owner = value(make());
  const paid = () => {
    const row = f.sessions[0]!; row.status = "complete"; row.payment_status = "paid"; row.url = null;
    row.payment_intent = { object: "payment_intent", id: "pi_message", livemode: false, amount: f.intent.payment.amount,
      amount_received: f.intent.payment.amount, currency: f.intent.payment.currency, status: "succeeded",
      latest_charge: { object: "charge", id: "ch_message", payment_intent: "pi_message", livemode: false,
        amount: f.intent.payment.amount, amount_captured: f.intent.payment.amount, currency: f.intent.payment.currency,
        status: "succeeded", paid: true, captured: true, amount_refunded: 0, disputed: false, refunded: false,
        receipt_url: "https://pay.stripe.com/receipts/private-message-receipt" } };
  };
  return { ...f, recordsAuthority: f.authority, config, binding: messageBinding, owner, make, messages, queries, nativeCalls, stripeReads, nativePort, stripePort, delivery, authority,
    send: (purpose: FinancialMessagePurpose = "linkDelivery", signal = stop()) => owner.sendOnce(messageBinding, purpose, signal), paid,
    denySource: () => { source = false; }, denyHistory: () => { history = false; }, denyMessage: () => { allowed = false; },
    unadmit: () => { admitted = false; }, expireMessageOwner: () => { live = false; }, denyBinding: () => { approvedCheckout = undefined; },
    approveRecoveredBinding: () => { approvedCheckout = "cs_test_owner"; }, changeApprovedRecipient: () => { approvedRecipient = "new-recipient@example.invalid"; },
    changeSender: () => { selected = { ...selected, sender: "changed@example.test" }; } };
}
export { value, now, stop };
