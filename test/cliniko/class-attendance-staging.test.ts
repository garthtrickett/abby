import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ClinikoClassAttendanceWriter } from "../../src/cliniko/class-attendance-write.ts";
import type { ClinikoAttendanceRequest } from "../../src/cliniko/class-attendance-write.ts";
import { classAttendanceFixture, classScope as scope, classNow as now, classAttendee as attendee, classLink as link } from "../support/class-attendance.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

function fixture() {
  const f = classAttendanceFixture(), request: Extract<ClinikoAttendanceRequest, { kind: "book" }> = { kind: "book", scope, patientId: "42", sessionId: "94", actionId: randomUUID() };
  const row: Record<string, unknown> = { ...attendee("701", "94", "42"), arrived: null, notes: `Abby attendance ${request.actionId}` };
  const traffic: string[][] = []; let allowed = true, linked = false, status = 200, beforeRead = (_count: number) => {}, onBody = (_body: Record<string, unknown>) => {};
  const fetchPort: typeof fetch = async (value, init) => {
    const u = new URL(String(value)); assert.equal(u.origin, "https://api.au5.cliniko.com"); assert.equal(u.pathname, "/v1/attendees");
    assert.equal(init?.method, "GET"); assert.equal(init.redirect, "error"); assert.ok(init.signal);
    assert.equal(u.searchParams.get("page"), "1"); assert.equal(u.searchParams.get("per_page"), "100"); assert.equal(u.searchParams.get("sort"), "id:asc");
    const filters = u.searchParams.getAll("q[]"); assert.deepEqual(filters, ["id:=701", "patient_id:=42", "booking_id:=94", "patient_case_id:!?"]);
    traffic.push(filters); beforeRead(traffic.length);
    if (status !== 200) return new Response(null, { status, headers: { "X-RateLimit-Reset": String(Date.parse(now) / 1000 + 60) } });
    const body = { attendees: linked ? [] : [structuredClone(row)], total_entries: linked ? 0 : 1 };
    onBody(body); return Response.json(body);
  };
  const writer = resultValue(ClinikoClassAttendanceWriter.create(f.config, fetchPort));
  const permit = async (signal: AbortSignal) => {
    const p = await f.proof.verifyPatient(scope, "private-class-proof", now, signal);
    return allowed && !signal.aborted && p.ok && p.value.patientRef === "42";
  };
  const inspect = (signal = new AbortController().signal) => writer.inspectUnlinked(request, "cliniko:attendee:701", signal, permit);
  return { ...f, row, request, writer, fetchPort, permit, inspect, traffic, get proofCalls() { return f.proofCalls; }, deny: () => { allowed = false; }, link: () => { linked = true; },
    beforeRead: (hook: typeof beforeRead) => { beforeRead = hook; }, onBody: (hook: typeof onBody) => { onBody = hook; }, setStatus: (value: number) => { status = value; } };
}

test("E2E-408 a staged replacement requires two exact native is-null-filtered observations and current proof/independent permission", async () => {
  const f = fixture(), before = structuredClone(f.attendees), groups = structuredClone(f.groups);
  assert.equal(resultValue(await f.inspect()), true); assert.equal(f.traffic.length, 2); assert.equal(f.proofCalls, 4);
  assert.deepEqual(f.attendees, before); assert.deepEqual(f.groups, groups);
});
test("E2E-408 missing case property alone cannot prove an unlinked replacement if the provider auto-associated it", async () => {
  const f = fixture(); assert.equal("patient_case" in f.row, false); f.link();
  assert.equal(resultValue(await f.inspect()), false); assert.equal(f.traffic.length, 1);
});
test("E2E-408 a case assigned between staging observations cannot authorize original cancellation", async () => {
  const f = fixture(); f.beforeRead(count => { if (count === 2) f.link(); });
  assert.equal(resultValue(await f.inspect()), false); assert.equal(f.traffic.length, 2);
});
for (const fault of ["patient", "booking", "id", "notes", "cancelled", "archived", "deleted", "arrived", "case", "malformedCase"] as const)
  test(`E2E-408 staging row ${fault} contradicts the exact replacement and cannot pass`, async () => {
    const f = fixture();
    if (fault === "patient") f.row.patient = link("patients", "43");
    if (fault === "booking") f.row.booking = link("bookings", "93");
    if (fault === "id") f.row.id = "702";
    if (fault === "notes") f.row.notes = "private unrelated attendance";
    if (fault === "cancelled") f.row.cancelled_at = now;
    if (fault === "archived") f.row.archived_at = now;
    if (fault === "deleted") f.row.deleted_at = now;
    if (fault === "arrived") f.row.arrived = false;
    if (fault === "case") f.row.patient_case = link("patient_cases", "51");
    if (fault === "malformedCase") f.row.patient_case = { links: "not-a-link" };
    assert.equal(resultValue(await f.inspect()), false);
  });
