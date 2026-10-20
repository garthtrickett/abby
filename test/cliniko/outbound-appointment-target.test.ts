import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ClinikoOutboundAppointmentTarget } from "../../src/cliniko/outbound-appointment-target.ts";
import { outboundTargetFixture } from "../support/outbound-appointment-target.ts";
import { value } from "../support/outbound-records.ts";

test("staff observation binds exactly one native individual target without patient proof or unrelated private fields", async () => {
  const f = outboundTargetFixture(), found = value(await f.observe());
  assert.equal(found.target.appointmentRef, f.input.appointmentRef); assert.equal(found.target.patientId, "21");
  assert.equal(found.target.businessId, "11"); assert.equal(found.target.practitionerId, "31"); assert.equal(found.target.appointmentTypeId, "41");
  assert.equal(found.target.updatedAt, f.row.updated_at); assert.equal(found.target.startsAt, f.row.starts_at);
  assert.equal(Object.isFrozen(found), true); assert.equal(Object.isFrozen(found.target), true);
  assert.match(found.digest, /^[a-f0-9]{64}$/); assert.equal(f.claims, 1); assert.equal(f.fetches, 1);
  const exposed = JSON.stringify([found, f.queries]);
  for (const privateText of ["discard-private-native-target-note", "discard-private-native-target-name", "patientProof"]) assert.equal(exposed.includes(privateText), false);
  assert.equal(f.queries[0]!.appointmentPolicyDigest, "e".repeat(64));
  assert.ok(f.queries.some(q => q.target?.updatedAt === f.row.updated_at && q.targetDigest === found.digest));
});
test("fresh exact request read matches the original observation and passes full canonical context to its separate authority", async () => {
  const f = outboundTargetFixture(), observed = value(await f.observe());
  const request = { ...f.request, purpose: "sickDay" as const, appointment: { ref: f.input.appointmentRef, digest: observed.digest } };
  f.setNow("2026-11-01T10:00:01.000Z");
  const current = value(await f.reader.readForRequest(request, new AbortController().signal));
  assert.equal(current.digest, observed.digest); assert.notEqual(current.observedAt, observed.observedAt);
  assert.equal(f.fetches, 2); assert.ok(f.queries.some(q => q.operation === "readRequestIndividualTarget" && q.request?.purpose === "sickDay" && q.requestDigest));
});
for (const [name, patch] of Object.entries({ wrongId: { id: "72" }, wrongPatient: { patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/22" } } },
  wrongBusiness: { business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/12" } } }, foreignShard: { links: { self: "https://api.uk1.cliniko.com/v1/individual_appointments/71" } },
  noncanonicalId: { practitioner: { links: { self: "https://api.au5.cliniko.com/v1/practitioners/031" } } },
  collectionInsteadOfType: { appointment_type: { links: { self: "https://api.au5.cliniko.com/v1/appointment_types" } } },
  invalidDate: { starts_at: "2026-02-30T10:00:00Z" }, backwardsTime: { ends_at: "2026-11-01T00:00:00Z" },
  backwardsVersion: { updated_at: "2025-01-01T00:00:00Z" }, missingArchive: { archived_at: undefined }, missingCancellation: { cancelled_at: undefined },
  missingDelete: { deleted_at: undefined }, unknownArrival: { patient_arrived: "false" }, missingDidNotArrive: { did_not_arrive: undefined } }))
  test(`malformed or foreign exact target refuses without list fallback: ${name}`, async () => {
    const f = outboundTargetFixture(); Object.assign(f.row, patch);
    assert.deepEqual(await f.observe(), { ok: false, error: { kind: "mismatched" } }); assert.equal(f.fetches, 1);
  });
for (const [name, patch] of Object.entries({ microsecondVersion: { updated_at: "2026-10-02T00:00:00.000002Z" },
  changedPractitioner: { practitioner: { links: { self: "https://api.au5.cliniko.com/v1/practitioners/32" } } },
  changedType: { appointment_type: { links: { self: "https://api.au5.cliniko.com/v1/appointment_types/42" } } },
  rescheduled: { starts_at: "2026-11-02T10:01:00+11:00" }, cancelled: { cancelled_at: "2026-11-01T10:00:00Z" },
  archived: { archived_at: "2026-11-01T10:00:00Z" }, deleted: { deleted_at: "2026-11-01T10:00:00Z" }, arrived: { patient_arrived: true }, didNotArrive: { did_not_arrive: false } }))
  test(`changed native version cannot satisfy a pinned request: ${name}`, async () => {
    const f = outboundTargetFixture(), observed = value(await f.observe());
    Object.assign(f.row, patch);
    assert.deepEqual(await f.reader.readForRequest({ ...f.request, appointment: { ref: f.input.appointmentRef, digest: observed.digest } }, new AbortController().signal),
      { ok: false, error: { kind: "mismatched" } }); assert.equal(f.fetches, 2);
  });
test("cancelled and past observations expose status without deciding call or clinical eligibility", async () => {
  const f = outboundTargetFixture(); f.row.cancelled_at = "2026-11-01T10:00:00Z"; f.setNow("2026-12-01T10:00:00.000Z");
  const found = value(await f.observe()); assert.equal(found.target.cancelledAt, f.row.cancelled_at);
  assert.equal(Object.hasOwn(found, "eligible"), false); assert.equal(Object.hasOwn(found, "grant"), false);
});
for (const kind of ["allows", "current", "decoded"] as const)
  test(`appointment permission independently refuses ${kind}`, async () => {
    const f = outboundTargetFixture({ authority: kind === "decoded" ? { allows: async q => !q.target } : {} });
    if (kind === "allows") f.deny(); if (kind === "current") f.retire();
    assert.deepEqual(await f.observe(), { ok: false, error: { kind: "forbidden" } }); assert.equal(f.fetches, kind === "decoded" ? 1 : 0);
  });
test("withdrawal while claiming physical account quota prevents native GET", async () => {
  let f!: ReturnType<typeof outboundTargetFixture>;
  f = outboundTargetFixture({ claim: async () => { f.retire(); return null; } });
  assert.deepEqual(await f.observe(), { ok: false, error: { kind: "forbidden" } }); assert.equal(f.fetches, 0); assert.equal(f.claims, 1);
});
test("withdrawal while reading native body prevents returning a private observation", async () => {
  let f!: ReturnType<typeof outboundTargetFixture>;
  f = outboundTargetFixture({ response: row => { f.retire(); return Response.json(row); } });
  assert.deepEqual(await f.observe(), { ok: false, error: { kind: "forbidden" } });
});
for (const mode of ["permission", "fetch", "body"] as const)
  test(`hung ${mode} respects owned deadline without later returning a target`, { timeout: 3000 }, async () => {
    const held = new Promise<never>(() => {});
    const f = outboundTargetFixture({ deadlineMs: 30,
      ...(mode === "permission" ? { authority: { allows: () => held } } : {}),
      ...(mode === "fetch" ? { response: () => held } : mode === "body" ? { response: () => new Response(new ReadableStream({ start() {} })) } : {}) });
    assert.deepEqual(await f.observe(), { ok: false, error: { kind: "unavailable" } });
    assert.equal(f.fetches, mode === "permission" ? 0 : 1);
  });
test("pre-aborted observation does not claim quota or read native data", async () => {
  const f = outboundTargetFixture(), controller = new AbortController(); controller.abort();
  assert.deepEqual(await f.observe(controller.signal), { ok: false, error: { kind: "unavailable" } }); assert.equal(f.claims, 0); assert.equal(f.fetches, 0);
});
test("mid-body abort cancels the owned native stream and suppresses the observation", async () => {
  let started!: () => void, cancelled = false;
  const began = new Promise<void>(resolve => { started = resolve; });
  const f = outboundTargetFixture({ response: () => new Response(new ReadableStream({
    pull() { started(); }, cancel() { cancelled = true; },
  })) }), controller = new AbortController(), running = f.observe(controller.signal);
  await began; controller.abort(); assert.equal((await running).ok, false);
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(cancelled, true);
});
test("physical quota refusal prevents the exact GET and native 429 remains rate limited", async () => {
  const f = outboundTargetFixture({ claim: async () => ({ kind: "rateLimited" }) });
  assert.deepEqual(await f.observe(), { ok: false, error: { kind: "rateLimited" } }); assert.equal(f.fetches, 0);
  const g = outboundTargetFixture({ response: () => new Response(null, { status: 429 }) });
  assert.deepEqual(await g.observe(), { ok: false, error: { kind: "rateLimited" } }); assert.equal(g.fetches, 1);
});
test("a backwards current clock after native fetch cannot return target truth", async () => {
  let f!: ReturnType<typeof outboundTargetFixture>;
  f = outboundTargetFixture({ response: row => { f.setNow("2026-11-01T09:59:59.000Z"); return Response.json(row); } });
  assert.deepEqual(await f.observe(), { ok: false, error: { kind: "unavailable" } });
});
test("captured permission methods cannot be replaced to undo denial", async () => {
  const f = outboundTargetFixture(); f.deny(); Object.assign(f.authority, { allows: async () => true });
  assert.deepEqual(await f.observe(), { ok: false, error: { kind: "forbidden" } }); assert.equal(f.fetches, 0);
});
test("concurrent request reads retain their own strongest decoded permission context", async () => {
  let denied = "";
  const f = outboundTargetFixture({ authority: { allows: async q => !q.target || q.request?.actionRef !== denied } });
  const observed = value(await f.observe()), request = { ...f.request, appointment: { ref: f.input.appointmentRef, digest: observed.digest } };
  denied = request.actionRef;
  const [first, second] = await Promise.all([f.reader.readForRequest(request, new AbortController().signal),
    f.reader.readForRequest({ ...request, actionRef: randomUUID() }, new AbortController().signal)]);
  assert.deepEqual(first, { ok: false, error: { kind: "forbidden" } }); assert.equal(value(second).digest, observed.digest);
});
test("explicit clock failure cannot fall back to wall time", async () => {
  const f = outboundTargetFixture(); Object.assign(f.config.requests, { clock: () => undefined }); const cold = value(f.make());
  assert.deepEqual(await cold.observeTarget(f.input, new AbortController().signal), { ok: false, error: { kind: "unavailable" } }); assert.equal(f.fetches, 0);
});
test("foreign request context and absent exact appointment refuse before private reads", async () => {
  const f = outboundTargetFixture(), observed = value(await f.observe()), request = { ...f.request, appointment: { ref: f.input.appointmentRef, digest: observed.digest } };
  for (const foreign of [f.request, { ...request, scope: { ...request.scope, clinicId: "foreign" } }, { ...request, businessId: "12" },
    { ...request, credentialFingerprint: "f".repeat(64) }])
    assert.deepEqual(await f.reader.readForRequest(foreign, new AbortController().signal), { ok: false, error: { kind: "invalidQuery" } });
  assert.equal(f.fetches, 1);
});
test("no appointment policy or native outbound source selection can be inferred from financial configuration", () => {
  const f = outboundTargetFixture();
  for (const config of [{ requests: f.config.requests }, { ...f.config, appointmentPolicyDigest: "" },
    { ...f.config, requests: { ...f.config.requests, outboundRecallTypeId: undefined } }])
    assert.equal(ClinikoOutboundAppointmentTarget.create(config as typeof f.config, f.authority, f.port).ok, false);
  assert.equal(f.fetches, 0);
});
test("native error and oversized or malformed bodies cannot yield a target", async () => {
  for (const response of [() => new Response(null, { status: 404 }), () => new Response(null, { status: 401 }),
    () => new Response("not-json"), () => new Response(" ".repeat(1_000_001))]) {
    const f = outboundTargetFixture({ response }); assert.equal((await f.observe()).ok, false); assert.equal(f.fetches, 1);
  }
});
