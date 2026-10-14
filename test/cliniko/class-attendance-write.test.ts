import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ClinikoClassAttendanceWriter } from "../../src/cliniko/class-attendance-write.ts";
import type { ClinikoAttendanceRequest } from "../../src/cliniko/class-attendance-write.ts";
import { classAttendanceFixture, classScope as scope, classNow as now, classUntil as to, classBase as base, classAttendee as attendee, classLink as link } from "../support/class-attendance.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

function fixture(kind: "book" | "cancel" = "book") {
  const f = classAttendanceFixture(), writes: { path: string; body: Record<string, unknown> }[] = [], reads: string[] = [];
  const beforeGroups = structuredClone(f.groups), beforeOther = structuredClone(f.attendees.filter(row => (row.patient as { links: { self: string } }).links.self !== `${base}/patients/42`));
  let allowed = true, lost = false, incorrect = false, afterSend: (() => void) | undefined, afterRead: (() => void) | undefined;
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET";
    if (method === "POST" || method === "PATCH") {
      assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
      const body = JSON.parse(String(init?.body)); writes.push({ path: url.pathname, body });
      let row: Record<string, unknown>;
      if (method === "POST") {
        assert.equal(url.pathname, "/v1/attendees"); assert.deepEqual(Object.keys(body).sort(), ["booking_id", "notes", "patient_id"]);
        row = { ...attendee("401", body.booking_id, body.patient_id), notes: body.notes }; f.attendees.push(row);
      } else {
        assert.equal(url.pathname, "/v1/attendees/101/cancel"); assert.deepEqual(body, { cancellation_reason: 50, apply_to_repeats: false });
        row = f.attendees.find(row => row.id === "101")!; row.cancelled_at = now; row.cancellation_reason = body.cancellation_reason;
      }
      afterSend?.();
      if (lost) throw new Error("synthetic lost attendance write response");
      return method === "PATCH" ? new Response(null, { status: 204 }) : Response.json(incorrect ? { ...row, patient: link("patients", "999") } : row, { status: 201 });
    }
    if (/^\/v1\/attendees\/\d+$/.test(url.pathname)) {
      reads.push(url.pathname); afterRead?.(); return Response.json(f.attendees.find(row => row.id === url.pathname.split("/").at(-1)));
    }
    return f.fetchPort(value, init);
  };
  const writer = resultValue(ClinikoClassAttendanceWriter.create(f.config, fetchPort));
  const request: ClinikoAttendanceRequest = { scope, actionId: randomUUID(), patientId: "42", sessionId: kind === "book" ? "94" : "91",
    ...(kind === "book" ? { kind } : { kind, attendeeId: "101", cancellationReason: 50 }) };
  let checks = 0;
  const permit = async (signal: AbortSignal) => {
    checks++; if (!allowed) return false;
    const observed = await f.reader.inspect(scope, "private-class-proof", request.sessionId, now, to, now, signal);
    if (!observed.ok || observed.value.patientRef !== request.patientId) return false;
    const selected = observed.value.sessions[0];
    return !!selected && (kind === "book" ? selected.attendance.kind === "none" && selected.remainingPlaces > 0 :
      selected.attendance.kind === "one" && request.kind === "cancel" && selected.attendance.attendeeRef === request.attendeeId);
  };
  // Independent permission remains required for exact post-write record access.
  const readPermit = async (signal: AbortSignal) => {
    checks++; if (!allowed || signal.aborted) return false;
    const proof = await f.proof.verifyPatient(scope, "private-class-proof", now);
    return proof.ok && proof.value.patientRef === request.patientId && !signal.aborted;
  };
  return { ...f, writer, request, permit, readPermit, writes, reads,
    get checks() { return checks; }, deny: () => { allowed = false; }, loseResponse: () => { lost = true; }, wrongReceipt: () => { incorrect = true; },
    afterSend: (callback: () => void) => { afterSend = callback; },
    afterRead: (callback: () => void) => { afterRead = callback; },
    unchangedSharedRecords: () => { assert.deepEqual(f.groups, beforeGroups); assert.deepEqual(f.attendees.filter(row => (row.patient as { links: { self: string } }).links.self !== `${base}/patients/42`), beforeOther); } };
}

