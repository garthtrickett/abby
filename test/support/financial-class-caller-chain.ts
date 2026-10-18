/** One original signed caller booking followed by separately owned finance.
 * Provider state and independent approvals outlive each compiled money worker. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { financialClassVoiceJourney } from "./financial-class-voice-journey.ts";
import { financialConsumerFixture } from "./financial-consumer.ts";
import { financialConsumerPeer } from "./financial-consumer-peer.ts";
import { withSmtpVerificationServer } from "./smtp-verification-server.ts";
import { decodeClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import { ClinikoFinancialResendRecords } from "../../src/cliniko/financial-resend-records.ts";
import { financialResendRequestDigest } from "../../src/cliniko/financial-resend-request.ts";
import { resendRequestValue } from "./financial-resend.ts";
import { financialMessageSelectionDigest } from "../../src/standalone/smtp-financial-message-delivery.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { secret } from "./financial-webhook-handoff.ts";
import { value, stop } from "./financial-retention.ts";

export async function financialClassCallerChain(passes: boolean, stage: (value: number) => void): Promise<void> {
  stage(1);
  await financialClassVoiceJourney(passes, async ({ booking: f, db, connectionString }) => {
    stage(2);
    const observation = f.proof();
    assert.equal(observation.targetRef, "cliniko:attendee:401");
    assert.deepEqual(observation.classCreationRequest, { sessionId: "94", ...(passes ? { patientCaseId: f.pass.caseId } : {}) });
    const intentRow = f.funding.rows.get(observation.intentRecallRef.split(":").at(-1)!)!;
    const intent = value(decodeClinikoFinancialIntent(intentRow.notes));
    const observationRow = [...f.funding.rows.values()].find(row => String(row.notes).includes("financial booking observation"))!;
    assert.notEqual(intent.actionRef, f.funding.intent.actionRef, "use the caller record, never the fixture's old template");
    assert.equal(intent.payment.amount, 1200); assert.equal(intent.payment.currency, "gbp");
    const originalNotes = [intentRow.notes, observationRow.notes], originalWrites = structuredClone(f.writes);
    assert.equal(originalWrites.length, 1); assert.equal(originalWrites[0]!.booking_id, "94");
    const began = performance.now(), anchor = Math.max(Date.parse(f.classSessionConfig.clock()), Date.parse(observation.observedAt));
    const clock = () => new Date(anchor + performance.now() - began).toISOString();
    const tick = () => f.setTime(clock()); tick();
    const directory = await mkdtemp(join(tmpdir(), "abby-caller-finance-"));
    const c = await financialConsumerFixture({ checkout: { retained: { native: f.funding, intent,
      binding: { intentRecallRef: observation.intentRecallRef, financialActionRef: intent.actionRef,
        observationRecallRef: `cliniko:recall:${observationRow.id}`, observationActionRef: observation.actionRef, reviewDate: "2026-10-05" },
      otherReviews: () => f.recalls.map(row => ({ ...row, recalled_at: null, archived_at: null,
        links: { self: `https://api.au5.cliniko.com/v1/recalls/${row.id}` }, created_at: observation.observedAt, updated_at: observation.observedAt })) } } });
    await c.consumer.close();
    let peer: Awaited<ReturnType<typeof financialConsumerPeer>> | undefined;
    const output: string[] = [], approvals = new Map<string, string>();
    let financialApproved = true;
    const seenRequests = new Set<string>(), seenFinancial = new Set<string>();
    const timer = setInterval(tick, 25);
    try {
      await withSmtpVerificationServer(async smtp => {
        const launch = async () => financialConsumerPeer(c, smtp.config, directory, {
          connectionString, voiceRunner: true, advancingClock: true, now: clock(), reviewDate: "2026-10-05",
          resend: { maximumAuthorityRequests: 0 },
          resendAuthorized: q => { seenRequests.add(q.resend.request.actionRef); return approvals.get(q.resend.request.approvalRef) === financialResendRequestDigest(q.resend.request); },
          resendFinancialAuthorized: q => { seenFinancial.add(q.resend.request.actionRef); return financialApproved; },
        });
        const until = async (predicate: () => boolean, label: string) => {
          const deadline = performance.now() + 95_000;
          while (!predicate()) {
            assert.ok(performance.now() < deadline, label);
            await peer!.nextCycle();
          }
        };
        peer = await launch();
        await until(() => smtp.messages.length === 1 && c.receipts.length === 1, "original caller Checkout and link");
        stage(3);
        assert.equal(c.sessions.length, 1); assert.ok(smtp.messages[0]!.includes(intent.recipient.address));
        assert.ok(smtp.messages[0]!.includes("checkout.stripe.com"));
        const receipt = c.receipts[0]!;
        const records = value(ClinikoFinancialResendRecords.create(c.config.checkout.cliniko, c.authority.records, c.barrier, c.dependencies.native));
        const request = async (purpose: "linkDelivery" | "receiptDelivery") => {
          tick();
          const selected = resendRequestValue(intent, { actionRef: randomUUID(), effectRef: randomUUID(), approvalRef: randomUUID(), purpose,
            intentRecallRef: observation.intentRecallRef, observationRecallRef: `cliniko:recall:${observationRow.id}`,
            observationActionRef: observation.actionRef, targetRef: observation.targetRef,
            checkoutAttemptRecallRef: receipt.attemptRecallRef, checkoutAttemptActionRef: receipt.attemptActionRef,
            checkoutRef: receipt.checkoutRef, requestedAt: clock(), expiresAt: new Date(Date.parse(clock()) + 300_000).toISOString(),
            selectionDigest: financialMessageSelectionDigest({ sender: smtp.config.from, template: "clinicFinancial.v1", timeZone: "Australia/Sydney" })! });
          assert.equal(value(await records.retainRequestOnce(selected, intent, "2026-10-05", stop())).kind, "accepted");
          return selected;
        };
        const link = await request("linkDelivery");
        // Discovery of the request is not independent approval.
        await until(() => seenRequests.has(link.actionRef), "exact native link request reached independent approval");
        assert.equal(smtp.messages.length, 1);
        approvals.set(link.approvalRef, financialResendRequestDigest(link)!);
        await until(() => smtp.messages.length === 2, "independently approved link resend");
        stage(4);
        await peer.kill(); output.push(...peer.output); peer = undefined;
        // The native provider and approval registry survive actual worker loss.
        peer = await launch(); await peer.nextCycle(); assert.equal(smtp.messages.length, 2); assert.equal(c.sessions.length, 1);
        c.paid();
        const timestamp = String(Math.floor(Date.parse(clock()) / 1000));
        const raw = JSON.stringify({ id: "evt_class_caller", object: "event", type: "checkout.session.completed", created: Number(timestamp),
          account: intent.stripe.accountRef, livemode: false, api_version: c.config.webhook.apiVersion,
          data: { object: { object: "checkout.session", id: receipt.checkoutRef, payment_status: "paid" } } });
        const signature = `t=${timestamp},v1=${createHmac("sha256", secret).update(timestamp + ".").update(raw).digest("hex")}`;
        const event = await fetch(`http://127.0.0.1:${peer.port}/stripe/webhook`, { method: "POST",
          headers: { "content-type": "application/json", "stripe-signature": signature }, body: raw });
        assert.equal(event.status, 200); assert.equal(await event.text(), '{"ok":true}');
        await until(() => smtp.messages.length === 3, "original current-money hosted receipt");
        assert.ok(smtp.messages[2]!.includes("pay.stripe.com/receipts/")); stage(5);
        const resend = await request("receiptDelivery");
        approvals.set(resend.approvalRef, financialResendRequestDigest(resend)!); financialApproved = false;
        await until(() => seenFinancial.has(resend.actionRef), "exact native receipt request reached current financial approval");
        assert.equal(smtp.messages.length, 3, "old receipt permission cannot replace current financial approval");
        financialApproved = true;
        await until(() => smtp.messages.length === 4, "independently approved receipt resend"); stage(6);
        await peer.kill(); output.push(...peer.output); peer = await launch();
        await peer.nextCycle(); await peer.nextCycle();
        assert.equal(smtp.messages.length, 4); assert.equal(c.sessions.length, 1); assert.equal(c.receipts.length, 1);
        assert.deepEqual([intentRow.notes, observationRow.notes], originalNotes);
        assert.deepEqual(f.writes, originalWrites);
        await peer.kill(); output.push(...peer.output); peer = undefined;
      });
      assert.ok(output.every(line => /^Abby voice local listener ready on 127\.0\.0\.1:\d+; calls disabled\n$/.test(line)));
      assert.deepEqual(await readdir(directory), []);
      const budgets = await db.selectFrom("cliniko_request_budgets").selectAll().execute();
      assert.equal(budgets.length, 1); assert.equal(budgets[0]!.max_per_minute, 180);
      assert.ok(Array.isArray(budgets[0]!.sent_at_ms) && budgets[0]!.sent_at_ms.length <= 180);
      const canaries = [intent.recipient.address, observation.financialConsent!.presentationDigest,
        observation.intentDigest, "cs_test_owner", "private-checkout-token", "private-consumer", ...originalNotes.map(String)];
      assert.deepEqual(value(await scanPatientDataCanaries(db, canaries.map((value, i) => ({ label: `chain_${i}`, value })))), []);
      const dump = execFileSync("pg_dump", [connectionString, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
      for (const canary of canaries) assert.equal(dump.includes(canary), false);
      stage(7);
    } finally {
      clearInterval(timer); await peer?.kill(); await c.consumer.close(); await rm(directory, { recursive: true, force: true });
    }
  });
}
