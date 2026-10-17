import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { checkoutFixture, value, now, stop } from "./financial-checkout-owner.ts";
import { ClinikoStripeWebhookHandoff } from "../../src/standalone/cliniko-stripe-webhook-handoff.ts";
import type { FinancialWebhookHandoffAuthority, FinancialWebhookHandoffConfig, FinancialWebhookPendingQuery } from "../../src/standalone/cliniko-stripe-webhook-handoff.ts";
import type { FinancialPendingAuthority } from "../../src/cliniko/financial-pending-discovery.ts";

export const secret = "whsec_syntheticHandoffSecret1234";
export async function handoffFixture(options: {
  checkout?: Parameters<typeof checkoutFixture>[0]; authority?: Partial<FinancialWebhookHandoffAuthority>;
  pendingAuthority?: Partial<FinancialPendingAuthority>; deadlineMs?: number;
} = {}) {
  const f = await checkoutFixture(options.checkout);
  value(await f.owner.createOnce(f.binding, stop()));
  for (const row of f.rows.values()) row.recalled_at = null;
  let reference = true, accepted = true, current = true, pending = true, record = true;
  const grants: FinancialWebhookPendingQuery[] = [], nativeReads: URL[] = [], stripeReads: URL[] = [];
  const nativePort: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); nativeReads.push(url); assert.equal(init?.method, "GET");
    if (url.pathname === "/v1/recalls") {
      assert.deepEqual(url.searchParams.getAll("q[]"), ["recalled_at:!?", "archived_at:!?"]);
      assert.equal(url.searchParams.get("sort"), "id:asc"); assert.equal(url.searchParams.get("per_page"), "100");
      const rows = [...f.rows.values()].filter(r => r.recalled_at === null && r.archived_at === null).sort((a, b) => Number(a.id) - Number(b.id));
      const page = Number(url.searchParams.get("page"));
      return Response.json({ recalls: rows.slice((page - 1) * 100, page * 100), total_entries: rows.length });
    }
    return f.nativePort(input, init);
  };
  const stripePort: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); stripeReads.push(url); assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
    const headers = new Headers(init.headers); assert.equal(headers.get("Stripe-Version"), f.config.stripe.apiVersion);
    assert.equal(headers.get("Stripe-Account"), f.config.stripe.accountRef);
    assert.ok(url.pathname === "/v1/account" || url.pathname === "/v1/checkout/sessions/cs_test_owner");
    return Response.json(url.pathname === "/v1/account" ? { object: "account", id: f.config.stripe.accountRef } : f.sessions[0]);
  };
  const config: FinancialWebhookHandoffConfig = { cliniko: f.config.cliniko, stripe: f.config.stripe,
    webhook: { endpointSecret: secret, accountRef: f.config.stripe.accountRef, livemode: false, apiVersion: f.config.stripe.apiVersion, clock: () => Date.parse(now) },
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }) };
  const authority: FinancialWebhookHandoffAuthority = { allowsReferenceRead: async () => reference,
    acceptsExistingPending: async q => { grants.push(q); return accepted; }, current: () => current, ...options.authority };
  const pendingAuthority: FinancialPendingAuthority = { allowsPendingRead: async () => pending, allowsRecordRead: async () => record,
    current: () => current, ...options.pendingAuthority };
  const make = (patch: Partial<FinancialWebhookHandoffConfig> = {}) => ClinikoStripeWebhookHandoff.create({ ...config, ...patch }, authority, pendingAuthority, nativePort, stripePort);
  const handoff = value(make());
  const event = (patch: Record<string, unknown> = {}) => ({ id: "evt_synthetic", object: "event", type: "checkout.session.completed",
    created: Date.parse(now) / 1_000, account: f.config.stripe.accountRef, livemode: false, api_version: f.config.stripe.apiVersion,
    data: { object: { object: "checkout.session", id: "cs_test_owner", payment_status: "paid", customer_email: "private-webhook@example.invalid", amount_total: 1 } }, ...patch });
  const signed = (patch: Record<string, unknown> = {}) => signWebhook(JSON.stringify(event(patch)));
  return { ...f, config, nativePort, stripePort, authority, pendingAuthority, grants, nativeReads, stripeReads, handoff, make, event, signed,
    accept: (patch: Record<string, unknown> = {}, signal = stop()) => { const e = signed(patch); return handoff.accept(webBody(e.raw), e.signature, signal); },
    denyReference: () => { reference = false; }, denyAccept: () => { accepted = false; }, denyPending: () => { pending = false; },
    denyRecord: () => { record = false; }, expire: () => { current = false; } };
}
export function signWebhook(raw: string) {
  const at = String(Date.parse(now) / 1_000);
  return { raw, signature: `t=${at},v1=${createHmac("sha256", secret).update(at + ".").update(raw).digest("hex")}` };
}
export function webBody(raw: string) { return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from(raw)); c.close(); } }); }
