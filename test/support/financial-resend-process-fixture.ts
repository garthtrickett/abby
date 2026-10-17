import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresFinancialEffectBarrier } from "../../src/storage/postgres-financial-effect-barrier.ts";
import { financialRecordOwnerBinding } from "../../src/cliniko/financial-record-retention.ts";
import type { FinancialMessagePurpose } from "../../src/cliniko/financial-message-attempt.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { financialResendFixture, value, stop, now } from "./financial-resend-owner.ts";
import { financialClassResendFixture } from "./financial-class-resend.ts";
import { intentValue } from "./financial-retention.ts";
import type { FinancialConsumerPeerOptions } from "./financial-consumer-peer.ts";
import { secret } from "./financial-webhook-handoff.ts";

export async function setup(db: ReturnType<typeof connectPostgres>, purpose: FinancialMessagePurpose = "linkDelivery", classRequest?: { patientCaseId?: string }) {
  const source = intentValue(), intent = { ...source, scope: { ...source.scope, tenantId: `explicit-resend-${randomUUID()}` }, actionRef: randomUUID(),
    booking: { ...source.booking, actionRef: randomUUID() }, effects: { checkout: randomUUID(), linkDelivery: randomUUID(), receiptDelivery: randomUUID(), checkoutExpiry: randomUUID(), clinicalExpiry: randomUUID() } };
  const barrierFactory = (config: Parameters<typeof financialRecordOwnerBinding>[0]) => new PostgresFinancialEffectBarrier(db, config.scope, value(financialRecordOwnerBinding(config)));
  const f = classRequest ? await financialClassResendFixture({ ...classRequest, purpose, intent, barrierFactory })
    : await financialResendFixture({ purpose, message: { checkout: { native: { intent, barrierFactory } } } });
  if (purpose === "receiptDelivery") f.paid(); value(await f.send(purpose));
  const first = f.rows.get(f.selected.binding.recallRef.split(":").at(-1)!)!; first.recalled = true; first.recalled_at = now;
  const selected = await f.createRequest(purpose), events: string[] = [];
  const native: typeof fetch = async (input, init) => {
    if (init?.method === "POST" && String(init.body).includes("Abby financial resend attempt v1")) {
      const rows = (await sql`select effect_ref from financial_effect_barriers where tenant_id = ${intent.scope.tenantId}
        and effect_ref in (${selected.request.effectRef}::uuid, ${selected.request.approvalRef}::uuid)`.execute(db)).rows;
      assert.equal(rows.length, 2, "both actual permanent opaque exclusions precede native possible-send dispatch"); events.push("possible");
    }
    return f.nativePort(input, init);
  };
  const stripe: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/checkout/sessions" && init?.method === "GET") {
      const from = Number(url.searchParams.get("created[gte]")), through = Number(url.searchParams.get("created[lte]"));
      return Response.json({ object: "list", url: "/v1/checkout/sessions", has_more: false,
        data: f.sessions.filter(s => Number(s.created) >= from && Number(s.created) <= through) });
    }
    return f.stripePort(input, init);
  };
  const checkout = { ...f.checkoutConfig, cliniko: f.config.cliniko, stripe: f.config.stripe };
  return { ...f, selected, events, approved: new Set([f.binding.checkoutRef]), receipts: [], dependencies: { native, stripe },
    config: { checkout, pollEveryMs: 1000, cycleDeadlineMs: 10_000, webhook: { endpointSecret: secret,
      accountRef: checkout.stripe.accountRef, livemode: false, apiVersion: checkout.stripe.apiVersion, clock: () => Date.parse(now) } } };
}
export type Fixture = Awaited<ReturnType<typeof setup>>;
export function options(f: Fixture): FinancialConsumerPeerOptions {
  return { resend: { maximumAuthorityRequests: 0 }, resendAuthorized: q => f.resendAuthority.allows(q, stop()),
    resendFinancialAuthorized: q => f.resendAuthority.financialAuthorized(q, stop()) };
}
export async function directory() { return mkdtemp(join(tmpdir(), "abby-explicit-financial-resend-")); }
export async function claims(db: ReturnType<typeof connectPostgres>, f: Fixture, ref: string) {
  return (await sql`select effect_ref from financial_effect_barriers where tenant_id = ${f.intent.scope.tenantId} and effect_ref = ${ref}::uuid`.execute(db)).rows;
}
export async function privacy(db: ReturnType<typeof connectPostgres>, f: Fixture) {
  const canaries = [f.intent.recipient.address, f.selected.request.intentDigest, "cs_test_owner", "Abby financial resend attempt v1",
    "Abby financial resend request v1", "cliniko:recall:30", "cliniko:appointment:91", "cliniko:attendee:91", "https://checkout.stripe.com/c/pay/", "https://pay.stripe.com/receipts/"];
  assert.deepEqual(await scanPatientDataCanaries(db, canaries.map((value, i) => ({ label: `explicit_resend_${i}`, value }))), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
  for (const canary of canaries) assert.equal(dump.includes(canary), false); return dump;
}
