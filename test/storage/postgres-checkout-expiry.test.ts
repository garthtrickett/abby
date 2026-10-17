import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresFinancialEffectBarrier } from "../../src/storage/postgres-financial-effect-barrier.ts";
import { financialRecordOwnerBinding } from "../../src/cliniko/financial-record-retention.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { expiryFixture, value } from "../support/financial-checkout-expiry.ts";
import { intentValue } from "../support/financial-retention.ts";
import { financialConsumerPeer } from "../support/financial-consumer-peer.ts";
import { withSmtpVerificationServer } from "../support/smtp-verification-server.ts";
import { secret } from "../support/financial-webhook-handoff.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
async function setup(options: Pick<NonNullable<Parameters<typeof expiryFixture>[0]>, "post"> = {}) {
  const source = intentValue(), intent = { ...source, scope: { ...source.scope, tenantId: `expiry-${randomUUID()}` }, actionRef: randomUUID(),
    booking: { ...source.booking, actionRef: randomUUID() }, effects: { checkout: randomUUID(), linkDelivery: randomUUID(), receiptDelivery: randomUUID(),
      checkoutExpiry: randomUUID(), clinicalExpiry: randomUUID() } };
  const f = await expiryFixture({ ...options, checkout: { native: { intent,
    barrierFactory: config => new PostgresFinancialEffectBarrier(db, config.scope, value(financialRecordOwnerBinding(config))) } } });
  const checkout = { ...f.checkoutConfig, cliniko: f.config.cliniko, stripe: f.config.stripe };
  return { ...f, now: f.config.cliniko.clock(), config: { checkout, pollEveryMs: 1000, cycleDeadlineMs: 10_000,
    webhook: { endpointSecret: secret, accountRef: checkout.stripe.accountRef, livemode: false,
      apiVersion: checkout.stripe.apiVersion, clock: checkout.stripe.clock } },
    dependencies: { native: f.nativePort, stripe: f.expiryStripePort }, approved: new Set([f.binding.checkoutRef]),
    receipts: [] as import("../../src/standalone/cliniko-stripe-checkout.ts").CheckoutCreationReceipt[] };
}
async function privacy(f: Awaited<ReturnType<typeof setup>>) {
  const canaries = [f.intent.recipient.address, "cs_test_owner", "cliniko:recall:30", "cliniko:appointment:91",
    "Abby financial expiry attempt v1", "Abby financial intent v1", "https://pay.stripe.com/receipts/", "https://checkout.stripe.com/c/pay/"];
  assert.deepEqual(await scanPatientDataCanaries(db, canaries.map((value, index) => ({ label: `expiry_${index}`, value }))), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
  for (const canary of canaries) assert.equal(dump.includes(canary), false);
  const rows = (await sql<Record<string, unknown>>`select * from financial_effect_barriers where tenant_id = ${f.intent.scope.tenantId}`.execute(db)).rows;
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["claimed_at", "clinic_id", "effect_ref", "location_id", "owner_binding", "tenant_id"]);
  return dump;
}

