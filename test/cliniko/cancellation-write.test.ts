import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoCancellationWriter } from "../../src/cliniko/cancellation-write.ts";
import type { ClinikoCancellationRequest } from "../../src/cliniko/cancellation-write.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";

const scope = { tenantId: "cancel-tenant", clinicId: "cancel-clinic", locationId: "cancel-location" };
const base = "https://api.au5.cliniko.com/v1";
const config = { scope, apiKey: "synthetic-key-au5", contactEmail: "dev@example.test", businessId: "11" };
const request: ClinikoCancellationRequest = {
  scope, patientId: "42", appointmentId: "91", practitionerId: "22", appointmentTypeId: "33",
  startsAt: "2026-10-08T11:00:00+07:00", endsAt: "2026-10-08T11:30:00+07:00",
  cancellationReason: 50,
};
const observedAt = "2026-10-01T10:00:00.000Z";

function appointment(changes: Record<string, unknown> = {}) {
  return { id: "91", starts_at: "2026-10-08T04:00:00Z", ends_at: "2026-10-08T04:30:00Z",
    cancelled_at: null, archived_at: null, deleted_at: null,
    patient: { links: { self: `${base}/patients/42` } },
    business: { links: { self: `${base}/businesses/11` } },
    practitioner: { links: { self: `${base}/practitioners/22` } },
    appointment_type: { links: { self: `${base}/appointment_types/33` } },
    patient_name: "Never disclose this", notes: "Private clinical note", ...changes };
}

function writer(fetchPort: typeof fetch, rateBudget?: ClinikoReadBudget): ClinikoCancellationWriter {
  const created = ClinikoCancellationWriter.create({ ...config, ...(rateBudget ? { rateBudget } : {}) },
    fetchPort, () => observedAt);
  assert.ok(created.ok, created.ok ? "" : created.error.kind);
  return created.value;
}

test("one exact active target is cancelled only after a fresh provider observation", async () => {
  let cancelled = false;
  const methods: string[] = [];
  const adapter = writer(async (input, init) => {
    const url = new URL(String(input));
    methods.push(String(init?.method));
    assert.equal(url.origin, "https://api.au5.cliniko.com");
    assert.equal(new Headers(init?.headers).get("Authorization"),
      `Basic ${Buffer.from("synthetic-key-au5:").toString("base64")}`);
    if (init?.method === "GET") {
      assert.equal(url.pathname, "/v1/individual_appointments/91");
      return Response.json(appointment({ cancelled_at: cancelled ? observedAt : null }));
    }
    assert.equal(init?.method, "PATCH");
    assert.equal(url.pathname, "/v1/individual_appointments/91/cancel");
    assert.deepEqual(JSON.parse(String(init.body)), {
      cancellation_note: null, cancellation_reason: 50, apply_to_repeats: false,
    });
    cancelled = true;
    return new Response(null, { status: 204 });
  });
  assert.deepEqual(await adapter.cancelOnce(request), { ok: true, value: { kind: "cancelled" } });
  assert.deepEqual(methods, ["GET", "PATCH", "GET"]);
  const observed = await adapter.observe(request);
  assert.deepEqual(observed, { ok: true, value: { kind: "cancelled", observedAt } });
  assert.equal(JSON.stringify(observed).includes("Never disclose this"), false);
  assert.equal(JSON.stringify(observed).includes("Private clinical note"), false);
  assert.deepEqual(await adapter.cancelOnce(request), { ok: false, error: { kind: "invalidQuery" } });
  assert.deepEqual(methods, ["GET", "PATCH", "GET", "GET"]);
});

test("wrong patient, moved target, archived target and already cancelled target never send a PATCH", async () => {
  for (const changes of [
    { patient: { links: { self: `${base}/patients/43` } } },
    { starts_at: "2026-10-08T05:00:00Z" },
    { archived_at: observedAt },
    { cancelled_at: observedAt },
  ]) {
    let writes = 0;
    const adapter = writer(async (_input, init) => {
      if (init?.method === "PATCH") { writes += 1; throw new Error("unexpected write"); }
      return Response.json(appointment(changes));
    });
    assert.deepEqual(await adapter.cancelOnce(request), { ok: false, error: { kind: "targetChanged" } });
    assert.equal(writes, 0);
  }
});

