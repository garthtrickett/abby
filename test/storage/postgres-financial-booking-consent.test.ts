import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresFinancialEffectBarrier } from "../../src/storage/postgres-financial-effect-barrier.ts";
import { financialRecordOwnerBinding } from "../../src/cliniko/financial-record-retention.ts";
import { ClinikoStripeCheckoutOwner } from "../../src/standalone/cliniko-stripe-checkout.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { financialBookingFixture } from "../support/financial-booking.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";
import { value, stop } from "../support/financial-retention.ts";
import { decodeClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(async () => { await db.destroy(); });
for (const consentAllowed of [true, false]) test(`actual private-consent/native booking to Stripe owner with real SQL exclusion (collection=${consentAllowed})`, async () => {
  const scope = { tenantId: `fc-${randomUUID()}`, clinicId: "clinic", locationId: "loc" };
  const f = await financialBookingFixture({ scope, barrierFor: config => new PostgresFinancialEffectBarrier(db, scope, value(financialRecordOwnerBinding(config))) });
  try {
    const ref = await f.verify(); resultValue(await f.propose(ref, "fee-required"));
    const notice = (await f.state()).pendingPresentationId!;
    resultValue(await f.runtime.startPresentation(f.callId, notice, f.sessionId, verificationNow));
    resultValue(await f.runtime.resolvePresentation(f.callId, notice, "played", f.sessionId, verificationNow));
    assert.equal(await f.play(), "pending"); assert.equal(await f.accept(), "verified");
    resultValue(await f.propose(ref, "clinical-proposal")); resultValue(await f.confirm()); resultValue(await f.drain()); assert.equal(f.posts, 1);
    const proof = f.proof(); assert.ok(proof.financialConsent);
    const intentRow = [...f.rows.values()].find(r => String(r.notes).includes("financial intent"))!, observationRow = [...f.rows.values()].find(r => String(r.notes).includes("financial booking observation"))!;
    const intent = value(decodeClinikoFinancialIntent(intentRow.notes)), stripePosts: string[] = [];
    const stripePort: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/account")) return Response.json({ object: "account", id: "acct_fixture" });
      assert.equal(init?.method, "POST"); stripePosts.push(String(init.body)); const p = new URLSearchParams(String(init.body));
      return Response.json({ object: "checkout.session", id: "cs_test_financialconsent", mode: "payment", livemode: false,
        client_reference_id: intent.actionRef, amount_total: intent.payment.amount, amount_subtotal: intent.payment.amount, currency: intent.payment.currency,
        status: "open", payment_status: "unpaid", payment_intent: null, expires_at: Number(p.get("expires_at")), created: Date.parse(verificationNow) / 1_000,
        metadata: { abby_financial_action: p.get("metadata[abby_financial_action]"), abby_effect: p.get("metadata[abby_effect]"), abby_intent_digest: p.get("metadata[abby_intent_digest]") },
        total_details: { amount_tax: 0, amount_shipping: 0, amount_discount: 0 }, automatic_tax: { enabled: false }, adaptive_pricing: { enabled: false },
        url: "https://checkout.stripe.com/c/pay/cs_test_financialconsent" });
    };
    const owner = () => value(ClinikoStripeCheckoutOwner.create({ cliniko: f.config.native,
      stripe: { apiKey: "sk_test_synthetic12345678", accountRef: "acct_fixture", connected: true, livemode: false, apiVersion: "2025-06-30.basil", clock: () => Date.parse(verificationNow) },
      productLabel: "Clinic deposit", paymentMethod: "card", successUrl: "https://clinic.example.invalid/complete", cancelUrl: "https://clinic.example.invalid/return" },
      { sourceAuthorized: async () => true, attemptScanAuthorized: async () => true,
        collectionAuthorized: async query => consentAllowed && query.bookingObservation.financialConsent?.presentationDigest === proof.financialConsent!.presentationDigest && query.intent.payment.termsVersion === "financial-terms-1",
        producerAdmitted: async () => true, current: () => true }, f.config.authority,
      new PostgresFinancialEffectBarrier(db, scope, value(financialRecordOwnerBinding(f.config.native))), f.config.fetchPort, stripePort));
    const binding = { intentRecallRef: `cliniko:recall:${intentRow.id}`, financialActionRef: intent.actionRef, observationRecallRef: `cliniko:recall:${observationRow.id}`,
      observationActionRef: proof.actionRef, reviewDate: "2026-10-05" };
    const result = await owner().createOnce(binding, stop());
    assert.equal(result.ok, consentAllowed); if (result.ok) assert.equal(result.value.kind, "created");
    assert.equal(stripePosts.length, consentAllowed ? 1 : 0);
    assert.equal((await owner().createOnce(binding, stop())).ok, false); assert.equal(stripePosts.length, consentAllowed ? 1 : 0);
    const local = (await sql<Record<string, unknown>>`select * from financial_effect_barriers where tenant_id = ${scope.tenantId}`.execute(db)).rows;
    assert.equal(local.length, consentAllowed ? 4 : 2);
    for (const row of local) assert.deepEqual(Object.keys(row).sort(), ["claimed_at", "clinic_id", "effect_ref", "location_id", "owner_binding", "tenant_id"]);
    assert.deepEqual(await scanPatientDataCanaries(db, [
      { label: "recipient", value: "financial-recipient@example.invalid" }, { label: "financial_text", value: "GBP 50.00" },
      { label: "financial_intent", value: "Abby financial intent v1" }, { label: "financial_consent", value: "Abby financial booking observation v2" },
      { label: "checkout", value: "cs_test_financialconsent" }, { label: "native_intent", value: binding.intentRecallRef },
      { label: "presentation_text", value: f.texts[0]!.slice(0, 200) },
      { label: "presentation_digest", value: proof.financialConsent!.presentationDigest },
    ]), { ok: true, value: [] });
  } finally { await f.close(); }
});
