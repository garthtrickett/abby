import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoClassAttendanceReader } from "../../src/cliniko/class-attendance-read.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

import { classAttendanceFixture as fixture, classScope as scope, classNow as now, classUntil as to, classBase as base, classLink as link, classAttendee as attendee } from "../support/class-attendance.ts";

test("E2E-390 native class reads count active attendance and reveal only the verified patients own target", async () => {
  const f = fixture(), result = resultValue(await f.list());
  assert.equal(f.proofCalls, 2); assert.equal(result.reservable, false); assert.equal(result.timeZone, "Australia/Sydney");
  assert.equal(result.className, "Approved mat Pilates");
  assert.deepEqual(result.sessions.map(row => ({ id: row.sessionRef, count: row.activeAttendanceCount, remaining: row.remainingPlaces, attendance: row.attendance })), [
    { id: "91", count: 2, remaining: 1, attendance: { kind: "one", attendeeRef: "101" } },
    { id: "92", count: 1, remaining: 0, attendance: { kind: "none" } },
    { id: "93", count: 2, remaining: 1, attendance: { kind: "ambiguous" } },
    { id: "94", count: 0, remaining: 3, attendance: { kind: "none" } },
  ]);
  for (const secret of ["private-class-shared-note", "private-attendee-note", "private-other-name", "untrusted-do-not-count", "102", "104", "106"]) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(f.traffic.filter(row => row.path === "/v1/group_appointments").length, 2);
  for (const query of f.traffic.filter(row => row.path === "/v1/group_appointments")) assert.deepEqual(query.filters,
    ["business_id:=11", "practitioner_id:=22", "appointment_type_id:=33", `starts_at:>=${now}`, `starts_at:<${to}`]);
});

test("E2E-390 selected occurrence inspection rereads capacity without modifying the shared class or other attendees", async () => {
  const f = fixture(); resultValue(await f.list()); f.attendees.push(attendee("107", "91", "47"));
  const inspected = resultValue(await f.reader.inspect(scope, "private-class-proof", "91", now, to, now, new AbortController().signal));
  assert.equal(inspected.sessions.length, 1); assert.equal(inspected.sessions[0]!.remainingPlaces, 0);
  assert.equal(f.traffic.filter(row => row.path === "/v1/group_appointments/91").length, 2);
  assert.equal(f.groups[0]!.max_attendees, 3);
});

test("E2E-397 paired occurrence inspection shares current metadata and proof while retaining exact own attendance and complete capacity", async () => {
  const f = fixture();
  const result = resultValue(await f.reader.inspectPair(scope, "private-class-proof", ["91", "94"], now, to, now, new AbortController().signal));
  assert.equal(f.proofCalls, 2);
  assert.deepEqual(result.sessions.map(row => ({ ref: row.sessionRef, remaining: row.remainingPlaces, attendance: row.attendance })), [
    { ref: "91", remaining: 1, attendance: { kind: "one", attendeeRef: "101" } }, { ref: "94", remaining: 3, attendance: { kind: "none" } },
  ]);
  assert.equal(f.traffic.filter(row => row.path === "/v1/businesses/11").length, 3, "metadata is fresh before both snapshots and after them");
  for (const secret of ["private-attendee-note", "private-other-name", "102", "103"]) assert.equal(JSON.stringify(result).includes(secret), false);
});

for (const fault of ["capacity", "subject", "wrongEndpointRecord", "duplicateSelection"] as const)
  test(`E2E-397 paired ${fault} cannot publish either occurrence as a partial result`, async () => {
    const f = fixture();
    if (fault === "capacity") f.onRead((path, count) => { if (path === "/v1/group_appointments/94" && count === 2) f.attendees.push(attendee("401", "94", "44")); });
    if (fault === "subject") f.onRead((path, count) => { if (path === "/v1/group_appointments/94" && count === 2) f.changeSubject(); });
    const port: typeof fetch = (value, init) => new URL(String(value)).pathname === "/v1/group_appointments/94" && fault === "wrongEndpointRecord"
      ? Promise.resolve(Response.json(f.groups[0])) : f.fetchPort(value, init);
    const reader = resultValue(ClinikoClassAttendanceReader.create(f.config, f.proof, port, () => now));
    const result = await reader.inspectPair(scope, "private-class-proof", fault === "duplicateSelection" ? ["91", "91"] : ["91", "94"], now, to, now, new AbortController().signal);
    assert.equal(result.ok, false);
  });

for (const fault of ["business", "practitioner", "type", "link", "capacity", "missingFlag", "booking", "patient", "range", "singleType", "relationship"] as const)
  test(`E2E-390 class ${fault} mismatch cannot publish a partial attendance result`, async () => {
    const f = fixture();
    if (fault === "business") f.groups[0]!.business = link("businesses", "12");
    if (fault === "practitioner") f.groups[0]!.practitioner = link("practitioners", "23");
    if (fault === "type") f.groups[0]!.appointment_type = link("appointment_types", "34");
    if (fault === "link") f.groups[0]!.links = { self: "https://attacker.test/group_appointments/91" };
    if (fault === "capacity") f.groups[0]!.max_attendees = null;
    if (fault === "missingFlag") delete f.attendees[0]!.cancelled_at;
    if (fault === "patient") f.attendees[0]!.patient = link("patients", "not-an-id");
    if (fault === "range") f.groups[0]!.starts_at = "2026-10-06T10:00:00.000Z";
    if (fault === "singleType") f.type.max_attendees = 1;
    if (fault === "relationship") f.noRelationship();
    if (fault === "booking") f.onResponse((path, body) => {
      if (path === "/v1/attendees" && (body.attendees as Record<string, unknown>[]).some(row => row.id === "101"))
        (body.attendees as Record<string, unknown>[]).find(row => row.id === "101")!.booking = link("bookings", "92");
    });
    const result = await f.list(); assert.equal(result.ok, false); assert.equal(result.error.kind, "malformed");
  });

