import assert from "node:assert/strict";
import test from "node:test";
import { expandStaffSchedule } from "../../src/reference/staff-schedule.ts";

const sunday = { weekday: 0, startMinute: 90, endMinute: 210 };

test("spring daylight-saving gap produces actual UTC staffed time", () => {
  const result = expandStaffSchedule({ timeZone: "Australia/Sydney", weekly: [sunday], closedDates: [] },
    "2026-10-03T14:00:00.000Z", "2026-10-03T18:00:00.000Z");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, [{ startsAt: "2026-10-03T15:30:00.000Z", endsAt: "2026-10-03T16:30:00.000Z" }]);
});

test("fall daylight-saving overlap includes both local occurrences", () => {
  const result = expandStaffSchedule({ timeZone: "Australia/Sydney",
    weekly: [{ weekday: 0, startMinute: 135, endMinute: 165 }], closedDates: [] },
  "2027-04-03T14:00:00.000Z", "2027-04-03T18:00:00.000Z");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, [
    { startsAt: "2027-04-03T15:15:00.000Z", endsAt: "2027-04-03T15:45:00.000Z" },
    { startsAt: "2027-04-03T16:15:00.000Z", endsAt: "2027-04-03T16:45:00.000Z" },
  ]);
});

test("local holiday closes a weekly window", () => {
  const result = expandStaffSchedule({ timeZone: "Australia/Sydney",
    weekly: [{ weekday: 1, startMinute: 540, endMinute: 1020 }], closedDates: ["2026-10-05"] },
  "2026-10-04T21:00:00.000Z", "2026-10-05T07:00:00.000Z");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, []);
});

test("overnight window crosses midnight and clips to the requested horizon", () => {
  const result = expandStaffSchedule({ timeZone: "Australia/Sydney",
    weekly: [{ weekday: 0, startMinute: 1320, endMinute: 120 }], closedDates: [] },
  "2026-10-04T11:30:30.000Z", "2026-10-04T16:00:00.000Z");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, [{ startsAt: "2026-10-04T11:30:30.000Z", endsAt: "2026-10-04T15:00:00.000Z" }]);
});

test("a closure on the shift's starting date also closes its after-midnight portion", () => {
  const schedule = { timeZone: "Pacific/Honolulu",
    weekly: [{ weekday: 0, startMinute: 22 * 60, endMinute: 120 }], closedDates: [] as string[] };
  const from = "2026-09-28T10:00:00.000Z"; // Monday 00:00 locally, within Sunday's shift.
  const to = "2026-09-28T11:00:00.000Z";
  assert.deepEqual(expandStaffSchedule(schedule, from, to),
    { ok: true, value: [{ startsAt: from, endsAt: to }] });
  assert.deepEqual(expandStaffSchedule({ ...schedule, closedDates: ["2026-09-27"] }, from, to),
    { ok: true, value: [] });
  assert.deepEqual(expandStaffSchedule({ ...schedule, closedDates: ["2026-09-28"] }, from, to),
    { ok: true, value: [] });
});

test("invalid schedule data fails before it can authorize a transfer", () => {
  const base = { timeZone: "Australia/Sydney", weekly: [sunday], closedDates: [] };
  const from = "2026-10-03T14:00:00.000Z";
  const to = "2026-10-03T18:00:00.000Z";
  assert.deepEqual(expandStaffSchedule({ ...base, timeZone: "Unknown/Nowhere" }, from, to),
    { ok: false, error: { kind: "invalidSchedule", field: "timeZone" } });
  assert.deepEqual(expandStaffSchedule({ ...base, weekly: [{ ...sunday, endMinute: 90 }] }, from, to),
    { ok: false, error: { kind: "invalidSchedule", field: "weekly" } });
  assert.deepEqual(expandStaffSchedule({ ...base, closedDates: ["2026-02-30"] }, from, to),
    { ok: false, error: { kind: "invalidSchedule", field: "closedDates" } });
  assert.deepEqual(expandStaffSchedule(base, from, "2026-10-10T18:00:00.000Z"),
    { ok: false, error: { kind: "invalidSchedule", field: "horizon" } });
});
