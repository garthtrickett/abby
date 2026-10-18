/** Explicit --import entry for the isolated compiled consumer only. Never used
 * by serving code. It observes real operations; no permission or result is set. */
import { FinancialClinicalExpiryProtocol } from "../../src/standalone/financial-clinical-expiry-protocol.ts";
import { PostgresFinancialEffectBarrier } from "../../src/storage/postgres-financial-effect-barrier.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { observeFinancialExpiry, expiryObservationCounts } from "./observe-financial-expiry.ts";

if (process.argv[1]?.endsWith("/financial-consumer-process.js") && process.env.ABBY_ISOLATED_POSTGRES_PROBE === "1" && process.connected) {
  const expire = FinancialClinicalExpiryProtocol.prototype.expireOnce;
  FinancialClinicalExpiryProtocol.prototype.expireOnce = function (...args: Parameters<typeof expire>) {
    return observeFinancialExpiry(() => expire.apply(this, args), observation => {
      if (process.connected) process.send?.({ kind: "expiryObservation", observation }, () => {});
    });
  };
  const claim = PostgresFinancialEffectBarrier.prototype.claimOnce;
  PostgresFinancialEffectBarrier.prototype.claimOnce = async function (...args: Parameters<typeof claim>) {
    const found = await claim.apply(this, args), counts = expiryObservationCounts.getStore();
    if (counts && found.ok && found.value.claimed) counts.claims++;
    return found;
  };
  const nativeClaim = PostgresClinikoRequestBudget.prototype.claim;
  PostgresClinikoRequestBudget.prototype.claim = async function (...args: Parameters<typeof nativeClaim>) {
    const counts = expiryObservationCounts.getStore(); if (counts) counts.requests++;
    const found = await nativeClaim.apply(this, args); if (counts && found !== null) counts.quotaDenials++;
    return found;
  };
  const headroom = PostgresClinikoRequestBudget.prototype.checkHeadroom;
  PostgresClinikoRequestBudget.prototype.checkHeadroom = async function (...args: Parameters<typeof headroom>) {
    const counts = expiryObservationCounts.getStore(); if (counts) counts.quotaRequired = args[0];
    const found = await headroom.apply(this, args); if (counts && found !== null) counts.quotaDenials++;
    return found;
  };
}