for (const kind of ["book", "cancel"] as const) {
  test(`E2E-391 native class ${kind} changes one attendee after current private proof/capacity and inspects exact receipt`, async () => {
    const f = fixture(kind), signal = new AbortController().signal;
    const outcome = resultValue(await f.writer.executeOnce(f.request, signal, f.permit)); assert.equal(outcome.kind, "accepted");
    assert.equal(resultValue(await f.writer.inspect(f.request, outcome.attendeeRef, signal, f.readPermit)), true);
    assert.equal(f.writes.length, 1); assert.equal(f.reads.length, 1); f.unchangedSharedRecords();
    if (kind === "book") assert.deepEqual(f.writes[0]!.body, { booking_id: "94", patient_id: "42", notes: `Abby attendance ${f.request.actionId}` });
    else assert.equal(f.attendees.find(row => row.id === "105")!.cancelled_at, null, "another occurrence is never cancelled");
    assert.equal(JSON.stringify(outcome).includes("private"), false);
  });
  test(`E2E-391 unknown class ${kind} stays uncertain and the same action cannot replay`, async () => {
    const f = fixture(kind), signal = new AbortController().signal; f.loseResponse();
    assert.deepEqual(resultValue(await f.writer.executeOnce(f.request, signal, f.permit)), { kind: "uncertain" });
    const repeat = await f.writer.executeOnce(f.request, signal, f.permit); assert.equal(repeat.ok, false); assert.equal(repeat.error.kind, "invalidQuery");
    assert.equal(f.writes.length, 1); f.unchangedSharedRecords();
  });
  test(`E2E-391 concurrent identical class ${kind} actions reserve before asynchronous permission reads`, async () => {
    const f = fixture(kind), signal = new AbortController().signal;
    const outcomes = await Promise.all([f.writer.executeOnce(f.request, signal, f.permit), f.writer.executeOnce(f.request, signal, f.permit)]);
    assert.equal(outcomes.filter(row => row.ok && row.value.kind === "accepted").length, 1);
    assert.equal(outcomes.filter(row => !row.ok && row.error.kind === "invalidQuery").length, 1); assert.equal(f.writes.length, 1);
  });
  test(`E2E-391 class ${kind} permission denied before send or revoked before inspection never yields an exact inspected result`, async () => {
    const f = fixture(kind), signal = new AbortController().signal; f.deny();
    assert.equal((await f.writer.executeOnce(f.request, signal, f.permit)).ok, false); assert.equal(f.writes.length, 0);
    const g = fixture(kind); g.afterSend(g.deny);
    const accepted = resultValue(await g.writer.executeOnce(g.request, signal, g.permit)); assert.equal(accepted.kind, "accepted");
    assert.equal((await g.writer.inspect(g.request, accepted.attendeeRef, signal, g.readPermit)).ok, false); assert.equal(g.reads.length, 0);
  });
}

test("E2E-391 already registered, full and duplicate own attendance deny another class registration", async () => {
  for (const sessionId of ["91", "92", "93"]) {
    const f = fixture(); (f.request as { sessionId: string }).sessionId = sessionId;
    const result = await f.writer.executeOnce(f.request, new AbortController().signal, f.permit);
    assert.equal(result.ok, false); assert.equal(f.writes.length, 0);
  }
});

test("E2E-391 cancellation cannot target a different patients attendee", async () => {
  const f = fixture("cancel"); assert.equal(f.request.kind, "cancel"); (f.request as { attendeeId: string }).attendeeId = "102";
  assert.equal((await f.writer.executeOnce(f.request, new AbortController().signal, f.permit)).ok, false); assert.equal(f.writes.length, 0);
});

test("E2E-391 wrong-patient acknowledgement or drift in an inspected attendance cannot claim success", async () => {
  const f = fixture(); f.wrongReceipt();
  assert.deepEqual(resultValue(await f.writer.executeOnce(f.request, new AbortController().signal, f.permit)), { kind: "uncertain" });
  const g = fixture(), signal = new AbortController().signal;
  const accepted = resultValue(await g.writer.executeOnce(g.request, signal, g.permit)); assert.equal(accepted.kind, "accepted");
  g.attendees.find(row => row.id === "401")!.booking = link("bookings", "93");
  assert.equal(resultValue(await g.writer.inspect(g.request, accepted.attendeeRef, signal, g.readPermit)), false);
});

