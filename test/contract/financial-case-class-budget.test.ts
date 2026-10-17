import assert from "node:assert/strict";
import test from "node:test";
import { caseClassExpiryFixture, value } from "../support/financial-case-class-expiry.ts";
import { classAttendee, classLink } from "../support/class-attendance.ts";
function history(f: Awaited<ReturnType<typeof caseClassExpiryFixture>>, count: number) {
  for (let i = 1; i < count; i++) f.caseRows.push({ ...classAttendee(String(1000+i), String(2000+i), f.intent.patientId),
    arrived: null, cancellation_reason: null, patient_case: classLink("patient_cases", "71") });
  f.caseRecord.attendee_ids = f.caseRows.map(row => row.id);
}
for (const count of [1, 501, 1_000]) test(`complete case history ${count} fits its admitted physical account plan`, { timeout: 10_000 }, async () => {
  const f = await caseClassExpiryFixture(); try {
    history(f, count); const result = value(await f.expireCase()); assert.equal(result.kind, "cancelled"); assert.equal(result.reviewRequired, false);
    assert.equal(f.cancellations.length, 1); assert.ok(f.claims <= 180);
    const admitted = f.headrooms.at(-1); assert.ok(admitted?.admitted); assert.ok(f.claimsAtClinicalClaim !== undefined);
    assert.ok(f.claims - f.claimsAtClinicalClaim <= admitted.required, "remaining physical requests do not exceed the declared admission plan");
  } finally { await f.close(); }
});
test("over-bound case history refuses before a possible clinical effect", async () => {
  const f = await caseClassExpiryFixture(); try {
    history(f, 1_001); assert.equal((await f.expireCase()).ok, false); assert.equal(f.cancellations.length, 0);
    assert.equal(f.burned.has(f.intent.effects.clinicalExpiry), false);
  } finally { await f.close(); }
});
test("combined maximum class metadata roster and case history refuse before claiming an insufficient physical plan", { timeout: 10_000 }, async () => {
  const f = await caseClassExpiryFixture(); try {
    history(f, 1_000);
    for (let i = 0; i < 499; i++) f.attendance.attendees.push({ ...classAttendee(String(3000+i), "91", String(4000+i), "2026-11-01T10:00:00.000Z"), arrived: null });
    f.attendance.onResponse((path, body) => {
      const name = path === "/v1/practitioners/22/businesses" ? "businesses" : path === "/v1/practitioners/22/appointment_types" ? "appointment_types" : undefined;
      if (!name) return;
      const page = f.attendance.traffic.at(-1)!.page;
      const rows = Array.from({ length: 500 }, (_, i) => { const id = i === 0 ? name === "businesses" ? "11" : "33" : String(1000+i); return { id, ...classLink(name, id) }; });
      body[name] = rows.slice((page-1)*100, page*100); body.total_entries = rows.length;
    });
    assert.equal((await f.expireCase()).ok, false); assert.equal(f.cancellations.length, 0);
    assert.equal(f.burned.has(f.intent.effects.clinicalExpiry), false); assert.equal(f.headrooms.at(-1)?.admitted, false);
  } finally { await f.close(); }
});
