import assert from "node:assert/strict";
import test from "node:test";
import { validRosterSearchPlan } from "../../src/cliniko/roster-calendar.ts";
import { rosterBookingFixture, rosterInterval, rosterPlan } from "../support/roster-booking.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const plan = { ...rosterPlan, openingRecurrence: "nativeOccurrences" as const };
const rule = { repeat_type: "Weekly", number_of_repeats: 6, repeating_interval: 2 };

test("E2E-414 native opening occurrences require independent explicit owner authority", () => {
  assert.equal(validRosterSearchPlan(plan), true);
  assert.equal(validRosterSearchPlan({ ...plan, busyRecurrence: "nativeOccurrences" }), true);
  for (const openingRecurrence of [undefined, null, false, "expandAll", {}])
    assert.equal(validRosterSearchPlan({ ...rosterPlan, openingRecurrence }), false);
  assert.equal(validRosterSearchPlan(Object.assign(Object.create({ openingRecurrence: "nativeOccurrences" }), rosterPlan)), false);
});

for (const enabled of [false, true]) test(`E2E-414 dated recurring opening ${enabled ? "supports an exact inspected booking" : "retains legacy denial"}`, async () => {
  const f = await rosterBookingFixture(enabled ? plan : rosterPlan);
  try {
    f.calendar.rows.daily_availabilities = [];
    f.calendar.rows.availability_blocks![0]!.repeat_rule = rule;
    const proof = await f.verify(), listed = await f.list(proof);
    if (!enabled) { assert.equal(listed.ok, false); assert.equal(f.posts, 0); return; }
    const choices = resultValue(listed).choices;
    assert.deepEqual(choices.map(c => c.startsAt), ["2026-10-08T02:00:00.000Z", "2026-10-08T02:15:00.000Z", "2026-10-08T02:30:00.000Z"]);
    assert.equal(JSON.stringify(choices).includes("private-calendar-canary"), false);
    resultValue(await f.propose(proof, "native-opening-book", choices[0]!.offerRef)); resultValue(await f.confirm()); await f.drain();
    assert.equal(f.posts, 1); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
    assert.equal(f.allTraffic.some(p => p.endsWith("/available_times")), false);
  } finally { await f.close(); }
});

test("E2E-414 native opening metadata does not invent future recurrence dates", async () => {
  const f = await rosterBookingFixture(plan);
  try {
    f.calendar.rows.daily_availabilities = [];
    f.calendar.rows.availability_blocks![0]!.repeat_rule = rule;
    const proof = await f.verify(), later = resultValue(await f.list(proof, "2026-10-22", "2026-10-22"));
    assert.deepEqual(later.choices, []); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

test("E2E-414 opening authority cannot enable recurring busy records", async () => {
  const f = await rosterBookingFixture(plan);
  try {
    f.calendar.rows.availability_blocks![0]!.repeat_rule = rule;
    f.calendar.rows.group_appointments![0]!.repeat_rule = rule;
    const proof = await f.verify(); assert.equal((await f.list(proof)).ok, false); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

for (const metadata of [{ repeat_type: "Daily", number_of_repeats: null, repeating_interval: 1 },
  { repeat_type: "Monthly", number_of_repeats: 2, repeating_interval: 100 }])
  test(`E2E-414 ${metadata.repeat_type} native opening metadata preserves only its returned instants`, async () => {
    const f = await rosterBookingFixture(plan);
    try {
      f.calendar.rows.daily_availabilities = [];
      f.calendar.rows.availability_blocks![0]!.repeat_rule = metadata;
      const proof = await f.verify(), listed = resultValue(await f.list(proof));
      assert.equal(listed.choices[0]!.startsAt, "2026-10-08T02:00:00.000Z");
      assert.deepEqual(resultValue(await f.list(proof, "2026-10-22", "2026-10-22")).choices, []);
      assert.equal(f.posts, 0);
    } finally { await f.close(); }
  });

for (const repeat_rule of [undefined, {}, "Weekly", { ...rule, repeating_interval: 0 }, { ...rule, repeating_interval: 101 },
  { ...rule, number_of_repeats: 0 }, { ...rule, repeat_type: "Yearly" }, { ...rule, timezone: "UTC" }])
  test(`E2E-414 malformed native opening metadata ${JSON.stringify(repeat_rule)} denies before writes`, async () => {
    const f = await rosterBookingFixture(plan);
    try {
      f.calendar.rows.availability_blocks![0]!.repeat_rule = repeat_rule;
      const proof = await f.verify(); assert.equal((await f.list(proof)).ok, false); assert.equal(f.posts, 0);
    } finally { await f.close(); }
  });

for (const fault of ["changedSnapshot", "lateBusy", "withdrawn"] as const)
  test(`E2E-414 ${fault} cannot turn recurring native openings into an unapproved booking`, async () => {
    const f = await rosterBookingFixture(plan);
    try {
      f.calendar.rows.daily_availabilities = [];
      f.calendar.rows.availability_blocks![0]!.repeat_rule = rule;
      const proof = await f.verify();
      if (fault === "changedSnapshot") {
        f.calendar.onRead((name, count) => { if (name === "availability_blocks" && count === 2) f.calendar.rows.availability_blocks![0]!.ends_at = "2026-10-08T03:00:00.000Z"; });
        assert.equal((await f.list(proof)).ok, false);
      } else {
        const choices = resultValue(await f.list(proof)).choices;
        resultValue(await f.propose(proof, `native-opening-${fault}`, choices[0]!.offerRef));
        f.setOnRecall(async () => {
          if (fault === "withdrawn") await f.replacePolicy({ availabilityPlan: rosterPlan });
          else f.calendar.rows.unavailable_blocks!.push(rosterInterval("unavailable_blocks", "106", "2026-10-08T02:00:00.000Z", "2026-10-08T03:00:00.000Z", "12"));
        });
        resultValue(await f.confirm()); await f.drain();
        assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed");
      }
      assert.equal(f.posts, 0);
    } finally { await f.close(); }
  });
