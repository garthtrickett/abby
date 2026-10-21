import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ClinikoClassAttendanceWriter } from "../../src/cliniko/class-attendance-write.ts";
import type { ClinikoAttendanceRequest } from "../../src/cliniko/class-attendance-write.ts";
import { classAttendanceFixture } from "../support/class-attendance.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("only the owning class writer's actual204 result supplies immutable cancellation acknowledgement, not inspected success", async () => {
  const f = classAttendanceFixture(), q: Extract<ClinikoAttendanceRequest, { kind: "cancel" }> = { kind: "cancel", scope: f.config.scope,
    actionId: randomUUID(), patientId: "42", sessionId: "91", attendeeId: "101", cancellationReason: 50 };
  let sends = 0; const port: typeof fetch = async (_url, init) => { sends++; assert.equal(init?.method, "PATCH"); return new Response(null, { status: 204 }); };
  const writer = resultValue(ClinikoClassAttendanceWriter.create(f.config, port)), other = resultValue(ClinikoClassAttendanceWriter.create(f.config, port));
  const result = resultValue(await writer.executeOnce(q, new AbortController().signal, async () => true)); assert.equal(result.kind, "accepted");
  const source = writer.cancellationAcknowledgement(result); assert.ok(source); assert.deepEqual(source.request, q); assert.equal(source.attendeeRef, "cliniko:attendee:101");
  assert.equal(Object.isFrozen(source), true); assert.equal(Object.isFrozen(source.request.scope), true); assert.equal(Object.isFrozen(source.selection.scope), true);
  assert.equal(writer.cancellationAcknowledgement({ ...result }), undefined); assert.equal(other.cancellationAcknowledgement(result), undefined);
  assert.equal(writer.bookingAcknowledgement(result), undefined); assert.equal(sends, 1, "no inspection is fabricated or silently performed");
});

test("lost and non204 class cancellation responses supply no memo acknowledgement and cannot be replayed", async () => {
  for (const lost of [false, true]) {
    const f = classAttendanceFixture(), q: Extract<ClinikoAttendanceRequest, { kind: "cancel" }> = { kind: "cancel", scope: f.config.scope,
      actionId: randomUUID(), patientId: "42", sessionId: "91", attendeeId: "101", cancellationReason: 50 };
    let sends = 0; const writer = resultValue(ClinikoClassAttendanceWriter.create(f.config, async () => { sends++; if (lost) throw Error("Synthetic response loss"); return new Response(null, { status: 200 }); }));
    const result = resultValue(await writer.executeOnce(q, new AbortController().signal, async () => true)); assert.equal(result.kind, "uncertain");
    assert.equal(writer.cancellationAcknowledgement(result), undefined); assert.equal((await writer.executeOnce(q, new AbortController().signal, async () => true)).ok, false); assert.equal(sends, 1);
  }
});
