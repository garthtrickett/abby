import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ClinikoClassAttendanceWriter } from "../../src/cliniko/class-attendance-write.ts";
import type { ClinikoAttendanceRequest } from "../../src/cliniko/class-attendance-write.ts";
import { classAttendanceFixture, classScope as scope, classNow as now, classBase as base, classAttendee as attendee, classLink as link } from "../support/class-attendance.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

function fixture() {
  const f = classAttendanceFixture(), creationActionId = randomUUID();
  const request: Extract<ClinikoAttendanceRequest, { kind: "linkCase" }> = {
    kind: "linkCase", scope, actionId: randomUUID(), creationActionId, patientId: "42", sessionId: "94", attendeeId: "701", patientCaseId: "51",
  };
  const row: Record<string, unknown> = { ...attendee("701", "94", "42"), arrived: null,
    notes: `Abby attendance ${creationActionId}`, patient_case: link("patient_cases", "52") };
  const before = structuredClone(row), writes: { path: string; body: unknown }[] = [], reads: string[] = [];
  let allowed = true, lost = false, status = 200, afterWrite = () => {}, beforeReceipt = (_row: Record<string, unknown>) => {}, afterRead = () => {};
  const fetchPort: typeof fetch = async (value, init) => {
    const u = new URL(String(value)); assert.equal(u.origin, base.slice(0, -3));
    assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    assert.equal(u.pathname, "/v1/attendees/701");
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)); writes.push({ path: u.pathname, body });
      assert.deepEqual(body, { patient_case_id: "51" }, "no notes, arrival, booking, patient, repeats or whole-case IDs are changed");
      row.patient_case = link("patient_cases", body.patient_case_id); afterWrite();
      if (lost) throw new Error("synthetic association response lost");
      const receipt = structuredClone(row); beforeReceipt(receipt);
      return status === 204 ? new Response(null, { status }) : Response.json(receipt, { status, headers: { "X-RateLimit-Reset": String(Date.parse(now) / 1000 + 60) } });
    }
    assert.equal(init?.method, "GET"); reads.push(u.pathname); afterRead(); return Response.json(row);
  };
  const writer = resultValue(ClinikoClassAttendanceWriter.create(f.config, fetchPort));
  const permit = async (signal: AbortSignal) => {
    const p = await f.proof.verifyPatient(scope, "private-class-proof", now, signal);
    return allowed && !signal.aborted && p.ok && p.value.patientRef === "42" && row.id === "701" && row.cancelled_at === null &&
      row.notes === `Abby attendance ${creationActionId}` && JSON.stringify(row.patient_case) === JSON.stringify(before.patient_case);
  };
  const inspectPermit = async (signal: AbortSignal) => {
    const p = await f.proof.verifyPatient(scope, "private-class-proof", now, signal);
    return allowed && !signal.aborted && p.ok && p.value.patientRef === "42";
  };
  return { ...f, writer, request, row, before, writes, reads, fetchPort, permit, inspectPermit,
    deny: () => { allowed = false; }, lose: () => { lost = true; }, setStatus: (value: number) => { status = value; },
    afterWrite: (hook: typeof afterWrite) => { afterWrite = hook; }, beforeReceipt: (hook: typeof beforeReceipt) => { beforeReceipt = hook; },
    afterRead: (hook: typeof afterRead) => { afterRead = hook; } };
}

test("E2E-408 native association update changes only an independently approved replacement case and inspects exact receipt", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const accepted = resultValue(await f.writer.executeOnce(f.request, signal, f.permit)); assert.equal(accepted.kind, "accepted");
  assert.equal(accepted.attendeeRef, "cliniko:attendee:701");
  assert.equal(resultValue(await f.writer.inspect(f.request, accepted.attendeeRef, signal, f.inspectPermit)), true);
  assert.deepEqual(f.row, { ...f.before, patient_case: link("patient_cases", "51") });
  assert.equal(f.writes.length, 1); assert.equal(f.reads.length, 1);
  assert.deepEqual(Object.keys(accepted).sort(), ["attendeeRef", "kind"]);
});

for (const fault of ["patient", "session", "case", "attendee", "notes", "cancelled", "archived", "deleted", "dna", "missingArrival", "foreignLink"] as const)
  test(`E2E-408 association acknowledgement with ${fault} cannot become confirmed or replay`, async () => {
    const f = fixture(), signal = new AbortController().signal;
    f.beforeReceipt(row => {
      if (fault === "patient") row.patient = link("patients", "43");
      if (fault === "session") row.booking = link("bookings", "93");
      if (fault === "case") row.patient_case = link("patient_cases", "52");
      if (fault === "attendee") row.id = "702";
      if (fault === "notes") row.notes = "synthetic unrelated attendance";
      if (fault === "cancelled") row.cancelled_at = now;
      if (fault === "archived") row.archived_at = now;
      if (fault === "deleted") row.deleted_at = now;
      if (fault === "dna") row.arrived = false;
      if (fault === "missingArrival") delete row.arrived;
      if (fault === "foreignLink") row.links = { self: "https://foreign.example.test/attendees/701" };
    });
    assert.deepEqual(resultValue(await f.writer.executeOnce(f.request, signal, f.permit)), { kind: "uncertain" });
    assert.equal((await f.writer.executeOnce(f.request, signal, f.permit)).ok, false); assert.equal(f.writes.length, 1);
  });

