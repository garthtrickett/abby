import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoRecallWriter } from "../../src/cliniko/recall-write.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import type { ClinikoReviewRequest } from "../../src/cliniko/review-request.ts";
import { ClinikoReviewedSend } from "../../src/standalone/cliniko-reviewed-send.ts";

const scope = { tenantId: "reviewed-tenant", clinicId: "clinic", locationId: "location" };
const apiKey = "synthetic-reviewed-key-au5";
const time = "2026-10-04T04:00:00Z";
const base = "https://api.au5.cliniko.com/v1";
const fingerprint = clinikoCredentialFingerprint(apiKey);
function request(kind: "book" | "cancel" | "reschedule" = "book"): ClinikoReviewRequest {
  const common = { startsAt: "2026-10-08T04:00:00Z", endsAt: "2026-10-08T04:30:00Z",
    practitionerId: "22", appointmentTypeId: "33" };
  return { scope, patientId: "42", businessId: "11", credentialFingerprint: fingerprint,
    policyVersion: "policy", termsVersion: "terms", timeZone: "Asia/Jakarta", createdAt: time,
    operation: kind === "book" ? { kind, ...common } : kind === "cancel" ? { kind, ...common, appointmentId: "71", cancellationReason: 10 } :
      { kind, ...common, appointmentId: "71", newStartsAt: "2026-10-09T04:00:00Z", newEndsAt: "2026-10-09T04:30:00Z" } };
}
function accepted(init: RequestInit | undefined): Response {
  const body = JSON.parse(String(init?.body));
  return Response.json({ id: "91", notes: body.notes, recalled: false, archived_at: null,
    recall_at: body.recall_at, patient: { links: { self: `${base}/patients/${body.patient_id}` } },
    recall_type: { links: { self: `${base}/recall_types/${body.recall_type_id}` } } }, { status: 201 });
}
function setup(fetchPort: typeof fetch, rateBudget?: ClinikoRequestBudget, deadlineMs = 5_000) {
  const writer = ClinikoRecallWriter.create({ scope, apiKey, contactEmail: "test@example.test",
    ...(rateBudget ? { rateBudget } : {}) }, fetchPort);
  assert.ok(writer.ok);
  const config = { scope, businessId: "11", credentialFingerprint: fingerprint, policyVersion: "policy",
    timeZone: "Asia/Jakarta", recallTypeId: "7", writer: writer.value, clock: () => Date.parse(time), deadlineMs };
  return { gate: new ClinikoReviewedSend(config), writer: writer.value, config };
}
const live = () => new AbortController().signal;

test("E2E-268 all confirmed operation envelopes are acknowledged before one clinical send, with fresh authorization", async () => {
  for (const kind of ["book", "cancel", "reschedule"] as const) {
    const order: string[] = [];
    const confirmed = request(kind);
    const { gate } = setup(async (url, init) => {
      order.push("recall"); assert.equal(String(url), `${base}/recalls`); assert.equal(init?.method, "POST");
      const decoded = decodeClinikoReview(JSON.parse(String(init.body)).notes); assert.ok(decoded.ok);
      assert.deepEqual(decoded.value.request, confirmed);
      return accepted(init);
    });
    const ports = { authorize: async () => { order.push("authorize"); return true; },
      send: async (exact: ClinikoReviewRequest) => {
        order.push("mutation"); assert.deepEqual(exact, confirmed);
        return { kind: "providerOutcomeForInspection" };
      } };
    assert.deepEqual(await gate.run(confirmed, ports, live()), { ok: true, value: {
      recallRef: "cliniko:recall:91", outcome: { kind: "providerOutcomeForInspection" } } });
    assert.deepEqual(order, ["authorize", "recall", "authorize", "mutation"]);
    assert.deepEqual(await gate.run(confirmed, ports, live()), { ok: false, error: { kind: "attemptConsumed" } });
    assert.equal(order.length, 4);
  }
});

test("E2E-268 disabled/denied authority and invalid selection send neither a recall nor an appointment", async () => {
  let sends = 0;
  const ports = { authorize: async () => false, send: async () => { sends += 1; return "sent"; } };
  for (const changed of [request(), { ...request(), scope: { ...scope, locationId: "other" } },
    { ...request(), businessId: "12" }, { ...request(), policyVersion: "old" },
    { ...request(), credentialFingerprint: "b".repeat(64) }, { ...request(), timeZone: "UTC" },
    { ...request(), createdAt: "2026-10-03T04:00:00Z" }]) {
    const { gate } = setup(async () => { sends += 1; return new Response(); });
    const result = await gate.run(changed, ports, live()); assert.equal(result.ok, false);
  }
  assert.equal(sends, 0);
  const { config } = setup(async (_url, init) => accepted(init));
  assert.throws(() => new ClinikoReviewedSend({ ...config, credentialFingerprint: "b".repeat(64) }), /invalid reviewed/);
  assert.throws(() => new ClinikoReviewedSend({ ...config, scope: { ...scope, clinicId: "other" } }), /invalid reviewed/);
});

