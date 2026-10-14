import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ClinikoPatientCaseSessionsReader } from "../../src/cliniko/patient-case-sessions.ts";
import type { ClinikoCaseQuery, ClinikoCaseConfig } from "../../src/cliniko/patient-case-sessions.ts";
import { ClinikoClassAttendanceWriter } from "../../src/cliniko/class-attendance-write.ts";
import type { ClinikoAttendanceRequest } from "../../src/cliniko/class-attendance-write.ts";
import { classAttendanceFixture, classLink as link, classAttendee as attendee, classScope as scope, classNow as now, classUntil as until } from "../support/class-attendance.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const canary = "synthetic-private-case-notes-and-referral";
function fixture() {
  const f = classAttendanceFixture();
  Object.assign(f.groups.find(row => row.id === "94")!, { starts_at: "2026-10-08T14:00:00.000Z", ends_at: "2026-10-08T15:00:00.000Z" });
  const rows: Record<string, unknown>[] = [
    { ...attendee("601", "401", "42"), patient_case: link("patient_cases", "51"), arrived: true },
    { ...attendee("602", "402", "42"), patient_case: link("patient_cases", "51"), arrived: null },
    { ...attendee("603", "403", "42", now), patient_case: link("patient_cases", "51"), arrived: null },
    { ...attendee("604", "404", "42"), patient_case: link("patient_cases", "51"), arrived: false },
  ];
  const record: Record<string, unknown> = { id: "51", ...link("patient_cases", "51"), patient: link("patients", "42"), attendee_ids: rows.map(r => r.id),
    max_sessions: 5, include_cancelled_attendees: false, include_dna_attendees: false, issue_date: "2026-10-01", expiry_date: "2026-10-09",
    closed_at: null, archived_at: null, name: canary, notes: canary, referral: { name: canary } };
  const query: ClinikoCaseQuery = { scope, verificationRef: "private-class-proof", patientCaseId: "51", classSessionId: "94", startsAt: "2026-10-08T14:00:00.000Z", now };
  const traffic: { path: string; page: number; filters: string[] }[] = [], writes: Record<string, unknown>[] = [];
  let allowed = true, status = 200, lost = false, wrongCase = false, proofTime = now;
  let onRead = (_path: string, _count: number) => {}, onBody = (_path: string, _body: Record<string, unknown>) => {}, onWrite = () => {};
  const counts = new Map<string, number>();
  const fetchPort: typeof fetch = async (value, init) => {
    const u = new URL(String(value)), path = u.pathname, method = init?.method ?? "GET";
    assert.equal(u.origin, "https://api.au5.cliniko.com"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    if (path === "/v1/attendees" && method === "POST") {
      const body = JSON.parse(String(init?.body)); writes.push(body);
      assert.deepEqual(Object.keys(body).sort(), ["booking_id", "notes", "patient_case_id", "patient_id"]);
      const row = { ...attendee("701", body.booking_id, body.patient_id), patient_case: link("patient_cases", body.patient_case_id), arrived: null, notes: body.notes };
      rows.push(row); f.attendees.push(row); (record.attendee_ids as string[]).push("701"); onWrite();
      if (lost) throw new Error("synthetic lost case attendance response");
      return Response.json(wrongCase ? { ...row, patient_case: link("patient_cases", "52") } : row, { status: 201 });
    }
    if (path === "/v1/attendees/701") return Response.json(rows.find(row => row.id === "701"));
    if (!path.startsWith("/v1/patient_cases/")) return f.fetchPort(value, init);
    assert.equal(method, "GET");
    assert.equal(new Headers(init?.headers).get("User-Agent"), "Abby (dev@example.test)");
    traffic.push({ path, page: Number(u.searchParams.get("page") ?? 1), filters: u.searchParams.getAll("q[]") });
    const count = (counts.get(path) ?? 0) + 1; counts.set(path, count); onRead(path, count);
    if (status !== 200) return new Response(null, { status, headers: { "X-RateLimit-Reset": String(Date.parse(now) / 1000 + 60) } });
    let body: Record<string, unknown>;
    if (path === "/v1/patient_cases/51") body = structuredClone(record);
    else {
      assert.equal(path, "/v1/patient_cases/51/attendees");
      const page = Number(u.searchParams.get("page"));
      assert.equal(u.searchParams.get("per_page"), "100"); assert.equal(u.searchParams.get("sort"), "id:asc");
      assert.equal(u.searchParams.has("q[]"), false, "all case uses count, including other services and past appointments");
      body = { attendees: structuredClone(rows.slice((page - 1) * 100, page * 100)), total_entries: rows.length };
    }
    onBody(path, body); return Response.json(body);
  };
  const config: ClinikoCaseConfig = { ...f.config, timeZone: "Australia/Sydney", attendanceStatus: "arrivedFalseIsDna" };
  const permission = { allows: async (q: ClinikoCaseQuery & { patientId: string }) => allowed && q.patientId === "42" && q.patientCaseId === "51" && q.classSessionId === "94" };
  const reader = resultValue(ClinikoPatientCaseSessionsReader.create(config, f.proof, permission, fetchPort, () => proofTime));
  const writer = resultValue(ClinikoClassAttendanceWriter.create(f.config, fetchPort));
  const request: ClinikoAttendanceRequest = { kind: "book", scope, patientId: "42", sessionId: "94", patientCaseId: "51", actionId: randomUUID() };
  const read = (q = query, signal = new AbortController().signal) => reader.read(q, signal);
  const permit = async (signal: AbortSignal) => {
    const pass = await read(query, signal), session = await f.reader.inspect(scope, query.verificationRef, query.classSessionId, now, until, now, signal);
    return pass.ok && pass.value.eligibleOnSessionDate && pass.value.remaining > 0 && !pass.value.overdrawn && session.ok &&
      session.value.sessions[0]?.attendance.kind === "none" && session.value.sessions[0]?.remainingPlaces > 0;
  };
  return { ...f, config, attendanceConfig: f.config, query, record, rows, reader, read, writer, request, permit, traffic, writes, permission, fetchPort,
    get proofCalls() { return f.proofCalls; },
    deny: () => { allowed = false; }, setStatus: (value: number) => { status = value; }, lose: () => { lost = true; }, wrongCase: () => { wrongCase = true; },
    onRead: (hook: typeof onRead) => { onRead = hook; }, onBody: (hook: typeof onBody) => { onBody = hook; }, onWrite: (hook: typeof onWrite) => { onWrite = hook; },
    setClock: (value: string) => { proofTime = value; } };
}

test("E2E-405 private native case counter counts every associated service without claiming payment or a reservation", async () => {
  const f = fixture(), found = resultValue(await f.read());
  assert.deepEqual(found, { patientCaseId: "51", patientId: "42", verificationRef: "private-class-proof", observedAt: now,
    maximum: 5, used: 2, remaining: 3, overdrawn: false, eligibleOnSessionDate: true, includeCancelled: false, includeDna: false, usageFingerprint: found.usageFingerprint, financialAuthority: "none", reservable: false });
  assert.match(found.usageFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(f.traffic.length, 4); assert.equal(f.proofCalls, 2);
  assert.equal(JSON.stringify(found).includes(canary), false); assert.equal(JSON.stringify(found).includes("private-other-name"), false);
  assert.equal(f.writes.length, 0);
});
for (const cancelled of [false, true]) for (const dna of [false, true])
  test(`E2E-405 native case cancellation=${cancelled} and DNA=${dna} rules govern session use`, async () => {
    const f = fixture(); f.record.include_cancelled_attendees = cancelled; f.record.include_dna_attendees = dna;
    const found = resultValue(await f.read()); assert.equal(found.used, 2 + Number(cancelled) + Number(dna));
    f.rows[2]!.arrived = false;
    assert.equal(resultValue(await f.read()).used, found.used, "cancellation takes precedence over an earlier DNA status");
  });
test("E2E-405 cancelled, DNA and archived/deleted records cannot manufacture extra session use", async () => {
  const f = fixture(); f.record.include_cancelled_attendees = true; f.record.include_dna_attendees = true;
  f.rows[0]!.archived_at = now; f.rows[1]!.deleted_at = now;
  assert.equal(resultValue(await f.read()).used, 2);
});
for (const patch of [{ closed_at: now }, { archived_at: now }, { expiry_date: "2026-10-08" }, { issue_date: "2026-10-10", expiry_date: "2026-10-11" }])
  test(`E2E-405 case date/activity ${JSON.stringify(patch)} cannot grant a future class entitlement`, async () => {
    const f = fixture(); Object.assign(f.record, patch);
    assert.equal(resultValue(await f.read()).eligibleOnSessionDate, false, "14Z is October9 at the Sydney clinic, not October8 UTC");
    assert.equal((await f.writer.executeOnce(f.request, new AbortController().signal, f.permit)).ok, false); assert.equal(f.writes.length, 0);
  });
test("E2E-405 issue and expiry dates are inclusive on the clinic date", async () => {
  const f = fixture(); f.record.issue_date = "2026-10-09"; f.record.expiry_date = "2026-10-09";
  assert.equal(resultValue(await f.read()).eligibleOnSessionDate, true);
});
test("E2E-405 full and overdrawn cases prevent another native attendee write", async () => {
  for (const maximum of [1, 2]) {
    const f = fixture(); f.record.max_sessions = maximum;
    const pass = resultValue(await f.read()); assert.equal(pass.remaining, 0); assert.equal(pass.overdrawn, maximum === 1);
    assert.equal((await f.writer.executeOnce(f.request, new AbortController().signal, f.permit)).ok, false); assert.equal(f.writes.length, 0);
  }
});
test("E2E-405 complete multi-page historical case uses are counted twice before publishing a result", async () => {
  const f = fixture(); f.rows.splice(0, f.rows.length, ...Array.from({ length: 205 }, (_, i) => ({
    ...attendee(String(1001 + i), String(2001 + i), "42"), patient_case: link("patient_cases", "51"), arrived: null }))) ;
  f.record.attendee_ids = f.rows.map(r => r.id); f.record.max_sessions = 210;
  const pass = resultValue(await f.read()); assert.equal(pass.used, 205); assert.equal(pass.remaining, 5);
  assert.equal(f.traffic.filter(t => t.page === 3).length, 2);
});
for (const fault of ["patient", "case", "self", "missing", "duplicate", "arrived", "active", "maximum", "cancelRule", "dnaRule", "dates", "ids"] as const)
  test(`E2E-405 malformed or foreign case ${fault} denies private evidence`, async () => {
    const f = fixture();
    if (fault === "patient") f.record.patient = link("patients", "43");
    if (fault === "case") f.rows[0]!.patient_case = link("patient_cases", "52");
    if (fault === "self") f.rows[0]!.links = { self: "https://foreign.test/attendees/601" };
    if (fault === "missing") (f.record.attendee_ids as string[]).push("999");
    if (fault === "duplicate") f.rows.push(f.rows[0]!);
    if (fault === "arrived") delete f.rows[0]!.arrived;
    if (fault === "active") delete f.rows[0]!.deleted_at;
    if (fault === "maximum") f.record.max_sessions = null;
    if (fault === "cancelRule") f.record.include_cancelled_attendees = null;
    if (fault === "dnaRule") f.record.include_dna_attendees = "false";
    if (fault === "dates") f.record.expiry_date = "2026-02-30";
    if (fault === "ids") f.record.attendee_ids = ["601", "601"];
    const result = await f.read(); assert.equal(result.ok, false); assert.equal(result.error.kind, "malformed");
    assert.equal(f.writes.length, 0);
  });
for (const fault of ["use", "maximum", "expiry", "cancelRule", "subject", "permission", "proof"] as const)
  test(`E2E-405 changing case ${fault} before final authority check cannot escape`, async () => {
    const f = fixture(); f.onRead((path, count) => {
      if (path !== "/v1/patient_cases/51" || count !== 2) return;
      if (fault === "use") f.rows[0]!.cancelled_at = now;
      if (fault === "maximum") f.record.max_sessions = 6;
      if (fault === "expiry") f.record.expiry_date = "2026-10-10";
      if (fault === "cancelRule") f.record.include_cancelled_attendees = true;
      if (fault === "subject") f.changeSubject();
      if (fault === "permission") f.deny();
      if (fault === "proof") f.revoke();
    });
    const result = await f.read(); assert.equal(result.ok, false); assert.equal(f.writes.length, 0);
  });
test("E2E-405 missing/denied proof, independent permission and invalid queries do not read a patient case", async () => {
  for (const fault of ["permission", "proof", "scope", "case", "time"] as const) {
    const f = fixture(); if (fault === "permission") f.deny(); if (fault === "proof") f.revoke();
    const result = await f.read({ ...f.query, ...(fault === "scope" ? { scope: { ...scope, locationId: "foreign" } } : {}),
      ...(fault === "case" ? { patientCaseId: "51?secret" } : {}), ...(fault === "time" ? { now: "2026-10-07T11:00:00.000Z" } : {}) });
    assert.equal(result.ok, false); assert.equal(f.traffic.length, 0);
  }
});
for (const status of [401, 403, 429, 503]) test(`E2E-405 case HTTP${status} yields typed failure without exposing native content`, async () => {
  const f = fixture(); f.setStatus(status); const result = await f.read(); assert.equal(result.ok, false);
  assert.equal(result.error.kind, status === 429 ? "rateLimited" : status === 503 ? "unavailable" : "forbidden");
  assert.equal(JSON.stringify(result).includes(canary), false);
  if (status === 429) assert.equal((await f.budget.claim())?.kind, "rateLimited");
});
test("E2E-405 truncated, oversized and contradictory pages never produce a partial pass balance", async () => {
  for (const fault of ["truncated", "oversized", "next"] as const) {
    const f = fixture(); f.onBody((path, body) => {
      if (!path.endsWith("/attendees")) return;
      if (fault === "truncated") (body.attendees as unknown[]).pop();
      if (fault === "oversized") body.total_entries = 1001;
      if (fault === "next") body.links = { next: "https://foreign.test/steal" };
    });
    const result = await f.read(); assert.equal(result.ok, false); assert.equal(result.error.kind, fault === "oversized" ? "tooManyResults" : "malformed");
  }
});
test("E2E-405 caller abort resolves an unresponsive private source and does not mutate attendance", async () => {
  const f = fixture(), abort = new AbortController();
  const never = resultValue(ClinikoPatientCaseSessionsReader.create(f.config, f.proof, f.permission, async () => {
    queueMicrotask(() => abort.abort()); return new Promise<Response>(() => {});
  }, () => now));
  const result = await never.read(f.query, abort.signal); assert.equal(result.ok, false); assert.equal(result.error.kind, "unavailable"); assert.equal(f.writes.length, 0);
});
test("E2E-405 native case-linked registration requires current counters and inspects the exact case association", async () => {
  const f = fixture(), signal = new AbortController().signal, shared = structuredClone(f.groups);
  const sent = resultValue(await f.writer.executeOnce(f.request, signal, f.permit)); assert.equal(sent.kind, "accepted");
  assert.equal(resultValue(await f.writer.inspect(f.request, sent.attendeeRef, signal, async s => (await f.read(f.query, s)).ok)), true);
  const pass = resultValue(await f.read()); assert.equal(pass.used, 3); assert.equal(pass.remaining, 2);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0]!.patient_case_id, "51"); assert.deepEqual(f.groups, shared);
  f.rows.find(r => r.id === "701")!.patient_case = link("patient_cases", "52");
  assert.equal(resultValue(await f.writer.inspect(f.request, sent.attendeeRef, signal, async () => true)), false);
});
for (const fault of ["wrongCase", "lost", "lateUse"] as const)
  test(`E2E-405 ${fault} cannot confirm or replay a case-linked attendance`, async () => {
    const f = fixture(), signal = new AbortController().signal;
    if (fault === "wrongCase") f.wrongCase(); if (fault === "lost") f.lose();
    if (fault === "lateUse") f.onWrite(() => { f.record.max_sessions = 2; });
    const sent = resultValue(await f.writer.executeOnce(f.request, signal, f.permit));
    if (fault === "lateUse") {
      assert.equal(sent.kind, "accepted", "provider acknowledgement alone is not final pass qualification");
      assert.equal(resultValue(await f.read()).overdrawn, true);
    } else assert.equal(sent.kind, "uncertain");
    assert.equal((await f.writer.executeOnce(f.request, signal, f.permit)).ok, false); assert.equal(f.writes.length, 1);
  });
