import assert from "node:assert/strict";
import test from "node:test";
import { validRosterSearchPlan } from "../../src/cliniko/roster-calendar.ts";
import { rosterBookingFixture, rosterInterval, rosterPlan } from "../support/roster-booking.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const plan = { ...rosterPlan, busyRecurrence: "nativeOccurrences" as const };
const rule = { repeat_type: "Weekly", number_of_repeats: 6, repeating_interval: 1 };
const families = ["individual_appointments", "group_appointments", "unavailable_blocks"];

test("E2E-404 native busy occurrence authority is an explicit owner plan value", () => {
  assert.equal(validRosterSearchPlan(rosterPlan), true); assert.equal(validRosterSearchPlan(plan), true);
  for (const busyRecurrence of [undefined, null, false, "expandAll", {}]) assert.equal(validRosterSearchPlan({ ...rosterPlan, busyRecurrence }), false);
  assert.equal(validRosterSearchPlan({ ...plan, inferOpenings: true }), false);
  assert.equal(validRosterSearchPlan(Object.assign(Object.create({ busyRecurrence: "nativeOccurrences" }), rosterPlan)), false);
});

for (const family of families) for (const enabled of [false, true])
  test(`E2E-404 ${family} native recurring occurrence ${enabled ? "subtracts its actual dated interval before a verified booking" : "cannot bypass legacy owner scope"}`, async () => {
    const f = await rosterBookingFixture(enabled ? plan : rosterPlan);
    try {
      const busy = rosterInterval(family, "106", "2026-10-07T22:00:00.000Z", "2026-10-07T22:30:00.000Z", "12");
      busy.repeat_rule = rule; f.calendar.rows[family]!.push(busy);
      const proof = await f.verify(), listed = await f.list(proof);
      if (!enabled) { assert.equal(listed.ok, false); assert.equal(f.posts, 0); return; }
      const choices = resultValue(listed).choices;
      // Daily hours end at noon; extra opening hours start at 13:00 (02:00 UTC).
      assert.deepEqual(choices.map(row => row.startsAt), ["2026-10-07T23:00:00.000Z", "2026-10-08T00:00:00.000Z", "2026-10-08T02:00:00.000Z"]);
      assert.equal(JSON.stringify(choices).includes("private-calendar-canary"), false); assert.equal(JSON.stringify(choices).includes("9999"), false);
      resultValue(await f.propose(proof, `native-repeat-${family}`, choices[0]!.offerRef)); resultValue(await f.confirm()); await f.drain();
      assert.equal(f.posts, 1); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
      assert.equal(f.allTraffic.some(path => path.endsWith("/available_times")), false);
      for (const read of f.calendar.requests.filter(row => row.collection === family)) assert.equal(read.filters.some(value => value.startsWith("business_id")), false);
    } finally { await f.close(); }
  });

