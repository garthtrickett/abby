import assert from "node:assert/strict";
import test from "node:test";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { financialConsumerFixture } from "../support/financial-consumer.ts";

test("financial consumer composition requires its exact clinic/account and physical budget", async t => {
  const f = await financialConsumerFixture(); t.after(() => f.consumer.close());
  const native = f.config.checkout.cliniko, fp = clinikoCredentialFingerprint(native.apiKey);
  assert.equal(f.consumer.matchesAccount(native.scope, fp, native.rateBudget), true);
  for (const key of ["tenantId", "clinicId", "locationId"] as const)
    assert.equal(f.consumer.matchesAccount({ ...native.scope, [key]: "foreign" }, fp, native.rateBudget), false);
  assert.equal(f.consumer.matchesAccount(native.scope, "f".repeat(64), native.rateBudget), false);
  assert.equal(f.consumer.matchesAccount(native.scope, fp, { ...native.rateBudget }), false);
  assert.equal(f.sessions.length, 0); assert.equal(f.messages.length, 0);
});
test("editing the supplied financial configuration cannot rebind an already constructed owner", async t => {
  const f = await financialConsumerFixture(); t.after(() => f.consumer.close());
  const native = f.config.checkout.cliniko, scope = { ...native.scope }, fp = clinikoCredentialFingerprint(native.apiKey), budget = native.rateBudget;
  const foreign = { ...scope, tenantId: "foreign" }, replacement = { ...budget };
  assert.equal(Reflect.set(native, "scope", foreign), true);
  assert.equal(Reflect.set(native, "apiKey", "foreign-key-au5"), true);
  assert.equal(Reflect.set(native, "rateBudget", replacement), true);
  assert.equal(f.consumer.matchesAccount(scope, fp, budget), true);
  assert.equal(f.consumer.matchesAccount(foreign, clinikoCredentialFingerprint("foreign-key-au5"), replacement), false);
  assert.equal(f.sessions.length, 0); assert.equal(f.messages.length, 0);
});
