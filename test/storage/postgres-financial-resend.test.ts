import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresFinancialEffectBarrier } from "../../src/storage/postgres-financial-effect-barrier.ts";
import { financialRecordOwnerBinding } from "../../src/cliniko/financial-record-retention.ts";
import { decodeFinancialResendAttempt } from "../../src/cliniko/financial-resend-attempt.ts";
import { financialConsumerPeer } from "../support/financial-consumer-peer.ts";
import { withSmtpVerificationServer } from "../support/smtp-verification-server.ts";
import { value, now } from "../support/financial-resend-owner.ts";
import { setup, options, directory, claims, privacy } from "../support/financial-resend-process-fixture.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
for (const purpose of ["linkDelivery", "receiptDelivery"] as const)
  test(`compiled approved ${purpose} sends one real TLS message with permanent opaque claims and no repeat`, { timeout: 35_000 }, async t => {
    const f = await setup(db, purpose), dir = await directory(); t.after(() => rm(dir, { recursive: true, force: true }));
    await withSmtpVerificationServer(async smtp => {
      void smtp.receivedData.then(() => f.events.push("data"));
      const peer = await financialConsumerPeer(f, smtp.config, dir, options(f)); t.after(peer.kill);
      assert.equal((await peer.nextCycle()).messageAccepted, 1); assert.equal(smtp.messages.length, 1);
      assert.deepEqual(f.events, ["possible", "data"]); assert.equal((await claims(db, f, f.selected.request.approvalRef)).length, 1);
      assert.equal((await claims(db, f, f.selected.request.effectRef)).length, 1);
      assert.match(smtp.messages[0]!, purpose === "linkDelivery" ? /Your clinic payment link/ : /Your Stripe payment receipt/);
      const repeat = await peer.nextCycle(); assert.equal(repeat.messageAccepted, 0); assert.ok(repeat.reviewRequired > 0); await peer.kill();
      assert.equal(smtp.messages.length, 1); assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
      assert.deepEqual(await readdir(dir), []); await privacy(db, f);
    });
  });
