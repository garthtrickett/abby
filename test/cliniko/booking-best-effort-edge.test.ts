import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoBookingWriter } from "../../src/cliniko/booking-write.ts";
import { standaloneBookingFixture } from "../support/standalone-booking.ts";

const config = { scope: { tenantId: "booking-edge", clinicId: "clinic", locationId: "main" }, apiKey: "synthetic-key-au5",
  contactEmail: "test@example.test", businessId: "11", practitionerId: "22", appointmentTypeId: "33" };
const request = { scope: config.scope, patientId: "42", startsAt: "2026-10-08T04:00:00.000Z", marker: "7a6b240c-94fa-45d8-ae0b-f4ee91cb2bd1" };
const base = "https://api.au5.cliniko.com/v1";
function row() { return { id: "91", notes: `Abby booking ${request.marker}`, starts_at: request.startsAt, ends_at: "2026-10-08T04:30:00.000Z",
  cancelled_at: null, archived_at: null, deleted_at: null,
  ...Object.fromEntries(Object.entries({ patient: "patients/42", business: "businesses/11", practitioner: "practitioners/22", appointment_type: "appointment_types/33" })
    .map(([name, path]) => [name, { links: { self: `${base}/${path}` } }])) }; }

test("E2E-280 final trusted send check runs after budget reservation, denies false/throw/held/aborted results and consumes the marker", async () => {
  for (const failure of ["false", "throw", "held", "abort"] as const) {
    const order: string[] = []; let posts = 0;
    const created = ClinikoBookingWriter.create({ ...config, rateBudget: { claim: async () => { order.push("budget"); return null; }, observe429: async () => ({ kind: "rateLimited" }) } },
      async () => { posts++; return Response.json(row(), { status: 201 }); }); assert.ok(created.ok);
    const stop = new AbortController();
    const pending = created.value.writeOnce(request, stop.signal, async () => {
      order.push("authority"); if (failure === "throw") throw new Error("synthetic failure");
      if (failure === "held") return new Promise<never>(() => undefined);
      if (failure === "abort") stop.abort(); return false;
    });
    if (failure === "held") setTimeout(() => stop.abort(), 30);
    assert.equal((await pending).ok, false); assert.deepEqual(order, ["budget", "authority"]); assert.equal(posts, 0);
    assert.equal((await created.value.writeOnce(request)).ok, false);
  }
});

test("E2E-280 booking exact read-back checks id, interval, marker, provider links and all active status fields", async () => {
  for (const failure of ["none", "id", "start", "end", "marker", "patient", "business", "practitioner", "type", "missingStatus", "cancelled", "server", "malformed"] as const) {
    const received = row() as Record<string, unknown>;
    if (failure === "id") received.id = "92";
    if (failure === "start") received.starts_at = "2026-10-08T05:00:00.000Z";
    if (failure === "end") received.ends_at = "2026-10-08T05:30:00.000Z";
    if (failure === "marker") received.notes = "foreign marker";
    const keys: Record<string, string> = { patient: "patient", business: "business", practitioner: "practitioner", type: "appointment_type" };
    if (keys[failure]) received[keys[failure]!] = { links: { self: "https://foreign.example.test/v1/rows/91" } };
    if (failure === "missingStatus") delete received.deleted_at;
    if (failure === "cancelled") received.cancelled_at = "2026-10-04T06:00:00.000Z";
    const created = ClinikoBookingWriter.create(config, async (value, init) => {
      assert.equal(String(value), `${base}/individual_appointments/91`); assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
      return failure === "server" ? new Response(null, { status: 503 }) : failure === "malformed" ? Response.json({}) : Response.json(received);
    }); assert.ok(created.ok);
    const result = await created.value.inspectCreated(request, "cliniko:appointment:91", "2026-10-08T04:30:00.000Z");
    assert.deepEqual(result.ok && result.value, failure === "none");
  }
});

test("E2E-280 emergency stop at the actual booking budget edge prevents POST after a saved review", async () => {
  let f: Awaited<ReturnType<typeof standaloneBookingFixture>>, stopOnNext = false, stopped = false;
  const rateBudget = { claim: async () => {
    if (stopOnNext && !stopped) { stopped = true; assert.ok((await f.ledger.stopWrites(f.scope, "synthetic-admin", "budget edge stop")).ok); }
    return null;
  }, observe429: async () => ({ kind: "rateLimited" as const }) };
  f = await standaloneBookingFixture({ rateBudget });
  try {
    assert.ok((await f.propose(await f.verify())).ok); assert.ok((await f.confirm()).ok);
    // The post-review authorization finishes several fresh contact checks. Arm only the writer's send reservation.
    const original = f.writer.writeOnce.bind(f.writer);
    f.writer.writeOnce = async (...args) => { stopOnNext = true; return original(...args); };
    await f.drain(); assert.equal(f.recalls.length, 1); assert.equal(stopped, true); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

test("E2E-280 caller-owned booking input cannot change after the budget wait", async () => {
  const incoming = structuredClone(request); let posted: Record<string, unknown> | undefined;
  const created = ClinikoBookingWriter.create({ ...config, rateBudget: { claim: async () => {
    incoming.patientId = "43"; incoming.startsAt = "2026-10-08T05:00:00.000Z"; incoming.scope.clinicId = "foreign"; return null;
  }, observe429: async () => ({ kind: "rateLimited" }) } }, async (_input, init) => {
    posted = JSON.parse(String(init?.body)); return Response.json(row(), { status: 201 });
  }); assert.ok(created.ok);
  const result = await created.value.writeOnce(incoming, undefined, async () => true);
  assert.ok(result.ok && result.value.kind === "accepted"); assert.equal(posted?.patient_id, request.patientId); assert.equal(posted?.starts_at, request.startsAt);
});

test("E2E-280 read-back and conflict reads recheck trusted authority after their budget waits", async () => {
  for (const kind of ["created", "conflicts"] as const) {
    const order: string[] = []; let gets = 0;
    const created = ClinikoBookingWriter.create({ ...config, rateBudget: { claim: async () => { order.push("budget"); return null; },
      observe429: async () => ({ kind: "rateLimited" }) } }, async () => { gets++; return Response.json(row()); }); assert.ok(created.ok);
    const check = async () => { order.push("permission"); return false; };
    const result = kind === "created" ? await created.value.inspectCreated(request, "cliniko:appointment:91", "2026-10-08T04:30:00.000Z", undefined, check) :
      await created.value.inspectConflicts("cliniko:appointment:91", undefined, check);
    assert.deepEqual(result, { ok: false, error: { kind: "forbidden" } }); assert.deepEqual(order, ["budget", "permission"]); assert.equal(gets, 0);
  }
});
