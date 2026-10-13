import assert from "node:assert/strict";
import test from "node:test";
import { rosterBookingFixture, rosterInterval } from "../support/roster-booking.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("E2E-357 approved offline booking subtracts every busy family and cross-business conflicts before one native send", async () => {
  const f = await rosterBookingFixture();
  try {
    const proof = await f.verify(), listed = resultValue(await f.list(proof));
    assert.deepEqual(listed.choices.map(c => c.startsAt), ["2026-10-07T22:00:00.000Z", "2026-10-07T23:00:00.000Z", "2026-10-08T00:00:00.000Z"]);
    assert.equal(JSON.stringify(listed).includes("private-calendar-canary"), false); assert.equal(JSON.stringify(listed).includes("9999"), false);
    assert.equal(f.calendar.requests.length, 10);
    for (const r of f.calendar.requests.filter(r => ["individual_appointments", "group_appointments", "unavailable_blocks"].includes(r.collection))) {
      assert.equal(r.filters.some(q => q.startsWith("business_id")), false);
    }
    resultValue(await f.propose(proof, "offline-proposal", listed.choices[0]!.offerRef)); resultValue(await f.confirm()); await f.drain();
    assert.equal(f.posts, 1); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
    assert.equal(f.allTraffic.some(p => p.endsWith("/available_times")), false);
    assert.equal(f.claims, f.allTraffic.length + f.calendar.requests.length);
  } finally { await f.close(); }
});

for (const family of ["daily_availabilities", "availability_blocks", "individual_appointments", "group_appointments", "unavailable_blocks"]) test(`E2E-357 failed ${family} cannot publish offline offers`, async () => {
  const f = await rosterBookingFixture();
  try { const proof = await f.verify(); f.calendar.fail(family); assert.equal((await f.list(proof)).ok, false); assert.equal(f.posts, 0); }
  finally { await f.close(); }
});

for (const fault of ["changed", "foreignPractitioner", "missingFlags", "repeatRule", "wrongZone", "revoked"] as const) test(`E2E-357 ${fault} cannot establish offline calendar authority`, async () => {
  const f = await rosterBookingFixture();
  try {
    const proof = await f.verify();
    if (fault === "foreignPractitioner") f.calendar.rows.individual_appointments![0]!.practitioner = { links: { self: "https://api.au5.cliniko.com/v1/practitioners/23" } };
    if (fault === "missingFlags") delete f.calendar.rows.group_appointments![0]!.deleted_at;
    if (fault === "repeatRule") f.calendar.rows.availability_blocks![0]!.repeat_rule = { repeat_type: "Weekly", number_of_repeats: null, repeating_interval: 1 };
    if (fault === "wrongZone") f.calendar.rows.daily_availabilities![0]!.time_zone_identifier = "Europe/London";
    f.calendar.onRead(async (name, count) => {
      if (name === "individual_appointments" && count === 2) {
        if (fault === "changed") f.calendar.rows.individual_appointments!.push(rosterInterval(name, "106", "2026-10-07T22:00:00.000Z", "2026-10-07T22:30:00.000Z"));
        if (fault === "revoked") await f.replacePolicy({ approved: false });
      }
    });
    assert.equal((await f.list(proof)).ok, false); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

test("E2E-357 a new busy interval or withdrawn roster plan after proposal prevents the final send", async () => {
  for (const fault of ["busy", "policy"] as const) {
    const f = await rosterBookingFixture();
    try {
      const proof = await f.verify(), selected = resultValue(await f.list(proof)).choices[0]!;
      resultValue(await f.propose(proof, "offline-late-change", selected.offerRef));
      f.setOnRecall(async () => {
        if (fault === "policy") await f.replacePolicy({ enabled: false });
        else f.calendar.rows.unavailable_blocks!.push(rosterInterval("unavailable_blocks", "106", selected.startsAt, selected.endsAt));
      });
      resultValue(await f.confirm()); await f.drain(); assert.equal(f.posts, 0);
      assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed");
    } finally { await f.close(); }
  }
});

test("E2E-357 legacy approval cannot infer offline calendar permission", async () => {
  const f = await rosterBookingFixture(null);
  try { const proof = await f.verify(); assert.equal((await f.list(proof)).ok, false); assert.equal(f.calendar.requests.length, 0); assert.equal(f.posts, 0); }
  finally { await f.close(); }
});

for (const fault of ["businessArchive", "businessType", "inactive", "practitionerArchive", "typeArchive", "duration", "relationship", "typeRelationship", "zone", "practitionerName", "typeName"]) test(`E2E-357 offline approval retains native ${fault} validation`, async () => {
  const f = await rosterBookingFixture();
  try {
    const proof = await f.verify();
    const selected = fault === "practitionerName" || fault === "typeName" ? resultValue(await f.list(proof)).choices[0] : undefined;
    f.setFailure(fault);
    assert.equal((selected ? await f.source.resolve(f.query(proof, selected.offerRef)) : await f.list(proof)).ok, false);
    assert.equal(f.posts, 0);
  }
  finally { await f.close(); }
});

test("E2E-357 offline offers subtract conflicts on later native pages without reading chart fields", async () => {
  const f = await rosterBookingFixture();
  try {
    for (let n = 0; n < 100; n++) f.calendar.rows.group_appointments!.push(rosterInterval("group_appointments", String(200 + n), "2026-10-07T23:30:00.000Z", "2026-10-08T00:00:00.000Z"));
    f.calendar.rows.group_appointments!.push(rosterInterval("group_appointments", "400", "2026-10-07T22:00:00.000Z", "2026-10-07T22:30:00.000Z", "12"));
    const proof = await f.verify(), listed = resultValue(await f.list(proof));
    assert.equal(listed.choices[0]!.startsAt, "2026-10-07T23:00:00.000Z");
    assert.equal(f.calendar.requests.filter(r => r.collection === "group_appointments" && r.page === 2).length, 2);
    assert.equal(JSON.stringify(listed).includes("private-calendar-canary"), false); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

for (const fault of ["secondPageFailure", "changingTotal", "duplicateId", "foreignSelf", "sourceBound"] as const) test(`E2E-357 ${fault} cannot establish a complete offline calendar`, async () => {
  const f = await rosterBookingFixture();
  try {
    const count = fault === "sourceBound" ? 1001 : 101;
    for (let n = 0; n < count; n++) f.calendar.rows.group_appointments!.push(rosterInterval("group_appointments", String(200 + n), "2026-10-07T23:30:00.000Z", "2026-10-08T00:00:00.000Z"));
    if (fault === "duplicateId") f.calendar.rows.group_appointments![100] = structuredClone(f.calendar.rows.group_appointments![0]!);
    if (fault === "foreignSelf") f.calendar.rows.group_appointments![100]!.links = { self: "https://foreign.example.test/group_appointments/299" };
    f.calendar.onRead((name, n) => {
      if (name === "group_appointments" && n === 2) {
        if (fault === "secondPageFailure") f.calendar.fail(name);
        if (fault === "changingTotal") f.calendar.rows.group_appointments!.pop();
      }
    });
    const proof = await f.verify(); assert.equal((await f.list(proof)).ok, false); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});