test("E2E-404 a past series root does not replace the exact current native child occurrence", async () => {
  const f = await rosterBookingFixture(plan);
  try {
    const root = rosterInterval("individual_appointments", "106", "2026-09-30T23:00:00.000Z", "2026-09-30T23:30:00.000Z", "12"); root.repeat_rule = rule;
    const child = rosterInterval("individual_appointments", "107", "2026-10-07T23:00:00.000Z", "2026-10-07T23:30:00.000Z", "12");
    child.repeated_from = { links: { self: "https://api.au5.cliniko.com/v1/individual_appointments/106" } };
    f.calendar.rows.individual_appointments!.push(root, child);
    const proof = await f.verify(), choices = resultValue(await f.list(proof)).choices;
    assert.equal(choices.some(row => row.startsAt === "2026-10-07T23:00:00.000Z"), false);
    assert.equal(choices[0]!.startsAt, "2026-10-07T22:00:00.000Z"); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

for (const metadata of [{ repeat_type: "Daily", number_of_repeats: null, repeating_interval: 2 },
  { repeat_type: "Monthly", number_of_repeats: 2, repeating_interval: 100 }])
  test(`E2E-404 supported ${metadata.repeat_type} metadata uses only returned native busy instants`, async () => {
    const f = await rosterBookingFixture(plan);
    try {
      for (const family of families) f.calendar.rows[family]![0]!.repeat_rule = metadata;
      const proof = await f.verify(), offered = resultValue(await f.list(proof));
      assert.deepEqual(offered.choices.map(row => row.startsAt), ["2026-10-07T22:00:00.000Z", "2026-10-07T23:00:00.000Z", "2026-10-08T00:00:00.000Z"]);
      assert.equal(f.posts, 0); assert.equal(JSON.stringify(offered).includes("private-calendar-canary"), false);
    } finally { await f.close(); }
  });

test("E2E-404 complete native recurring busy pages retain late availability across an adaptive range split", async () => {
  const f = await rosterBookingFixture({ ...plan, maxSearchDays: 90 }, 90);
  try {
    f.calendar.rows.daily_availabilities = [];
    f.calendar.rows.availability_blocks = [rosterInterval("availability_blocks", "102", "2026-11-20T04:00:00.000Z", "2026-11-20T06:00:00.000Z")];
    f.calendar.rows.group_appointments = Array.from({ length: 1200 }, (_, index) => {
      const start = Date.parse("2026-10-08T08:00:00Z") + Math.floor(index / 20) * 86400000 + index % 20 * 60000;
      return { ...rosterInterval("group_appointments", String(200 + index), new Date(start).toISOString(), new Date(start + 300000).toISOString(), index % 2 ? "12" : "11"),
        repeat_rule: { ...rule, repeating_interval: 100 } };
    });
    f.calendar.rows.group_appointments.push({ ...rosterInterval("group_appointments", "6000", "2026-10-30T00:00:00.000Z", "2026-11-10T00:00:00.000Z", "12"),
      repeat_rule: { ...rule, repeating_interval: 100 } });
    const proof = await f.verify(), offered = resultValue(await f.list(proof, "2026-10-08", "2026-11-30"));
    assert.equal(offered.choices[0]!.startsAt, "2026-11-20T04:00:00.000Z");
    assert.equal(new Set(f.calendar.requests.filter(row => row.collection === "group_appointments").map(row => row.filters.join("|"))).size, 3);
    assert.equal(JSON.stringify(offered).includes("private-calendar-canary"), false); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

for (const repeat_rule of [undefined, "Weekly", {}, { ...rule, repeat_type: "Unknown" }, { ...rule, repeat_type: "Yearly" },
  { ...rule, number_of_repeats: "6" }, { ...rule, number_of_repeats: 0 }, { ...rule, repeating_interval: 0 }, { ...rule, repeating_interval: 101 }])
  test(`E2E-404 malformed native repeat metadata ${JSON.stringify(repeat_rule)} cannot establish a calendar`, async () => {
    const f = await rosterBookingFixture(plan);
    try {
      f.calendar.rows.individual_appointments![0]!.repeat_rule = repeat_rule;
      const proof = await f.verify(); assert.equal((await f.list(proof)).ok, false); assert.equal(f.posts, 0);
    } finally { await f.close(); }
  });

test("E2E-404 native busy occurrence approval does not authorize recurring extra openings", async () => {
  const f = await rosterBookingFixture(plan);
  try {
    f.calendar.rows.availability_blocks![0]!.repeat_rule = rule;
    const proof = await f.verify(); assert.equal((await f.list(proof)).ok, false); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

for (const fault of ["withdrawn", "lateBusy", "unstable"] as const)
  test(`E2E-404 ${fault} cannot turn dated-repeat availability into a native booking`, async () => {
    const f = await rosterBookingFixture(plan);
    try {
      f.calendar.rows.individual_appointments![0]!.repeat_rule = rule;
      const proof = await f.verify();
      const occupy = () => { const busy = rosterInterval("unavailable_blocks", "106", "2026-10-07T22:00:00.000Z", "2026-10-07T22:30:00.000Z", "12"); busy.repeat_rule = rule; f.calendar.rows.unavailable_blocks!.push(busy); };
      if (fault === "unstable") {
        f.calendar.onRead((name, count) => { if (name === "unavailable_blocks" && count === 2) occupy(); });
        assert.equal((await f.list(proof)).ok, false);
      } else {
        const selected = resultValue(await f.list(proof)).choices[0]!;
        resultValue(await f.propose(proof, `native-repeat-${fault}`, selected.offerRef));
        f.setOnRecall(async () => { if (fault === "withdrawn") await f.replacePolicy({ availabilityPlan: rosterPlan }); else occupy(); });
        resultValue(await f.confirm()); await f.drain();
        assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed");
      }
      assert.equal(f.posts, 0);
    } finally { await f.close(); }
  });
