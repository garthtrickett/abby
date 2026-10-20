import test from "node:test";
import assert from "node:assert/strict";
import { outboundEffectArchiveRecord, outboundEffectBarrierRow, validOutboundEffectHistory } from "../../src/portability/outbound-effect-history.ts";

const row = { effectRef: "00000000-0000-4000-8000-000000000001", ownerBinding: "a".repeat(64), claimedAt: "2026-10-17T01:00:00.000Z" };
const scope = { tenantId: "fixture-tenant", clinicId: "fixture-clinic", locationId: "fixture-location" };
test("outbound effect history is exact opaque consumed-ID metadata, including original scope", () => {
  assert.equal(validOutboundEffectHistory(undefined), true); assert.equal(validOutboundEffectHistory([]), true);
  assert.equal(validOutboundEffectHistory([row]), true);
  assert.equal(validOutboundEffectHistory([{ ...row, originScope: scope }]), true);
  assert.deepEqual(outboundEffectBarrierRow({ ...row, originScope: scope }), row);
  const record = outboundEffectArchiveRecord(scope, row);
  assert.equal(record.kind, "outboundEffectBarrier"); assert.match(record.recordId, /^outboundEffect:[a-f0-9]{64}:000000000001$/);
  assert.equal(Object.hasOwn(record, "paid"), false);
});
test("outbound history refuses duplicate IDs, private fields, outbound truth and malformed binding/time", () => {
  for (const patch of [
    { effectRef: "cs_private-payment-id" }, { effectRef: "00000000-0000-1000-8000-000000000001" },
    { ownerBinding: "native-patient" }, { claimedAt: "2026-11-31T01:00:00.000Z" }, { claimedAt: "2026-10-17T01:00:00Z" },
    { patientId: "21" }, { amount: 5000 }, { paid: true }, { recipient: "private@example.invalid" },
    { originScope: { ...scope, patientId: "21" } }, { originScope: { ...scope, locationId: "\nprivate" } },
  ]) assert.equal(validOutboundEffectHistory([{ ...row, ...patch }]), false);
  assert.equal(validOutboundEffectHistory([row, row]), false);
});
test("canonical record bytes give origin fields a stable order across decoded provider objects", () => {
  assert.equal(JSON.stringify(outboundEffectArchiveRecord(scope, { ...row, originScope: scope })),
    JSON.stringify(outboundEffectArchiveRecord(scope, { ...row, originScope: { locationId: scope.locationId, tenantId: scope.tenantId, clinicId: scope.clinicId } })));
});
