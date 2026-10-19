import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresFinancialEffectBarrier } from "../../src/storage/postgres-financial-effect-barrier.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { financialRecordOwnerBinding } from "../../src/cliniko/financial-record-retention.ts";
import { financialIntentDigest } from "../../src/cliniko/financial-booking-observation.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { financialConsumerFixture } from "../support/financial-consumer.ts";
import { financialSourceApprovalFixture } from "../support/financial-source-approval.ts";
import { waiverFixture, issuerKey } from "../support/financial-waiver.ts";
import { intentValue, value, base, stop } from "../support/financial-retention.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/src/standalone/", import.meta.url);
const { createFinancialSettlementConsumer } = await import(new URL("financial-settlement-authorities.js", emitted).href) as typeof import("../../src/standalone/financial-settlement-authorities.ts");
const { ClinikoFinancialSettlementReview } = await import(new URL("cliniko-financial-settlement-review.js", emitted).href) as typeof import("../../src/standalone/cliniko-financial-settlement-review.ts");
const { ApprovedFinancialWaiverIssuer, financialWaiverContentPolicy } = await import(new URL("approved-financial-waiver-issuer.js", emitted).href) as typeof import("../../src/standalone/approved-financial-waiver-issuer.ts");
const { OwnerFileFinancialSource, financialSourceSelection } = await import(new URL("owner-file-financial-source.js", emitted).href) as typeof import("../../src/standalone/owner-file-financial-source.ts");

for (const scenario of ["open", "recordedPaid", "waived"] as const)
test(`compiled reviewed financial consumer with PostgreSQL, native180 and ${scenario} evidence`, { timeout: 30_000 }, async t => {
  const apiKey = `synthetic-settlement-${randomUUID()}-au5`, original = intentValue();
  const intent = { ...original, scope: { ...original.scope, tenantId: `settlement-${randomUUID()}` }, actionRef: randomUUID(),
    credentialFingerprint: clinikoCredentialFingerprint(apiKey), booking: { ...original.booking, actionRef: randomUUID() },
    effects: { checkout: randomUUID(), linkDelivery: randomUUID(), receiptDelivery: randomUUID(), checkoutExpiry: randomUUID(), clinicalExpiry: randomUUID() } };
  const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const f = await financialConsumerFixture({ checkout: { native: { intent, config: { apiKey, rateBudget: budget },
    barrierFactory: config => new PostgresFinancialEffectBarrier(db, config.scope, value(financialRecordOwnerBinding(config))) } } });
  t.after(() => f.consumer.close());
  const nativeConfig = f.config.checkout.cliniko, targetRef = "cliniko:appointment:91";
  const invoice = { financialActionRef: intent.actionRef, invoiceRef: "72", patientId: intent.patientId, bookingId: "91", bookingKind: "book" as const,
    expectedTotalMinor: intent.payment.amount, currency: intent.payment.currency, expiresAt: "2026-11-01T11:00:00.000Z" };
  const invoiceRow = { id: "72", links: { self: `${base}/invoices/72` }, patient: { links: { self: `${base}/patients/${intent.patientId}` } },
    business: { links: { self: `${base}/businesses/${intent.businessId}` } }, booking: { links: { self: `${base}/bookings/91` } },
    status: scenario === "recordedPaid" ? 20 : 10, total_amount: "50.00", archived_at: null, deleted_at: null,
    created_at: intent.createdAt, updated_at: intent.createdAt, notes: "private-settlement-invoice-note", invoice_to: "private-settlement-address" };
  let invoiceReads = 0;
  const native: typeof fetch = async (input, init) => {
    if (String(input) === `${base}/invoices/72`) { invoiceReads++; assert.equal(init?.method, "GET"); return Response.json(invoiceRow); }
    return f.dependencies.native(input, init);
  };
  const signed = waiverFixture(), decision = { ...signed.decision, actionRef: randomUUID(), financialActionRef: intent.actionRef,
    intentDigest: financialIntentDigest(intent)!, amount: intent.payment.amount, currency: intent.payment.currency };
  const binding = { intent, intentRecallRef: "cliniko:recall:30", targetRef, waiverRecallRef: "cliniko:recall:71", decisionRef: decision.actionRef };
  const source = await financialSourceApprovalFixture(); t.after(source.close);
  source.state.now = nativeConfig.clock!();
  source.state.account = { ...source.state.account!, actor: { ...source.state.account!.actor, scope: intent.scope } };
  const waiverConfig = { ...nativeConfig, recallTypeId: "49" };
  const selection = value(financialSourceSelection({ ...waiverConfig, producer: issuerKey }, financialWaiverContentPolicy));
  const { scope: _scope, ...selected } = selection;
  await source.replace({ scope: intent.scope, source: selected });
  const definition = value(await OwnerFileFinancialSource.capture({ ...source.config, scope: intent.scope }, stop()));
  const issuer = value(ApprovedFinancialWaiverIssuer.create(waiverConfig, issuerKey, definition));
  if (scenario === "waived") f.rows.set("71", { id: "71", links: { self: `${base}/recalls/71` },
    patient: { links: { self: `${base}/patients/${intent.patientId}` } }, recall_type: { links: { self: `${base}/recall_types/49` } },
    notes: signed.format(decision), recalled: false, recalled_at: null, archived_at: null, recall_at: "2026-11-02",
    created_at: decision.approvedAt, updated_at: decision.approvedAt });
  const review = value(ClinikoFinancialSettlementReview.create(nativeConfig, {
    bindings: { resolve: async () => ({ targetRef, invoice, ...(scenario === "waived" ? { waiver: binding } : {}) }), current: () => true },
    invoices: { allows: async () => true, current: () => true },
    waivers: { config: waiverConfig, issuer, authority: { allows: async () => true, current: () => true } }, native }));
  const consumer = value(createFinancialSettlementConsumer(f.config, f.authority, review, { ...f.dependencies, native }));
  t.after(() => consumer.close());
  const pending = f.cycle(); value(consumer.start(stop())); const result = await pending;
  assert.ok(invoiceReads > 0);
  assert.equal(result.creationAcknowledged, scenario === "open" ? 1 : 0); assert.equal(f.sessions.length, scenario === "open" ? 1 : 0);
  await consumer.close();
  const claim = await sql<{ effect_ref: string }>`select effect_ref from financial_effect_barriers
    where tenant_id = ${intent.scope.tenantId} and effect_ref = ${intent.effects.checkout}::uuid`.execute(db);
  assert.equal(claim.rows.length, scenario === "open" ? 1 : 0);
  const canaries = [intent.recipient.address, "private-settlement-invoice-note", "private-settlement-address", "Abby approved financial waiver v1",
    "cliniko:appointment:91", "cliniko:recall:71", "cs_test_owner"];
  assert.deepEqual(await scanPatientDataCanaries(db, canaries.map((value, i) => ({ label: `settlement_${i}`, value }))), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
  for (const canary of canaries) assert.equal(dump.includes(canary), false);
  const rows = (await sql<Record<string, unknown>>`select * from financial_effect_barriers where tenant_id = ${intent.scope.tenantId}`.execute(db)).rows;
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["claimed_at", "clinic_id", "effect_ref", "location_id", "owner_binding", "tenant_id"]);
});