for (const fault of ["missing", "total", "duplicate", "next"] as const)
  test(`E2E-408 staging collection ${fault} is incomplete or contradictory`, async () => {
    const f = fixture(); f.onBody(body => {
      if (fault === "missing") delete body.attendees;
      if (fault === "total") body.total_entries = 2;
      if (fault === "duplicate") { body.attendees = [f.row, f.row]; body.total_entries = 2; }
      if (fault === "next") body.links = { next: "https://foreign.example.test/attendees" };
    });
    const result = await f.inspect(); assert.equal(result.ok, false); assert.equal(result.error.kind, "malformed");
  });
test("E2E-408 denied staging permission, late budget denial and post-response revocation do not publish an unlinked result", async () => {
  const denied = fixture(); denied.deny(); assert.equal((await denied.inspect()).ok, false); assert.equal(denied.traffic.length, 0);
  const late = fixture(), budget = { claim: async () => { late.deny(); return null; }, observe429: late.budget.observe429.bind(late.budget) };
  const writer = resultValue(ClinikoClassAttendanceWriter.create({ ...late.config, rateBudget: budget }, late.fetchPort));
  assert.equal((await writer.inspectUnlinked(late.request, "cliniko:attendee:701", new AbortController().signal, late.permit)).ok, false); assert.equal(late.traffic.length, 0);
  const revoked = fixture(); revoked.beforeRead(count => { if (count === 2) revoked.deny(); });
  assert.equal((await revoked.inspect()).ok, false); assert.equal(revoked.traffic.length, 2);
});
for (const status of [401, 403, 429, 503]) test(`E2E-408 HTTP${status} staging inspection fails without a mutation or native payload escaping`, async () => {
  const f = fixture(); f.setStatus(status); const result = await f.inspect(); assert.equal(result.ok, false);
  assert.equal(result.error.kind, status === 429 ? "rateLimited" : status === 503 ? "unavailable" : "forbidden");
  assert.equal(JSON.stringify(result).includes("private"), false);
});
test("E2E-408 invalid staging input or aborted private source cannot read or claim a staged replacement", async () => {
  const f = fixture(), signal = new AbortController().signal;
  assert.equal((await f.writer.inspectUnlinked({ ...f.request, patientCaseId: "51" }, "cliniko:attendee:701", signal, f.permit)).ok, false);
  assert.equal((await f.writer.inspectUnlinked(f.request, "cliniko:attendee:701?x", signal, f.permit)).ok, false); assert.equal(f.traffic.length, 0);
  const abort = new AbortController();
  const writer = resultValue(ClinikoClassAttendanceWriter.create(f.config, async () => { queueMicrotask(() => abort.abort()); return new Promise<Response>(() => {}); }));
  const result = await writer.inspectUnlinked(f.request, "cliniko:attendee:701", abort.signal, f.permit);
  assert.equal(result.ok, false); assert.equal(result.error.kind, "unavailable");
});
