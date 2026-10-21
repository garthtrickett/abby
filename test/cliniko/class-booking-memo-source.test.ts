import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ClinikoClassAttendanceWriter } from "../../src/cliniko/class-attendance-write.ts";
import type { ClinikoAttendanceRequest } from "../../src/cliniko/class-attendance-write.ts";
import { classAttendanceFixture, classAttendee, classLink } from "../support/class-attendance.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

for (const passes of [false, true]) test(`only the original exact guarded ${passes ? "pass" : "ordinary"} class creation owns immutable memo provenance`, async () => {
  const f = classAttendanceFixture(), q: Extract<ClinikoAttendanceRequest, { kind: "book" }> = { kind: "book", scope: f.config.scope,
    actionId: randomUUID(), patientId: "42", sessionId: "94", ...(passes ? { patientCaseId: "901" } : {}) };
  let calls = 0;
  const port: typeof fetch = async (_url, init) => {
    assert.equal(init?.method, "POST"); calls++; const body = JSON.parse(String(init.body));
    return Response.json({ ...classAttendee("401", body.booking_id, body.patient_id), notes: body.notes,
      ...(body.patient_case_id ? { patient_case: classLink("patient_cases", body.patient_case_id) } : {}) }, { status: 201 });
  };
  const writer = resultValue(ClinikoClassAttendanceWriter.create(f.config, port));
  const result = resultValue(await writer.executeBookingOnce(q, new AbortController().signal, { beforeSend: async () => true,
    current: () => true, acknowledged: receipt => { assert.ok(writer.bookingAcknowledgement(receipt)); throw Error("Synthetic observer failure"); } }));
  assert.equal(result.kind, "accepted"); const source = writer.bookingAcknowledgement(result); assert.ok(source);
  assert.deepEqual(source.request, q); assert.equal(source.attendeeRef, "cliniko:attendee:401"); assert.equal(source.selection.businessId, "11");
  assert.equal(Object.isFrozen(source), true); assert.equal(Object.isFrozen(source.request), true); assert.equal(Object.isFrozen(source.request.scope), true);
  assert.equal(Object.isFrozen(source.selection), true); assert.equal(Object.isFrozen(source.selection.scope), true);
  assert.equal(writer.bookingAcknowledgement({ ...result }), undefined);
  const other = resultValue(ClinikoClassAttendanceWriter.create(f.config, port)); assert.equal(other.bookingAcknowledgement(result), undefined);
  const generic = resultValue(await writer.executeOnce({ ...q, actionId: randomUUID() }, new AbortController().signal, async () => true));
  assert.equal(generic.kind, "accepted"); assert.equal(writer.bookingAcknowledgement(generic), undefined); assert.equal(calls, 2);
});

test("response-loss, nonexact and unapproved-case class results have no memo receipt provenance", async () => {
  for (const mode of ["lost", "wrongPatient", "unapprovedCase"] as const) {
    const f = classAttendanceFixture(), q: Extract<ClinikoAttendanceRequest, { kind: "book" }> = { kind: "book", scope: f.config.scope, actionId: randomUUID(), patientId: "42", sessionId: "94" };
    const writer = resultValue(ClinikoClassAttendanceWriter.create(f.config, async () => {
      if (mode === "lost") throw Error("Synthetic response loss");
      return Response.json({ ...classAttendee("401", "94", mode === "wrongPatient" ? "43" : "42"), notes: `Abby attendance ${q.actionId}`,
        ...(mode === "unapprovedCase" ? { patient_case: classLink("patient_cases", "901") } : {}) }, { status: 201 });
    }));
    const result = resultValue(await writer.executeBookingOnce(q, new AbortController().signal, { beforeSend: async () => true, current: () => true, acknowledged() {} }));
    assert.equal(result.kind, "uncertain"); assert.equal(writer.bookingAcknowledgement(result), undefined);
  }
});

test("optional class provenance failure cannot erase an exact native acknowledgement", async t => {
  const f = classAttendanceFixture(), q: Extract<ClinikoAttendanceRequest, { kind: "book" }> = { kind: "book", scope: f.config.scope, actionId: randomUUID(), patientId: "42", sessionId: "94" };
  const writer = resultValue(ClinikoClassAttendanceWriter.create(f.config, async () => Response.json({ ...classAttendee("401", "94", "42"), notes: `Abby attendance ${q.actionId}` }, { status: 201 })));
  t.mock.method(writer, "selection", () => { throw Error("Synthetic optional source failure"); }); let acknowledged = false;
  const result = resultValue(await writer.executeBookingOnce(q, new AbortController().signal, { beforeSend: async () => true, current: () => true, acknowledged: () => { acknowledged = true; } }));
  assert.equal(result.kind, "accepted"); assert.equal(acknowledged, true); assert.equal(writer.bookingAcknowledgement(result), undefined);
});
