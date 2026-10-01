import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoRescheduleWriter } from "../../src/cliniko/reschedule-write.ts";
import type { ClinikoRescheduleRequest } from "../../src/cliniko/reschedule-write.ts";

const scope = { tenantId: "move-tenant", clinicId: "move-clinic", locationId: "move-location" };
const base = "https://api.au5.cliniko.com/v1";
const observedAt = "2026-10-01T10:00:00.000Z";

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(check(), "expected provider phase did not start");
}
const request: ClinikoRescheduleRequest = {
  scope, patientId: "42", appointmentId: "91", practitionerId: "22", appointmentTypeId: "33",
  startsAt: "2026-10-08T11:00:00+07:00", endsAt: "2026-10-08T11:30:00+07:00",
  newStartsAt: "2026-10-08T12:00:00+07:00", newEndsAt: "2026-10-08T12:30:00+07:00",
};

function appointment(changes: Record<string, unknown> = {}) {
  return { id: "91", starts_at: "2026-10-08T04:00:00Z", ends_at: "2026-10-08T04:30:00Z",
    cancelled_at: null, archived_at: null, deleted_at: null,
    patient: { links: { self: `${base}/patients/42` } },
    business: { links: { self: `${base}/businesses/11` } },
    practitioner: { links: { self: `${base}/practitioners/22` } },
    appointment_type: { links: { self: `${base}/appointment_types/33` } },
    notes: "Private clinical note", ...changes };
}

function writer(fetchPort: typeof fetch): ClinikoRescheduleWriter {
  const created = ClinikoRescheduleWriter.create({ scope, apiKey: "synthetic-key-au5",
    contactEmail: "dev@example.test", businessId: "11" }, fetchPort, () => observedAt);
  assert.ok(created.ok, created.ok ? "" : created.error.kind);
  return created.value;
}

test("one in-place PATCH needs a fresh exact moved read and no conflict before a moved result", async () => {
  let moved = false;
  const methods: string[] = [];
  const adapter = writer(async (input, init) => {
    const url = new URL(String(input));
    methods.push(`${init?.method} ${url.pathname}`);
    if (url.pathname.endsWith("/conflicts")) return Response.json({ conflicts: { exist: false } });
    if (init?.method === "PATCH") {
      assert.equal(url.pathname, "/v1/individual_appointments/91");
      assert.deepEqual(JSON.parse(String(init.body)), {
        starts_at: request.newStartsAt, ends_at: null,
      });
      moved = true;
      return Response.json(appointment({ starts_at: "2026-10-08T05:00:00Z",
        ends_at: "2026-10-08T05:30:00Z" }));
    }
    return Response.json(appointment(moved ? { starts_at: "2026-10-08T05:00:00Z",
      ends_at: "2026-10-08T05:30:00Z" } : {}));
  });
  assert.deepEqual(await adapter.rescheduleOnce(request), { ok: true, value: { kind: "moved" } });
  assert.deepEqual(methods, [
    "GET /v1/individual_appointments/91", "PATCH /v1/individual_appointments/91",
    "GET /v1/individual_appointments/91", "GET /v1/individual_appointments/91/conflicts",
  ]);
  assert.deepEqual(await adapter.observeReschedule(request), {
    ok: true, value: { kind: "new", observedAt },
  });
  assert.deepEqual(await adapter.rescheduleOnce(request), { ok: false, error: { kind: "invalidQuery" } });
});

test("wrong patient, changed time, archived and cancelled targets cause no move", async () => {
  for (const changes of [
    { patient: { links: { self: `${base}/patients/43` } } },
    { starts_at: "2026-10-08T06:00:00Z" },
    { archived_at: observedAt },
    { cancelled_at: observedAt },
  ]) {
    let writes = 0;
    const adapter = writer(async (_input, init) => {
      if (init?.method === "PATCH") { writes += 1; throw new Error("unexpected write"); }
      return Response.json(appointment(changes));
    });
    assert.deepEqual(await adapter.rescheduleOnce(request), {
      ok: false, error: { kind: "targetChanged" },
    });
    assert.equal(writes, 0);
  }
});

test("a response lost after provider move stays uncertain but can be observed without replay", async () => {
  let moved = false;
  let writes = 0;
  const adapter = writer(async (input, init) => {
    if (String(input).endsWith("/conflicts")) return Response.json({ conflicts: { exist: false } });
    if (init?.method === "PATCH") {
      writes += 1;
      moved = true;
      throw new Error("response lost after provider commit");
    }
    return Response.json(appointment(moved ? { starts_at: "2026-10-08T05:00:00Z",
      ends_at: "2026-10-08T05:30:00Z" } : {}));
  });
  assert.deepEqual(await adapter.rescheduleOnce(request), { ok: true, value: { kind: "uncertain" } });
  assert.deepEqual(await adapter.observeReschedule(request), {
    ok: true, value: { kind: "new", observedAt },
  });
  assert.deepEqual(await adapter.rescheduleOnce(request), { ok: false, error: { kind: "invalidQuery" } });
  assert.equal(writes, 1);
});

