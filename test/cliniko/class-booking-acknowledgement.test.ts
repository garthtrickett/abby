import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ClinikoClassAttendanceWriter } from "../../src/cliniko/class-attendance-write.ts";
import { ClinikoClassAttendanceReader } from "../../src/cliniko/class-attendance-read.ts";
import type { ClinikoAttendanceRequest } from "../../src/cliniko/class-attendance-write.ts";
import { classAttendanceFixture, classAttendee, classLink, classScope, classNow, classUntil } from "../support/class-attendance.ts";
import { classBookingFixture } from "../support/class-booking.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const request = (pass = false): Extract<ClinikoAttendanceRequest, { kind: "book" }> => ({ kind: "book", scope: classScope,
  patientId: "42", sessionId: "94", actionId: randomUUID(), ...(pass ? { patientCaseId: "901" } : {}) });
function responseRow(q: ReturnType<typeof request>) {
  return { ...classAttendee("401", q.sessionId, q.patientId), notes: `Abby attendance ${q.actionId}`,
    ...(q.patientCaseId ? { patient_case: classLink("patient_cases", q.patientCaseId) } : {}) };
}

test("E2E-392/E2E-406 class creation acknowledges exact no-pass/pass responses without a GET and refuses nonexact or unexpected cases", async () => {
  const mutations: Record<string, unknown>[] = [
    { id: "402" }, { id: "0" }, { links: classLink("attendees", "402").links },
    { patient: classLink("patients", "43") }, { booking: classLink("bookings", "93") }, { notes: "different action" },
    { archived_at: classNow }, { deleted_at: classNow }, { cancelled_at: classNow },
    { archived_at: undefined }, { deleted_at: undefined }, { cancelled_at: undefined },
    { patient_case: classLink("patient_cases", "902") }, { patient_case: null }, { patient_case: {} },
  ];
  for (const pass of [false, true]) for (const changes of [undefined, ...mutations, ...(pass ? [{ patient_case: undefined }] : [])]) {
    const f = classAttendanceFixture(), q = request(pass);
    let posts = 0, gets = 0, acknowledged = 0;
    const writer = resultValue(ClinikoClassAttendanceWriter.create(f.config, async (_url, init) => {
      if (init?.method !== "POST") { gets++; throw new Error("no acknowledgement readback permitted"); }
      posts++;
      const body = JSON.parse(String(init.body));
      assert.equal(body.booking_id, q.sessionId); assert.equal(body.patient_id, q.patientId);
      assert.equal(body.patient_case_id, q.patientCaseId);
      return Response.json({ ...responseRow(q), ...changes }, { status: 201 });
    }));
    const result = await writer.executeBookingOnce(q, new AbortController().signal, {
      beforeSend: async () => true, current: () => true, acknowledged: () => { acknowledged++; },
    });
    assert.deepEqual(result, { ok: true, value: changes ? { kind: "uncertain" } : { kind: "accepted", attendeeRef: "cliniko:attendee:401" } }, JSON.stringify({ pass, changes }));
    assert.equal(acknowledged, changes ? 0 : 1); assert.equal(posts, 1); assert.equal(gets, 0);
    assert.equal((await writer.executeBookingOnce(q, new AbortController().signal,
      { beforeSend: async () => true, current: () => true, acknowledged() {} })).ok, false);
    assert.equal(posts, 1);
  }
});

test("a native class acknowledgement survives later abort/observer failure while held parsing remains uncertain", async () => {
  for (const failure of ["abortAfterAck", "observer", "heldBody"] as const) {
    const f = classAttendanceFixture(), q = request(), stop = new AbortController();
    let reported = 0, began!: () => void, release = () => {};
    const reading = new Promise<void>(resolve => { began = resolve; });
    const writer = resultValue(ClinikoClassAttendanceWriter.create(f.config, async () => {
      if (failure !== "heldBody") return Response.json(responseRow(q), { status: 201 });
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        began(); return new Promise<void>(resolve => { release = () => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(responseRow(q)))); controller.close(); resolve();
        }; });
      } }, { highWaterMark: 0 }), { status: 201 });
    }));
    const pending = writer.executeBookingOnce(q, stop.signal, { beforeSend: async () => true, current: () => true,
      acknowledged: () => { reported++; if (failure === "observer") throw new Error("synthetic observer failure"); stop.abort(); } });
    if (failure === "heldBody") { await reading; stop.abort(); }
    assert.deepEqual(resultValue(await pending), failure === "heldBody" ? { kind: "uncertain" } : { kind: "accepted", attendeeRef: "cliniko:attendee:401" });
    assert.equal(reported, failure === "heldBody" ? 0 : 1); release();
  }
});

