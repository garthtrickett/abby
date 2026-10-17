import assert from "node:assert/strict";
import test from "node:test";
import { caseClassExpiryFixture, value, stop } from "../support/financial-case-class-expiry.ts";
for (const options of [{}, { includeCancelled: true }, { includeCancelled: true, arrivedFalse: true }, { arrivedFalse: true }])
  test(`case class expiry inspects its independently approved counter effect ${JSON.stringify(options)}`, async () => {
    const f = await caseClassExpiryFixture(options); try {
      assert.deepEqual(value(await f.expireCase()), { kind: "cancelled", money: "unpaid", reviewRequired: false });
      assert.equal(f.cancellations.length, 1); assert.ok(f.caseReads > 0); assert.ok(f.claims <= 180);
      assert.equal((await value(f.makeCase()).expireOnce(f.binding, stop())).ok, false); assert.equal(f.cancellations.length, 1);
    } finally { await f.close(); }
  });
for (const gate of ["denySource", "denyHistory", "denyReference", "denyProvider", "denyFinancial", "denyClinical", "denyProducer", "retire"] as const)
  test(`case expiry cannot infer independent ${gate} from counters or closed-unpaid Stripe`, async () => {
    const f = await caseClassExpiryFixture(); try {
      f[gate](); assert.equal((await f.expireCase()).ok, false); assert.equal(f.cancellations.length, 0);
      assert.equal(f.burned.has(f.intent.effects.clinicalExpiry), false);
    } finally { await f.close(); }
  });
for (const change of [{ caseEffect: "consumeOne" as const }, { patientCaseId: "72" }, { caseTermsVersion: "other" },
  { approvedCaseTerms: "Other terms." }, { classPolicyVersion: "other" }, { entitlementRef: "" }])
  test(`case expiry refuses changed approved ${Object.keys(change)[0]}`, async () => {
    const f = await caseClassExpiryFixture(); try {
      f.changeCaseApproval(change); assert.equal((await f.expireCase()).ok, false); assert.equal(f.cancellations.length, 0);
      assert.equal(f.burned.has(f.intent.effects.clinicalExpiry), false);
    } finally { await f.close(); }
  });
test("the original requested case cannot be replaced by the presently linked case", async () => {
  const f = await caseClassExpiryFixture({ originalCase: "72" }); try {
    assert.equal((await f.expireCase()).ok, false); assert.equal(f.cancellations.length, 0);
  } finally { await f.close(); }
});
test("insufficient shared quota refuses before a possible clinical effect claim", async () => {
  const f = await caseClassExpiryFixture(); try {
    for (let i = 0; i < 120; i++) assert.equal(f.budget.claim(), null);
    assert.equal((await f.expireCase()).ok, false); assert.equal(f.cancellations.length, 0);
    assert.equal(f.burned.has(f.intent.effects.clinicalExpiry), false);
  } finally { await f.close(); }
});
test("failed later case inspection cannot erase an already inspected native cancellation", async () => {
  let f!: Awaited<ReturnType<typeof caseClassExpiryFixture>>;
  f = await caseClassExpiryFixture({ caseRead() { if (f.cancellations.length) f.caseRecord.max_sessions = 299; } });
  try {
    assert.deepEqual(value(await f.expireCase()), { kind: "cancelled", money: "unpaid", reviewRequired: true });
    assert.equal(f.cancellations.length, 1); assert.equal(f.posts.length, 0);
  } finally { await f.close(); }
});