test("a lost cancellation response can be observed but never retried in the same call owner", async () => {
  let writes = 0;
  let cancelled = false;
  const adapter = writer(async (_input, init) => {
    if (init?.method === "PATCH") {
      writes += 1;
      cancelled = true;
      throw new Error("response lost after provider commit");
    }
    return Response.json(appointment({ cancelled_at: cancelled ? observedAt : null }));
  });
  assert.deepEqual(await adapter.cancelOnce(request), { ok: true, value: { kind: "uncertain" } });
  assert.deepEqual(await adapter.observe(request), { ok: true, value: { kind: "cancelled", observedAt } });
  assert.deepEqual(await adapter.cancelOnce(request), { ok: false, error: { kind: "invalidQuery" } });
  assert.equal(writes, 1);
});

test("a 204 without a verifiable cancelled state stays uncertain", async () => {
  let reads = 0;
  const adapter = writer(async (_input, init) => {
    if (init?.method === "PATCH") return new Response(null, { status: 204 });
    reads += 1;
    return reads === 1 ? Response.json(appointment()) : new Response(null, { status: 503 });
  });
  assert.deepEqual(await adapter.cancelOnce(request), { ok: true, value: { kind: "uncertain" } });
  assert.equal(reads, 2);
});

test("a cancelled target hidden from the ordinary GET is found through Cliniko's cancelled view", async () => {
  let cancelled = false;
  const views: string[] = [];
  const adapter = writer(async (input, init) => {
    if (init?.method === "PATCH") { cancelled = true; return new Response(null, { status: 204 }); }
    const url = new URL(String(input));
    views.push(url.searchParams.getAll("q[]").join(","));
    if (cancelled && !url.searchParams.has("q[]")) return new Response(null, { status: 404 });
    return Response.json(appointment({ cancelled_at: cancelled ? observedAt : null }));
  });
  assert.deepEqual(await adapter.cancelOnce(request), { ok: true, value: { kind: "cancelled" } });
  assert.deepEqual(views, ["", "", "cancelled_at:*"]);
});

test("simultaneous attempts for one appointment cannot send twice", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  let writes = 0;
  const adapter = writer(async (_input, init) => {
    if (init?.method === "PATCH") { writes += 1; return new Response(null, { status: 204 }); }
    reads += 1;
    if (reads === 1) await held;
    return Response.json(appointment({ cancelled_at: reads > 1 ? observedAt : null }));
  });
  const first = adapter.cancelOnce(request);
  assert.deepEqual(await adapter.cancelOnce(request), { ok: false, error: { kind: "invalidQuery" } });
  release();
  assert.deepEqual(await first, { ok: true, value: { kind: "cancelled" } });
  assert.equal(writes, 1);
});

test("invalid scope, reason and target are rejected before a provider read or write", async () => {
  let requests = 0;
  const adapter = writer(async () => { requests += 1; throw new Error("unexpected request"); });
  for (const invalid of [
    { ...request, scope: { ...scope, locationId: "other" } },
    { ...request, patientId: "patient name" },
    { ...request, cancellationReason: 70 as 50 },
    { ...request, endsAt: request.startsAt },
  ]) {
    assert.equal((await adapter.cancelOnce(invalid)).ok, false);
    assert.equal((await adapter.observe(invalid)).ok, false);
  }
  assert.equal(requests, 0);
});

test("pre-read failure or shared budget exhaustion makes no cancellation attempt", async () => {
  let writes = 0;
  const denied = writer(async (_input, init) => {
    if (init?.method === "PATCH") writes += 1;
    return new Response(null, { status: 403 });
  });
  assert.deepEqual(await denied.cancelOnce(request), { ok: false, error: { kind: "forbidden" } });
  const budget = new ClinikoReadBudget(1, () => Date.parse(observedAt));
  const limited = writer(async (_input, init) => {
    if (init?.method === "PATCH") writes += 1;
    return Response.json(appointment());
  }, budget);
  assert.deepEqual(await limited.cancelOnce(request), {
    ok: false, error: { kind: "rateLimited", resetAt: new Date(Date.parse(observedAt) + 60_000).toISOString() },
  });
  assert.equal(writes, 0);
});
