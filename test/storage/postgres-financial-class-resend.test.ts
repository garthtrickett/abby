import assert from "node:assert/strict";
import test, { after } from "node:test";
import { rm, readdir } from "node:fs/promises";
import { connectPostgres } from "../../src/storage/connect.ts";
import { financialConsumerPeer } from "../support/financial-consumer-peer.ts";
import { withSmtpVerificationServer } from "../support/smtp-verification-server.ts";
import { setup, options, directory, claims, privacy } from "../support/financial-resend-process-fixture.ts";
import { now } from "../support/financial-resend-owner.ts";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
for (const patientCaseId of [undefined, "71"]) for (const purpose of ["linkDelivery", "receiptDelivery"] as const)
  test(`compiled class ${purpose} on original case=${patientCaseId ?? "none"} sends one TLS message without changing attendance or money`, { timeout: 35_000 }, async t => {
    const f = await setup(db, purpose, { ...(patientCaseId ? { patientCaseId } : {}) }), dir = await directory();
    t.after(() => rm(dir, { recursive: true, force: true }));
    await withSmtpVerificationServer(async smtp => {
      const peer = await financialConsumerPeer(f, smtp.config, dir, options(f)); t.after(peer.kill);
      assert.equal((await peer.nextCycle()).messageAccepted, 1); assert.equal(smtp.messages.length, 1);
      assert.equal(f.selected.request.targetRef, "cliniko:attendee:91");
      assert.equal((await claims(db, f, f.selected.request.approvalRef)).length, 1);
      assert.equal((await claims(db, f, f.selected.request.effectRef)).length, 1);
      assert.equal((await peer.nextCycle()).messageAccepted, 0); await peer.kill();
      assert.equal(smtp.messages.length, 1); assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
      assert.equal(f.nativeCalls.every(r => r.url.pathname.startsWith("/v1/recalls")), true);
      assert.deepEqual(await readdir(dir), []); await privacy(db, f);
    });
  });
test("mismatched compiled class request rejects complete discovery before any claim or send", { timeout: 35_000 }, async t => {
  const f = await setup(db, "linkDelivery", { patientCaseId: "71" }), dir = await directory();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const selected = f.rows.get(f.selected.binding.recallRef.split(":").at(-1)!)!; selected.recalled = true; selected.recalled_at = now;
  const wrong = await f.createRequest("linkDelivery", { targetRef: "cliniko:attendee:92" });
  await withSmtpVerificationServer(async smtp => {
    const peer = await financialConsumerPeer(f, smtp.config, dir, options(f)); t.after(peer.kill);
    const cycle = await peer.nextCycle(); assert.equal(cycle.kind, "unavailable"); assert.equal(cycle.messageAccepted, 0); assert.equal(cycle.reviewRequired, 0); await peer.kill();
    assert.equal(smtp.messages.length, 0); assert.equal((await claims(db, f, wrong.request.approvalRef)).length, 0);
    assert.equal((await claims(db, f, wrong.request.effectRef)).length, 0); await privacy(db, f);
  });
});
test("compiled class context and original receipt permission cannot replace current financial resend approval", { timeout: 35_000 }, async t => {
  const f = await setup(db, "receiptDelivery", { patientCaseId: "71" }), dir = await directory(); t.after(() => rm(dir, { recursive: true, force: true }));
  await withSmtpVerificationServer(async smtp => {
    const peer = await financialConsumerPeer(f, smtp.config, dir, { ...options(f), allows: p => p !== "resendFinancial" }); t.after(peer.kill);
    const cycle = await peer.nextCycle(); assert.equal(cycle.messageAccepted, 0); assert.ok(cycle.reviewRequired > 0); await peer.kill();
    assert.equal(smtp.messages.length, 0); assert.equal((await claims(db, f, f.selected.request.effectRef)).length, 0); await privacy(db, f);
  });
});
