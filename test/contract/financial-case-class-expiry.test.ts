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

for (const race of ["paid", "caseLink", "counter", "clinical", "entitlement", "closedReview"] as const)
  test(`case expiry rechecks ${race} after retaining the possible native attempt`, async () => {
    let f!: Awaited<ReturnType<typeof caseClassExpiryFixture>>;
    f = await caseClassExpiryFixture({ retained(row) {
      if (race === "paid") f.paid();
      if (race === "caseLink") f.attendee.patient_case = { links: { self: "https://api.au5.cliniko.com/v1/patient_cases/72" } };
      if (race === "counter") f.caseRecord.max_sessions = 299;
      if (race === "clinical") f.denyClinical();
      if (race === "entitlement") f.changeCaseApproval({ entitlementRef: "other-entitlement" });
      if (race === "closedReview") row.recalled = true;
    } });
    try { assert.equal((await f.expireCase()).ok, false); assert.equal(f.cancellations.length, 0); }
    finally { await f.close(); }
  });
for (const change of ["closed", "expired", "archived"] as const) test(`cancelling a ${change} case does not restore its eligibility`, async () => {
  const f = await caseClassExpiryFixture(); try {
    if (change === "closed") f.caseRecord.closed_at = "2026-11-01T10:00:00.000Z";
    if (change === "expired") f.caseRecord.expiry_date = "2026-11-01";
    if (change === "archived") f.caseRecord.archived_at = "2026-11-01T10:00:00.000Z";
    assert.deepEqual(value(await f.expireCase()), { kind: "cancelled", money: "unpaid", reviewRequired: false });
    assert.equal(f.caseRecord.closed_at, change === "closed" ? "2026-11-01T10:00:00.000Z" : null);
    assert.equal(f.caseRecord.archived_at, change === "archived" ? "2026-11-01T10:00:00.000Z" : null);
    assert.equal(f.caseRecord.expiry_date, change === "expired" ? "2026-11-01" : "2026-11-30");
  } finally { await f.close(); }
});
test("missing physical quota headroom port cannot admit case expiry", async () => {
  const f = await caseClassExpiryFixture(); try {
    Reflect.deleteProperty(f.config.cliniko.rateBudget, "checkHeadroom");
    assert.equal((await f.expireCase()).ok, false); assert.equal(f.cancellations.length, 0);
    assert.equal(f.burned.has(f.intent.effects.clinicalExpiry), false);
  } finally { await f.close(); }
});
test("late received money and unverified case effect preserve separately inspected cancellation", async () => {
  let f!: Awaited<ReturnType<typeof caseClassExpiryFixture>>;
  f = await caseClassExpiryFixture({ caseRead() { if (f.cancellations.length) { f.paid(); f.caseRecord.max_sessions = 299; } } });
  try { assert.deepEqual(value(await f.expireCase()), { kind: "cancelled", money: "received", reviewRequired: true }); assert.equal(f.posts.length, 0); }
  finally { await f.close(); }
});

for (const mode of ["abort", "deadline"] as const)
  test(`a held case source respects ${mode} before consuming clinical permission`, { timeout: 4_000 }, async t => {
    let began!: () => void, release!: () => void;
    const reading = new Promise<void>(resolve => { began = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    const f = await caseClassExpiryFixture({ deadlineMs: 1_500, async caseRead() { began(); await held; } });
    const timer = setTimeout(release, 3_000); t.after(() => clearTimeout(timer)); t.after(release); t.after(f.close);
    const started = performance.now(), running = f.expireCase(controller.signal);
    await reading; if (mode === "abort") controller.abort();
    const result = await running;
    assert.ok(performance.now() - started < 2_500); assert.equal(result.ok, false);
    assert.equal(f.burned.has(f.intent.effects.clinicalExpiry), false); assert.equal(f.cancellations.length, 0);
    release();
  });
test("an overdue held case-effect inspection preserves its separately confirmed native cancellation", { timeout: 4_000 }, async t => {
  let release!: () => void, began!: () => void, blocked = false, elapsed = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { began = resolve; });
  let f!: Awaited<ReturnType<typeof caseClassExpiryFixture>>;
  f = await caseClassExpiryFixture({ deadlineMs: 1_500, async caseRead() { if (f.cancellations.length) { blocked = true; began(); await held; } } });
  t.after(release); t.after(f.close);
  // Reach the intended held post-cancellation inspection before exhausting the
  // same 1500ms operation deadline. Shared CPU speed cannot choose an earlier
  // failure point and accidentally turn this into a preparation-timeout test.
  const realNow = performance.now.bind(performance);
  t.mock.method(performance, "now", () => elapsed);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const running = f.expireCase(); await reading;
  const started = realNow(); elapsed = 1_501; t.mock.timers.tick(1_500);
  const result = await running;
  assert.ok(realNow() - started < 1_000); assert.equal(blocked, true);
  assert.deepEqual(value(result), { kind: "cancelled", money: "unknown", reviewRequired: true });
  assert.equal(f.cancellations.length, 1); release();
});