for (const fault of ["lost", "abort", "204", "201", "422", "429"] as const)
  test(`E2E-408 invoked association with ${fault} remains uncertain and cannot send twice`, async () => {
    const f = fixture(), abort = new AbortController();
    if (fault === "lost") f.lose(); else if (fault === "abort") f.afterWrite(() => abort.abort()); else f.setStatus(Number(fault));
    assert.deepEqual(resultValue(await f.writer.executeOnce(f.request, abort.signal, f.permit)), { kind: "uncertain" });
    assert.equal((await f.writer.executeOnce(f.request, new AbortController().signal, f.permit)).ok, false); assert.equal(f.writes.length, 1);
  });

test("E2E-408 case authority denied before send, after budget wait or during inspection cannot confirm", async () => {
  const signal = new AbortController().signal, denied = fixture(); denied.deny();
  assert.equal((await denied.writer.executeOnce(denied.request, signal, denied.permit)).ok, false); assert.equal(denied.writes.length, 0);
  const late = fixture(), budget = { claim: async () => { late.deny(); return null; }, observe429: late.budget.observe429.bind(late.budget) };
  const writer = resultValue(ClinikoClassAttendanceWriter.create({ ...late.config, rateBudget: budget }, late.fetchPort));
  assert.equal((await writer.executeOnce(late.request, signal, late.permit)).ok, false); assert.equal(late.writes.length, 0);
  const revoked = fixture(), accepted = resultValue(await revoked.writer.executeOnce(revoked.request, signal, revoked.permit));
  assert.equal(accepted.kind, "accepted"); revoked.afterRead(revoked.deny);
  const read = await revoked.writer.inspect(revoked.request, accepted.attendeeRef, signal, revoked.inspectPermit);
  assert.equal(read.ok, false); assert.equal(read.error.kind, "forbidden"); assert.equal(revoked.writes.length, 1);
});

test("E2E-408 association action reserves before asynchronous permit, and pre-send denial alone can release the reservation", async () => {
  const f = fixture(), signal = new AbortController().signal;
  assert.equal((await f.writer.executeOnce(f.request, signal, async () => false)).ok, false);
  const results = await Promise.all([f.writer.executeOnce(f.request, signal, f.permit), f.writer.executeOnce(f.request, signal, f.permit)]);
  assert.equal(results.filter(r => r.ok && r.value.kind === "accepted").length, 1);
  assert.equal(results.filter(r => !r.ok && r.error.kind === "invalidQuery").length, 1); assert.equal(f.writes.length, 1);
});

test("E2E-408 association input cannot change session through native PATCH, drop a case or use an unrelated creation marker", async () => {
  for (const patch of [{ patientCaseId: null }, { patientCaseId: undefined }, { creationActionId: "not-an-action" },
    { attendeeId: "0" }, { booking_id: "93" }, { session: "93" }, { notes: "replace" }, { cancellationReason: 50 }]) {
    const f = fixture(), result = await f.writer.executeOnce({ ...f.request, ...patch } as unknown as ClinikoAttendanceRequest, new AbortController().signal, f.permit);
    assert.equal(result.ok, false); assert.equal(result.error.kind, "invalidQuery"); assert.equal(f.writes.length, 0);
  }
  const f = fixture(), signal = new AbortController().signal;
  assert.equal((await f.writer.executeOnce({ ...f.request, creationActionId: f.request.actionId }, signal, f.permit)).ok, false);
  assert.equal((await f.writer.executeOnce({ ...f.request, scope: { ...scope, locationId: "foreign" } }, signal, f.permit)).ok, false);
  assert.equal((await f.writer.inspect(f.request, "cliniko:attendee:702", signal, f.inspectPermit)).ok, false);
  assert.equal(f.writes.length, 0); assert.equal(f.reads.length, 0);
});

test("E2E-408 an acknowledged case association can drift before readback and grants no class movement or financial result", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const accepted = resultValue(await f.writer.executeOnce(f.request, signal, f.permit)); assert.equal(accepted.kind, "accepted");
  f.row.patient_case = link("patient_cases", "52");
  assert.equal(resultValue(await f.writer.inspect(f.request, accepted.attendeeRef, signal, f.inspectPermit)), false);
  assert.equal(f.writes.length, 1);
});
