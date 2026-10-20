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
import { financialConsumerFixture } from "../support/financial-consumer.ts";
import { intentValue, value, now } from "../support/financial-retention.ts";
import { withSmtpVerificationServer } from "../support/smtp-verification-server.ts";
import type { SmtpMailConfig } from "../../src/standalone/smtp-text-mail-transport.ts";
import { financialConsumerPeer } from "../support/financial-consumer-peer.ts";
import { signWebhook } from "../support/financial-webhook-handoff.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
async function setup() {
  const source = intentValue(), intent = { ...source, scope: { ...source.scope, tenantId: `consumer-${randomUUID()}` }, actionRef: randomUUID(),
    booking: { ...source.booking, actionRef: randomUUID() }, effects: { checkout: randomUUID(), linkDelivery: randomUUID(), receiptDelivery: randomUUID(),
      checkoutExpiry: randomUUID(), clinicalExpiry: randomUUID() } };
  return financialConsumerFixture({ checkout: { native: { intent,
    barrierFactory: config => new PostgresFinancialEffectBarrier(db, config.scope, value(financialRecordOwnerBinding(config))) } } });
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const worker = (f: Fixture, smtp: SmtpMailConfig, directory: string, admitted: () => boolean = () => true) =>
  financialConsumerPeer(f, smtp, directory, { producerAdmitted: admitted });
async function directory() { return mkdtemp(join(tmpdir(), "abby-financial-consumer-loss-")); }
async function privacy(f: Fixture) {
  const canaries = [f.intent.recipient.address, "cs_test_owner", "https://checkout.stripe.com/c/pay/", "private-consumer", "Abby financial message attempt v1",
    "Abby financial intent v1", "cliniko:appointment:91", "cliniko:recall:30"];
  assert.deepEqual(await scanPatientDataCanaries(db, canaries.map((v, i) => ({ label: `financial_${i}`, value: v }))), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
  for (const canary of canaries) assert.equal(dump.includes(canary), false);
  const rows = (await sql<Record<string, unknown>>`select * from financial_effect_barriers where tenant_id = ${f.intent.scope.tenantId}`.execute(db)).rows;
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["claimed_at", "clinic_id", "effect_ref", "location_id", "owner_binding", "tenant_id"]);
  return dump;
}

test("compiled financial host survives process loss, duplicate HTTP notifications, cold receipt delivery and database backup", { timeout: 40_000 }, async t => {
  const f = await setup(), dir = await directory(); t.after(() => f.consumer.close()); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    const first = await worker(f, smtp.config, dir); t.after(first.kill);
    assert.equal((await first.nextCycle()).creationAcknowledged, 1);
    assert.equal((await first.nextCycle()).messageAccepted, 1); assert.equal(smtp.messages.length, 1);
    const e = signWebhook(JSON.stringify({ id: "evt_compiledConsumer", object: "event", type: "checkout.session.completed", created: Date.parse(now) / 1_000,
      account: f.intent.stripe.accountRef, livemode: false, api_version: f.config.webhook.apiVersion,
      data: { object: { object: "checkout.session", id: "cs_test_owner", payment_status: "paid" } } }));
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`http://127.0.0.1:${first.port}/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": e.signature }, body: e.raw });
      assert.equal(response.status, 200); assert.equal(await response.text(), '{"ok":true}');
    }
    await first.kill(); assert.equal(f.sessions[0]!.payment_status, "unpaid");
    f.paid(); const cold = await worker(f, smtp.config, dir); t.after(cold.kill);
    assert.equal((await cold.nextCycle()).messageAccepted, 1); assert.equal(smtp.messages.length, 2);
    assert.match(smtp.messages[1]!, /Your Stripe payment receipt/);
    assert.equal((await cold.nextCycle()).alreadyAttempted, 1); await cold.kill();
    assert.equal(f.requests.filter(r => r.method === "POST").length, 1); assert.deepEqual(await readdir(dir), []);
    assert.doesNotMatch([...first.output, ...cold.output].join(""), /private|cs_test|cliniko:|recipient|@/);
    const dump = await privacy(f), name = `consumer_restore_${randomUUID().replaceAll("-", "")}`;
    await sql.raw(`create database "${name}"`).execute(db); const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`;
    const restored = connectPostgres(url.toString());
    try {
      execFileSync("psql", [url.toString(), "-X", "--set=ON_ERROR_STOP=1"], { input: dump, timeout: 10_000, maxBuffer: 8_000_000 });
      const barrier = new PostgresFinancialEffectBarrier(restored, f.intent.scope, value(financialRecordOwnerBinding(f.config.checkout.cliniko)));
      for (const ref of [f.intent.effects.checkout, f.intent.effects.linkDelivery, f.intent.effects.receiptDelivery])
        assert.deepEqual(await barrier.claimOnce(ref), { ok: true, value: { claimed: false } });
    } finally { await restored.destroy(); await sql.raw(`drop database "${name}"`).execute(db); }
  });
});

