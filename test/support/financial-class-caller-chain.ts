/** Paid branch of the original caller financial lifecycle. */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { withClassFinancialCaller } from "./financial-class-caller-context.ts";
import type { FinancialCallerActor } from "./financial-caller-context.ts";
import { financialConsumerPeer } from "./financial-consumer-peer.ts";
import { withSmtpVerificationServer } from "./smtp-verification-server.ts";
import { ClinikoFinancialResendRecords } from "../../src/cliniko/financial-resend-records.ts";
import { financialResendRequestDigest } from "../../src/cliniko/financial-resend-request.ts";
import { resendRequestValue } from "./financial-resend.ts";
import { financialMessageSelectionDigest } from "../../src/standalone/smtp-financial-message-delivery.ts";
import { secret } from "./financial-webhook-handoff.ts";
import { value, stop } from "./financial-retention.ts";

export async function financialClassCallerChain(passes: boolean, stage: (value: number) => void): Promise<void> {
  await withClassFinancialCaller(passes, stage, context => runPaidFinancialCaller(context, stage));
}
export async function runPaidFinancialCaller({ actor: c, observation, clock, directory, connectionString }: FinancialCallerActor, stage: (value: number) => void): Promise<void> {
    const intent = c.intent;
    let peer: Awaited<ReturnType<typeof financialConsumerPeer>> | undefined;
    const output: string[] = [], approvals = new Map<string, string>();
    let financialApproved = true;
    const seenRequests = new Set<string>(), seenFinancial = new Set<string>();
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
          const selected = resendRequestValue(intent, { actionRef: randomUUID(), effectRef: randomUUID(), approvalRef: randomUUID(), purpose,
            intentRecallRef: observation.intentRecallRef, observationRecallRef: c.binding.observationRecallRef,
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
        const raw = JSON.stringify({ id: "evt_classCaller", object: "event", type: "checkout.session.completed", created: Number(timestamp),
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
        await peer.kill(); output.push(...peer.output); peer = undefined;
      });
      assert.match(output.join(""), /^(Abby voice local listener ready on 127\.0\.0\.1:\d+; calls disabled\n){3}$/);
      assert.deepEqual(await readdir(directory), []);
    } finally { await peer?.kill(); }
}
