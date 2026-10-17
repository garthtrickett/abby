import assert from "node:assert/strict";
import { fixture, value, base } from "./financial-retention.ts";
import { ClinikoFinancialPendingDiscovery } from "../../src/cliniko/financial-pending-discovery.ts";
import type { FinancialPendingAuthority, FinancialPendingAccountQuery } from "../../src/cliniko/financial-pending-discovery.ts";

type Row = Record<string, unknown>;
export function pendingFinancialFixture(options: { native?: Parameters<typeof fixture>[0];
  list?: (body: { recalls: Row[]; total_entries: number }, url: URL) => Response | Promise<Response> } = {}) {
  const f = fixture(options.native); f.seedIntent(); f.rows.get("30")!.recalled_at = null;
  let account = true, record = true, live = true;
  const calls: URL[] = [], grants: FinancialPendingAccountQuery[] = [];
  const authority: FinancialPendingAuthority = { allowsPendingRead: async q => { grants.push(q); return account; },
    allowsRecordRead: async () => record, current: () => live };
  const port: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url); assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    assert.equal(new Headers(init.headers).get("Authorization"), `Basic ${Buffer.from(f.config.apiKey + ":").toString("base64")}`);
    if (url.pathname !== "/v1/recalls") return f.port(input, init);
    assert.deepEqual(url.searchParams.getAll("q[]"), ["recalled_at:!?", "archived_at:!?"]);
    assert.equal(url.searchParams.get("per_page"), "100"); assert.equal(url.searchParams.get("sort"), "id:asc");
    const pending = [...f.rows.values()].filter(r => r.recalled_at === null && r.archived_at === null).sort((a, b) => Number(a.id) - Number(b.id));
    const page = Number(url.searchParams.get("page"));
    const body = { recalls: structuredClone(pending.slice((page - 1) * 100, page * 100)), total_entries: pending.length };
    return options.list ? options.list(body, url) : Response.json(body);
  };
  const scanner = value(ClinikoFinancialPendingDiscovery.create(f.config, authority, port));
  const row = (id: number, financial = false): Row => ({ ...structuredClone(f.rows.get("30")!), id: String(id), links: { self: `${base}/recalls/${id}` },
    ...(financial ? {} : { recall_type: { links: { self: `${base}/recall_types/55` } }, notes: "unrelated-private-note-canary" }) });
  return { ...f, calls, grants, authority, port, scanner, row,
    scan: (signal = new AbortController().signal) => scanner.scanPending(signal),
    denyAccount: () => { account = false; }, denyRecord: () => { record = false; }, expirePending: () => { live = false; } };
}
