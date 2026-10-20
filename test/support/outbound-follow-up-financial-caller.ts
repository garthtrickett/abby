/** The actual outgoing caller's retained native intent and acknowledgement feed
 * the existing independent payment owner after the call has ended. */
import assert from "node:assert/strict";
import { financialCall, selectBooking, playTerms, until } from "./outbound-follow-up-financial.ts";
import { withDisposablePostgres } from "./disposable-postgres.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { PostgresOutboundEffectBarrier } from "../../src/storage/postgres-outbound-effect-barrier.ts";
import { PostgresFinancialEffectBarrier } from "../../src/storage/postgres-financial-effect-barrier.ts";
import { financialRecordOwnerBinding } from "../../src/cliniko/financial-record-retention.ts";
import { decodeClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import { verifyFinancialBookingObservation } from "../../src/cliniko/financial-booking-observation.ts";
import { value } from "./financial-retention.ts";
import { withRetainedFinancialCaller } from "./financial-caller-context.ts";
import { runPaidFinancialCaller } from "./financial-class-caller-chain.ts";
import { runUnpaidFinancialCaller } from "./financial-class-unpaid-chain.ts";

export async function outboundFollowUpFinancialCaller(outcome: "paid" | "closedUnpaid", stage: (value: number) => void) {
  stage(1); const callerBegan = performance.now();
  await withDisposablePostgres(async (db, connectionString) => {
    const budget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-session-au5", maxPerMinute: 180 });
    const c = await financialCall({ budget,
      sessionEffects: (scope, binding) => new PostgresOutboundEffectBarrier(db, scope, binding),
      financialBarrier: native => new PostgresFinancialEffectBarrier(db, native.scope, value(financialRecordOwnerBinding(native))) });
    const f = c.f;
    try {
      let callerTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([(async () => {
          const { input } = await selectBooking(c);
          await f.mark(); await playTerms(c); await f.privateKey("1");
          await until(() => input.readySelection !== undefined, "outgoing payment consent"); await f.privateQuiet();
          await f.say("continue booking", { kind: "clarify" }); await f.mark(); await f.say("Yes", { kind: "affirm" });
          assert.equal(f.bookings, 1); assert.equal(f.bookingRequests.length, 1);
        })(), new Promise<never>((_, reject) => {
          callerTimer = setTimeout(() => { reject(Error("original outgoing caller deadline")); void f.closeCall(); },
            Math.max(1, 120_000 - (performance.now() - callerBegan)));
        })]);
      } finally { if (callerTimer) clearTimeout(callerTimer); }
      const row = [...c.funding.rows.values()].find(record => String(record.notes).includes("financial intent")); assert.ok(row);
      const intent = value(decodeClinikoFinancialIntent(row.notes));
      const noted = [...c.funding.rows.values()].find(record => String(record.notes).includes("financial booking observation")); assert.ok(noted);
      const producer = c.funding.config.producer;
      const observation = value(verifyFinancialBookingObservation(noted.notes, { intent, intentRecallRef: `cliniko:recall:${row.id}`,
        producerKeyRef: producer.keyRef, publicKey: producer.publicKey }));
      assert.ok(observation.financialConsent); assert.equal(observation.targetRef, "cliniko:appointment:91");
      // Retire the actual wire/clinical owner before the independent consumer.
      // The synthetic native provider and its already-retained bytes outlive it.
      await f.closeCall(); assert.equal(f.flow.closed, true); stage(2);
      await withRetainedFinancialCaller({ native: c.funding, observation, clinicalNative: f.retainedNative.fetchPort,
        expected: { targetRef: "cliniko:appointment:91", amount: 5000, currency: "gbp" },
        clock: f.currentTime, setTime: f.setCallTime, clinicalWrites: () => f.bookingRequests, reviews: () => f.recalls },
        db, connectionString, stage, context => outcome === "paid" ? runPaidFinancialCaller(context, stage) : runUnpaidFinancialCaller(context, stage));
    } finally { await c.close(); }
  });
}