test("killed compiled sender and a restored missing SQL claim cannot replay a native possible send", { timeout: 35_000 }, async t => {
  const f = await setup(), dir = await directory(); t.after(() => f.consumer.close()); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    smtp.fault("stallData"); const first = await worker(f, smtp.config, dir); t.after(first.kill);
    assert.equal((await first.nextCycle()).creationAcknowledged, 1);
    await Promise.race([smtp.receivedData, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Synthetic SMTP dispatch deadline")), 10_000); timer.unref(); })]);
    await first.kill(); assert.equal(smtp.messages.length, 1); smtp.fault(undefined);
    // Simulate an incomplete local restore after independently confirming the
    // old sender's actual terminal. Native possible-send evidence survives it.
    await sql`delete from financial_effect_barriers where tenant_id = ${f.intent.scope.tenantId} and effect_ref = ${f.intent.effects.linkDelivery}::uuid`.execute(db);
    const native = f.rows.get("33")!; native.recalled = true; native.recalled_at = now; native.archived_at = now;
    const cold = await worker(f, smtp.config, dir); t.after(cold.kill);
    assert.equal((await cold.nextCycle()).alreadyAttempted, 1); await cold.kill();
    assert.equal(smtp.messages.length, 1); assert.equal(f.requests.filter(r => r.method === "POST").length, 1); await privacy(f);
  });
});

test("concurrent independently admitted compiled consumers share the real SQL permanent exclusion", { timeout: 35_000 }, async t => {
  const f = await setup(), dir = await directory(); t.after(() => f.consumer.close()); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    const first = await worker(f, smtp.config, dir), second = await worker(f, smtp.config, dir); t.after(first.kill); t.after(second.kill);
    const initial = await Promise.all([first.nextCycle(), second.nextCycle()]);
    assert.equal(initial.reduce((n, c) => n + c.creationAcknowledged, 0), 1);
    await Promise.all([first.nextCycle(), second.nextCycle()]); await first.kill(); await second.kill();
    assert.equal(f.requests.filter(r => r.method === "POST").length, 1); assert.equal(smtp.messages.length, 1); await privacy(f);
  });
});

test("incomplete producer/restore admission refuses a cold sender even when both old histories are absent", { timeout: 35_000 }, async t => {
  const f = await setup(), dir = await directory(); t.after(() => f.consumer.close()); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    const first = await worker(f, smtp.config, dir); t.after(first.kill);
    assert.equal((await first.nextCycle()).creationAcknowledged, 1); assert.equal((await first.nextCycle()).messageAccepted, 1); await first.kill();
    await sql`delete from financial_effect_barriers where tenant_id = ${f.intent.scope.tenantId} and effect_ref = ${f.intent.effects.linkDelivery}::uuid`.execute(db);
    f.rows.delete("33");
    const cold = await worker(f, smtp.config, dir, () => false); t.after(cold.kill);
    assert.equal((await cold.nextCycle()).reviewRequired, 1); await cold.kill();
    assert.equal(smtp.messages.length, 1); assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
    const restored = (await sql`select effect_ref from financial_effect_barriers where tenant_id = ${f.intent.scope.tenantId}
      and effect_ref = ${f.intent.effects.linkDelivery}::uuid`.execute(db)).rows;
    assert.deepEqual(restored, []); await privacy(f);
  });
});
