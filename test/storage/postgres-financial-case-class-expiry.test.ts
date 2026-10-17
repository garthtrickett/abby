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
import { decodeFinancialExpiryAttempt } from "../../src/cliniko/financial-expiry-attempt.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { caseClassExpiryFixture, value, stop } from "../support/financial-case-class-expiry.ts";
import { intentValue } from "../support/financial-retention.ts";
import { financialConsumerPeer } from "../support/financial-consumer-peer.ts";
import type { FinancialConsumerPeerOptions } from "../support/financial-consumer-peer.ts";
import { withSmtpVerificationServer } from "../support/smtp-verification-server.ts";
import { secret } from "../support/financial-webhook-handoff.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
async function setup(options: Pick<NonNullable<Parameters<typeof caseClassExpiryFixture>[0]>, "retained" | "cancel"> = {}) {
  const source = intentValue(), intent = { ...source, scope: { ...source.scope, tenantId: `class-clinical-${randomUUID()}` }, actionRef: randomUUID(),
    booking: { ...source.booking, actionRef: randomUUID() }, effects: { checkout: randomUUID(), linkDelivery: randomUUID(), receiptDelivery: randomUUID(),
      checkoutExpiry: randomUUID(), clinicalExpiry: randomUUID() } };
  const f = await caseClassExpiryFixture({ ...options, intent,
    barrierFor: config => new PostgresFinancialEffectBarrier(db, config.scope, value(financialRecordOwnerBinding(config))),
  beforeCancel: async () => {
    const rows = (await sql`select effect_ref from financial_effect_barriers where tenant_id = ${intent.scope.tenantId} and effect_ref = ${intent.effects.clinicalExpiry}::uuid`.execute(db)).rows;
    assert.equal(rows.length, 1, "actual permanent SQL exclusion exists before native cancellation");
  } });
  const checkout = { ...f.checkoutConfig, cliniko: f.config.cliniko, stripe: f.config.stripe };
  return { ...f, now: f.config.cliniko.clock!(), config: { checkout, pollEveryMs: 1000, cycleDeadlineMs: 10_000,
    webhook: { endpointSecret: secret, accountRef: checkout.stripe.accountRef, livemode: false, apiVersion: checkout.stripe.apiVersion, clock: checkout.stripe.clock } },
    dependencies: { native: f.caseNative, stripe: f.expiryStripePort }, approved: new Set([f.binding.checkoutRef]),
    receipts: [] as import("../../src/standalone/cliniko-stripe-checkout.ts").CheckoutCreationReceipt[] };
}
function peerOptions(f: Awaited<ReturnType<typeof setup>>): FinancialConsumerPeerOptions {
  return { now: f.now, enableCheckoutExpiry: true, caseClassClinicalExpiry: { path: f.classPolicyPath,
    directoryPath: f.classDirectoryPath, binding: f.classPolicy.binding(), maximumAuthorityRequests: 0 }, caseClassClinicalApproval: q => f.caseAuthority.clinicalApproval(q, stop()) };
}
async function privacy(f: Awaited<ReturnType<typeof setup>>) {
  const canaries = [f.intent.recipient.address, "cs_test_owner", "cliniko:recall:30", "cliniko:attendee:91", "Abby financial expiry attempt v1",
    "Abby financial booking observation v3", "Abby financial intent v1", "If this exact class deposit", "https://pay.stripe.com/receipts/"];
  assert.deepEqual(await scanPatientDataCanaries(db, canaries.map((value, index) => ({ label: `clinical_expiry_${index}`, value }))), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
  for (const canary of canaries) assert.equal(dump.includes(canary), false);
  return dump;
}
test("compiled case-linked class expiry consumes opaque SQL exclusion before one native cancellation and retains it through backup", { timeout: 35_000 }, async t => {
  const f = await setup(), dir = await mkdtemp(join(tmpdir(), "abby-clinical-expiry-host-")); t.after(f.close); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    const peer = await financialConsumerPeer(f, smtp.config, dir, peerOptions(f)); t.after(peer.kill);
    assert.equal((await peer.nextCycle()).clinicalExpiryCancelled, 1); await peer.kill();
    assert.equal(f.cancellations.length, 1); assert.equal(f.posts.length, 0); assert.equal(smtp.messages.length, 0); assert.deepEqual(await readdir(dir), []);
    const dump = await privacy(f), name = `clinical_restore_${randomUUID().replaceAll("-", "")}`;
    await sql.raw(`create database "${name}"`).execute(db); const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`;
    const restored = connectPostgres(url.toString());
    try {
      execFileSync("psql", [url.toString(), "-X", "--set=ON_ERROR_STOP=1"], { input: dump, timeout: 10_000, maxBuffer: 8_000_000 });
      const barrier = new PostgresFinancialEffectBarrier(restored, f.intent.scope, value(financialRecordOwnerBinding(f.config.checkout.cliniko)));
      assert.deepEqual(await barrier.claimOnce(f.intent.effects.clinicalExpiry), { ok: true, value: { claimed: false } });
    } finally { await restored.destroy(); await sql.raw(`drop database "${name}"`).execute(db); }
  });
});
test("killed compiled case-linked class sender cannot repeat after local claim loss and a closed native possible-expiry review", { timeout: 35_000 }, async t => {
  const f = await setup({ cancel: () => new Response(null, { status: 500 }) }), dir = await mkdtemp(join(tmpdir(), "abby-clinical-expiry-loss-"));
  t.after(f.close); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    let notify!: () => void; const submitted = new Promise<void>(resolve => { notify = resolve; });
    const first = await financialConsumerPeer(f, smtp.config, dir, { ...peerOptions(f), holdClinicalReply: true, onClinicalSubmitted: notify }); t.after(first.kill);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([submitted, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic clinical dispatch unavailable")), 10_000); })]); }
    finally { if (timer) clearTimeout(timer); }
    await first.kill(); assert.equal(f.cancellations.length, 1);
    await sql`delete from financial_effect_barriers where tenant_id = ${f.intent.scope.tenantId} and effect_ref = ${f.intent.effects.clinicalExpiry}::uuid`.execute(db);
    const retained = [...f.rows.values()].find(row => { const a = decodeFinancialExpiryAttempt(row.notes); return a.ok && a.value.purpose === "clinicalExpiry"; })!;
    retained.recalled = true; retained.archived_at = f.now;
    const cold = await financialConsumerPeer(f, smtp.config, dir, peerOptions(f)); t.after(cold.kill);
    assert.equal((await cold.nextCycle()).reviewRequired, 1); await cold.kill();
    assert.equal(f.cancellations.length, 1); assert.equal(smtp.messages.length, 0); await privacy(f);
  });
});
test("concurrent compiled financial case-linked class owners share the real permanent SQL exclusion", { timeout: 35_000 }, async t => {
  const f = await setup(), dir = await mkdtemp(join(tmpdir(), "abby-clinical-expiry-race-")); t.after(f.close); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    const [a, b] = await Promise.all([financialConsumerPeer(f, smtp.config, dir, peerOptions(f)), financialConsumerPeer(f, smtp.config, dir, peerOptions(f))]);
    t.after(a.kill); t.after(b.kill); const cycles = await Promise.all([a.nextCycle(), b.nextCycle()]);
    await a.kill(); await b.kill(); assert.equal(cycles.reduce((n, c) => n + c.clinicalExpiryCancelled, 0), 1);
    assert.equal(f.cancellations.length, 1); assert.equal(smtp.messages.length, 0); await privacy(f);
  });
});
test("payment winning compiled case-linked class preparation stops cancellation and the next cycle separately sends its hosted receipt", { timeout: 35_000 }, async t => {
  let paid = () => {}; const f = await setup({ retained: () => paid() }); paid = f.paid;
  const dir = await mkdtemp(join(tmpdir(), "abby-clinical-expiry-payment-")); t.after(f.close); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    const peer = await financialConsumerPeer(f, smtp.config, dir, peerOptions(f)); t.after(peer.kill);
    const first = await peer.nextCycle(); assert.equal(first.reviewRequired, 1); assert.equal(first.clinicalExpiryCancelled, 0);
    assert.equal(f.cancellations.length, 0); assert.equal(smtp.messages.length, 0);
    assert.equal((await peer.nextCycle()).messageAccepted, 1); await peer.kill();
    assert.match(smtp.messages[0]!, /Your Stripe payment receipt/); assert.equal(f.cancellations.length, 0); assert.equal(f.posts.length, 0); await privacy(f);
  });
});
for (const purpose of ["caseClassClinicalFinancial", "producer"] as const)
  test(`compiled current ${purpose} refusal preserves independent case-linked class expiry admission`, { timeout: 35_000 }, async t => {
    const f = await setup(), dir = await mkdtemp(join(tmpdir(), "abby-clinical-expiry-denied-")); t.after(f.close); t.after(() => rm(dir, { recursive: true, force: true }));
    await withSmtpVerificationServer(async smtp => {
      const peer = await financialConsumerPeer(f, smtp.config, dir, { ...peerOptions(f), allows: p => p !== purpose,
        ...(purpose === "producer" ? { producerAdmitted: () => false } : {}) }); t.after(peer.kill);
      assert.equal((await peer.nextCycle()).clinicalExpiryCancelled, 0); await peer.kill();
      assert.equal(f.cancellations.length, 0); assert.equal(smtp.messages.length, 0);
      assert.deepEqual((await sql`select effect_ref from financial_effect_barriers where tenant_id = ${f.intent.scope.tenantId} and effect_ref = ${f.intent.effects.clinicalExpiry}::uuid`.execute(db)).rows, []);
      await privacy(f);
    });
  });
