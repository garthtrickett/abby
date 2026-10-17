import assert from "node:assert/strict";
import test from "node:test";
import { unlinkedClassExpiryFixture, value, stop } from "../support/financial-unlinked-class-expiry.ts";
import { decodeFinancialExpiryAttempt } from "../../src/cliniko/financial-expiry-attempt.ts";
function attempts(f: Awaited<ReturnType<typeof unlinkedClassExpiryFixture>>) {
  return [...f.rows.values()].flatMap(row => { const decoded = decodeFinancialExpiryAttempt(row.notes); return decoded.ok ? [decoded.value] : []; });
}
test("independent class expiry requires native unlinked filters and its own inspected cancellation", async () => {
  const f = await unlinkedClassExpiryFixture(); try {
    assert.deepEqual(value(await f.expireClass()), { kind: "cancelled", money: "unpaid", reviewRequired: false });
    assert.equal(f.cancellations.length, 1); assert.ok(f.filters.length >= 8); assert.equal(f.posts.length, 0);
    assert.equal(attempts(f).length, 1); assert.equal(attempts(f)[0]!.purpose, "clinicalExpiry");
    assert.equal(f.burned.has(f.intent.effects.checkoutExpiry), false);
    assert.equal((await f.expireClass()).ok, false); assert.equal((await value(f.makeClass()).expireOnce(f.binding, stop())).ok, false);
    assert.equal(f.cancellations.length, 1); assert.equal(JSON.stringify(value(f.makeClass())), "{}");
  } finally { await f.close(); }
});
for (const gate of ["denySource", "denyHistory", "denyReference", "denyFinancial", "denyProvider", "denyClinical", "denyProducer", "retire"] as const)
  test(`unpaid class context cannot bypass independent ${gate}`, async () => {
    const f = await unlinkedClassExpiryFixture(); try {
      f[gate](); assert.equal((await f.expireClass()).ok, false); assert.equal(f.cancellations.length, 0);
      assert.equal(f.burned.has(f.intent.effects.clinicalExpiry), false); assert.equal(attempts(f).length, 0);
    } finally { await f.close(); }
  });
for (const options of [{ legacy: true }, { requestedCase: "71" }]) test(`original class evidence refuses ${JSON.stringify(options)}`, async () => {
  const f = await unlinkedClassExpiryFixture(options); try {
    assert.equal((await f.expireClass()).ok, false); assert.equal(f.cancellations.length, 0); assert.equal(attempts(f).length, 0);
  } finally { await f.close(); }
});
for (const change of [{ classPolicyVersion: "changed" }, { policyVersion: "changed" }, { termsVersion: "changed" },
  { approvedTerms: "Other terms." }, { timeZone: "Etc/UTC" }]) test(`unlinked class refuses changed clinical approval ${Object.keys(change)[0]}`, async () => {
  const f = await unlinkedClassExpiryFixture(); try {
    f.changeApproval(change); assert.equal((await f.expireClass()).ok, false); assert.equal(f.cancellations.length, 0); assert.equal(attempts(f).length, 0);
  } finally { await f.close(); }
});
for (const change of ["linked", "otherPatient", "otherCreation", "time", "duplicateAttendance", "paid", "policy"] as const)
  test(`current ${change} cannot be inferred from original creation evidence`, async () => {
    const f = await unlinkedClassExpiryFixture(); try {
      if (change === "linked") f.linkCase();
      if (change === "otherPatient") f.attendee.patient = { links: { self: "https://api.au5.cliniko.com/v1/patients/99" } };
      if (change === "otherCreation") f.attendee.notes = "Abby attendance 00000000-0000-4000-8000-000000000099";
      if (change === "time") f.attendance.groups[0]!.ends_at = "2026-11-03T09:45:00.000Z";
      if (change === "duplicateAttendance") f.attendance.attendees.push({ ...f.attendee, id: "92", links: { self: "https://api.au5.cliniko.com/v1/attendees/92" } });
      if (change === "paid") f.paid();
      if (change === "policy") await f.changePolicy({ enabled: false });
      assert.equal((await f.expireClass()).ok, false); assert.equal(f.cancellations.length, 0); assert.equal(attempts(f).length, 0);
    } finally { await f.close(); }
  });
for (const race of ["paid", "linked", "permission", "closedReview"] as const) test(`class expiry rechecks ${race} after retaining its possible native attempt`, async () => {
  let f!: Awaited<ReturnType<typeof unlinkedClassExpiryFixture>>;
  f = await unlinkedClassExpiryFixture({ retained(row) {
    if (race === "paid") f.paid(); if (race === "linked") f.linkCase(); if (race === "permission") f.denyClinical(); if (race === "closedReview") row.recalled = true;
  } });
  try { assert.equal((await f.expireClass()).ok, false); assert.equal(f.cancellations.length, 0); assert.equal(attempts(f).length, 1); }
  finally { await f.close(); }
});
test("native class attempt history prevents a cold replay when the local opaque claim is missing", async () => {
  const f = await unlinkedClassExpiryFixture({ cancel: () => { throw new Error("lost class cancellation response"); } });
  try {
    assert.equal(value(await f.expireClass()).kind, "uncertain"); assert.equal(f.cancellations.length, 1);
    f.burned.delete(f.intent.effects.clinicalExpiry);
    for (const row of f.rows.values()) if (decodeFinancialExpiryAttempt(row.notes).ok) row.recalled = true;
    assert.equal((await value(f.makeClass()).expireOnce(f.binding, stop())).ok, false); assert.equal(f.cancellations.length, 1);
  } finally { await f.close(); }
});
test("a class204 without an exact cancelled inspection remains uncertain", async () => {
  const f = await unlinkedClassExpiryFixture({ cancel: () => new Response(null, { status: 204 }) });
  try { const result = value(await f.expireClass()); assert.equal(result.kind, "uncertain"); assert.equal(result.reviewRequired, true); assert.equal(f.cancellations.length, 1); }
  finally { await f.close(); }
});
test("received money after an inspected class cancellation remains received and requires review", async () => {
  let f!: Awaited<ReturnType<typeof unlinkedClassExpiryFixture>>;
  f = await unlinkedClassExpiryFixture({ cancel(row) { row.cancelled_at = f.config.cliniko.clock!(); row.cancellation_reason = 50; f.paid(); return new Response(null, { status: 204 }); } });
  try { assert.deepEqual(value(await f.expireClass()), { kind: "cancelled", money: "received", reviewRequired: true }); assert.equal(f.cancellations.length, 1); assert.equal(f.posts.length, 0); }
  finally { await f.close(); }
});
for (const mode of ["abort", "deadline"] as const) test(`a held class native read respects ${mode} and cannot dispatch later`, async () => {
  const controller = new AbortController(); let began!: () => void; const reading = new Promise<void>(done => { began = done; });
  let release!: () => void; const gate = new Promise<void>(done => { release = done; });
  const f = await unlinkedClassExpiryFixture({ ...(mode === "deadline" ? { deadlineMs: 150 } : {}), async read() { began(); await gate; } });
  try {
    const running = f.expireClass(controller.signal); await reading; if (mode === "abort") controller.abort();
    assert.equal((await running).ok, false); release(); await new Promise<void>(done => setImmediate(done)); assert.equal(f.cancellations.length, 0);
  } finally { release(); controller.abort(); await f.close(); }
});