test("E2E-405 final account-budget wait rechecks a depleted native case before sending", async () => {
  const f = fixture(); let first = true;
  const rateBudget = { claim: async () => { if (first) { first = false; f.record.max_sessions = 2; } return null; }, observe429: f.budget.observe429.bind(f.budget) };
  const writer = resultValue(ClinikoClassAttendanceWriter.create({ ...f.attendanceConfig, rateBudget }, f.fetchPort));
  assert.equal((await writer.executeOnce(f.request, new AbortController().signal, f.permit)).ok, false); assert.equal(f.writes.length, 0);
});
test("E2E-405 invalid native case IDs cannot be attached implicitly or supplied to cancellation", async () => {
  const f = fixture(), signal = new AbortController().signal;
  for (const patientCaseId of [undefined, null, "", "51?x", 51]) {
    const result = await f.writer.executeOnce({ ...f.request, patientCaseId } as ClinikoAttendanceRequest, signal, async () => true);
    assert.equal(result.ok, false);
  }
  const cancel = { ...f.request, kind: "cancel", attendeeId: "101", cancellationReason: 50 } as ClinikoAttendanceRequest;
  assert.equal((await f.writer.executeOnce(cancel, signal, async () => true)).ok, false); assert.equal(f.writes.length, 0);
});

