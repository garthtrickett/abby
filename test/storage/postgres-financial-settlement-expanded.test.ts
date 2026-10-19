import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresFinancialEffectBarrier } from "../../src/storage/postgres-financial-effect-barrier.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { financialRecordOwnerBinding } from "../../src/cliniko/financial-record-retention.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { caseClassExpiryFixture, value, stop } from "../support/financial-case-class-expiry.ts";
import { unlinkedClassExpiryFixture } from "../support/financial-unlinked-class-expiry.ts";
import { financialResendFixture } from "../support/financial-resend-owner.ts";
import { settlementNative } from "../support/financial-settlement-native.ts";
import { intentValue } from "../support/financial-retention.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { secret } from "../support/financial-webhook-handoff.ts";
import type { FinancialConsumerAuthorities, FinancialConsumerCycle, FinancialConsumerConfig } from "../../src/standalone/cliniko-financial-consumer.ts";
import type { FinancialRecordRetentionConfig } from "../../src/cliniko/financial-record-retention.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/src/standalone/", import.meta.url);
const { createFinancialSettlementConsumer } = await import(new URL("financial-settlement-authorities.js", emitted).href) as typeof import("../../src/standalone/financial-settlement-authorities.ts");
const { ClinikoFinancialSettlementReview } = await import(new URL("cliniko-financial-settlement-review.js", emitted).href) as typeof import("../../src/standalone/cliniko-financial-settlement-review.ts");
const { ApprovedFinancialWaiverIssuer } = await import(new URL("approved-financial-waiver-issuer.js", emitted).href) as typeof import("../../src/standalone/approved-financial-waiver-issuer.ts");
const { OwnerFileFinancialSource } = await import(new URL("owner-file-financial-source.js", emitted).href) as typeof import("../../src/standalone/owner-file-financial-source.ts");
const { OwnerFileClassPolicy } = await import(new URL("owner-file-class-policy.js", emitted).href) as typeof import("../../src/standalone/owner-file-class-policy.ts");
const runtime = { ClinikoFinancialSettlementReview, ApprovedFinancialWaiverIssuer, OwnerFileFinancialSource };