test("class creation checks local lifetime after final preparation and never invents an unlinked-stage receipt", async () => {
  const f = classAttendanceFixture(), q = request(); let posts = 0;
  const writer = resultValue(ClinikoClassAttendanceWriter.create(f.config, async () => { posts++; return Response.json(responseRow(q), { status: 201 }); }));
  const denied = await writer.executeBookingOnce(q, new AbortController().signal, {
    beforeSend: async () => true, current: () => false, acknowledged() { assert.fail("no acknowledged create"); },
  });
  assert.ok(!denied.ok && denied.error.kind === "forbidden"); assert.equal(posts, 0);
  // The earlier generic edge keeps its operation-specific contract. An absent
  // optional case field above establishes no native-is-null staging evidence.
  const generic = resultValue(ClinikoClassAttendanceWriter.create(f.config, async () =>
    Response.json({ ...responseRow(q), patient_case: classLink("patient_cases", "902") }, { status: 201 })));
  assert.equal(resultValue(await generic.executeOnce(q, new AbortController().signal, async () => true)).kind, "accepted");
});

test("class dispatch reader completes metadata and proof before its complete double capacity observation", async () => {
  const f = classAttendanceFixture(), events: string[] = [];
  const reader = resultValue(ClinikoClassAttendanceReader.create(f.config, { verifyPatient: async (...args) => {
    const proof = await f.proof.verifyPatient(...args); events.push("proof"); return proof;
  } }, async (url, init) => { const response = await f.fetchPort(url, init); events.push(new URL(String(url)).pathname); return response; }, () => classNow));
  const read = resultValue(await reader.inspectForSend(classScope, "private-class-proof", "94", classNow, classUntil, classNow, new AbortController().signal));
  assert.equal(read.sessions[0]?.remainingPlaces, 3);
  const firstGroup = events.indexOf("/v1/group_appointments/94"), lastProof = events.lastIndexOf("proof");
  assert.ok(firstGroup > lastProof && lastProof >= 0);
  assert.deepEqual(events.slice(firstGroup), ["/v1/group_appointments/94", "/v1/attendees", "/v1/group_appointments/94", "/v1/attendees"]);
  assert.equal(f.proofCalls, 2);
});

