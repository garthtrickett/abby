import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoClassAttendanceReader } from "../../src/cliniko/class-attendance-read.ts";
import { observedClassMoveRequests } from "../../src/cliniko/class-move-workload.ts";
import { ClinikoClassAttendanceMove } from "../../src/standalone/cliniko-class-attendance-move.ts";
import { classPassMoveFixture } from "../support/class-pass-move.ts";
import { classMoveFixture } from "../support/class-move.ts";
import { addClassRosterHistory } from "../support/class-pass-history.ts";
import { classLink } from "../support/class-attendance.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

type Fixture = Awaited<ReturnType<typeof classPassMoveFixture>>;
function relationships(f: Fixture, total: number): typeof fetch {
  return async (input, init) => {
    const u = new URL(String(input)), found = /^\/v1\/practitioners\/(22|23)\/(businesses|appointment_types)$/.exec(u.pathname);
    if (!found) return f.config.fetchPort(input, init);
    assert.equal(init?.method, "GET"); assert.equal(init.redirect, "error"); assert.ok(init.signal);
    const name = found[2]!, selected = name === "businesses" ? "11" : found[1] === "22" ? "33" : "34";
    const rows = Array.from({ length: total }, (_, i) => ({ id: i ? String(800000 + i) : selected, ...classLink(name, i ? String(800000 + i) : selected) }));
    const page = Number(u.searchParams.get("page"));
    return Response.json({ [name]: rows.slice((page - 1) * 100, page * 100), total_entries: rows.length });
  };
}
async function estimate(f: Fixture, port: typeof fetch) {
  const c = f.config, make = (service: typeof c.source) => resultValue(ClinikoClassAttendanceReader.create({ ...c.cliniko, ...service, scope: f.scope }, c.proof, port, c.clock));
  const from = f.request.source.startsAt, to = f.request.destination.endsAt;
  const paired = c.source.practitionerId === c.destination.practitionerId && c.source.appointmentTypeId === c.destination.appointmentTypeId;
  const source = make(c.source);
  const reads = paired ? [resultValue(await source.inspectPair(f.scope, f.request.verificationRef, [f.request.source.sessionId, f.request.destination.sessionId], from, to, c.clock(), f.lifetime.signal))] :
    [resultValue(await source.inspect(f.scope, f.request.verificationRef, f.request.source.sessionId, from, to, c.clock(), f.lifetime.signal)),
      resultValue(await make(c.destination).inspect(f.scope, f.request.verificationRef, f.request.destination.sessionId, from, to, c.clock(), f.lifetime.signal))];
  const sessions = reads.flatMap(r => r.sessions), a = sessions.find(s => s.sessionRef === f.request.source.sessionId)!, b = sessions.find(s => s.sessionRef === f.request.destination.sessionId)!;
  const pass = await f.passes.selectWithWorkload(f.request, "proposal", f.lifetime.signal); assert.ok(pass);
  return { requests: observedClassMoveRequests(pass.minimumNativeRequests, a, b, paired), source: a, destination: b };
}

for (const row of [
  { roster: 99, relationships: 1, different: false },
  { roster: 100, relationships: 1, different: false },
  { roster: 101, relationships: 1, different: false },
  { roster: 201, relationships: 201, different: false },
  { roster: 99, relationships: 201, different: true },
]) test(`E2E-415 observed complete class cost matches actual native move requests ${JSON.stringify(row)}`, async () => {
  const f = await classPassMoveFixture({ history: 99, rosterHistory: row.roster, differentService: row.different, differentCase: row.different });
  try {
    const port = relationships(f, row.relationships), observed = await estimate(f, port);
    assert.equal(observed.source.nativeWorkload?.attendanceRecords, row.roster);
    assert.equal(observed.destination.nativeWorkload?.attendanceRecords, row.roster);
    assert.equal(observed.source.nativeWorkload?.metadataRequests, 3 + 2 * Math.ceil(row.relationships / 100));
    assert.ok(observed.requests !== undefined && observed.requests <= 180);
    f.setTime("2026-10-07T10:01:01.000Z");
    const mover = resultValue(ClinikoClassAttendanceMove.create({ ...f.config, fetchPort: port })), before = f.claims;
    const result = resultValue(await mover.executeOnce(f.request, f.lifetime.signal, f.permit));
    assert.equal(result.kind, "moved"); assert.equal(f.claims - before, observed.requests);
    assert.deepEqual(f.writes.map(w => w.leg), ["replacement", "original", "association"]);
  } finally { f.lifetime.abort(); }
});