test("E2E-391 mutation acknowledgement cannot reserve class capacity or hide a concurrent overbooking", async () => {
  const f = fixture(), signal = new AbortController().signal; f.groups.find(row => row.id === "94")!.max_attendees = 1;
  f.afterSend(() => { f.attendees.push(attendee("402", "94", "49")); });
  const acknowledged = resultValue(await f.writer.executeOnce(f.request, signal, f.permit)); assert.equal(acknowledged.kind, "accepted");
  assert.equal(resultValue(await f.writer.inspect(f.request, acknowledged.attendeeRef, signal, f.readPermit)), true);
  const current = resultValue(await f.reader.inspect(scope, "private-class-proof", "94", now, to, now, signal));
  assert.equal(current.sessions[0]!.overCapacity, true); assert.equal(current.sessions[0]!.remainingPlaces, 0);
  assert.equal((await f.writer.executeOnce(f.request, signal, f.permit)).ok, false); assert.equal(f.writes.length, 1);
});

test("E2E-391 permission is checked after a final account-budget wait", async () => {
  const f = fixture(), signal = new AbortController().signal;
  let first = true;
  const budget = { claim: async () => { if (first) { first = false; f.deny(); } return null; }, observe429: f.budget.observe429.bind(f.budget) };
  const writer = resultValue(ClinikoClassAttendanceWriter.create({ ...f.config, rateBudget: budget }, f.fetchPort));
  assert.equal((await writer.executeOnce(f.request, signal, f.permit)).ok, false); assert.equal(f.writes.length, 0);
});

test("E2E-391 invalid scope, missing trusted authority and pre-send abort cannot invoke an attendee write", async () => {
  const f = fixture(), signal = new AbortController().signal;
  assert.equal((await f.writer.executeOnce({ ...f.request, scope: { ...scope, locationId: "foreign" } }, signal, f.permit)).ok, false);
  assert.equal((await f.writer.executeOnce(f.request, signal, undefined as unknown as typeof f.permit)).ok, false);
  const abort = new AbortController(); abort.abort(); assert.equal((await f.writer.executeOnce(f.request, abort.signal, f.permit)).ok, false);
  assert.equal(f.writes.length, 0); assert.equal(f.checks, 0);
});

test("E2E-391 an abort after provider invocation is uncertain and cannot invoke another mutation", async () => {
  const f = fixture(), abort = new AbortController(); f.afterSend(() => abort.abort());
  assert.deepEqual(resultValue(await f.writer.executeOnce(f.request, abort.signal, f.permit)), { kind: "uncertain" });
  assert.equal((await f.writer.executeOnce(f.request, new AbortController().signal, f.permit)).ok, false); assert.equal(f.writes.length, 1);
});

test("E2E-391 permission withdrawn during exact attendee inspection prevents the result from escaping", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const acknowledged = resultValue(await f.writer.executeOnce(f.request, signal, f.permit)); assert.equal(acknowledged.kind, "accepted");
  f.afterRead(f.deny); const inspected = await f.writer.inspect(f.request, acknowledged.attendeeRef, signal, f.readPermit);
  assert.equal(inspected.ok, false); assert.equal(inspected.error.kind, "forbidden"); assert.equal(f.reads.length, 1); assert.equal(f.writes.length, 1);
});

test("E2E-391 aborting a pending budget reservation does not send or call private authority", async () => {
  const f = fixture(), abort = new AbortController();
  const budget = { claim: () => new Promise<null>(() => { queueMicrotask(() => abort.abort()); }), observe429: f.budget.observe429.bind(f.budget) };
  const writer = resultValue(ClinikoClassAttendanceWriter.create({ ...f.config, rateBudget: budget }, f.fetchPort));
  const result = await writer.executeOnce(f.request, abort.signal, f.permit);
  assert.equal(result.ok, false); assert.equal(result.error.kind, "unavailable"); assert.equal(f.writes.length, 0); assert.equal(f.checks, 0);
});