async function movementFixture(includeCancelled = false, arrived: boolean | null = null, includeDna = false) {
  const f = fixture(), signal = new AbortController().signal;
  // The source belongs to another class/service; no catalogue or future-only
  // filter may drop it when qualifying the whole case's final movement.
  f.rows[0]!.arrived = arrived; f.record.include_cancelled_attendees = includeCancelled; f.record.include_dna_attendees = includeDna;
  const before = resultValue(await f.read());
  const original = f.rows[0]!; original.cancelled_at = now;
  const replacement: Record<string, unknown> = { ...attendee("701", "94", "42"), patient_case: link("patient_cases", "51"), arrived: null };
  f.rows.push(replacement); (f.record.attendee_ids as string[]).push("701");
  const movement = { usageFingerprint: before.usageFingerprint, originalAttendeeId: "601", originalClassSessionId: "401", replacementAttendeeId: "701" };
  return { ...f, signal, before, original, replacement, movement, inspect: () => f.reader.inspectMovement(f.query, movement, signal) };
}
for (const cancelled of [false, true]) for (const arrived of [null, false, true]) for (const dna of [false, true])
  test(`E2E-408 whole-case movement inspects exact original and replacement with cancelled=${cancelled} arrived=${arrived} DNA=${dna}`, async () => {
    const f = await movementFixture(cancelled, arrived, dna), result = resultValue(await f.inspect());
    const contribution = arrived === false ? Number(dna) : 1;
    assert.equal(result.used, f.before.used + 1 + Number(cancelled) - contribution);
    assert.equal(result.maximum, f.before.maximum); assert.notEqual(result.usageFingerprint, f.before.usageFingerprint);
    assert.equal(result.financialAuthority, "none"); assert.equal(result.reservable, false); assert.equal(f.writes.length, 0);
    assert.equal(JSON.stringify(result).includes(canary), false);
  });
