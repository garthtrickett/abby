import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";

const scope = { tenantId: "queue-tenant", clinicId: "queue-clinic" };
const base = "https://api.au5.cliniko.com/v1";
const observedAt = "2026-10-01T12:00:00.000Z";
const config = { scope, apiKey: "synthetic-key-au5", contactEmail: "dev@example.test" };

function recall(id: number, typeId = "8", date = "2026-10-01", recalled = false) {
  return { id: String(id), notes: "private-patient-note-canary", recalled, archived_at: null,
    recall_at: date, patient: { links: { self: `${base}/patients/${id + 100}` } },
    recall_type: { links: { self: `${base}/recall_types/${typeId}` } } };
}

function reader(fetchPort: typeof fetch, budget: ClinikoRequestBudget = new ClinikoReadBudget()): ClinikoRecallReader {
  const created = ClinikoRecallReader.create({ ...config, rateBudget: budget }, fetchPort, () => observedAt);
  assert.ok(created.ok);
  return created.value;
}

test("E2E-228 C1 read-only pulse scans every active page and returns only aggregate counts for one type", async () => {
  const requests: URL[] = [];
  const rows = [recall(1, "7", "2026-09-30"), recall(2, "7"),
    recall(3, "7", "2026-09-29", true),
    ...Array.from({ length: 98 }, (_, index) => recall(index + 4))];
  const fetchPort: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.equal(url.origin, "https://api.au5.cliniko.com");
    assert.equal(url.pathname, "/v1/recalls");
    assert.equal(url.searchParams.has("q[]"), false, "Cliniko does not document a recall-type list filter");
    assert.equal(url.searchParams.get("sort"), "id:asc");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("User-Agent"), "Abby (dev@example.test)");
    const page = Number(url.searchParams.get("page"));
    return Response.json({ total_entries: rows.length,
      recalls: rows.slice((page - 1) * 100, page * 100) });
  };
  const result = await reader(fetchPort, new ClinikoReadBudget(2)).queuePulse(scope, "7", "2026-10-01");
  assert.deepEqual(result, { ok: true, value: { scope, observedAt, throughDate: "2026-10-01",
    scanned: 101, pending: 2, overdue: 1, markedRecalled: 1 } });
  assert.deepEqual(requests.map(url => url.searchParams.get("page")), ["1", "2"]);
  assert.equal(JSON.stringify(result).includes("private-patient-note-canary"), false);
  assert.equal(JSON.stringify(result).includes("/patients/"), false);
});

test("C1 pulse rejects foreign scope and invalid type or clinic date before reading", async () => {
  let requests = 0;
  const pulse = reader(async () => { requests += 1; throw new Error("unexpected provider read"); });
  assert.deepEqual(await pulse.queuePulse({ ...scope, clinicId: "other" }, "7", "2026-10-01"),
    { ok: false, error: { kind: "scopeMismatch" } });
  for (const [type, date] of [["0", "2026-10-01"], ["7 OR 1=1", "2026-10-01"],
    ["7", "2026-02-30"]]) {
    assert.deepEqual(await pulse.queuePulse(scope, type!, date!),
      { ok: false, error: { kind: "invalidQuery" } });
  }
  assert.equal(requests, 0);
});

test("C1 pulse refuses incomplete, drifting, duplicate, malformed or oversized account scans", async () => {
  const cases: Array<{ pages: unknown[]; expected: string }> = [
    { pages: [{ total_entries: 2, recalls: [recall(1)] }], expected: "malformed" },
    { pages: [{ total_entries: 101, recalls: Array.from({ length: 100 }, (_, i) => recall(i + 1)) },
      { total_entries: 102, recalls: [recall(101), recall(102)] }], expected: "tooManyResults" },
    { pages: [{ total_entries: 2, recalls: [recall(1), recall(1)] }], expected: "malformed" },
    { pages: [{ total_entries: 1, recalls: [{ ...recall(1), recall_at: "2026-02-30" }] }],
      expected: "malformed" },
    { pages: [{ total_entries: 1, recalls: [{ ...recall(1), archived_at: observedAt }] }],
      expected: "malformed" },
    { pages: [{ total_entries: 501, recalls: [] }], expected: "tooManyResults" },
  ];
  for (const { pages, expected } of cases) {
    const pulse = reader(async input => Response.json(pages[Number(new URL(String(input)).searchParams.get("page")) - 1]));
    assert.deepEqual(await pulse.queuePulse(scope, "7", "2026-10-01"),
      { ok: false, error: { kind: expected } });
  }
});

test("C1 pulse returns no partial queue count on 429, provider failure, or budget denial", async () => {
  for (const response of [new Response(null, { status: 429 }), new Response(null, { status: 503 })]) {
    const pulse = reader(async () => response.clone());
    const result = await pulse.queuePulse(scope, "7", "2026-10-01");
    assert.ok(!result.ok);
    assert.equal(result.error.kind, response.status === 429 ? "rateLimited" : "unavailable");
  }
  let fetches = 0;
  const denied = reader(async () => { fetches += 1; throw new Error("must not fetch"); },
    { claim: () => ({ kind: "unavailable" }), observe429: () => ({ kind: "rateLimited" }) });
  assert.deepEqual(await denied.queuePulse(scope, "7", "2026-10-01"),
    { ok: false, error: { kind: "unavailable" } });
  assert.equal(fetches, 0);
});
