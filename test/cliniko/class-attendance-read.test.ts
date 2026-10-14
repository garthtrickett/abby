import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoClassAttendanceReader } from "../../src/cliniko/class-attendance-read.ts";
import type { PatientProofHost } from "../../src/core/host.ts";
import { ok, err } from "../../src/core/model.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const scope = { tenantId: "synthetic-class-tenant", clinicId: "synthetic-class-clinic", locationId: "synthetic-class-location" };
const now = "2026-10-07T10:00:00.000Z", to = "2026-10-14T10:00:00.000Z", base = "https://api.au5.cliniko.com/v1";
const link = (resource: string, id: string) => ({ links: { self: `${base}/${resource}/${id}` } });
function group(id: string, capacity = 3) {
  return { id, ...link("group_appointments", id), starts_at: "2026-10-08T10:00:00.000Z", ends_at: "2026-10-08T11:00:00.000Z",
    archived_at: null, deleted_at: null, max_attendees: capacity, patient_ids: ["untrusted-do-not-count"], notes: "private-class-shared-note",
    business: link("businesses", "11"), practitioner: link("practitioners", "22"), appointment_type: link("appointment_types", "33"),
    repeat_rule: { repeat_type: "Weekly", number_of_repeats: 4, repeating_interval: 1 } };
}
function attendee(id: string, booking: string, patient = "44", cancelled_at: string | null = null) {
  return { id, ...link("attendees", id), booking: link("bookings", booking), patient: link("patients", patient),
    archived_at: null, deleted_at: null, cancelled_at, notes: "private-attendee-note", patient_name: "private-other-name" };
}
function fixture() {
  const groups: Record<string, unknown>[] = [group("91"), group("92", 1), group("93"), group("94")];
  const attendees: Record<string, unknown>[] = [attendee("101", "91", "42"), attendee("102", "91"), attendee("103", "91", "45", now),
    attendee("104", "92"), attendee("105", "93", "42"), attendee("106", "93", "42")];
  const business: Record<string, unknown> = { id: "11", time_zone_identifier: "Australia/Sydney", archived_at: null, appointment_type_ids: ["33"] };
  const type: Record<string, unknown> = { id: "33", archived_at: null, max_attendees: 10 };
  const traffic: { path: string; filters: string[]; page: number }[] = [];
  let denied = false, subject = "42", proofCalls = 0, responseStatus = 200, missingRelationship = false;
  let onRead: ((path: string, count: number) => void) | undefined;
  let onResponse: ((path: string, body: Record<string, unknown>) => void) | undefined;
  const counts = new Map<string, number>();
  const proof: PatientProofHost = { verifyPatient: async (s, ref) => {
    proofCalls++; assert.deepEqual(s, scope); assert.equal(ref, "private-class-proof");
    return denied ? err({ kind: "expired", target: "patient" }) : ok({ scope, patientRef: subject, verificationRef: ref, expiresAt: "2026-10-08T10:00:00.000Z" });
  } };
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)), path = url.pathname; assert.equal(url.origin, "https://api.au5.cliniko.com");
    assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get("User-Agent"), "Abby (dev@example.test)");
    traffic.push({ path, filters: url.searchParams.getAll("q[]"), page: Number(url.searchParams.get("page") ?? 1) });
    const count = (counts.get(path) ?? 0) + 1; counts.set(path, count); onRead?.(path, count);
    if (responseStatus !== 200) return new Response(null, { status: responseStatus, headers: { "X-RateLimit-Reset": String(Date.parse(now) / 1000 + 60) } });
    if (path === "/v1/businesses/11") return Response.json(business);
    if (path === "/v1/practitioners/22") return Response.json({ id: "22", active: true });
    if (path === "/v1/appointment_types/33") return Response.json(type);
    let rows: Record<string, unknown>[] = [], name: string;
    if (path === "/v1/practitioners/22/businesses") { name = "businesses"; rows = missingRelationship ? [] : [{ id: "11", ...link(name, "11") }]; }
    else if (path === "/v1/practitioners/22/appointment_types") { name = "appointment_types"; rows = [{ id: "33", ...link(name, "33") }]; }
    else if (path === "/v1/group_appointments") { name = "group_appointments"; rows = groups; }
    else if (/^\/v1\/group_appointments\/\d+$/.test(path)) return Response.json(groups.find(row => row.id === path.split("/").at(-1)));
    else if (path === "/v1/attendees") {
      name = "attendees"; const booking = url.searchParams.getAll("q[]").find(filter => filter.startsWith("booking_id:="))!.slice(12);
      rows = attendees.filter(row => (row.booking as { links: { self: string } }).links.self === `${base}/bookings/${booking}`);
      assert.equal(url.searchParams.getAll("q[]").some(filter => filter.startsWith("patient_id")), false, "capacity counts the complete class, not only the caller");
    } else throw new Error(`unexpected native request ${path}`);
    const page = Number(url.searchParams.get("page"));
    const body = { [name]: rows.slice((page - 1) * 100, page * 100), total_entries: rows.length };
    onResponse?.(path, body); return Response.json(body);
  };
  const budget = new ClinikoReadBudget(200, () => Date.parse(now));
  const config = { scope, apiKey: "synthetic-class-au5", contactEmail: "dev@example.test", businessId: "11", practitionerId: "22", appointmentTypeId: "33", className: "Approved mat Pilates", rateBudget: budget };
  const reader = resultValue(ClinikoClassAttendanceReader.create(config, proof, fetchPort, () => now));
  return { reader, config, proof, fetchPort, groups, attendees, business, type, traffic, budget,
    list: (signal = new AbortController().signal) => reader.list(scope, "private-class-proof", now, to, now, signal),
    get proofCalls() { return proofCalls; }, revoke: () => { denied = true; }, changeSubject: () => { subject = "43"; },
    status: (status: number) => { responseStatus = status; }, noRelationship: () => { missingRelationship = true; },
    onRead: (callback: typeof onRead) => { onRead = callback; },
    onResponse: (callback: typeof onResponse) => { onResponse = callback; } };
}

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
  if (status === 429) assert.equal(f.budget.claim()?.kind, "rateLimited");
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
