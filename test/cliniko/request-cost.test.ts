import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoReadBudget, clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { declareClinikoRequestCost, clinikoRequestCeiling, inheritClinikoRequestCost } from "../../src/cliniko/request-cost.ts";

test("Cliniko callback ceilings require an exact trusted callback, account and physical budget", async () => {
  const binding = { scope: { tenantId: "cost", clinicId: "clinic" }, credentialFingerprint: clinikoCredentialFingerprint("synthetic-au5"), budget: new ClinikoReadBudget() };
  let calls = 0;
  const original = async (value: number) => { calls++; return value + 1; };
  assert.equal(clinikoRequestCeiling(original, binding), undefined);
  const port = declareClinikoRequestCost(original, binding, 3);
  assert.equal(clinikoRequestCeiling(port, binding), 3);
  assert.equal(await port(4), 5); assert.equal(calls, 1);
  assert.equal(clinikoRequestCeiling(port.bind(undefined), binding), undefined, "a new callback does not inherit a contract implicitly");
  for (const foreign of [{ ...binding, budget: new ClinikoReadBudget() }, { ...binding, credentialFingerprint: clinikoCredentialFingerprint("other-au5") },
    { ...binding, scope: { ...binding.scope, clinicId: "other" } }, { ...binding, scope: { ...binding.scope, tenantId: "other" } }])
    assert.equal(clinikoRequestCeiling(port, foreign), undefined);
  const forwarded = inheritClinikoRequestCost(async (n: number) => port(n), port);
  assert.equal(clinikoRequestCeiling(forwarded, binding), 3); assert.equal(await forwarded(5), 6);
  assert.equal(clinikoRequestCeiling(inheritClinikoRequestCost(original, original), binding), undefined);
  for (const invalid of [-1, 201, NaN, Infinity, 0.5]) assert.throws(() => declareClinikoRequestCost(original, binding, invalid));
  assert.equal(clinikoRequestCeiling(declareClinikoRequestCost(original, binding, 0), binding), 0, "explicit zero is distinct from unknown");
});
