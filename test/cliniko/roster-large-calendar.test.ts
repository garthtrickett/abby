import assert from "node:assert/strict";
import test from "node:test";
import { rosterBookingFixture, rosterInterval, rosterPlan } from "../support/roster-booking.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";

async function largeCalendar(budget?: ClinikoRequestBudget) {
  const f = await rosterBookingFixture({ ...rosterPlan, maxSearchDays: 90 }, 90, budget);
  f.calendar.rows.daily_availabilities = [];
  f.calendar.rows.availability_blocks = [rosterInterval("availability_blocks", "102", "2026-11-20T04:00:00.000Z", "2026-11-20T06:00:00.000Z")];
  f.calendar.rows.group_appointments = [];
  for (let n = 0; n < 1200; n++) {
    const start = Date.parse("2026-10-08T08:00:00Z") + Math.floor(n / 20) * 86_400_000 + (n % 20) * 60_000;
    f.calendar.rows.group_appointments.push(rosterInterval("group_appointments", String(200 + n), new Date(start).toISOString(), new Date(start + 5 * 60_000).toISOString(), n % 2 ? "12" : "11"));
  }
  f.calendar.rows.group_appointments.push(rosterInterval("group_appointments", "6000", "2026-10-30T00:00:00.000Z", "2026-11-10T00:00:00.000Z", "12"));
  return f;
}

test("E2E-358 complete large calendars split oversized native busy ranges and retain late offline choices", async () => {
  const f = await largeCalendar();
  try {
    const proof = await f.verify(), offered = resultValue(await f.list(proof, "2026-10-08", "2026-11-30"));
    assert.equal(offered.choices[0]!.startsAt, "2026-11-20T04:00:00.000Z");
    const queries = new Set(f.calendar.requests.filter(r => r.collection === "group_appointments").map(r => r.filters.join("|")));
    assert.equal(queries.size, 3); assert.equal(f.claims, f.allTraffic.length + f.calendar.requests.length);
    assert.equal(JSON.stringify(offered).includes("private-calendar-canary"), false); assert.equal(f.posts, 0);
    assert.equal(f.allTraffic.some(path => path.endsWith("/available_times")), false);
  } finally { await f.close(); }
});

for (const fault of ["failedHalf", "changedCrossingRecord", "budgetExhausted", "missingHalfRecord"] as const) test(`E2E-358 ${fault} cannot publish partial adaptive calendar evidence`, async () => {
  let exhausted = false;
  const f = await largeCalendar(fault === "budgetExhausted" ? { claim: async () => exhausted ? { kind: "rateLimited", resetAt: "2026-10-04T06:01:00.000Z" } : null,
    observe429: async () => ({ kind: "rateLimited" }) } : undefined);
  try {
    const proof = await f.verify();
    f.calendar.onRead((name, count) => {
      const request = f.calendar.requests.at(-1)!;
      if (name !== "group_appointments") return;
      if (fault === "missingHalfRecord" && count === 2) f.calendar.rows.group_appointments!.shift();
      const lower = request.filters.find(q => q.startsWith("ends_at:>"))!.slice(9);
      if (Date.parse(lower) <= Date.parse("2026-10-08T13:00:00Z")) return;
      if (fault === "failedHalf") f.calendar.fail(name);
      if (fault === "changedCrossingRecord") f.calendar.rows.group_appointments!.at(-1)!.ends_at = "2026-11-10T00:01:00.000Z";
      if (fault === "budgetExhausted") exhausted = true;
    });
    assert.equal((await f.list(proof, "2026-10-08", "2026-11-30")).ok, false); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

for (const sunday of [0, 7]) test(`E2E-358 Sunday ${sunday} roster convention preserves the same clinic day`, async () => {
  const f = await rosterBookingFixture();
  try {
    f.calendar.rows.daily_availabilities![0]!.day_of_week = sunday;
    const proof = await f.verify(), offered = resultValue(await f.list(proof, "2026-10-11", "2026-10-11"));
    assert.equal(offered.choices[0]!.startsAt, "2026-10-10T22:00:00.000Z"); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});