test("E2E-408 an observed same-case move can release the original full-pass session without pretending to reserve capacity", async () => {
  const f = await movementFixture(); f.record.max_sessions = f.before.used;
  // Bind a source snapshot at the full limit before applying the two changes.
  f.original.cancelled_at = null; f.rows.pop(); (f.record.attendee_ids as string[]).pop();
  const before = resultValue(await f.read()); assert.equal(before.remaining, 0);
  f.movement.usageFingerprint = before.usageFingerprint; f.original.cancelled_at = now;
  f.rows.push(f.replacement); (f.record.attendee_ids as string[]).push("701");
  const result = resultValue(await f.inspect()); assert.equal(result.used, before.used); assert.equal(result.remaining, 0); assert.equal(result.overdrawn, false);
});
for (const fault of ["originalActive", "wrongSource", "originalArchived", "replacementCancelled", "replacementDna", "wrongDestination", "rule", "maximum", "expiry", "swap", "extraUse", "permission", "proof"] as const)
  test(`E2E-408 ${fault} cannot satisfy an exact whole-case movement`, async () => {
    const f = await movementFixture();
    if (fault === "originalActive") f.original.cancelled_at = null;
    if (fault === "wrongSource") f.original.booking = link("bookings", "402");
    if (fault === "originalArchived") f.original.archived_at = now;
    if (fault === "replacementCancelled") f.replacement.cancelled_at = now;
    if (fault === "replacementDna") f.replacement.arrived = false;
    if (fault === "wrongDestination") f.replacement.booking = link("bookings", "93");
    if (fault === "rule") f.record.include_cancelled_attendees = true;
    if (fault === "maximum") f.record.max_sessions = 6;
    if (fault === "expiry") f.record.expiry_date = "2026-10-10";
    if (fault === "swap") { f.rows[1]!.id = "702"; f.rows[1]!.links = { self: "https://api.au5.cliniko.com/v1/attendees/702" }; (f.record.attendee_ids as string[])[1] = "702"; }
    if (fault === "extraUse") { f.rows.push({ ...attendee("703", "406", "42"), patient_case: link("patient_cases", "51"), arrived: null }); (f.record.attendee_ids as string[]).push("703"); }
    if (fault === "permission") f.deny(); if (fault === "proof") f.revoke();
    const result = await f.inspect(); assert.equal(result.ok, false); assert.equal(f.writes.length, 0);
    assert.equal(result.error.kind, fault === "permission" ? "forbidden" : fault === "proof" ? "invalidProof" : "changed");
  });
test("E2E-408 invalid movement identities cannot start protected reads and source mutation is not caller authority", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const movement = { usageFingerprint: "a".repeat(64), originalAttendeeId: "601", originalClassSessionId: "401", replacementAttendeeId: "701" };
  for (const patch of [{ usageFingerprint: "guessed" }, { originalAttendeeId: "701" }, { originalClassSessionId: "94" },
    { replacementAttendeeId: "-1" }, { originalClassSessionId: "401?secret" }]) {
    const result = await f.reader.inspectMovement(f.query, { ...movement, ...patch }, signal);
    assert.equal(result.ok, false); assert.equal(result.error.kind, "invalidQuery");
  }
  assert.equal(f.traffic.length, 0); assert.equal(f.writes.length, 0);
});
