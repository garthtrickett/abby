import assert from "node:assert/strict";
import { ClinikoFinancialConsumer } from "../../src/standalone/cliniko-financial-consumer.ts";
import type { FinancialConsumerAuthorities, FinancialConsumerCycle } from "../../src/standalone/cliniko-financial-consumer.ts";
import type { CheckoutCreationReceipt } from "../../src/standalone/cliniko-stripe-checkout.ts";
import { checkoutFixture, now, stop, value, reviewDate } from "./financial-checkout-owner.ts";
import { secret } from "./financial-webhook-handoff.ts";

export async function financialConsumerFixture(options: {
  checkout?: Parameters<typeof checkoutFixture>[0]; authority?: Partial<FinancialConsumerAuthorities>;
  onAcknowledged?(receipt: CheckoutCreationReceipt): Promise<void>;
} = {}) {
  const response = options.checkout?.native?.response;
  const f = await checkoutFixture(options.checkout?.retained ? options.checkout : { ...options.checkout, native: { ...options.checkout?.native, response: async (row, method) => {
    if (method === "POST") row.recalled_at = null;
    return response ? response(row, method) : Response.json(row, { status: method === "POST" ? 201 : 200 });
  } } });
  for (const row of f.rows.values()) row.recalled_at = null;
  const nativePort: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "GET" && url.pathname === "/v1/recalls" && url.searchParams.getAll("q[]").includes("recalled_at:!?")) {
      const rows = [...f.rows.values(), ...(options.checkout?.retained?.otherReviews?.() ?? [])].filter(row => row.recalled_at === null && row.archived_at === null).sort((a, b) => Number(a.id) - Number(b.id));
      const page = Number(url.searchParams.get("page")); return Response.json({ total_entries: rows.length, recalls: rows.slice((page - 1) * 100, page * 100) });
    }
    return f.nativePort(input, init);
  };
  const stripeReads: URL[] = [];
  const stripePort: typeof fetch = async (input, init) => {
    if (init?.method === "POST") return f.stripePort(input, init);
    const url = new URL(String(input)); stripeReads.push(url); assert.equal(init?.method, "GET");
    assert.equal(new Headers(init.headers).get("Stripe-Account"), f.config.stripe.accountRef);
    if (url.pathname === "/v1/account") return f.stripePort(input, init);
    if (url.pathname === "/v1/checkout/sessions") {
      const first = Number(url.searchParams.get("created[gte]")), last = Number(url.searchParams.get("created[lte]"));
      const data = f.sessions.filter(s => Number(s.created) >= first && Number(s.created) <= last);
      return Response.json({ object: "list", url: "/v1/checkout/sessions", data, has_more: false });
    }
    assert.equal(url.pathname, "/v1/checkout/sessions/cs_test_owner"); return Response.json(f.sessions[0]);
  };
  const approved = new Set<string>(), receipts: CheckoutCreationReceipt[] = [], messages: { mail: unknown; ref: string }[] = [], cycles: FinancialConsumerCycle[] = [];
  let runAllowed = true, live = true, workAllowed = true, pendingAllowed = true;
  let nextCycle: ((cycle: FinancialConsumerCycle) => void) | undefined;
  const authority: FinancialConsumerAuthorities = {
    run: { allows: async () => runAllowed, current: () => live },
    pending: { allowsPendingRead: async () => pendingAllowed, allowsRecordRead: async () => true, current: () => live },
    checkout: f.checkoutAuthority, records: f.authority,
    message: { sourceAuthorized: async () => true, attemptScanAuthorized: async () => true,
      providerBindingAuthorized: async q => approved.has(q.binding.checkoutRef), messageAuthorized: async q => q.message.email === f.intent.recipient.address,
      producerAdmitted: async () => true, current: () => live },
    work: { authorizeWork: async () => workAllowed ? { reviewDate } : null,
      providerBindingAuthorized: async q => approved.has(q.checkoutRef), current: () => live,
      onCheckoutAcknowledged: async receipt => { receipts.push(receipt); await options.onAcknowledged?.(receipt); approved.add(receipt.checkoutRef); } },
    webhook: { allowsReferenceRead: async () => true, acceptsExistingPending: async () => true, current: () => live }, ...options.authority,
  };
  const config = { checkout: f.config, pollEveryMs: 1_000, cycleDeadlineMs: 5_000,
    webhook: { endpointSecret: secret, accountRef: f.config.stripe.accountRef, livemode: false, apiVersion: f.config.stripe.apiVersion, clock: () => Date.parse(f.config.cliniko.clock?.() ?? now) } };
  const dependencies = { barrier: f.barrier, native: nativePort, stripe: stripePort,
    delivery: { selection: () => ({ sender: "clinic@example.test", template: "clinicFinancial.v1" as const, timeZone: "Australia/Sydney" }),
      send: async (mail: unknown, _signal: AbortSignal, ref: string) => { messages.push({ mail, ref }); return { kind: "accepted" as const, messageRef: ref }; } },
    onCycle: (cycle: FinancialConsumerCycle) => { cycles.push(cycle); const waiting = nextCycle; nextCycle = undefined; waiting?.(cycle); } };
  const make = () => value(ClinikoFinancialConsumer.create(config, authority, dependencies));
  const consumer = make();
  const cycle = () => new Promise<FinancialConsumerCycle>((resolve, reject) => {
    assert.equal(nextCycle, undefined); const timer = setTimeout(() => reject(new Error("Synthetic financial cycle unavailable")), 8_000);
    nextCycle = result => { clearTimeout(timer); resolve(result); };
  });
  const paid = () => {
    const row = f.sessions[0]!; row.status = "complete"; row.payment_status = "paid"; row.url = null;
    row.payment_intent = { object: "payment_intent", id: "pi_consumer", livemode: false, amount: f.intent.payment.amount, amount_received: f.intent.payment.amount,
      currency: f.intent.payment.currency, status: "succeeded", latest_charge: { object: "charge", id: "ch_consumer", payment_intent: "pi_consumer", livemode: false,
        amount: f.intent.payment.amount, amount_captured: f.intent.payment.amount, currency: f.intent.payment.currency, status: "succeeded", paid: true,
        captured: true, amount_refunded: 0, disputed: false, refunded: false, receipt_url: "https://pay.stripe.com/receipts/private-consumer" } };
  };
  return { ...f, config, authority, dependencies, consumer, make, cycle, cycles, receipts, messages, approved, stripeReads, paid,
    start: () => value(consumer.start(stop())), denyRun: () => { runAllowed = false; }, retire: () => { live = false; },
    denyWork: () => { workAllowed = false; }, denyPending: () => { pendingAllowed = false; } };
}
