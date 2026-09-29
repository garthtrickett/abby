import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { ClinikoRecallWriter } from "../../src/cliniko/recall-write.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRecallFailure, ClinikoRecallMatch } from "../../src/cliniko/recalls.ts";
import type { Result } from "../../src/core/model.ts";

const scope = { tenantId: "recall-tenant", clinicId: "recall-clinic" };
const config = { scope, apiKey: "synthetic-key-au5", contactEmail: "dev@example.test" };
const marker = "7a6b240c-94fa-45d8-ae0b-f4ee91cb2bd1";
const observedAt = "2026-09-29T10:00:00.000Z";

function recall(id: string, notes: string | null = marker, patientId = "42", archivedAt: string | null = null) {
  return { id, notes, recalled: false, archived_at: archivedAt,
    patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${patientId}` } },
    recall_at: "2026-10-01", recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/7" } },
    private_patient_notes: "clinical secret" };
}

function reader(fetchPort: typeof fetch, rateBudget?: ClinikoReadBudget): ClinikoRecallReader {
  const created = ClinikoRecallReader.create({ ...config, ...(rateBudget ? { rateBudget } : {}) }, fetchPort, () => observedAt);
  assert.ok(created.ok);
  return created.value;
}

function value(result: Result<ClinikoRecallMatch, ClinikoRecallFailure>): ClinikoRecallMatch {
  assert.ok(result.ok, result.ok ? "" : result.error.kind);
  return result.value;
}

function failure(result: Result<unknown, ClinikoRecallFailure>, kind: ClinikoRecallFailure["kind"]): void {
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, kind);
}

test("exact patient and random-marker lookup returns only a transient recall reference", async () => {
  const requests: URL[] = [];
  const fetchPort: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.equal(url.origin, "https://api.au5.cliniko.com");
    assert.equal(url.pathname, "/v1/recalls");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), `Basic ${Buffer.from("synthetic-key-au5:").toString("base64")}`);
    assert.equal(headers.get("User-Agent"), "Abby (dev@example.test)");
    return Response.json({ total_entries: 2, recalls: [recall("9", "other"), recall("10")] });
  };
  const result = value(await reader(fetchPort).findByMarker(scope, "42", marker));
  assert.deepEqual(result, { kind: "one", scope, observedAt, recallRef: "cliniko:recall:10", recalled: false, archived: false });
  assert.equal(JSON.stringify(result).includes("clinical secret"), false);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]!.searchParams.getAll("q[]"), ["patient_id:=42"]);
  assert.equal(requests[0]!.searchParams.get("per_page"), "100");
  assert.equal(requests[0]!.searchParams.get("sort"), "id:asc");
});

test("Cliniko owns request details while one-attempt create and observe expose only a recall reference", async () => {
  const summary = "Patient asks staff to discuss a booking";
  const notes = `Abby request ${marker}\n${summary}`;
  let writes = 0;
  const fetchPort: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/recalls" && init?.method === "POST") {
      writes += 1;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.deepEqual(body, { patient_id: "42", recall_type_id: "7", recall_at: "2026-10-01",
        notes, recalled: false });
      assert.equal(init.redirect, "error");
      return Response.json({ id: "91", notes, recall_at: "2026-10-01", recalled: false, archived_at: null,
        patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/42" } },
        recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/7" } } }, { status: 201 });
    }
    assert.equal(init?.method, "GET");
    return Response.json({ total_entries: 1, recalls: [recall("91", notes)] });
  };
  const created = ClinikoRecallWriter.create(config, fetchPort);
  assert.ok(created.ok);
  const request = { scope, patientId: "42", recallTypeId: "7", recallAt: "2026-10-01", marker, summary };
  const sent = await created.value.openOnce(request);
  assert.deepEqual(sent, { ok: true, value: { kind: "accepted", recallRef: "cliniko:recall:91" } });
  assert.equal(JSON.stringify(sent).includes(summary), false);
  const observed = value(await created.value.observe(request));
  assert.equal(observed.kind, "one");
  assert.equal(JSON.stringify(observed).includes(summary), false);
  assert.deepEqual(observed, { kind: "one", scope, recallRef: "cliniko:recall:91", recalled: false,
    archived: false, observedAt: observed.observedAt });
  assert.equal(value(await created.value.observe({ ...request, summary: "Different request" })).kind, "mismatch");
  assert.equal(value(await created.value.observe({ ...request, recallTypeId: "8" })).kind, "mismatch");
  assert.equal(value(await created.value.observe({ ...request, recallAt: "2026-10-02" })).kind, "mismatch");
  failure(await created.value.openOnce(request), "invalidQuery");
  assert.equal(writes, 1);
});

test("recall observation rejects a changed type or date and cannot authorize another write", async () => {
  let writes = 0;
  const notes = `Abby request ${marker}\nPatient asks staff to call`;
  const adapter = ClinikoRecallWriter.create(config, async (_input, init) => {
    if (init?.method === "POST") { writes += 1; throw new Error("lost response"); }
    return Response.json({ total_entries: 1, recalls: [
      { ...recall("91", notes), recall_at: "2026-10-03" },
    ] });
  });
  assert.ok(adapter.ok);
  const request = { scope, patientId: "42", recallTypeId: "7", recallAt: "2026-10-01", marker,
    summary: "Patient asks staff to call" };
  assert.deepEqual(await adapter.value.openOnce(request), { ok: true, value: { kind: "uncertain" } });
  assert.equal(value(await adapter.value.observe(request)).kind, "mismatch");
  failure(await adapter.value.openOnce(request), "invalidQuery");
  assert.equal(writes, 1);
});

test("a lost or malformed create response stays uncertain and cannot send the marker again", async () => {
  for (const responseKind of ["lost", "malformed", "rateLimited"] as const) {
    let writes = 0;
    const fetchPort: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        writes += 1;
        if (responseKind === "lost") throw new Error("response lost after send");
        if (responseKind === "rateLimited") return new Response(null, { status: 429 });
        return Response.json({ id: "91", notes: "unexpected" }, { status: 201 });
      }
      return Response.json({ total_entries: 0, recalls: [] });
    };
    const created = ClinikoRecallWriter.create(config, fetchPort);
    assert.ok(created.ok);
    const request = { scope, patientId: "42", recallTypeId: "7", recallAt: "2026-10-01", marker,
      summary: "Please contact the patient" };
    assert.deepEqual(await created.value.openOnce(request), { ok: true, value: { kind: "uncertain" } });
    const observed = await created.value.observe(request);
    if (responseKind === "rateLimited") failure(observed, "rateLimited");
    else assert.equal(value(observed).kind, "none");
    failure(await created.value.openOnce(request), "invalidQuery");
    assert.equal(writes, 1);
  }
});

test("invalid recall scope and fields fail before a provider write", async () => {
  let writes = 0;
  const created = ClinikoRecallWriter.create(config, async () => { writes += 1; throw new Error("unexpected send"); });
  assert.ok(created.ok);
  const request = { scope, patientId: "42", recallTypeId: "7", recallAt: "2026-10-01", marker,
    summary: "Please contact the patient" };
  failure(await created.value.openOnce({ ...request, scope: { ...scope, clinicId: "other" } }), "scopeMismatch");
  failure(await created.value.openOnce({ ...request, patientId: "patient name" }), "invalidQuery");
  failure(await created.value.openOnce({ ...request, patientId: 42 as unknown as string }), "invalidQuery");
  failure(await created.value.openOnce({ ...request, recallAt: "2026-02-30" }), "invalidQuery");
  failure(await created.value.openOnce({ ...request, marker: "patient name" }), "invalidQuery");
  failure(await created.value.openOnce({ ...request, summary: "" }), "invalidQuery");
  failure(await created.value.observe({ ...request, recallAt: "2026-02-30" }), "invalidQuery");
  assert.equal(writes, 0);
});

test("lookup scans all pages before declaring a miss or unique match", async () => {
  const pages: number[] = [];
  const fetchPort: typeof fetch = async input => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    pages.push(page);
    return Response.json({ total_entries: 101, recalls: page === 1
      ? Array.from({ length: 100 }, (_, index) => recall(String(index + 1), "other"))
      : [recall("101")] });
  };
  const result = value(await reader(fetchPort).findByMarker(scope, "42", marker));
  assert.equal(result.kind, "one");
  assert.deepEqual(pages, [1, 2]);

  const empty = reader(async () => Response.json({ total_entries: 0, recalls: [] }));
  assert.deepEqual(value(await empty.findByMarker(scope, "42", marker)), { kind: "none", scope, observedAt });
});

test("duplicate exact markers are ambiguous and archived reads use an explicit filter", async () => {
  const duplicate = reader(async () => Response.json({ total_entries: 2, recalls: [recall("1"), recall("2")] }));
  assert.equal(value(await duplicate.findByMarker(scope, "42", marker)).kind, "ambiguous");
  const mixed = reader(async () => Response.json({ total_entries: 2,
    recalls: [recall("1"), recall("2", `Abby request ${marker}\nDifferent request`)] }));
  assert.equal(value(await mixed.findByMarker(scope, "42", marker)).kind, "ambiguous");
  const archivedReader = reader(async input => {
    assert.deepEqual(new URL(String(input)).searchParams.getAll("q[]"), ["patient_id:=42", "archived_at:*"]);
    return Response.json({ total_entries: 1, recalls: [recall("2", marker, "42", observedAt)] });
  });
  assert.deepEqual(value(await archivedReader.findByMarker(scope, "42", marker, true)),
    { kind: "one", scope, observedAt, recallRef: "cliniko:recall:2", recalled: false, archived: true });
});

test("scope, marker, patient, and provider filter drift fail closed", async () => {
  let requests = 0;
  const fetchPort: typeof fetch = async () => {
    requests += 1;
    return Response.json({ total_entries: 1, recalls: [recall("1", marker, "43")] });
  };
  const adapter = reader(fetchPort);
  failure(await adapter.findByMarker({ ...scope, clinicId: "other" }, "42", marker), "scopeMismatch");
  failure(await adapter.findByMarker(scope, "42", "patient name"), "invalidQuery");
  failure(await adapter.findByMarker(scope, "42 OR 1=1", marker), "invalidQuery");
  assert.equal(requests, 0);
  failure(await adapter.findByMarker(scope, "42", marker), "malformed");
});

test("incomplete, inconsistent, duplicate, and oversized pages fail closed", async () => {
  for (const body of [
    { total_entries: 1, recalls: [] },
    { total_entries: 2, recalls: [recall("1"), recall("1")] },
    { total_entries: 2, recalls: [recall("2"), recall("1")] },
    { total_entries: 501, recalls: [] },
    { total_entries: 1, recalls: [recall("1", marker, "42", observedAt)] },
  ]) {
    const kind = body.total_entries > 500 ? "tooManyResults" : "malformed";
    failure(await reader(async () => Response.json(body)).findByMarker(scope, "42", marker), kind);
  }
  failure(await reader(async () => Response.json({ total_entries: 1, recalls: [recall("1", "x".repeat(1_000_000))] }))
    .findByMarker(scope, "42", marker), "tooManyResults");
});

test("provider and shared-budget failures are typed and no write is sent", async () => {
  for (const [status, kind] of [[403, "forbidden"], [404, "unavailable"], [429, "rateLimited"],
    [503, "unavailable"]] as const) {
    failure(await reader(async (_input, init) => {
      assert.equal(init?.method, "GET");
      return new Response(null, { status });
    }).findByMarker(scope, "42", marker), kind);
  }
  failure(await reader(async () => { throw new Error("transport"); }).findByMarker(scope, "42", marker), "unavailable");
  const limited = reader(async () => { throw new Error("should not fetch"); }, new ClinikoReadBudget(1));
  failure(await limited.findByMarker(scope, "42", marker), "unavailable");
  failure(await limited.findByMarker(scope, "42", marker), "rateLimited");
});