for (const mode of ["rosterCost", "metadataCost", "inspectionOverflow"] as const)
  test(`E2E-415 ${mode} cannot dispatch a known oversized pass move`, async () => {
    const f = await classPassMoveFixture({ history: 999, rosterHistory: mode === "inspectionOverflow" ? 500 : mode === "rosterCost" ? 201 : 3 });
    try {
      const port = relationships(f, mode === "metadataCost" ? 201 : 1), observed = await estimate(f, port);
      if (mode === "inspectionOverflow") assert.equal(observed.requests, undefined);
      else assert.ok(observed.requests! > 180);
      f.setTime("2026-10-07T10:01:01.000Z");
      const mover = resultValue(ClinikoClassAttendanceMove.create({ ...f.config, fetchPort: port }));
      const result = resultValue(await mover.executeOnce(f.request, f.lifetime.signal, f.permit));
      assert.equal(result.kind, "notSent"); assert.equal(f.writes.length, 0); assert.equal(f.original.cancelled_at, null);
      assert.equal((await mover.executeOnce(f.request, f.lifetime.signal, f.permit)).ok, false);
    } finally { f.lifetime.abort(); }
  });

test("E2E-415 ordinary offers account for inactive attendance pages before preparing consent", async () => {
  const f = await classMoveFixture(false, false, { history: 999, rosterHistory: 201 });
  try {
    await f.verify();
    resultValue(await f.reception.readReschedulingMenu(f.scope, f.turn("targets"), "targets", "2026-10-08", "2026-10-08", f.config.clock())); await f.play();
    resultValue(await f.reception.selectReschedulingMenu(f.scope, f.turn("target-one", "one"), "targets", 1, f.config.clock())); await f.play();
    resultValue(await f.reception.readReschedulingMenu(f.scope, f.turn("offers"), "offers", "2026-10-09", "2026-10-09", f.config.clock()));
    const state = await f.state();
    assert.equal(Object.keys(state.actions).length, 0); assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
    assert.equal(f.native.attendees.find(r => r.id === "101")!.cancelled_at, null);
    assert.match(state.callerMessages.at(-1)!, /couldn't find an eligible new appointment time/);
    assert.equal(JSON.stringify([state.callerMessages, state.presentations]).includes("nativeWorkload"), false);
  } finally { await f.close(); }
});

test("E2E-415 fresh proposal inspection detects workload growth after a menu was played", async () => {
  const f = await classMoveFixture(false, false, { history: 999 });
  try {
    await f.verify();
    resultValue(await f.reception.readReschedulingMenu(f.scope, f.turn("targets"), "targets", "2026-10-08", "2026-10-08", f.config.clock())); await f.play();
    resultValue(await f.reception.selectReschedulingMenu(f.scope, f.turn("target-one", "one"), "targets", 1, f.config.clock())); await f.play();
    resultValue(await f.reception.readReschedulingMenu(f.scope, f.turn("offers"), "offers", "2026-10-09", "2026-10-09", f.config.clock())); await f.play();
    for (const [side, group] of ["91", "94"].entries()) addClassRosterHistory(f.native.attendees, group, 201, f.config.clock(), 700000 + side * 1000);
    await f.pause(61);
    await f.reception.selectReschedulingMenu(f.scope, f.turn("offer-one", "one"), "offers", 1, f.config.clock());
    assert.equal(Object.keys((await f.state()).actions).length, 0); assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
    assert.equal(f.native.attendees.find(r => r.id === "101")!.cancelled_at, null);
  } finally { await f.close(); }
});