for (const kind of ["unlinked", "case", "resend"] as const) for (const scenario of ["open", "paid", "waived"] as const)
test(`compiled native settlement ${kind}/${scenario} uses real PostgreSQL one-use effects and native180`, { timeout: 30_000 }, async t => {
  const apiKey = `synthetic-expanded-${randomUUID()}-au5`, original = intentValue();
  const intent = { ...original, scope: { ...original.scope, tenantId: `expanded-${randomUUID()}` }, actionRef: randomUUID(),
    credentialFingerprint: clinikoCredentialFingerprint(apiKey), booking: { ...original.booking, actionRef: randomUUID() },
    effects: { checkout: randomUUID(), linkDelivery: randomUUID(), receiptDelivery: randomUUID(), checkoutExpiry: randomUUID(), clinicalExpiry: randomUUID() } };
  const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 }), claimed = new Set<string>();
  const barrierFor = (config: FinancialRecordRetentionConfig) => {
    // Fixture capture happens before its readers/owners are constructed. Keep
    // the same physical budget object but bind all ports to this real account.
    Object.assign(config, { apiKey });
    Object.assign(config.rateBudget, { claim: budget.claim.bind(budget), observe429: budget.observe429.bind(budget), checkHeadroom: budget.checkHeadroom.bind(budget) });
    const actual = new PostgresFinancialEffectBarrier(db, config.scope, value(financialRecordOwnerBinding(config)));
    return { matches: actual.matches.bind(actual), claimOnce: async (ref: string) => {
      const result = await actual.claimOnce(ref); if (result.ok && result.value.claimed) claimed.add(ref); return result;
    } };
  };
  const selected = kind === "resend" ? { kind: "resend" as const, fixture: await financialResendFixture({ message: { checkout: { native: { intent, config: { apiKey }, barrierFactory: barrierFor } } } }) }
    : kind === "case" ? { kind: "case" as const, fixture: await caseClassExpiryFixture({ intent, barrierFor, beforeCancel: async () => { assert.ok(claimed.has(intent.effects.clinicalExpiry)); } }) }
    : { kind: "unlinked" as const, fixture: await unlinkedClassExpiryFixture({ intent, barrierFor, beforeCancel: async () => { assert.ok(claimed.has(intent.effects.clinicalExpiry)); } }) };
  const f = selected.fixture;
  if (selected.kind !== "resend") t.after(selected.fixture.close);
  if (selected.kind === "resend") value(await selected.fixture.send());
  const native = selected.kind === "case" ? selected.fixture.caseNative : selected.kind === "unlinked" ? selected.fixture.classNative : selected.fixture.nativePort;
  const source = await settlementNative(f.config.cliniko, f.intent, native, runtime); t.after(source.close);
  if (scenario === "paid") source.state.status = 20;
  if (scenario === "waived") source.state.waived = true;
  if (source.state.waived) await source.confirmWaiver();
  const classPolicy = selected.kind === "resend" ? undefined : value(await OwnerFileClassPolicy.capture({
    ...selected.fixture.classPolicy.binding(), path: selected.fixture.classPolicyPath,
    directory: new OwnerFileAdminDirectory(selected.fixture.classDirectoryPath, intent.scope), clock: f.config.cliniko.clock! }));
  const authority: FinancialConsumerAuthorities = {
    run: { allows: async () => true, current: () => true },
    pending: { allowsPendingRead: async () => true, allowsRecordRead: async () => true, current: () => true },
    checkout: f.checkoutAuthority, records: f.recordsAuthority, message: f.authority,
    ...(selected.kind === "case" ? { caseClassClinicalExpiry: { authority: selected.fixture.caseAuthority, classPolicy: classPolicy!, maximumAuthorityRequests: 0 } }
      : selected.kind === "unlinked" ? { classClinicalExpiry: { authority: selected.fixture.classAuthority, classPolicy: classPolicy! } }
      : { resend: { authority: selected.fixture.resendAuthority, maximumAuthorityRequests: 0 } }),
    work: { authorizeWork: async () => ({ reviewDate: "2026-11-02" }), providerBindingAuthorized: async () => true,
      current: () => true, onCheckoutAcknowledged: async () => { throw new Error("No new payable expected"); } },
    webhook: { allowsReferenceRead: async () => true, acceptsExistingPending: async () => true, current: () => true } };
  const stripe: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); if (url.pathname === "/v1/checkout/sessions" && init?.method === "GET") {
      const from = Number(url.searchParams.get("created[gte]")), through = Number(url.searchParams.get("created[lte]"));
      return Response.json({ object: "list", url: "/v1/checkout/sessions", has_more: false,
        data: f.sessions.filter(s => Number(s.created) >= from && Number(s.created) <= through) });
    }
    return selected.kind === "resend" ? selected.fixture.stripePort(input, init) : selected.fixture.expiryStripePort(input, init);
  };
  const checkout = { ...f.checkoutConfig, cliniko: f.config.cliniko, stripe: f.config.stripe };
  const config: FinancialConsumerConfig = { checkout, pollEveryMs: 1000, cycleDeadlineMs: 10_000,
    webhook: { endpointSecret: secret, accountRef: checkout.stripe.accountRef, livemode: false, apiVersion: checkout.stripe.apiVersion, clock: () => Date.parse(checkout.cliniko.clock!()) } };
  let notify!: (result: FinancialConsumerCycle) => void;
  const cycle = new Promise<FinancialConsumerCycle>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Compiled settlement cycle unavailable")), 15_000);
    notify = result => { clearTimeout(timer); resolve(result); };
  });
  const consumer = value(createFinancialSettlementConsumer(config, authority, source.review,
    { barrier: f.barrier, delivery: f.delivery, native: source.native, stripe, onCycle: notify },
    kind === "case" ? { caseClassClinicalExpiry: 6 } : kind === "resend" ? { resend: 8 } : {}));
  t.after(() => consumer.close()); value(consumer.start(stop())); const result = await cycle; await consumer.close();
  assert.ok(source.state.invoiceReads > 0);
  const effect = selected.kind === "resend" ? selected.fixture.selected.request.effectRef : f.intent.effects.clinicalExpiry;
  const rows = (await sql`select effect_ref from financial_effect_barriers where tenant_id = ${intent.scope.tenantId} and effect_ref = ${effect}::uuid`.execute(db)).rows;
  assert.equal(rows.length, scenario === "open" ? 1 : 0);
  assert.equal(kind === "resend" ? result.messageAccepted : result.clinicalExpiryCancelled, scenario === "open" ? 1 : 0);
  assert.equal(f.sessions.length, 1);
  if (selected.kind !== "resend") assert.equal(selected.fixture.cancellations.length, scenario === "open" ? 1 : 0);
  if (selected.kind === "resend") {
    const f = selected.fixture;
    assert.equal(f.messages.length, scenario === "open" ? 2 : 1);
    const approvals = (await sql`select effect_ref from financial_effect_barriers where tenant_id = ${intent.scope.tenantId}
      and effect_ref = ${f.selected.request.approvalRef}::uuid`.execute(db)).rows;
    assert.equal(approvals.length, scenario === "open" ? 1 : 0);
  }
  const canaries = [intent.recipient.address, apiKey, "Abby approved financial waiver v1", "cliniko:attendee:91", "cliniko:recall:71", "cs_test_owner", "private-class-case-notes"];
  assert.deepEqual(await scanPatientDataCanaries(db, canaries.map((value, i) => ({ label: `expanded_${i}`, value }))), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
  for (const canary of canaries) assert.equal(dump.includes(canary), false);
});