for (const fault of ["capacity", "typeCapacity", "attendee", "subject", "permission", "timezone"] as const)
  test(`E2E-390 class ${fault} changing between observations denies publication`, async () => {
    const f = fixture();
    f.onRead((path, count) => {
      if (path === "/v1/businesses/11" && count === 2) {
        if (fault === "capacity") f.groups[0]!.max_attendees = 2;
        if (fault === "typeCapacity") f.type.max_attendees = 5;
        if (fault === "attendee") f.attendees.push(attendee("108", "94", "49"));
        if (fault === "subject") f.changeSubject();
        if (fault === "permission") f.revoke();
        if (fault === "timezone") f.business.time_zone_identifier = "Europe/London";
      }
    });
    const result = await f.list(); assert.equal(result.ok, false); assert.equal(result.error.kind, fault === "permission" ? "invalidProof" : "changed");
  });

test("E2E-390 denied proof, foreign scope and invalid time do not read class attendance", async () => {
  const f = fixture(); f.revoke(); assert.equal((await f.list()).ok, false); assert.equal(f.traffic.length, 0);
  assert.equal((await f.reader.list({ ...scope, locationId: "foreign" }, "private-class-proof", now, to, now, new AbortController().signal)).ok, false);
  assert.equal((await f.reader.list(scope, "private-class-proof", now, to, "2026-10-06T10:00:00.000Z", new AbortController().signal)).ok, false);
  assert.equal(f.traffic.length, 0);
});

test("E2E-390 complete attendee pagination excludes cancelled records and reports overcapacity honestly", async () => {
  const f = fixture(); f.attendees.splice(0, f.attendees.length, ...Array.from({ length: 105 }, (_, i) => attendee(String(201 + i), "91", String(1001 + i))));
  const result = resultValue(await f.list());
  assert.equal(result.sessions[0]!.activeAttendanceCount, 105); assert.equal(result.sessions[0]!.remainingPlaces, 0); assert.equal(result.sessions[0]!.overCapacity, true);
  assert.equal(f.traffic.filter(row => row.path === "/v1/attendees" && row.filters.includes("booking_id:=91") && row.page === 2).length, 2);
});

for (const status of [401, 429, 503]) test(`E2E-390 native class HTTP${status} yields a typed failure`, async () => {
  const f = fixture(); f.status(status); const result = await f.list(); assert.equal(result.ok, false);
  assert.equal(result.error.kind, status === 401 ? "forbidden" : status === 429 ? "rateLimited" : "unavailable");
  if (status === 429) assert.equal((await f.budget.claim())?.kind, "rateLimited");
});

test("E2E-390 account budget and cancellation prevent additional native reads", async () => {
  const f = fixture(); for (let i = 0; i < 200; i++) assert.equal(f.budget.claim(), null);
  const result = await f.list(); assert.equal(result.ok, false); assert.equal(result.error.kind, "rateLimited"); assert.equal(f.traffic.length, 0);
  const g = fixture(), abort = new AbortController(); g.onRead(path => { if (path === "/v1/businesses/11") abort.abort(); });
  assert.equal((await g.list(abort.signal)).ok, false); assert.equal(g.traffic.length, 1);
});

for (const fault of ["duplicate", "partial", "changingTotal", "nextLink", "tooMany"] as const)
  test(`E2E-390 incomplete class attendance ${fault} cannot masquerade as free capacity`, async () => {
    const f = fixture();
    f.attendees.splice(0, f.attendees.length, ...Array.from({ length: fault === "tooMany" ? 501 : 105 }, (_, i) => attendee(String(201 + i), "91", String(1001 + i))));
    f.onResponse((path, body) => {
      if (path !== "/v1/attendees" || !(body.attendees as Record<string, unknown>[]).some(row => row.id === "301")) return;
      if (fault === "duplicate") (body.attendees as Record<string, unknown>[])[0] = attendee("201", "91", "1001");
      if (fault === "partial") (body.attendees as unknown[]).pop();
      if (fault === "changingTotal") body.total_entries = 106;
      if (fault === "nextLink") body.links = { next: `${base}/attendees?page=3` };
    });
    const result = await f.list(); assert.equal(result.ok, false);
    assert.equal(result.error.kind, fault === "tooMany" ? "tooManyResults" : "malformed");
  });

test("E2E-390 impossible dates and invalid native configuration cannot create class evidence", async () => {
  const f = fixture();
  assert.equal((await f.reader.list(scope, "private-class-proof", "2026-02-30T10:00:00Z", to, now, new AbortController().signal)).ok, false);
  assert.equal(f.traffic.length, 0);
  for (const patch of [{ businessId: "11?foreign=1" }, { className: "Injected\ntext" }, { rateBudget: undefined }, { contactEmail: "bad" }])
    assert.equal(ClinikoClassAttendanceReader.create({ ...f.config, ...patch } as typeof f.config, f.proof, f.fetchPort, () => now).ok, false);
});

test("E2E-390 class metadata revoked during the final attendee scan cannot publish earlier eligibility", async () => {
  const f = fixture(); let reads = 0;
  f.onRead(path => {
    if (path === "/v1/attendees" && ++reads === 8) f.business.appointment_type_ids = [];
  });
  const result = await f.list(); assert.equal(result.ok, false); assert.equal(result.error.kind, "malformed");
});
