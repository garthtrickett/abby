import assert from "node:assert/strict";
import test from "node:test";
import { rosterStarts } from "../../src/cliniko/roster-calendar.ts";
import { rosterPlan } from "../support/roster-booking.ts";

test("E2E-357 roster calculation uses real DST intervals, keeps both folds and cannot invent spring-gap starts", () => {
  const common = { timeZone: "Australia/Sydney", durationMinutes: 30, plan: { ...rosterPlan, slotIntervalMinutes: 30 },
    daily: [{ dayOfWeek: 0, intervals: [{ startMinute: 60, endMinute: 240 }] }], extra: [], busy: [], signal: new AbortController().signal };
  assert.deepEqual(rosterStarts({ ...common, from: "2026-10-04", to: "2026-10-04" }), [
    "2026-10-03T15:00:00.000Z", "2026-10-03T15:30:00.000Z", "2026-10-03T16:00:00.000Z", "2026-10-03T16:30:00.000Z",
  ]);
  const fall = rosterStarts({ ...common, from: "2027-04-04", to: "2027-04-04" });
  assert.equal(fall.length, 8); assert.equal(new Set(fall).size, 8);
});

test("E2E-357 extra intervals retain their grid origin and full duration across a midnight query boundary", () => {
  const starts = rosterStarts({ from: "2026-10-08", to: "2026-10-08", timeZone: "UTC", durationMinutes: 60,
    plan: { ...rosterPlan, slotIntervalMinutes: 15 }, daily: [],
    extra: [{ start: Date.parse("2026-10-07T23:07:00Z"), end: Date.parse("2026-10-09T01:07:00Z") }], busy: [], signal: new AbortController().signal });
  assert.equal(starts[0], "2026-10-08T00:07:00.000Z"); assert.equal(starts.at(-1), "2026-10-08T23:52:00.000Z");
});

test("E2E-357 owner-declared weekday mapping and next-day conflicts govern the full appointment", () => {
  const common = { from: "2026-10-08", to: "2026-10-08", timeZone: "UTC", durationMinutes: 60,
    plan: { ...rosterPlan, slotIntervalMinutes: 30 }, daily: [{ dayOfWeek: 3, intervals: [{ startMinute: 23 * 60, endMinute: 1440 }] },
      { dayOfWeek: 4, intervals: [{ startMinute: 0, endMinute: 60 }] }], extra: [], busy: [], signal: new AbortController().signal };
  assert.deepEqual(rosterStarts({ ...common, plan: { ...common.plan, weekdayOrigin: "monday" } }), ["2026-10-08T23:00:00.000Z", "2026-10-08T23:30:00.000Z"]);
  assert.deepEqual(rosterStarts({ ...common, plan: { ...common.plan, weekdayOrigin: "monday" },
    busy: [{ start: Date.parse("2026-10-09T00:00:00Z"), end: Date.parse("2026-10-09T00:30:00Z") }] }), ["2026-10-08T23:00:00.000Z"]);
  assert.deepEqual(rosterStarts(common), ["2026-10-08T00:00:00.000Z"]);
});