test("actual backup and restore retain both one-use resend exclusions without retaining private context", { timeout: 35_000 }, async t => {
  const f = await setup(db), dir = await directory(); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    const peer = await financialConsumerPeer(f, smtp.config, dir, options(f)); t.after(peer.kill); assert.equal((await peer.nextCycle()).messageAccepted, 1); await peer.kill();
    const dump = await privacy(db, f), name = `resend_restore_${randomUUID().replaceAll("-", "")}`;
    await sql.raw(`create database "${name}"`).execute(db); const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`; const restored = connectPostgres(url.toString());
    try {
      execFileSync("psql", [url.toString(), "-X", "--set=ON_ERROR_STOP=1"], { input: dump, timeout: 10_000, maxBuffer: 8_000_000 });
      const barrier = new PostgresFinancialEffectBarrier(restored, f.intent.scope, value(financialRecordOwnerBinding(f.config.checkout.cliniko)));
      for (const id of [f.selected.request.approvalRef, f.selected.request.effectRef]) assert.deepEqual(await barrier.claimOnce(id), { ok: true, value: { claimed: false } });
    } finally { await restored.destroy(); await sql.raw(`drop database "${name}"`).execute(db); }
  });
});
test("concurrent compiled financial hosts share the real approved-request and send exclusions", { timeout: 35_000 }, async t => {
  const f = await setup(db), dir = await directory(); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    const [a, b] = await Promise.all([financialConsumerPeer(f, smtp.config, dir, options(f)), financialConsumerPeer(f, smtp.config, dir, options(f))]);
    t.after(a.kill); t.after(b.kill); const cycles = await Promise.all([a.nextCycle(), b.nextCycle()]); await a.kill(); await b.kill();
    assert.equal(cycles.reduce((n, c) => n+c.messageAccepted, 0), 1); assert.equal(smtp.messages.length, 1); await privacy(db, f);
  });
});
test("SIGKILL with a possible native resend cannot replay after both local claims are lost and that review is closed", { timeout: 35_000 }, async t => {
  const f = await setup(db), dir = await directory(); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    let submitted!: () => void; const dispatched = new Promise<void>(resolve => { submitted = resolve; });
    const first = await financialConsumerPeer(f, smtp.config, dir, { ...options(f), holdResendAttemptReply: true, onResendAttemptSubmitted: submitted }); t.after(first.kill);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([dispatched, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic resend possible dispatch unavailable")), 10_000); })]); }
    finally { if (timer) clearTimeout(timer); }
    await first.kill(); assert.equal(smtp.messages.length, 0);
    await sql`delete from financial_effect_barriers where tenant_id = ${f.intent.scope.tenantId}
      and effect_ref in (${f.selected.request.effectRef}::uuid, ${f.selected.request.approvalRef}::uuid)`.execute(db);
    const possible = [...f.rows.values()].find(row => decodeFinancialResendAttempt(row.notes).ok)!;
    possible.recalled = true; possible.recalled_at = now; possible.archived_at = now;
    const cold = await financialConsumerPeer(f, smtp.config, dir, options(f)); t.after(cold.kill);
    const cycle = await cold.nextCycle(); assert.equal(cycle.kind, "observed"); assert.equal(cycle.messageAccepted, 0); assert.ok(cycle.reviewRequired > 0); await cold.kill();
    assert.equal(smtp.messages.length, 0); assert.equal((await claims(db, f, f.selected.request.effectRef)).length, 0);
    assert.equal((await claims(db, f, f.selected.request.approvalRef)).length, 0); await privacy(db, f);
  });
});
test("a killed compiled sender after real TLS DATA leaves one possible send and cannot send again", { timeout: 35_000 }, async t => {
  const f = await setup(db), dir = await directory(); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    smtp.fault("stallData"); const first = await financialConsumerPeer(f, smtp.config, dir, options(f)); t.after(first.kill);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([smtp.receivedData, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic resend TLS DATA unavailable")), 10_000); })]); }
    finally { if (timer) clearTimeout(timer); }
    await first.kill(); assert.equal(smtp.messages.length, 1); smtp.fault(undefined);
    const cold = await financialConsumerPeer(f, smtp.config, dir, options(f)); t.after(cold.kill);
    const cycle = await cold.nextCycle(); assert.equal(cycle.kind, "observed"); assert.equal(cycle.messageAccepted, 0); assert.ok(cycle.reviewRequired > 0); await cold.kill();
    assert.equal(smtp.messages.length, 1); await privacy(db, f);
  });
});
for (const purpose of ["resendRequest", "resendFinancial"] as const)
  test(`compiled independent ${purpose} refusal cannot be replaced by a native request or old delivery grant`, { timeout: 35_000 }, async t => {
    const f = await setup(db), dir = await directory(); t.after(() => rm(dir, { recursive: true, force: true }));
    await withSmtpVerificationServer(async smtp => {
      const peer = await financialConsumerPeer(f, smtp.config, dir, { ...options(f), allows: p => p !== purpose }); t.after(peer.kill);
      const cycle = await peer.nextCycle(); assert.equal(cycle.messageAccepted, 0); assert.ok(cycle.reviewRequired > 0); await peer.kill();
      assert.equal(smtp.messages.length, 0); assert.equal((await claims(db, f, f.selected.request.approvalRef)).length, 0);
      assert.equal((await claims(db, f, f.selected.request.effectRef)).length, 0); await privacy(db, f);
    });
  });
test("compiled consumer missing resend provisioning does not turn a native request into another message", { timeout: 35_000 }, async t => {
  const f = await setup(db), dir = await directory(); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    const peer = await financialConsumerPeer(f, smtp.config, dir); t.after(peer.kill);
    assert.equal((await peer.nextCycle()).messageAccepted, 0); await peer.kill();
    assert.equal(smtp.messages.length, 0); assert.equal((await claims(db, f, f.selected.request.effectRef)).length, 0); await privacy(db, f);
  });
});
test("payment winning compiled resend preparation prevents the link and separately admits the original hosted receipt", { timeout: 35_000 }, async t => {
  const f = await setup(db), dir = await directory(), native = f.dependencies.native; t.after(() => rm(dir, { recursive: true, force: true }));
  f.dependencies.native = async (input, init) => {
    const response = await native(input, init); if (init?.method === "POST" && String(init.body).includes("Abby financial resend attempt v1")) f.paid(); return response;
  };
  await withSmtpVerificationServer(async smtp => {
    const peer = await financialConsumerPeer(f, smtp.config, dir, options(f)); t.after(peer.kill);
    const first = await peer.nextCycle(); assert.equal(first.messageAccepted, 0); assert.ok(first.reviewRequired > 0); assert.equal(smtp.messages.length, 0);
    assert.equal((await peer.nextCycle()).messageAccepted, 1); await peer.kill(); assert.equal(smtp.messages.length, 1);
    assert.match(smtp.messages[0]!, /Your Stripe payment receipt/); assert.equal(f.requests.filter(r => r.method === "POST").length, 1); await privacy(db, f);
  });
});
