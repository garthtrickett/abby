import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoBookingWriter } from "../../src/cliniko/booking-write.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import type { ClinikoBookingConfig, ClinikoBookingRequest } from "../../src/cliniko/booking-write.ts";

const scope = { tenantId: "booking-tenant", clinicId: "booking-clinic", locationId: "booking-location" };
const config: ClinikoBookingConfig = { scope, apiKey: "synthetic-key-au5", contactEmail: "dev@example.test",
  businessId: "11", practitionerId: "22", appointmentTypeId: "33" };
const request: ClinikoBookingRequest = { scope, patientId: "42", startsAt: "2026-10-08T11:00:00+07:00",
  marker: "7a6b240c-94fa-45d8-ae0b-f4ee91cb2bd1" };
const observedAt = "2026-10-01T10:00:00.000Z";
const baseUrl = "https://api.au5.cliniko.com/v1";

function appointment(id: string, changes: Record<string, unknown> = {}) {
  return { id, notes: `Abby booking ${request.marker}`, starts_at: "2026-10-08T04:00:00Z",
    cancelled_at: null, archived_at: null, deleted_at: null,
    patient: { links: { self: `${baseUrl}/patients/42` } },
    business: { links: { self: `${baseUrl}/businesses/11` } },
    practitioner: { links: { self: `${baseUrl}/practitioners/22` } },
    appointment_type: { links: { self: `${baseUrl}/appointment_types/33` } }, ...changes };
}

function writer(fetchPort: typeof fetch, overrides: Partial<ClinikoBookingConfig> = {}) {
  const created = ClinikoBookingWriter.create({ ...config, ...overrides }, fetchPort, () => observedAt);
  assert.ok(created.ok, created.ok ? "" : created.error.kind);
  return created.value;
}

test("one marked booking POST produces a bounded receipt and exact patient-scoped observation", async () => {
  let writes = 0;
  const fetchPort: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.au5.cliniko.com");
    assert.equal(url.pathname, "/v1/individual_appointments");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"),
      `Basic ${Buffer.from("synthetic-key-au5:").toString("base64")}`);
    if (init?.method === "POST") {
      writes += 1;
      assert.deepEqual(JSON.parse(String(init.body)), { business_id: "11", practitioner_id: "22",
        appointment_type_id: "33", patient_id: "42", starts_at: request.startsAt,
        notes: `Abby booking ${request.marker}` });
      return Response.json(appointment("91"), { status: 201 });
    }
    assert.equal(init?.method, "GET");
    assert.deepEqual(url.searchParams.getAll("q[]"), ["patient_id:=42"]);
    assert.equal(url.searchParams.get("per_page"), "100");
    return Response.json({ total_entries: 1, individual_appointments: [appointment("91")] });
  };
  const adapter = writer(fetchPort);
  assert.deepEqual(await adapter.writeOnce(request),
    { ok: true, value: { kind: "accepted", appointmentRef: "cliniko:appointment:91" } });
  assert.deepEqual(await adapter.observe(request), { ok: true, value: { kind: "one", scope, observedAt,
    appointmentRef: "cliniko:appointment:91", active: true } });
  assert.deepEqual(await adapter.writeOnce(request), { ok: false, error: { kind: "invalidQuery" } });
  assert.equal(writes, 1);
});

test("lost response after commit reconciles one exact appointment and never replays POST", async () => {
  let writes = 0;
  const adapter = writer(async (_input, init) => {
    if (init?.method === "POST") { writes += 1; throw new Error("response lost after commit"); }
    return Response.json({ total_entries: 1, individual_appointments: [appointment("91")] });
  });
  assert.deepEqual(await adapter.writeOnce(request), { ok: true, value: { kind: "uncertain" } });
  const observed = await adapter.observe(request);
  assert.ok(observed.ok);
  assert.equal(observed.value.kind, "one");
  assert.deepEqual(await adapter.writeOnce(request), { ok: false, error: { kind: "invalidQuery" } });
  assert.equal(writes, 1);
});