test("a moved appointment with a conflict is distinct from a clean move", async () => {
  let moved = false;
  const adapter = writer(async (input, init) => {
    if (String(input).endsWith("/conflicts")) return Response.json({ conflicts: { exist: true } });
    if (init?.method === "PATCH") { moved = true; return Response.json({}); }
    return Response.json(appointment(moved ? { starts_at: "2026-10-08T05:00:00Z",
      ends_at: "2026-10-08T05:30:00Z" } : {}));
  });
  assert.deepEqual(await adapter.rescheduleOnce(request), {
    ok: true, value: { kind: "movedWithConflict" },
  });
});

test("a 200 without the exact new interval or a readable conflict view stays uncertain", async () => {
  for (const unreadableConflict of [false, true]) {
    let moved = false;
    const adapter = writer(async (input, init) => {
      if (String(input).endsWith("/conflicts")) return new Response(null, { status: 503 });
      if (init?.method === "PATCH") { moved = true; return Response.json({}); }
      return Response.json(appointment(moved ? { starts_at: "2026-10-08T05:00:00Z",
        ends_at: unreadableConflict ? "2026-10-08T05:30:00Z" : "2026-10-08T05:45:00Z" } : {}));
    });
    assert.deepEqual(await adapter.rescheduleOnce(request), {
      ok: true, value: { kind: "uncertain" },
    });
  }
});

test("invalid new interval, scope and repeated simultaneous attempts are denied", async () => {
  let writes = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const adapter = writer(async (input, init) => {
    if (String(input).endsWith("/conflicts")) return Response.json({ conflicts: { exist: false } });
    if (init?.method === "PATCH") { writes += 1; return Response.json({}); }
    reads += 1;
    if (reads === 1) await held;
    return Response.json(appointment(reads > 1 ? { starts_at: "2026-10-08T05:00:00Z",
      ends_at: "2026-10-08T05:30:00Z" } : {}));
  });
  for (const invalid of [
    { ...request, newEndsAt: request.newStartsAt },
    { ...request, newEndsAt: "2026-10-08T12:45:00+07:00" },
    { ...request, scope: { ...scope, locationId: "other" } },
  ]) assert.equal((await adapter.rescheduleOnce(invalid)).ok, false);
  assert.equal(reads, 0);
  const first = adapter.rescheduleOnce(request);
  assert.deepEqual(await adapter.rescheduleOnce(request), { ok: false, error: { kind: "invalidQuery" } });
  release();
  assert.deepEqual(await first, { ok: true, value: { kind: "moved" } });
  assert.equal(writes, 1);
});

test("a hangup before or during the old-appointment read prevents a move PATCH", async () => {
  let release!: (response: Response) => void;
  const held = new Promise<Response>(resolve => { release = resolve; });
  let reads = 0;
  let writes = 0;
  const adapter = writer(async (_input, init) => {
    if (init?.method === "PATCH") { writes += 1; throw new Error("unexpected PATCH"); }
    reads += 1;
    return held;
  });
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  assert.deepEqual(await adapter.rescheduleOnce(request, alreadyAborted.signal),
    { ok: false, error: { kind: "unavailable" } });
  assert.equal(reads, 0);
  const controller = new AbortController();
  const pending = adapter.rescheduleOnce(request, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  controller.abort();
  assert.deepEqual(await pending, { ok: false, error: { kind: "unavailable" } });
  release(Response.json(appointment()));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 0);
});

test("a hangup after the move PATCH starts is uncertain despite a late 200", async () => {
  let release!: (response: Response) => void;
  const held = new Promise<Response>(resolve => { release = resolve; });
  let reads = 0;
  let writes = 0;
  let providerSignal: AbortSignal | undefined;
  const adapter = writer(async (_input, init) => {
    if (init?.method === "PATCH") { writes += 1; providerSignal = init.signal ?? undefined; return held; }
    reads += 1;
    return Response.json(appointment());
  });
  const controller = new AbortController();
  const pending = adapter.rescheduleOnce(request, controller.signal);
  await waitFor(() => writes === 1);
  controller.abort();
  assert.equal(providerSignal?.aborted, true);
  assert.deepEqual(await pending, { ok: true, value: { kind: "uncertain" } });
  release(Response.json(appointment({ starts_at: "2026-10-08T05:00:00Z",
    ends_at: "2026-10-08T05:30:00Z" })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1, "late PATCH success must not trigger a moved-state read");
  assert.deepEqual(await adapter.rescheduleOnce(request), { ok: false, error: { kind: "invalidQuery" } });
  assert.equal(writes, 1);
});

test("aborting move observation during a conflict read cannot report a clean move", async () => {
  let release!: (response: Response) => void;
  const held = new Promise<Response>(resolve => { release = resolve; });
  let conflicts = 0;
  const adapter = writer(async (input) => {
    if (String(input).endsWith("/conflicts")) { conflicts += 1; return held; }
    return Response.json(appointment({ starts_at: "2026-10-08T05:00:00Z",
      ends_at: "2026-10-08T05:30:00Z" }));
  });
  const controller = new AbortController();
  const pending = adapter.observeReschedule(request, controller.signal);
  await waitFor(() => conflicts === 1);
  controller.abort();
  assert.deepEqual(await pending, { ok: false, error: { kind: "unavailable" } });
  release(Response.json({ conflicts: { exist: false } }));
});