test("E2E-268 uncertain, rejected and altered recall acknowledgments never allow a clinical send or recall retry", async () => {
  for (const fault of ["lost", "503", "429", "wrongNotes", "wrongPatient", "wrongType", "wrongDate"] as const) {
    let recalls = 0, mutations = 0;
    const { gate } = setup(async (_url, init) => {
      recalls += 1;
      if (fault === "lost") throw new Error("response lost");
      if (fault === "503" || fault === "429") return new Response(null, { status: Number(fault) });
      const row = await accepted(init).json();
      if (fault === "wrongNotes") row.notes = "edited";
      if (fault === "wrongPatient") row.patient.links.self = `${base}/patients/43`;
      if (fault === "wrongType") row.recall_type.links.self = `${base}/recall_types/8`;
      if (fault === "wrongDate") row.recall_at = "2026-10-05";
      return Response.json(row, { status: 201 });
    });
    const ports = { authorize: async () => true, send: async () => { mutations += 1; return "sent"; } };
    assert.deepEqual(await gate.run(request(), ports, live()), { ok: false, error: { kind: "reviewUncertain" } });
    assert.equal((await gate.run(request(), ports, live())).ok, false);
    assert.equal(recalls, 1); assert.equal(mutations, 0);
  }
});

test("E2E-268 authorization denied after acknowledgment keeps review work pending without sending", async () => {
    let calls = 0, recalls = 0, mutations = 0;
    const { gate } = setup(async (_url, init) => { recalls += 1; return accepted(init); });
    const result = await gate.run(request(), { authorize: async () => ++calls === 1,
      send: async () => { mutations += 1; return "sent"; } }, live());
    assert.deepEqual(result, { ok: false, error: { kind: "authorityLost" } });
    assert.equal(recalls, 1); assert.equal(mutations, 0);
});

test("E2E-268 concurrent callers claim one attempt before awaiting authorization and cannot edit its approved envelope", async () => {
  let release: (value: boolean) => void = () => undefined;
  let recalls = 0, mutations = 0, calls = 0;
  const confirmation = structuredClone(request());
  const { gate } = setup(async (_url, init) => {
    recalls += 1;
    const decoded = decodeClinikoReview(JSON.parse(String(init?.body)).notes); assert.ok(decoded.ok);
    assert.equal(decoded.value.request.patientId, "42");
    return accepted(init);
  });
  const ports = { authorize: async (exact: ClinikoReviewRequest) => {
    assert.throws(() => { (exact as { patientId: string }).patientId = "999"; }, TypeError);
    if (++calls === 1) return new Promise<boolean>(resolve => { release = resolve; });
    return true;
  }, send: async (exact: ClinikoReviewRequest) => { mutations += 1; assert.equal(exact.patientId, "42"); return "inspected"; } };
  const first = gate.run(confirmation, ports, live());
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(await gate.run(confirmation, ports, live()), { ok: false, error: { kind: "attemptConsumed" } });
  (confirmation as { patientId: string }).patientId = "999";
  release(true); assert.equal((await first).ok, true); assert.equal(recalls, 1); assert.equal(mutations, 1);
});

test("E2E-268 disconnect and deadline during recall creation block late clinical sends", async () => {
  for (const fault of ["disconnect", "deadline"] as const) {
    let release: (value: Response) => void = () => undefined;
    let storedInit: RequestInit | undefined;
    let mutations = 0;
    const { gate } = setup(async (_url, init) => {
      storedInit = init;
      return new Promise<Response>(resolve => { release = resolve; });
    }, undefined, fault === "deadline" ? 30 : 5_000);
    const pending = gate.run(request(), { authorize: async () => true,
      send: async () => { mutations += 1; return "sent"; } }, live());
    await new Promise<void>(resolve => setImmediate(resolve));
    if (fault === "disconnect") gate.close();
    assert.deepEqual(await pending, { ok: false, error: { kind: "reviewUncertain" } });
    release(accepted(storedInit));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(mutations, 0); assert.equal(storedInit?.signal?.aborted, true);
  }
});

test("E2E-268 mutation response loss/timeout retains uncertainty, never replays and leaves its recall pending", async () => {
  for (const fault of ["throw", "timeout", "disconnect"] as const) {
    let recalls = 0, mutations = 0;
    const { gate } = setup(async (_url, init) => { recalls += 1; return accepted(init); }, undefined, 30);
    const ports = { authorize: async () => true, send: async () => {
      mutations += 1;
      if (fault === "throw") throw new Error("lost mutation response");
      if (fault === "disconnect") gate.close();
      return new Promise<string>(() => undefined);
    } };
    assert.deepEqual(await gate.run(request(), ports, live()), { ok: false, error: { kind: "mutationUncertain" } });
    assert.equal((await gate.run(request(), ports, live())).ok, false);
    assert.equal(recalls, 1); assert.equal(mutations, 1);
  }
});

test("E2E-268 abort during budget reservation sends no recall, while pre-send denial stays unavailable", async () => {
  let release: (value: null) => void = () => undefined;
  const budget: ClinikoRequestBudget = { claim: () => new Promise<null>(resolve => { release = resolve; }),
    observe429: () => ({ kind: "rateLimited" }) };
  let sends = 0;
  const { gate } = setup(async () => { sends += 1; return new Response(); }, budget);
  const pending = gate.run(request(), { authorize: async () => true, send: async () => { sends += 1; return "sent"; } }, live());
  await new Promise<void>(resolve => setImmediate(resolve));
  gate.close(); await pending; release(null);
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(sends, 0);
  const denied = setup(async () => { sends += 1; return new Response(); }, {
    claim: () => ({ kind: "unavailable" }), observe429: () => ({ kind: "rateLimited" }) });
  assert.deepEqual(await denied.gate.run(request(), { authorize: async () => true, send: async () => "sent" }, live()),
    { ok: false, error: { kind: "reviewUnavailable" } });
  assert.equal(sends, 0);
});