for (const passes of [false, true]) test(`actual ${passes ? "pass" : "ordinary"} SAM class dispatch has no preparation or native observation after final capacity`, async t => {
  const events: string[] = [];
  const delayed = new Set<string>();
  let delaying = false, dispatched = false, capacityCompleted = false, waitingPostBudget = false;
  const suspendPreparation = async (label: string) => {
    if (delayed.has(label)) return;
    delayed.add(label);
    assert.equal(dispatched, false, label); assert.equal(capacityCompleted, false, label);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(dispatched, false, label); assert.equal(capacityCompleted, false, label);
  };
  const f = await classBookingFixture({ passes, fetchAround: port => async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "POST" && path === "/v1/attendees") dispatched = true;
    events.push(`dispatch:${init?.method ?? "GET"}:${path}`);
    const response = await port(url, init);
    events.push(`native:${init?.method ?? "GET"}:${path}`); return response;
  } });
  try {
    await f.verify(); const action = await f.propose();
    const confirmed = resultValue(await f.confirm());
    const notice = confirmed.pendingPresentationId ? confirmed.presentations[confirmed.pendingPresentationId] : undefined;
    if (notice?.kind === "notice" && notice.confirmationWaitSeconds) {
      await f.play(); await f.pause(notice.confirmationWaitSeconds + 1); resultValue(await f.confirm());
    }
    const trace = <T extends object, K extends keyof T>(target: T, key: K, label: string) => {
      const original = target[key] as (...args: unknown[]) => Promise<unknown>;
      t.mock.method(target, key as never, async (...args: unknown[]) => {
        events.push(`${label}:begin`); const value = await original.apply(target, args);
        if (delaying && !dispatched) await suspendPreparation(label);
        events.push(`${label}:end`); return value;
      });
    };
    trace(f.ledger, "read", "ledger"); trace(f.ledger, "readWriteStop", "stop"); trace(f.policies, "read", "settings");
    trace(f.policy, "current", "approval"); trace(f.session.proof, "verifyOperation", "proof");
    trace(f.sessionConfig.contact, "read", "patientContact");
    if (passes) trace(f.pass.authority, "select", "passAuthority");
    const budget = f.classSessionConfig.cliniko.rateBudget, claim = budget.claim.bind(budget);
    t.mock.method(budget, "claim", async () => {
      const result = await claim();
      if (waitingPostBudget) { waitingPostBudget = false; await suspendPreparation("postBudget"); }
      return result;
    });
    const write = ClinikoClassAttendanceWriter.prototype.executeBookingOnce;
    t.mock.method(ClinikoClassAttendanceWriter.prototype, "executeBookingOnce", function(this: ClinikoClassAttendanceWriter,
      ...args: Parameters<typeof write>) {
      waitingPostBudget = true; return write.apply(this, args);
    });
    const inspect = ClinikoClassAttendanceReader.prototype.inspectForSend;
    t.mock.method(ClinikoClassAttendanceReader.prototype, "inspectForSend", async function(this: ClinikoClassAttendanceReader,
      ...args: Parameters<typeof inspect>) {
      const result = await inspect.apply(this, args); capacityCompleted = true; return result;
    });
    events.length = 0; delaying = true; resultValue(await f.drain());
    for (const label of ["patientContact", "proof", "approval", "postBudget", ...(passes ? ["passAuthority"] : [])])
      assert.equal(delayed.has(label), true, `actual ${label} preparation was suspended`);
    assert.equal((await f.state()).actions[action.key]!.status, "committed");
    const sent = events.indexOf("dispatch:POST:/v1/attendees"); assert.ok(sent > 0);
    const finalCapacity = events.slice(0, sent).lastIndexOf("native:GET:/v1/attendees"); assert.ok(finalCapacity > 0);
    assert.deepEqual(events.slice(finalCapacity + 1, sent), [], "all async preparation must precede final native capacity");
    assert.equal(events.slice(sent + 1).some(event => event.startsWith("dispatch:GET:")), false, "acknowledgement requires no later native GET");
    assert.equal(f.writes.length, 1); assert.equal(f.recalls.length, 1);
    assert.equal(f.pass.queries.some(q => q.phase === "inspection"), false);
  } finally { await f.close(); }
});

test("a class creation acknowledgement survives shutdown before returned-promise delivery through actual SAM", async t => {
  const f = await classBookingFixture();
  try {
    await f.verify(); const action = await f.propose(); resultValue(await f.confirm());
    const execute = ClinikoClassAttendanceWriter.prototype.executeBookingOnce;
    t.mock.method(ClinikoClassAttendanceWriter.prototype, "executeBookingOnce", function(this: ClinikoClassAttendanceWriter,
      ...[q, signal, checks]: Parameters<typeof execute>) {
      return execute.call(this, q, signal, { ...checks, acknowledged: receipt => {
        checks.acknowledged(receipt); f.host.dispose();
      } });
    });
    resultValue(await f.drain());
    assert.equal((await f.state()).actions[action.key]!.status, "committed");
    assert.equal(f.writes.length, 1); assert.equal(f.recalls.length, 1);
  } finally { await f.close(); }
});

for (const invalidation of ["lifetime", "proof", "expiry"] as const)
  test(`actual SAM class dispatch refuses ${invalidation} invalidation after the final native capacity response`, async t => {
    const f = await classBookingFixture();
    try {
      await f.verify(); const action = await f.propose(); resultValue(await f.confirm());
      const inspect = ClinikoClassAttendanceReader.prototype.inspectForSend;
      t.mock.method(ClinikoClassAttendanceReader.prototype, "inspectForSend", async function(this: ClinikoClassAttendanceReader,
        ...args: Parameters<typeof inspect>) {
        const result = await inspect.apply(this, args); assert.equal(result.ok, true);
        if (invalidation === "lifetime") f.host.dispose();
        if (invalidation === "proof") f.session.proof.revoke();
        if (invalidation === "expiry") f.setTime(new Date(Date.parse(action.mutation.request.kind === "book"
          ? action.mutation.request.offer.expiresAt : classNow) + 1).toISOString());
        return result;
      });
      await f.drain();
      assert.equal(f.recalls.length, 1); assert.equal(f.writes.length, 0);
      assert.notEqual((await f.state()).actions[action.key]!.status, "committed");
    } finally { await f.close(); }
  });
