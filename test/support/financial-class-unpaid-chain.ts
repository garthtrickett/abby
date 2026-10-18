/** Current closed-unpaid observation is separate from paid receipt delivery and
 * separately authorized clinical cancellation. No forced late-open Session. */
import assert from "node:assert/strict";
import { sql } from "kysely";
import { withClassFinancialCaller } from "./financial-class-caller-context.ts";
import { financialConsumerPeer } from "./financial-consumer-peer.ts";
import { withSmtpVerificationServer } from "./smtp-verification-server.ts";
import type { FinancialConsumerCycle } from "../../src/standalone/cliniko-financial-consumer.ts";

export async function financialClassUnpaidChain(passes: boolean, stage: (value: number) => void): Promise<void> {
  await withClassFinancialCaller(passes, stage, async ({ actor: c, observation, clock, advanceTo, directory, connectionString, db }) => {
    let peer: Awaited<ReturnType<typeof financialConsumerPeer>> | undefined;
    const output: string[] = [];
    try {
      await withSmtpVerificationServer(async smtp => {
        const until = async (predicate: (cycle: FinancialConsumerCycle) => boolean, label: string) => {
          const deadline = performance.now() + 95_000;
          while (true) {
            assert.ok(performance.now() < deadline, label);
            const cycle = await peer!.nextCycle(); if (predicate(cycle)) return cycle;
          }
        };
        let denial: "checkoutExpiry" | "producer" | undefined;
        let seenExpiry = false, seenProducer = false;
        const launch = () => financialConsumerPeer(c, smtp.config, directory, {
          connectionString, voiceRunner: true, advancingClock: true, now: clock(), reviewDate: "2026-10-05", enableCheckoutExpiry: true,
          producerAdmitted: () => { seenProducer = true; return denial !== "producer"; },
          allows: (purpose, raw) => {
            if (purpose !== "checkoutExpiry") return true;
            seenExpiry = true;
            const query = raw as { binding: { financialActionRef: string; checkoutRef: string }; sources: { booking: { observation: { targetRef: string } } } };
            assert.equal(query.binding.financialActionRef, c.intent.actionRef); assert.equal(query.binding.checkoutRef, c.receipts[0]!.checkoutRef);
            assert.equal(query.sources.booking.observation.targetRef, observation.targetRef);
            return denial !== "checkoutExpiry";
          },
        });
        const stop = async () => { await peer!.kill(); output.push(...peer!.output); peer = undefined; };
        peer = await launch();
        await until(cycle => cycle.messageAccepted === 1 && smtp.messages.length === 1 && c.receipts.length === 1, "one original Checkout and accepted link");
        assert.equal(c.sessions.length, 1); assert.ok(smtp.messages[0]!.includes("checkout.stripe.com")); stage(3);
        await stop();
        assert.equal(c.sessions[0]!.expires_at, Date.parse(c.intent.payment.deadline) / 1000);
        advanceTo(new Date(Date.parse(c.intent.payment.deadline) + 1000).toISOString());
        // Stripe owns natural Session expiry; keep exact original deadline.
        Object.assign(c.sessions[0]!, { status: "expired", payment_status: "unpaid", url: null });
        assert.equal(c.sessions[0]!.payment_intent, null);
        denial = "checkoutExpiry"; seenExpiry = false; peer = await launch();
        const denied = await until(() => seenExpiry, "current financial expiry authority was consulted");
        assert.equal(denied.checkoutClosedUnpaid, 0); assert.ok(denied.reviewRequired > 0); await stop();
        denial = "producer"; seenProducer = false; peer = await launch();
        const unadmitted = await until(() => seenProducer, "independent producer/restore admission was consulted");
        assert.equal(unadmitted.checkoutClosedUnpaid, 0); await stop();
        assert.equal(smtp.messages.length, 1); stage(4);
        denial = undefined; seenExpiry = false; peer = await launch();
        const expired = await until(cycle => cycle.checkoutClosedUnpaid === 1, "current independently authorized closed-unpaid observation");
        assert.ok(seenExpiry); assert.equal(expired.checkoutExpiryAcknowledged, 0); assert.equal(expired.messageAccepted, 0); stage(5);
        await stop(); peer = await launch();
        const replay = await until(cycle => cycle.checkoutClosedUnpaid === 1, "cold closed-unpaid observation without replaying an effect");
        assert.equal(replay.messageAccepted, 0); assert.equal(replay.checkoutExpiryAcknowledged, 0); await stop();
        assert.equal(smtp.messages.length, 1); assert.equal(c.sessions[0]!.status, "expired");
        assert.equal(c.sessions[0]!.payment_status, "unpaid"); assert.equal(c.sessions[0]!.payment_intent, null);
        assert.equal(c.requests.filter(request => request.method === "POST").length, 1, "only the original Checkout creation, no fabricated late-open expiry");
        assert.deepEqual((await sql`select effect_ref from financial_effect_barriers where tenant_id = ${c.intent.scope.tenantId}
          and effect_ref in (${c.intent.effects.checkoutExpiry}::uuid, ${c.intent.effects.clinicalExpiry}::uuid)`.execute(db)).rows, []);
        stage(6);
      });
      assert.match(output.join(""), /^(Abby voice local listener ready on 127\.0\.0\.1:\d+; calls disabled\n){5}$/);
    } finally { await peer?.kill(); }
  });
}