test("a miss, altered booking, duplicate marker, and cancelled record never authorize another POST", async () => {
  for (const rows of [[], [appointment("91", { starts_at: "2026-10-08T05:00:00Z" })],
    [appointment("91"), appointment("92")], [appointment("91", { cancelled_at: observedAt })]]) {
    let writes = 0;
    const adapter = writer(async (_input, init) => {
      if (init?.method === "POST") { writes += 1; throw new Error("lost response"); }
      return Response.json({ total_entries: rows.length, individual_appointments: rows });
    });
    const sent = await adapter.writeOnce(request);
    assert.ok(sent.ok);
    assert.equal(sent.value.kind, "uncertain");
    const observed = await adapter.observe(request);
    assert.ok(observed.ok);
    assert.equal(observed.value.kind, rows.length === 0 ? "none" : rows.length === 2 ? "ambiguous" :
      rows[0]?.starts_at !== appointment("91").starts_at ? "mismatch" : "one");
    if (observed.value.kind === "one" && rows.length === 1 && rows[0]?.cancelled_at) {
      assert.equal(observed.value.active, false);
    }
    assert.equal((await adapter.writeOnce(request)).ok, false);
    assert.equal(writes, 1);
  }
});

test("non-201 or malformed create responses are uncertain, including a rate-limit response", async () => {
  for (const response of [new Response(null, { status: 403 }), new Response(null, { status: 422 }),
    new Response(null, { status: 429 }), new Response(null, { status: 503 }),
    Response.json({ id: "91" }, { status: 201 }), Response.json(appointment("91", { patient: { links: {
      self: `${baseUrl}/patients/99` } } }), { status: 201 }),
    Response.json(appointment("91", { cancelled_at: undefined }), { status: 201 })]) {
    let writes = 0;
    const adapter = writer(async () => { writes += 1; return response; });
    assert.deepEqual(await adapter.writeOnce(request), { ok: true, value: { kind: "uncertain" } });
    assert.equal((await adapter.writeOnce(request)).ok, false);
    assert.equal(writes, 1);
  }
});

test("observation scans all bounded patient pages before reporting an exact marker", async () => {
  const pages: number[] = [];
  const adapter = writer(async input => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    pages.push(page);
    const rows = page === 1
      ? Array.from({ length: 100 }, (_, index) => appointment(String(index + 1), { notes: "other booking" }))
      : [appointment("101")];
    return Response.json({ total_entries: 101, individual_appointments: rows });
  });
  const observed = await adapter.observe(request);
  assert.ok(observed.ok);
  assert.deepEqual(observed.value, { kind: "one", scope, observedAt,
    appointmentRef: "cliniko:appointment:101", active: true });
  assert.deepEqual(pages, [1, 2]);
});

test("simultaneous calls with one marker send at most one POST", async () => {
  let writes = 0;
  const adapter = writer(async () => {
    writes += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    return Response.json(appointment("91"), { status: 201 });
  });
  const sent = await Promise.all([adapter.writeOnce(request), adapter.writeOnce(request)]);
  assert.deepEqual(sent.map(result => result.ok ? result.value.kind : result.error.kind).sort(),
    ["accepted", "invalidQuery"]);
  assert.equal(writes, 1);
});

test("observation rejects a foreign patient, malformed status and excessive patient history", async () => {
  for (const rows of [[appointment("91", { patient: { links: { self: `${baseUrl}/patients/99` } } })],
    [appointment("91", { cancelled_at: undefined })]]) {
    const result = await writer(async () => Response.json({ total_entries: 1,
      individual_appointments: rows })).observe(request);
    assert.deepEqual(result, { ok: false, error: { kind: "malformed" } });
  }
  const tooMany = await writer(async () => Response.json({ total_entries: 501,
    individual_appointments: [] })).observe(request);
  assert.deepEqual(tooMany, { ok: false, error: { kind: "tooManyResults" } });
});

