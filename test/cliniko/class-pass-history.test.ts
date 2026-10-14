import assert from "node:assert/strict";
import test from "node:test";
import { classMoveFixture } from "../support/class-move.ts";
import { classPassMoveFixture } from "../support/class-pass-move.ts";
import { classBookingFixture } from "../support/class-booking.ts";
import { addCaseHistory } from "../support/class-pass-history.ts";
import { classLink } from "../support/class-attendance.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

type Fixture = Awaited<ReturnType<typeof classMoveFixture>>;
async function move(f: Fixture) {
  await f.verify(); const action = await f.prepare(); await f.play();
  resultValue(await f.reception.affirm(f.scope, f.turn("yes", "Yes"), action.key, action.digest, f.config.clock()));
  resultValue(await f.reception.drain(f.scope, f.callId, f.config.clock()));
  let state = await f.state();
  if (state.actions[action.key]!.status === "awaitingConfirmation") {
    assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
    const p = state.presentations[state.pendingPresentationId!]!; assert.ok("approvedText" in p);
    const seconds = /about (\d+) seconds/.exec(p.approvedText)?.[1]; assert.ok(seconds);
    await f.play(); await f.pause(Number(seconds));
    resultValue(await f.reception.affirm(f.scope, f.turn("yes-again", "Yes"), action.key, action.digest, f.config.clock()));
    resultValue(await f.reception.drain(f.scope, f.callId, f.config.clock())); state = await f.state();
  }
  return { action, state };
}
const combinations = [
  { differentService: false, differentCase: false, history: 501 },
  { differentService: true, differentCase: false, history: 201 },
  { differentService: false, differentCase: true, history: 201 },
  { differentService: true, differentCase: true, history: 201 },
];
for (const c of combinations) test(`E2E-411 ordinary move with ${c.history} mixed associations, service=${c.differentService} case=${c.differentCase}, verifies every page under the physical budget`, async () => {
  const f = await classMoveFixture(c.differentService, false, { differentCase: c.differentCase, history: c.history });
  try {
    const { action, state } = await move(f);
    assert.equal(state.actions[action.key]!.status, "committed", JSON.stringify({ windows: f.windowClaims, writes: f.writes.map(w => w.path) }));
    assert.deepEqual(f.writes.map(w => w.path), ["/v1/attendees", "/v1/attendees/101/cancel", "/v1/attendees/401"]);
    assert.ok(f.windowClaims.every(n => n <= 180));
    assert.equal(f.movePass!.caseRows(f.movePass!.destinationCaseId).length, c.history + 1);
    assert.ok(f.movePass!.casePages.some(p => p.page === Math.ceil((c.history + 1) / 100)));
    assert.equal(f.native.attendees.find(row => row.id === "101")!.cancellation_reason, 50);
    for (const secret of [f.movePass!.sourceCaseId, f.movePass!.destinationCaseId, "synthetic-private-move-pass-note", ...verificationCanaries])
      assert.equal(JSON.stringify([state.callerMessages, state.presentations]).includes(secret), false);
  } finally { await f.close(); }
});
test("E2E-411 a same-count booking-link change on the last history page prevents final confirmation and cannot replay", async () => {
  const f = await classMoveFixture(false, false, { history: 301 });
  try {
    f.onWrite(async phase => {
      if (phase === "association") f.movePass!.caseRows(f.movePass!.sourceCaseId).at(-2)!.booking = classLink("bookings", "799999");
    });
    const { action, state } = await move(f); assert.equal(state.actions[action.key]!.status, "uncertain");
    assert.equal(f.writes.length, 3); await f.reception.drain(f.scope, f.callId, f.config.clock()); assert.equal(f.writes.length, 3);
    assert.ok(f.movePass!.casePages.some(p => p.page === 4));
  } finally { await f.close(); }
});
for (const after of ["original", "association"] as const) test(`E2E-411 wrong cancellation reason after ${after} cannot pass complete-case inspection`, async () => {
  const f = await classPassMoveFixture({ differentCase: true });
  try {
    f.onWrite(phase => { if (phase === after) f.original.cancellation_reason = 40; });
    const outcome = resultValue(await f.run()); assert.equal(outcome.kind, "needsReview");
    assert.deepEqual(f.writes.map(w => w.leg), after === "original" ? ["replacement", "original"] : ["replacement", "original", "association"]);
    assert.equal((await f.run()).ok, false);
  } finally { f.lifetime.abort(); }
});
test("E2E-411 native movement cannot add an association that would exceed complete-case inspection capacity", async () => {
  const f = await classPassMoveFixture({ differentCase: true, history: 1000 });
  try {
    assert.equal(f.binding, undefined); assert.equal((await f.run()).ok, false);
    assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
  } finally { f.lifetime.abort(); }
});
test("E2E-411 an available pass session cannot publish a booking when the added association could not be completely inspected", async () => {
  const f = await classBookingFixture({ passes: true });
  try {
    addCaseHistory(f.pass.rows, f.pass.caseId, verificationCanaries[2]!, 1000, f.classSessionConfig.clock());
    f.pass.record.attendee_ids = f.pass.rows.map(row => row.id);
    await f.verify();
    resultValue(await f.reception.readBookingMenu(f.scope, f.turn("menu"), "2026-10-08", "2026-10-08", f.classSessionConfig.clock()));
    assert.equal(Object.keys((await f.state()).actions).length, 0); assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
    assert.ok(f.pass.queries.some(query => query.phase === "proposal"));
  } finally { await f.close(); }
});
test("E2E-411 patient permission lost in the fused post-replacement observation cannot cancel the original", async () => {
  const f = await classMoveFixture(true, false, { differentCase: true, history: 101 });
  try {
    let revoked = false;
    f.movePass!.onRead(() => { if (!revoked && f.writes.length === 1) { revoked = true; f.setPermitted(false); } });
    const { action, state } = await move(f); assert.equal(revoked, true); assert.equal(state.actions[action.key]!.status, "uncertain");
    assert.deepEqual(f.writes.map(w => w.path), ["/v1/attendees"]); assert.equal(f.native.attendees.find(row => row.id === "101")!.cancelled_at, null);
  } finally { await f.close(); }
});
