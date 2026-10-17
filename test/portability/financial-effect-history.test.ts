import test from "node:test";
import assert from "node:assert/strict";
import { financialEffectArchiveRecord, financialEffectBarrierRow, validFinancialEffectHistory } from "../../src/portability/financial-effect-history.ts";

const row = { effectRef: "00000000-0000-4000-8000-000000000001", ownerBinding: "a".repeat(64), claimedAt: "2026-10-17T01:00:00.000Z" };
const scope = { tenantId: "fixture-tenant", clinicId: "fixture-clinic", locationId: "fixture-location" };
test("financial effect history is exact opaque consumed-ID metadata, including original scope", () => {
  assert.equal(validFinancialEffectHistory(undefined), true); assert.equal(validFinancialEffectHistory([]), true);
  assert.equal(validFinancialEffectHistory([row]), true);
  assert.equal(validFinancialEffectHistory([{ ...row, originScope: scope }]), true);
  assert.deepEqual(financialEffectBarrierRow({ ...row, originScope: scope }), row);
  const record = financialEffectArchiveRecord(scope, row);
  assert.equal(record.kind, "financialEffectBarrier"); assert.match(record.recordId, /^financialEffect:[a-f0-9]{64}:000000000001$/);
  assert.equal(Object.hasOwn(record, "paid"), false);
});
test("financial history refuses duplicate IDs, private fields, financial truth and malformed binding/time", () => {
  for (const patch of [
    { effectRef: "cs_private-payment-id" }, { effectRef: "00000000-0000-1000-8000-000000000001" },
    { ownerBinding: "native-patient" }, { claimedAt: "2026-11-31T01:00:00.000Z" }, { claimedAt: "2026-10-17T01:00:00Z" },
    { patientId: "21" }, { amount: 5000 }, { paid: true }, { recipient: "private@example.invalid" },
    { originScope: { ...scope, patientId: "21" } }, { originScope: { ...scope, locationId: "\nprivate" } },
  ]) assert.equal(validFinancialEffectHistory([{ ...row, ...patch }]), false);
  assert.equal(validFinancialEffectHistory([row, row]), false);
});
test("canonical record bytes give origin fields a stable order across decoded provider objects", () => {
  assert.equal(JSON.stringify(financialEffectArchiveRecord(scope, { ...row, originScope: scope })),
    JSON.stringify(financialEffectArchiveRecord(scope, { ...row, originScope: { locationId: scope.locationId, tenantId: scope.tenantId, clinicId: scope.clinicId } })));
});