test("invalid scope, IDs, marker and time fail before any provider request", async () => {
  let requests = 0;
  const adapter = writer(async () => { requests += 1; throw new Error("unexpected request"); });
  for (const invalid of [
    { ...request, scope: { ...scope, locationId: "other" } },
    { ...request, patientId: "patient name" },
    { ...request, marker: "free text" },
    { ...request, startsAt: "2026-02-30" },
  ]) {
    assert.equal((await adapter.writeOnce(invalid)).ok, false);
    assert.equal((await adapter.observe(invalid)).ok, false);
  }
  assert.equal(requests, 0);
});

test("a shared budget blocks the write before send and the marker remains fenced", async () => {
  let writes = 0;
  const budget = new ClinikoReadBudget(1, () => Date.parse(observedAt));
  assert.equal(budget.claim(), null);
  const adapter = writer(async () => { writes += 1; throw new Error("unexpected send"); }, { rateBudget: budget });
  const denied = await adapter.writeOnce(request);
  assert.equal(denied.ok, false);
  assert.equal(denied.error.kind, "rateLimited");
  assert.equal((await adapter.writeOnce(request)).ok, false);
  assert.equal(writes, 0);
});

test("a call abort before or during budget claim prevents the POST and fences the marker", async () => {
  let claims = 0;
  let writes = 0;
  let releaseClaim!: (value: null) => void;
  const budget = { claim() {
    claims += 1;
    return new Promise<null>(resolve => { releaseClaim = resolve; });
  }, observe429() { return { kind: "rateLimited" as const }; } };
  const adapter = writer(async () => { writes += 1; throw new Error("unexpected POST"); }, { rateBudget: budget });
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await adapter.writeOnce(request, aborted.signal),
    { ok: false, error: { kind: "unavailable" } });
  assert.equal(claims, 0);
  assert.deepEqual(await adapter.writeOnce(request), { ok: false, error: { kind: "invalidQuery" } });

  const second = writer(async () => { writes += 1; throw new Error("unexpected POST"); }, { rateBudget: budget });
  const controller = new AbortController();
  const pending = second.writeOnce(request, controller.signal);
  assert.equal(claims, 1);
  controller.abort();
  assert.deepEqual(await pending, { ok: false, error: { kind: "unavailable" } });
  releaseClaim(null);
  await Promise.resolve();
  assert.equal(writes, 0);
  assert.deepEqual(await second.writeOnce(request), { ok: false, error: { kind: "invalidQuery" } });
});

test("an abort after the booking POST begins is uncertain even if a late response reports success", async () => {
  let finish!: (response: Response) => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const late = new Promise<Response>(resolve => { finish = resolve; });
  let writes = 0;
  let providerSignal: AbortSignal | null | undefined;
  const adapter = writer(async (_input, init) => {
    writes += 1;
    assert.equal(init?.method, "POST");
    providerSignal = init?.signal;
    began();
    return late;
  });
  const controller = new AbortController();
  const pending = adapter.writeOnce(request, controller.signal);
  await started;
  controller.abort();
  assert.equal(providerSignal?.aborted, true);
  assert.deepEqual(await pending, { ok: true, value: { kind: "uncertain" } });
  finish(Response.json(appointment("91"), { status: 201 }));
  await Promise.resolve();
  assert.equal(writes, 1);
  assert.deepEqual(await adapter.writeOnce(request), { ok: false, error: { kind: "invalidQuery" } });
});

test("an abort while reading a successful booking body cannot become an accepted booking", async () => {
  let beganReading!: () => void;
  let releaseBody!: () => void;
  const reading = new Promise<void>(resolve => { beganReading = resolve; });
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    beganReading();
    return new Promise<void>(resolve => {
      releaseBody = () => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(appointment("91"))));
        controller.close();
        resolve();
      };
    });
  } }, { highWaterMark: 0 });
  const adapter = writer(async () => new Response(body, { status: 201 }));
  const controller = new AbortController();
  const pending = adapter.writeOnce(request, controller.signal);
  await reading;
  controller.abort();
  assert.deepEqual(await pending, { ok: true, value: { kind: "uncertain" } });
  releaseBody();
  await Promise.resolve();
  assert.deepEqual(await adapter.writeOnce(request), { ok: false, error: { kind: "invalidQuery" } });
});

