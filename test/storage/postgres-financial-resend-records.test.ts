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
import { decodeFinancialCheckoutAttempt } from "../../src/cliniko/financial-checkout-attempt.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { financialConsumerFixture } from "../support/financial-consumer.ts";
import { financialConsumerPeer } from "../support/financial-consumer-peer.ts";
import type { FinancialConsumerPeerOptions } from "../support/financial-consumer-peer.ts";
import { resendRequestValue } from "../support/financial-resend.ts";
import { intentValue, value, stop, reviewDate } from "../support/financial-retention.ts";
import { withSmtpVerificationServer } from "../support/smtp-verification-server.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
async function setup() {
  const source = intentValue(), intent = { ...source, scope: { ...source.scope, tenantId: `resend-context-${randomUUID()}` }, actionRef: randomUUID(),
    booking: { ...source.booking, actionRef: randomUUID() }, effects: { checkout: randomUUID(), linkDelivery: randomUUID(), receiptDelivery: randomUUID(), checkoutExpiry: randomUUID(), clinicalExpiry: randomUUID() } };
  const f = await financialConsumerFixture({ checkout: { native: { intent,
    barrierFactory: config => new PostgresFinancialEffectBarrier(db, config.scope, value(financialRecordOwnerBinding(config))) } } });
  const created = value(await f.owner.createOnce(f.binding, stop())); assert.equal(created.kind, "created");
  if (created.kind !== "created") throw new Error("Synthetic creation unavailable"); f.approved.add(created.checkoutRef);
  const attempt = value(decodeFinancialCheckoutAttempt(f.rows.get(created.attemptRecallRef.split(":").at(-1)!)!.notes));
  const request = resendRequestValue(intent, { actionRef: randomUUID(), effectRef: randomUUID(), approvalRef: randomUUID(),
    observationRecallRef: f.binding.observationRecallRef, observationActionRef: f.binding.observationActionRef,
    checkoutAttemptRecallRef: created.attemptRecallRef, checkoutAttemptActionRef: attempt.actionRef });
  const native: typeof fetch = async (input, init) => {
    if (init?.method === "POST" && String(init.body).includes("Abby financial resend request v1")) {
      const rows = (await sql`select effect_ref from financial_effect_barriers where tenant_id = ${intent.scope.tenantId} and effect_ref = ${request.actionRef}::uuid`.execute(db)).rows;
      assert.equal(rows.length, 1, "actual permanent record exclusion exists before provider dispatch");
    }
    return f.dependencies.native(input, init);
  };
  return { ...f, dependencies: { ...f.dependencies, native }, request, options: { resendRequestRetention: { request, intent, reviewDate } } satisfies FinancialConsumerPeerOptions };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function directory() { return mkdtemp(join(tmpdir(), "abby-resend-native-context-")); }
async function claims(f: Fixture, ref: string) {
  return (await sql`select effect_ref from financial_effect_barriers where tenant_id = ${f.intent.scope.tenantId} and effect_ref = ${ref}::uuid`.execute(db)).rows;
}
async function privacy(f: Fixture) {
  const canaries = [f.intent.recipient.address, f.request.intentDigest, "cs_test_owner", "Abby financial resend request v1", "cliniko:recall:30", "cliniko:appointment:91"];
  assert.deepEqual(await scanPatientDataCanaries(db, canaries.map((value, i) => ({ label: `resend_context_${i}`, value }))), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
  for (const canary of canaries) assert.equal(dump.includes(canary), false); return dump;
}
test("compiled prospective resend retains one native record with an opaque durable action, no send and a restorable exclusion", { timeout: 35_000 }, async t => {
  const f = await setup(), dir = await directory(); t.after(() => f.consumer.close()); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    const before = f.rows.size, posts = f.requests.filter(r => r.method === "POST").length;
    const peer = await financialConsumerPeer(f, smtp.config, dir, f.options); t.after(peer.kill);
    const result = value(await peer.nextRetention()); assert.equal(result.kind, "accepted"); await peer.kill();
    assert.equal(f.rows.size, before + 1); assert.equal(f.requests.filter(r => r.method === "POST").length, posts); assert.equal(smtp.messages.length, 0); assert.deepEqual(await readdir(dir), []);
    assert.equal((await claims(f, f.request.actionRef)).length, 1); assert.equal((await claims(f, f.request.effectRef)).length, 0);
    assert.equal((await claims(f, f.intent.effects.linkDelivery)).length, 0);
    const dump = await privacy(f), name = `resend_restore_${randomUUID().replaceAll("-", "")}`;
    await sql.raw(`create database "${name}"`).execute(db); const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`; const restored = connectPostgres(url.toString());
    try {
      execFileSync("psql", [url.toString(), "-X", "--set=ON_ERROR_STOP=1"], { input: dump, timeout: 10_000, maxBuffer: 8_000_000 });
      const barrier = new PostgresFinancialEffectBarrier(restored, f.intent.scope, value(financialRecordOwnerBinding(f.config.checkout.cliniko)));
      assert.deepEqual(await barrier.claimOnce(f.request.actionRef), { ok: true, value: { claimed: false } });
    } finally { await restored.destroy(); await sql.raw(`drop database "${name}"`).execute(db); }
  });
});
test("concurrent compiled recorders share the same permanent request action", { timeout: 35_000 }, async t => {
  const f = await setup(), dir = await directory(); t.after(() => f.consumer.close()); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    const before = f.rows.size;
    const [a, b] = await Promise.all([financialConsumerPeer(f, smtp.config, dir, f.options), financialConsumerPeer(f, smtp.config, dir, f.options)]);
    t.after(a.kill); t.after(b.kill); const results = await Promise.all([a.nextRetention(), b.nextRetention()]); await a.kill(); await b.kill();
    assert.equal(results.filter(r => r.ok && r.value.kind === "accepted").length, 1);
    assert.equal(results.filter(r => !r.ok && r.error.kind === "alreadyClaimed").length, 1);
    assert.equal(f.rows.size, before + 1); assert.equal(smtp.messages.length, 0); await privacy(f);
  });
});
test("SIGKILL after native request creation cannot repeat its consumed action through a cold compiled process", { timeout: 35_000 }, async t => {
  const f = await setup(), dir = await directory(); t.after(() => f.consumer.close()); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    let submitted!: () => void; const dispatched = new Promise<void>(resolve => { submitted = resolve; }); const before = f.rows.size;
    const first = await financialConsumerPeer(f, smtp.config, dir, { ...f.options, holdResendRequestReply: true, onResendRequestSubmitted: submitted }); t.after(first.kill);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([dispatched, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic resend context dispatch unavailable")), 10_000); })]); }
    finally { if (timer) clearTimeout(timer); }
    await first.kill(); assert.equal(f.rows.size, before + 1);
    const cold = await financialConsumerPeer(f, smtp.config, dir, f.options); t.after(cold.kill);
    assert.deepEqual(await cold.nextRetention(), { ok: false, error: { kind: "alreadyClaimed" } }); await cold.kill();
    assert.equal(f.rows.size, before + 1); assert.equal((await claims(f, f.request.effectRef)).length, 0); assert.equal(smtp.messages.length, 0); await privacy(f);
  });
});
for (const purpose of ["resendRecord", "producer"] as const)
  test(`compiled independent ${purpose} denial cannot retain a prospective request`, { timeout: 35_000 }, async t => {
    const f = await setup(), dir = await directory(); t.after(() => f.consumer.close()); t.after(() => rm(dir, { recursive: true, force: true }));
    await withSmtpVerificationServer(async smtp => {
      const before = f.rows.size, peer = await financialConsumerPeer(f, smtp.config, dir, { ...f.options, allows: p => p !== purpose,
        ...(purpose === "producer" ? { producerAdmitted: () => false } : {}) }); t.after(peer.kill);
      assert.equal((await peer.nextRetention()).ok, false); await peer.kill(); assert.equal(f.rows.size, before);
      assert.equal((await claims(f, f.request.actionRef)).length, 0); assert.equal((await claims(f, f.request.effectRef)).length, 0); assert.equal(smtp.messages.length, 0); await privacy(f);
    });
  });

test("compiled periodic polling cannot turn prospective context into another send or a new effect", { timeout: 35_000 }, async t => {
  const f = await setup(), dir = await directory(); t.after(() => f.consumer.close()); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    const recorder = await financialConsumerPeer(f, smtp.config, dir, f.options); t.after(recorder.kill);
    assert.equal(value(await recorder.nextRetention()).kind, "accepted"); await recorder.kill();
    assert.deepEqual(await f.barrier.claimOnce(f.intent.effects.linkDelivery), { ok: true, value: { claimed: true } });
    const before = f.rows.size, poller = await financialConsumerPeer(f, smtp.config, dir); t.after(poller.kill);
    assert.equal((await poller.nextCycle()).messageAccepted, 0); assert.equal((await poller.nextCycle()).messageAccepted, 0); await poller.kill();
    assert.equal(f.rows.size, before); assert.equal((await claims(f, f.request.effectRef)).length, 0); assert.equal(smtp.messages.length, 0);
    assert.deepEqual(await readdir(dir), []); await privacy(f);
  });
});