test("compiled periodic Checkout expiry preserves opaque SQL claims through actual backup and sends no clinical cancellation", { timeout: 35_000 }, async t => {
  const f = await setup(), dir = await mkdtemp(join(tmpdir(), "abby-checkout-expiry-host-")); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    const peer = await financialConsumerPeer(f, smtp.config, dir, { now: f.now, enableCheckoutExpiry: true }); t.after(peer.kill);
    assert.equal((await peer.nextCycle()).checkoutExpiryAcknowledged, 1); assert.equal((await peer.nextCycle()).checkoutClosedUnpaid, 1);
    await peer.kill(); assert.equal(f.posts.length, 1); assert.equal(smtp.messages.length, 0); assert.deepEqual(await readdir(dir), []);
    assert.equal(f.requests.filter(r => r.method === "POST").length, 1); assert.deepEqual((await sql`select effect_ref from financial_effect_barriers where tenant_id = ${f.intent.scope.tenantId}
      and effect_ref = ${f.intent.effects.clinicalExpiry}::uuid`.execute(db)).rows, []);
    const dump = await privacy(f), name = `expiry_restore_${randomUUID().replaceAll("-", "")}`;
    await sql.raw(`create database "${name}"`).execute(db); const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`;
    const restored = connectPostgres(url.toString());
    try {
      execFileSync("psql", [url.toString(), "-X", "--set=ON_ERROR_STOP=1"], { input: dump, timeout: 10_000, maxBuffer: 8_000_000 });
      const barrier = new PostgresFinancialEffectBarrier(restored, f.intent.scope, value(financialRecordOwnerBinding(f.config.checkout.cliniko)));
      assert.deepEqual(await barrier.claimOnce(f.intent.effects.checkoutExpiry), { ok: true, value: { claimed: false } });
    } finally { await restored.destroy(); await sql.raw(`drop database "${name}"`).execute(db); }
  });
});

test("killed compiled expiry sender cannot repeat uncertain POST after local claim loss and native attempt closure", { timeout: 35_000 }, async t => {
  const f = await setup({ post: () => Response.json({ error: "Uncertain expiry" }, { status: 500 }) });
  const dir = await mkdtemp(join(tmpdir(), "abby-checkout-expiry-loss-")); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    let notify!: () => void; const submitted = new Promise<void>(resolve => { notify = resolve; });
    const first = await financialConsumerPeer(f, smtp.config, dir, { now: f.now, enableCheckoutExpiry: true, holdExpiryReply: true, onExpirySubmitted: notify }); t.after(first.kill);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([submitted, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic expiry dispatch unavailable")), 10_000); })]); }
    finally { if (timer) clearTimeout(timer); }
    await first.kill(); assert.equal(f.posts.length, 1);
    await sql`delete from financial_effect_barriers where tenant_id = ${f.intent.scope.tenantId} and effect_ref = ${f.intent.effects.checkoutExpiry}::uuid`.execute(db);
    const retained = f.rows.get("33")!; retained.recalled = true; retained.recalled_at = f.now; retained.archived_at = f.now;
    const cold = await financialConsumerPeer(f, smtp.config, dir, { now: f.now, enableCheckoutExpiry: true }); t.after(cold.kill);
    assert.equal((await cold.nextCycle()).reviewRequired, 1); await cold.kill();
    assert.equal(f.posts.length, 1); assert.equal(smtp.messages.length, 0); await privacy(f);
  });
});

test("compiled payment-winning expiry race preserves received money and separately delivers its hosted receipt", { timeout: 35_000 }, async t => {
  let paid = () => {};
  const f = await setup({ post: () => { paid(); return Response.json({ error: "Already completed" }, { status: 400 }); } }); paid = f.paid;
  const dir = await mkdtemp(join(tmpdir(), "abby-checkout-expiry-paid-")); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    const peer = await financialConsumerPeer(f, smtp.config, dir, { now: f.now, enableCheckoutExpiry: true }); t.after(peer.kill);
    assert.equal((await peer.nextCycle()).reviewRequired, 1); assert.equal((await peer.nextCycle()).messageAccepted, 1);
    await peer.kill(); assert.equal(f.posts.length, 1); assert.equal(smtp.messages.length, 1); assert.match(smtp.messages[0]!, /Your Stripe payment receipt/);
    assert.equal(f.sessions[0]!.payment_status, "paid"); assert.equal(f.requests.filter(r => r.method === "POST").length, 1); await privacy(f);
  });
});

for (const denied of ["checkoutExpiry", "producer"] as const)
test(`compiled current ${denied} refusal preserves manual-paid/restore separation before any financial expiry`, { timeout: 25_000 }, async t => {
  const f = await setup(), dir = await mkdtemp(join(tmpdir(), "abby-checkout-expiry-denied-")); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    const peer = await financialConsumerPeer(f, smtp.config, dir, { now: f.now, enableCheckoutExpiry: true,
      producerAdmitted: () => denied !== "producer", allows: purpose => purpose !== denied }); t.after(peer.kill);
    assert.equal((await peer.nextCycle()).reviewRequired, 1); await peer.kill(); assert.equal(f.posts.length, 0); assert.equal(smtp.messages.length, 0);
    const rows = (await sql`select effect_ref from financial_effect_barriers where tenant_id = ${f.intent.scope.tenantId}
      and effect_ref = ${f.intent.effects.checkoutExpiry}::uuid`.execute(db)).rows; assert.deepEqual(rows, []); await privacy(f);
  });
});
