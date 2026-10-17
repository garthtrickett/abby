import assert from "node:assert/strict";
import test from "node:test";
import { classFinancialBookingRequestPlan } from "../../src/cliniko/class-booking-workload.ts";

const costs = { proof: 1, ownership: 0, permit: 0, passSelect: 0, financialCurrent: 0, source: 0, recordPermit: 0, recordProducer: 0, capture: 1 };
test("complete financial class bounds include full metadata, rosters, three case histories, proof and retention", () => {
  assert.deepEqual(classFinancialBookingRequestPlan(costs, true), { write: 149, confirmation: 149 });
  assert.deepEqual(classFinancialBookingRequestPlan(costs, false), { write: 77, confirmation: 77 });
  assert.deepEqual(classFinancialBookingRequestPlan({ ...costs, capture: 0 }, true), { write: 147, confirmation: 147 });
  assert.deepEqual(classFinancialBookingRequestPlan({ ...costs, proof: 2, ownership: 1, permit: 1, passSelect: 1 }, true), { write: 177, confirmation: 180 });
  assert.equal(classFinancialBookingRequestPlan({ ...costs, proof: 2, ownership: 2, permit: 1, passSelect: 1 }, true), undefined);
});
for (const field of Object.keys(costs)) test(`unknown, malformed or unbounded ${field} cannot supply a financial class plan`, () => {
  for (const value of [undefined, -1, 0.5, NaN, Infinity, 201, "0"]) assert.equal(classFinancialBookingRequestPlan({ ...costs, [field]: value }, true), undefined);
});
test("cost accessors, extra fields, invalid capture and proxies cannot grant quota admission", () => {
  const getter = { ...costs }; Object.defineProperty(getter, "proof", { get() { throw new Error("Private external value"); }, enumerable: true });
  assert.equal(classFinancialBookingRequestPlan(getter, true), undefined);
  assert.equal(classFinancialBookingRequestPlan({ ...costs, callbackName: "trusted" }, true), undefined);
  assert.equal(classFinancialBookingRequestPlan({ ...costs, capture: 2 }, true), undefined);
  assert.equal(classFinancialBookingRequestPlan(new Proxy({}, { getPrototypeOf() { throw new Error("Private proxy value"); } }), true), undefined);
});
