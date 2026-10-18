import assert from "node:assert/strict";
import { ClinikoOutboundLaunchHistory } from "../../src/cliniko/outbound-launch-history.ts";
import type { OutboundLaunchHistoryAuthority, OutboundLaunchHistoryQuery } from "../../src/cliniko/outbound-launch-history.ts";
import type { OutboundLaunchRecordQuery } from "../../src/cliniko/outbound-launch-records.ts";
import { outboundLaunchFixture } from "./outbound-launch.ts";
import { value } from "./outbound-records.ts";
export async function outboundLaunchHistoryFixture(options: { deadlineMs?: number; request?: import("../../src/cliniko/outbound-recipient-request.ts").OutboundRecipientRequest } = {}) {
  const f = await outboundLaunchFixture(options); value(await f.retain()); f.calls.length = 0;
  let accountAllowed = true, recordAllowed = true, live = true;
  const accountQueries: OutboundLaunchHistoryQuery[] = [], recordQueries: OutboundLaunchRecordQuery[] = [];
  const native = structuredClone([...f.rows.values()]), calls: { method: string; url: URL }[] = [];
  const controls: { rows: Record<string, unknown>[]; total?: number; page?: (rows: Record<string, unknown>[], page: number) => Response | Promise<Response>;
    get?: (row: Record<string, unknown>) => Response | Promise<Response> } = { rows: native };
  const authority: OutboundLaunchHistoryAuthority = { allowsHistoryRead: async q => { accountQueries.push(q); return accountAllowed; },
    allowsRecordRead: async q => { recordQueries.push(q); return recordAllowed; }, current: () => live };
  const port: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, "https://api.au5.cliniko.com"); assert.equal(init?.method, "GET");
    assert.equal(init.redirect, "error"); assert.equal(new Headers(init.headers).get("Authorization"), `Basic ${Buffer.from(`${f.config.apiKey}:`).toString("base64")}`);
    assert.equal(init.body, undefined); calls.push({ method: init.method, url });
    if (url.pathname === "/v1/recalls") {
      assert.equal(url.searchParams.get("per_page"), "100"); assert.equal(url.searchParams.get("sort"), "id:asc");
      assert.deepEqual(url.searchParams.getAll("q[]"), [`patient_id:=${f.attempt.patientId}`, "archived_at:*"]);
      assert.deepEqual([...url.searchParams.keys()].sort(), ["page", "per_page", "q[]", "q[]", "sort"]);
      const page = Number(url.searchParams.get("page")), rows = controls.rows.slice((page-1)*100,page*100);
      return controls.page ? controls.page(rows,page) : Response.json({ recalls: rows, total_entries: controls.total ?? controls.rows.length });
    }
    const row = f.rows.get(url.pathname.split("/").at(-1)!)!;
    return controls.get ? controls.get(row) : Response.json(row);
  };
  const request = f.request;
  const make = () => ClinikoOutboundLaunchHistory.create(f.config, authority, port);
  return { f, request, authority, controls, calls, accountQueries, recordQueries, port, make,
    scan: (signal = new AbortController().signal) => value(make()).readForRequest({recallRef:f.attempt.requestRecallRef,request},signal),
    denyAccount: () => { accountAllowed = false; }, denyRecord: () => { recordAllowed = false; }, retire: () => { live = false; } };
}