test("observation abort before or during the budget claim prevents a patient GET", async () => {
  let claims = 0;
  let gets = 0;
  let releaseClaim!: (value: null) => void;
  const budget = { claim() {
    claims += 1;
    return new Promise<null>(resolve => { releaseClaim = resolve; });
  }, observe429() { return { kind: "rateLimited" as const }; } };
  const adapter = writer(async () => { gets += 1; throw new Error("unexpected patient GET"); },
    { rateBudget: budget });
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  assert.deepEqual(await adapter.observe(request, alreadyAborted.signal),
    { ok: false, error: { kind: "unavailable" } });
  assert.equal(claims, 0);

  const controller = new AbortController();
  const pending = adapter.observe(request, controller.signal);
  assert.equal(claims, 1);
  controller.abort();
  assert.deepEqual(await pending, { ok: false, error: { kind: "unavailable" } });
  releaseClaim(null);
  await Promise.resolve();
  assert.equal(gets, 0);
});

test("observation abort during an uncooperative patient GET ignores its late exact row", async () => {
  let releaseGet!: (response: Response) => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const late = new Promise<Response>(resolve => { releaseGet = resolve; });
  let providerSignal: AbortSignal | null | undefined;
  let gets = 0;
  const adapter = writer(async (_input, init) => {
    gets += 1;
    providerSignal = init?.signal;
    began();
    return late;
  });
  const controller = new AbortController();
  const pending = adapter.observe(request, controller.signal);
  await started;
  controller.abort();
  assert.equal(providerSignal?.aborted, true);
  assert.deepEqual(await pending, { ok: false, error: { kind: "unavailable" } });
  releaseGet(Response.json({ total_entries: 1, individual_appointments: [appointment("91")] }));
  await Promise.resolve();
  assert.equal(gets, 1);
});

test("observation abort while reading a patient page cannot report an exact match", async () => {
  let beganReading!: () => void;
  let releaseBody!: () => void;
  const reading = new Promise<void>(resolve => { beganReading = resolve; });
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    beganReading();
    return new Promise<void>(resolve => {
      releaseBody = () => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ total_entries: 1,
          individual_appointments: [appointment("91")] })));
        controller.close();
        resolve();
      };
    });
  } }, { highWaterMark: 0 });
  const adapter = writer(async () => new Response(body, { status: 200 }));
  const controller = new AbortController();
  const pending = adapter.observe(request, controller.signal);
  await reading;
  controller.abort();
  assert.deepEqual(await pending, { ok: false, error: { kind: "unavailable" } });
  releaseBody();
  await Promise.resolve();
});

test("observation abort between patient pages prevents the next GET", async () => {
  let releaseSecondClaim!: (value: null) => void;
  let secondClaimStarted!: () => void;
  const waitingForSecondClaim = new Promise<void>(resolve => { secondClaimStarted = resolve; });
  let claims = 0;
  const budget = { claim() {
    claims += 1;
    if (claims === 1) return null;
    secondClaimStarted();
    return new Promise<null>(resolve => { releaseSecondClaim = resolve; });
  }, observe429() { return { kind: "rateLimited" as const }; } };
  let gets = 0;
  const adapter = writer(async () => {
    gets += 1;
    assert.equal(gets, 1);
    return Response.json({ total_entries: 101, individual_appointments:
      Array.from({ length: 100 }, (_, index) => appointment(String(index + 1), { notes: "other booking" })) });
  }, { rateBudget: budget });
  const controller = new AbortController();
  const pending = adapter.observe(request, controller.signal);
  await waitingForSecondClaim;
  controller.abort();
  assert.deepEqual(await pending, { ok: false, error: { kind: "unavailable" } });
  releaseSecondClaim(null);
  await Promise.resolve();
  assert.equal(gets, 1);
});
