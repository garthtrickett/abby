import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { outboundCapacityOwnerBinding } from "../../src/core/outbound-capacity.ts";
import { validOutboundCapacityHistory, outboundCapacityArchiveRecord } from "../../src/portability/outbound-capacity-history.ts";
const row = () => ({ allocationRef: randomUUID(), ownerBinding: "a".repeat(64), acquiredAt: "2026-10-19T00:00:00.000Z", releasedAt: null });
test("capacity history preserves held and released random IDs without private context", () => {
  const held = row(), released = { ...row(), releasedAt: "2026-10-19T00:01:00.000Z" };
  assert.equal(validOutboundCapacityHistory(undefined), true); assert.equal(validOutboundCapacityHistory([held, released]), true);
  assert.equal(validOutboundCapacityHistory([held, held]), false);
  const scope = { tenantId: "fixture", clinicId: "clinic", locationId: "location" };
  assert.equal(validOutboundCapacityHistory([{ ...held, originScope: scope }]), true);
  assert.equal(outboundCapacityArchiveRecord(scope, held).kind, "outboundCapacityAllocation");
});
for (const change of [{ allocationRef: "private-provider-call-id" }, { ownerBinding: "private-patient-id" }, { patientId: "21" },
  { acquiredAt: "2026-02-30T00:00:00.000Z" }, { releasedAt: "2026-10-18T00:00:00.000Z" }, { releasedAt: undefined }, { originScope: null }])
  test(`capacity archive refuses ${Object.keys(change)[0]} drift`, () => assert.equal(validOutboundCapacityHistory([{ ...row(), ...change }]), false));
test("campaign occupancy binding is stable, opaque and refuses nonrandom identity", () => {
  const ref = randomUUID(); assert.equal(outboundCapacityOwnerBinding(ref), outboundCapacityOwnerBinding(ref));
  assert.match(outboundCapacityOwnerBinding(ref)!, /^[a-f0-9]{64}$/);
  assert.notEqual(outboundCapacityOwnerBinding(ref), outboundCapacityOwnerBinding(randomUUID()));
  assert.equal(outboundCapacityOwnerBinding("cliniko:patient:21"), undefined);
});
