import assert from "node:assert/strict";
import test from "node:test";
import { decodeAdministrativeMemo, administrativeMemoActionRef } from "../../src/cliniko/administrative-memo.ts";
import { classBookingMemoFixture } from "../support/class-booking-memo.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { ClinikoClassAttendanceWriter } from "../../src/cliniko/class-attendance-write.ts";

for (const passes of [false, true]) for (const mode of ["accepted", "lostStored", "lostUnstored", "nonexact"] as const)
test(`actual ${passes ? "pass" : "ordinary"} class attendance has one patient memo without claiming payment or a whole move: ${mode}`, async t => {
  const f = await classBookingMemoFixture({ passes, mode }); t.after(f.close); const action = await f.prepare(); await f.drain();
  assert.equal((await f.state()).actions[action.key]!.status, "committed"); assert.equal(f.writes.length, 1); assert.equal(f.memoPosts.length, 1);
  assert.equal(f.outcomes[0]!.kind, mode === "accepted" ? "accepted" : "uncertain");
  const memo = decodeAdministrativeMemo(f.memoPosts[0]!.content); assert.ok(memo.ok); assert.equal(memo.value.outcome.kind, "classBookingConfirmed");
  assert.equal(memo.value.patientId, verificationCanaries[2]); assert.equal(memo.value.outcome.appointmentRef, "cliniko:booking:94");
  assert.equal(memo.value.outcome.attendeeRef, "cliniko:attendee:401"); assert.equal(memo.value.direction, "inbound");
  assert.equal(f.writes[0]!.notes, `Abby attendance ${memo.value.sourceActionRef}`); assert.equal(memo.value.actionRef, administrativeMemoActionRef(memo.value.sourceActionRef));
  assert.equal(f.memoPosts[0]!.patient_id, verificationCanaries[2]); assert.equal(f.cancellations.length, 0);
  await f.drain(); assert.equal(f.writes.length, 1); assert.equal(f.memoPosts.length, 1);
});

for (const passes of [false, true]) test(`actual ${passes ? "pass" : "ordinary"} class acknowledgement survives a held independent memo grant and clinical disposal`, async t => {
  const f = await classBookingMemoFixture({ passes }); t.after(f.close); const action = await f.prepare(); let release!: () => void;
  f.gates.hold = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.drainClinical(); assert.equal((await f.state()).actions[action.key]!.status, "committed"); assert.equal(f.outcomes.length, 0);
    f.host.dispose(); release(); await f.memoSettled; assert.equal(f.outcomes[0]!.kind, "accepted"); assert.equal(f.writes.length, 1);
  } finally { release(); }
});

for (const denied of ["producer", "allowed", "clinicalLost", "reviewLost"] as const)
test(`class memo cannot promote or repeat a clinical operation after ${denied}`, async t => {
  const f = await classBookingMemoFixture(); t.after(f.close); const action = await f.prepare();
  if (denied === "producer") f.gates.producer = false;
  if (denied === "allowed") f.gates.allowed = false;
  if (denied === "clinicalLost") f.loseWrite();
  if (denied === "reviewLost") f.loseReview();
  await f.drain(); assert.equal(f.memoPosts.length, 0); assert.equal(f.consumed.size, 0);
  if (denied === "producer" || denied === "allowed") assert.equal((await f.state()).actions[action.key]!.status, "committed");
  else assert.notEqual((await f.state()).actions[action.key]!.status, "committed");
  const writes = f.writes.length; await f.drain(); assert.equal(f.writes.length, writes); assert.equal(f.memoPosts.length, 0);
});

test("class receipt source is captured before a clinical acknowledgement observer disposes the host", async t => {
  const f = await classBookingMemoFixture(); t.after(f.close); const action = await f.prepare();
  const execute = ClinikoClassAttendanceWriter.prototype.executeBookingOnce;
  t.mock.method(ClinikoClassAttendanceWriter.prototype, "executeBookingOnce", function(this: ClinikoClassAttendanceWriter,
    ...[q, signal, checks]: Parameters<typeof execute>) {
    return execute.call(this, q, signal, { ...checks, acknowledged: receipt => { checks.acknowledged(receipt); f.host.dispose(); } });
  });
  await f.drain(); assert.equal((await f.state()).actions[action.key]!.status, "committed"); assert.equal(f.outcomes[0]!.kind, "accepted");
  assert.equal(f.writes.length, 1); assert.equal(f.memoPosts.length, 1);
});

for (const passes of [false, true]) for (const allowed of [false, true])
test(`actual admitted ${passes ? "pass" : "ordinary"} class owner separately verifies its patient and ${allowed ? "retains" : "denies"} its memo`, async t => {
  const f = await classBookingMemoFixture({ passes, admitted: true }); t.after(f.close); assert.ok(f.admitted);
  assert.equal(await f.admitted.verified(), undefined); const action = await f.prepare(); f.gates.allowed = allowed;
  await f.drain(); assert.equal((await f.state()).actions[action.key]!.status, "committed"); assert.equal(f.writes.length, 1);
  assert.equal(f.memoPosts.length, allowed ? 1 : 0); assert.equal(f.outcomes[0]!.kind, allowed ? "accepted" : "unavailable");
  if (allowed) {
    const memo = decodeAdministrativeMemo(f.memoPosts[0]!.content); assert.ok(memo.ok);
    assert.equal(memo.value.patientId, verificationCanaries[2]); assert.equal(memo.value.outcome.kind, "classBookingConfirmed");
  }
});
