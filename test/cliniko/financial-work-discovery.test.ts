import assert from "node:assert/strict";
import test from "node:test";
import { encodeClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import { ClinikoFinancialWorkDiscovery } from "../../src/cliniko/financial-work-discovery.ts";
import type { FinancialDiscoveryAuthority } from "../../src/cliniko/financial-work-discovery.ts";
import { fixture, value, observation, now, base, stop, uuid } from "../support/financial-retention.ts";

const window = { createdFrom: "2026-11-01T09:30:00.000Z", createdThrough: now };
type Row = Record<string, unknown>;
function setup(options: { rows?: (source: Row) => Row[]; page?: (rows: Row[], page: number) => unknown; authority?: Partial<FinancialDiscoveryAuthority>;
  response?: (input: string, response: Response) => Response | Promise<Response>; config?: Parameters<typeof fixture>[0] } = {}) {
  const f = fixture(options.config); f.seedIntent();
  const source = f.rows.get("30")!;
  const obs: Row = { ...source, id: "31", links: { self: `${base}/recalls/31` }, notes: observation(f.intent) };
  f.rows.set("31", obs);
  const rows = options.rows?.(source) ?? [source, obs], requests: string[] = [], grants: unknown[] = [];
  let allowed = true, current = true;
  const authority: FinancialDiscoveryAuthority = {
    allowsAccountRead: async q => { grants.push(q); return allowed; },
    allowsRecordRead: async q => { grants.push(q); return allowed; }, current: () => current, ...options.authority,
  };
  const port: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); requests.push(String(input)); assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Basic ${Buffer.from(`${f.config.apiKey}:`).toString("base64")}`);
    let response: Response;
    if (url.pathname === "/v1/recalls") {
      assert.deepEqual(url.searchParams.getAll("q[]"), [`created_at:>=${window.createdFrom}`, `created_at:<=${window.createdThrough}`, "archived_at:*"]);
      assert.equal(url.searchParams.get("sort"), "id:asc"); assert.equal(url.searchParams.get("per_page"), "100");
      const page = Number(url.searchParams.get("page"));
      response = Response.json(options.page?.(rows, page) ?? { total_entries: rows.length, recalls: rows.slice((page - 1) * 100, page * 100) });
    } else {
      assert.deepEqual(url.searchParams.getAll("q[]"), ["archived_at:*"]);
      const row = f.rows.get(url.pathname.split("/").at(-1)!);
      response = row ? Response.json(row) : new Response(null, { status: 404 });
    }
    return options.response ? options.response(String(input), response) : response;
  };
  const scanner = value(ClinikoFinancialWorkDiscovery.create(f.config, authority, port));
  return { ...f, scanner, rows, obs, source, requests, grants, deny: () => { allowed = false; }, withdraw: () => { current = false; } };
}
test("discovers private exact pair; filters unrelated type without exposing raw rows", async () => {
  const f = setup({ rows: s => [{ ...s, recall_type: { links: { self: `${base}/recall_types/41` } }, notes: "foreign-note-secret" },
    { ...s, id: "31", links: { self: `${base}/recalls/31` }, notes: observation() }] });
  const result = value(await f.scanner.scan(window, stop()));
  assert.equal(result.scanned, 2); assert.equal(result.work.length, 1); assert.equal(result.work[0]?.kind, "pairedContext");
  assert.equal(f.requests.length, 2); assert.ok(!JSON.stringify(result).includes("foreign-note-secret"));
  assert.ok(f.grants.some(q => (q as { purpose?: string }).purpose === "sourceIntent"));
});
test("resolves an archived intent outside window using separately authorized exact lookup", async () => {
  const f = setup({ rows: s => [{ ...s, id: "31", links: { self: `${base}/recalls/31` }, notes: observation() }] });
  f.source.created_at = "2026-11-01T09:00:00.000Z"; f.source.archived_at = now;
  const work = value(await f.scanner.scan(window, stop())).work;
  assert.equal(work[0]?.kind, "pairedContext"); assert.equal(work[0]?.intent.archivedAt, now);
});
test("unpaired intent is context, never missing acknowledgement or payment permission", async () => {
  const f = setup({ rows: s => [s] });
  const work = value(await f.scanner.scan(window, stop())).work;
  assert.equal(work[0]?.kind, "intentContext"); assert.equal(f.requests.length, 2);
});
test("complete empty window remains bounded context", async () => {
  const f = setup({ rows: () => [] }); assert.deepEqual(value(await f.scanner.scan(window, stop())).work, []); assert.equal(f.requests.length, 1);
});
for (const [name, mutate] of Object.entries({
  "duplicate ID": (rows: Row[]) => { rows[1]!.id = "30"; },
  "wrong self": (rows: Row[]) => { rows[1]!.links = { self: "https://evil.invalid/recalls/31" }; },
  "wrong native patient": (rows: Row[]) => { rows[1]!.patient = { links: { self: `${base}/patients/22` } }; },
  "unknown selected financial schema": (rows: Row[]) => { rows[1]!.notes = "unrecognized finance record"; },
  "tampered signature": (rows: Row[]) => { rows[1]!.notes = String(rows[1]!.notes).replace("cliniko:appointment:91", "cliniko:appointment:92"); },
  "outside created window": (rows: Row[]) => { rows[1]!.created_at = "2026-11-01T08:00:00.000Z"; },
  "future update": (rows: Row[]) => { rows[1]!.updated_at = "2026-11-02T10:00:00.000Z"; },
  "malformed archive": (rows: Row[]) => { rows[1]!.archived_at = "bad"; },
})) test(`refuses entire window: ${name}`, async () => {
  const f = setup(); mutate(f.rows); assert.equal((await f.scanner.scan(window, stop())).ok, false);
});
for (const [name, authority] of Object.entries({
  "no account grant": { allowsAccountRead: async () => false },
  "no exact record grant": { allowsRecordRead: async () => false },
  "no current grant": { current: () => false },
  "no out-of-window source grant": { allowsRecordRead: async (q: { purpose: string }) => q.purpose !== "sourceIntent" },
})) test(`refuses ${name}`, async () => {
  const f = setup({ authority, rows: s => [{ ...s, id: "31", links: { self: `${base}/recalls/31` }, notes: observation() }] });
  const result = await f.scanner.scan(window, stop()); assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "forbidden");
});
test("withdrawal during body reading prevents returned contexts", async () => {
  let f: ReturnType<typeof setup>;
  f = setup({ response: async (_url, response) => { f.withdraw(); return response; } });
  const r = await f.scanner.scan(window, stop()); assert.equal(r.ok, false); if (!r.ok) assert.equal(r.error.kind, "forbidden");
});
for (const count of [-1, 501, 2.5]) test(`refuses invalid or over-bound count ${count}`, async () => {
  const f = setup({ page: rows => ({ total_entries: count, recalls: rows }) }); assert.equal((await f.scanner.scan(window, stop())).ok, false);
});
test("refuses incomplete page rather than returning found pair", async () => {
  const f = setup({ page: rows => ({ total_entries: 3, recalls: rows }) }); assert.equal((await f.scanner.scan(window, stop())).ok, false);
});
function foreignRows(source: Row, count: number) {
  return Array.from({ length: count }, (_, i) => ({ ...source, id: String(i + 1), links: { self: `${base}/recalls/${i + 1}` }, recall_type: { links: { self: `${base}/recall_types/41` } } }));
}
test("two complete stable pages use count and sorted IDs, never foreign links", async () => {
  const f = setup({ rows: s => foreignRows(s, 101), page: (rows, page) => ({ total_entries: rows.length, recalls: rows.slice((page-1)*100, page*100), links: { next: "https://evil.invalid" } }) });
  const r = value(await f.scanner.scan(window, stop())); assert.equal(r.scanned, 101); assert.equal(f.requests.length, 2);
});
test("refuses changing total across pages", async () => {
  const f = setup({ rows: s => foreignRows(s, 101), page: (rows, page) => ({ total_entries: page === 1 ? 101 : 102, recalls: rows.slice((page-1)*100, page*100) }) });
  assert.equal((await f.scanner.scan(window, stop())).ok, false);
});
test("refuses duplicate action markers across different native records", async () => {
  const f = setup({ rows: s => [s, { ...s, id: "31", links: { self: `${base}/recalls/31` } }] });
  assert.equal((await f.scanner.scan(window, stop())).ok, false);
});
test("shared budget denial performs no provider request", async () => {
  const f = setup({ config: { config: { rateBudget: { claim: async () => ({ kind: "rateLimited" }), observe429: async () => ({ kind: "rateLimited" }) } } } });
  const r = await f.scanner.scan(window, stop()); assert.equal(r.ok, false); assert.equal(f.requests.length, 0);
});
test("source changes between list and exact reread refuse mixed context", async () => {
  const f = setup({ rows: s => [{ ...s }] }); f.source.notes = String(f.source.notes).replace("5000", "6000");
  assert.equal((await f.scanner.scan(window, stop())).ok, false);
});
test("no source context or source proof mismatch can produce payable work", async () => {
  const f = setup({ rows: s => [{ ...s, id: "31", links: { self: `${base}/recalls/31` }, notes: observation() }] });
  f.source.notes = String(f.source.notes).replace(uuid(2), uuid(9));
  assert.equal((await f.scanner.scan(window, stop())).ok, false);
});
test("whole scan deadline bounds stalled trusted permission", async () => {
  const f = setup({ config: { config: { deadlineMs: 20 } }, authority: { allowsAccountRead: () => new Promise(() => {}) } });
  const result = await f.scanner.scan(window, stop()); assert.equal(result.ok, false); assert.equal(f.requests.length, 0);
});
test("invalid oversized window and ended lifetime perform no I/O", async () => {
  const f = setup(); assert.equal((await f.scanner.scan({ ...window, createdFrom: "2026-10-31T00:00:00.000Z" }, stop())).ok, false);
  const ended = new AbortController(); ended.abort(); assert.equal((await f.scanner.scan(window, ended.signal)).ok, false); assert.equal(f.requests.length, 0);
});

test("late headers after caller abort are cancelled without returning a context", async () => {
  const ended = new AbortController();
  let release!: (r: Response) => void, cancelled = false;
  const f = fixture();
  const scanner = value(ClinikoFinancialWorkDiscovery.create(f.config, {
    allowsAccountRead: async () => true, allowsRecordRead: async () => true, current: () => true,
  }, () => new Promise(resolve => { release = resolve; setImmediate(() => ended.abort()); })));
  assert.equal((await scanner.scan(window, ended.signal)).ok, false);
  release(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, true);
});
test("stalled owned body is cancelled at whole scan deadline", async () => {
  let cancelled = false;
  const f = setup({ config: { config: { deadlineMs: 20 } }, response: () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  assert.equal((await f.scanner.scan(window, stop())).ok, false); assert.equal(cancelled, true);
});
test("malformed JSON and body byte overflow return no partial results", async () => {
  for (const data of ["{bad", "x".repeat(1_000_001)]) {
    const f = setup({ response: () => new Response(data) }); assert.equal((await f.scanner.scan(window, stop())).ok, false);
  }
});
test("provider 429 observes the shared account budget", async () => {
  let observed = false;
  const f = setup({ config: { config: { rateBudget: { claim: async () => null, observe429: async () => { observed = true; return { kind: "rateLimited" }; } } } },
    response: () => new Response(null, { status: 429 }) });
  const result = await f.scanner.scan(window, stop()); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.kind, "rateLimited"); assert.equal(observed, true);
});
test("selected record cap refuses before exact lookups", async () => {
  const f = setup({ rows: s => Array.from({ length: 51 }, (_, i) => ({ ...s, id: String(i + 1), links: { self: `${base}/recalls/${i + 1}` } })) });
  assert.equal((await f.scanner.scan(window, stop())).ok, false); assert.equal(f.requests.length, 1);
});


test("different obligations cannot reuse effect IDs even when action markers differ", async () => {
  const f = setup({ rows: s => [s] });
  const second = { ...f.intent, actionRef: uuid(20), booking: { ...f.intent.booking, actionRef: uuid(21) } };
  const secondRow = { ...f.source, id: "32", links: { self: `${base}/recalls/32` }, notes: value(encodeClinikoFinancialIntent(second)) };
  // Exact GET uses the provider-owned map, not the scan's list.
  const originalPort = f.port;
  const port: typeof fetch = async (input, init) => String(input).includes("/recalls/32?") ? Response.json(secondRow) : originalPort(input, init);
  const scanner = value(ClinikoFinancialWorkDiscovery.create(f.config, {
    allowsAccountRead: async () => true, allowsRecordRead: async () => true, current: () => true,
  }, async (input, init) => {
    if (new URL(String(input)).pathname === "/v1/recalls") return Response.json({ total_entries: 2, recalls: [f.source, secondRow] });
    return port(input, init);
  }));
  assert.equal((await scanner.scan(window, stop())).ok, false);
});
test("foreign financial selection in an otherwise valid native intent refuses", async () => {
  const f = setup({ rows: s => [s] });
  const notes = value(encodeClinikoFinancialIntent({ ...f.intent, businessId: "99" }));
  f.source.notes = notes;
  const r = await f.scanner.scan(window, stop()); assert.equal(r.ok, false); if (!r.ok) assert.equal(r.error.kind, "mismatched");
});
test("native class booking citation remains bound to an attendee target", async () => {
  const f = setup({ rows: s => [{ ...s, id: "31", links: { self: `${base}/recalls/31` }, notes: observation() }] });
  const changed = { ...f.intent, booking: { ...f.intent.booking, kind: "classBook" as const, sessionId: "61" } };
  f.source.notes = value(encodeClinikoFinancialIntent(changed));
  // The unchanged individual citation must not be promoted to class context.
  assert.equal((await f.scanner.scan(window, stop())).ok, false);
});
