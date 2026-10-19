import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { outboundContactAccountFixture } from "./outbound-contact-account.ts";
import { value } from "./outbound-records.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import { ClinikoOutboundNumberStops } from "../../src/standalone/cliniko-outbound-number-stops.ts";
import type { OutboundNumberStopQuery } from "../../src/standalone/cliniko-outbound-number-stops.ts";
import { encodeOutboundContactReview } from "../../src/cliniko/outbound-contact-review.ts";
import type { OutboundContactReview } from "../../src/cliniko/outbound-contact-review.ts";
export async function outboundNumberStopsFixture(options: Parameters<typeof outboundContactAccountFixture>[0] & {
  Reader?: typeof ClinikoOutboundNumberStops; budget?: ClinikoRequestBudget;
} = {}) {
  const f = await outboundContactAccountFixture(options); try {
    const first = f.first, second = f.second, base = "https://api.au5.cliniko.com/v1", secondary = { ...second.first, patientId: "22" };
    const state: { live: boolean; claims: number; rows: Record<string, unknown>[]; allow?: (q: OutboundNumberStopQuery) => boolean | Promise<boolean>;
      page?: (rows: Record<string, unknown>[], page: number) => Response | Promise<Response>; get?: (row: Record<string, unknown>) => Response | Promise<Response> } = {
      live: true, claims: 0, rows: [first.row(first.first, "101"), second.row(secondary, "201")] };
    const budget = options.budget ?? new ClinikoReadBudget(180, () => Date.parse(first.state.now));
    const physical = { claim: () => { state.claims++; return budget.claim(); }, observe429: budget.observe429.bind(budget),
      ...(budget.checkHeadroom ? { checkHeadroom: budget.checkHeadroom.bind(budget) } : {}) };
    const requests = { scope: first.request.scope, apiKey: first.config.apiKey, contactEmail: first.config.contactEmail, businessId: first.config.businessId,
      outboundRecallTypeId: "61", recordPolicyDigest: "d".repeat(64), rateBudget: physical, clock: () => first.state.now };
    const config = { requests, source: f.approval.account.sources[0]!, account: f.owner, maximumNativeRequests: 70 };
    const queries: OutboundNumberStopQuery[] = [], calls: URL[] = [];
    const authority = { allows: async (q: OutboundNumberStopQuery) => { queries.push(q); return state.allow ? state.allow(q) : true; }, current: () => state.live };
    const native: typeof fetch = async (input, init) => {
      const url = new URL(String(input)); calls.push(url); assert.equal(url.origin, "https://api.au5.cliniko.com"); assert.equal(init?.method, "GET"); assert.ok(init); assert.equal(init.redirect, "error");
      assert.equal(new Headers(init.headers).get("Authorization"), `Basic ${Buffer.from(`${requests.apiKey}:`).toString("base64")}`); assert.equal(init.body, undefined);
      assert.deepEqual(url.searchParams.getAll("q[]"), ["archived_at:*"]);
      if (url.pathname === "/v1/recalls") {
        assert.equal(url.searchParams.get("sort"), "id:asc"); assert.equal(url.searchParams.get("per_page"), "100"); const page = Number(url.searchParams.get("page"));
        const rows = [...state.rows].sort((a, b) => Number(a.id) - Number(b.id)).slice((page - 1) * 100, page * 100);
        return state.page ? state.page(rows, page) : Response.json({ recalls: rows, total_entries: state.rows.length });
      }
      const row = state.rows.find(r => url.pathname === `/v1/recalls/${r.id}`); assert.ok(row);
      return state.get ? state.get(row) : Response.json(row);
    };
    const make = () => (options.Reader ?? ClinikoOutboundNumberStops).create(config, authority, native), reader = value(make());
    const append = (review: OutboundContactReview, id: string) => { const row = { ...first.row(review, id), created_at: review.reviewedAt, updated_at: review.reviewedAt }; state.rows.push(row); return row; };
    const stopOther = () => { const review = second.next(secondary, { consent: "unknown", doNotCall: "blocked", reviewedAt: first.state.now, effectiveFrom: first.state.now });
      append(review, "202"); return review; };
    const clearOther = (stop: OutboundContactReview, changes: Partial<OutboundContactReview> = {}) => {
      const review = second.next(stop, { reviewerRef: "clinic-approved-human", consent: "granted", doNotCall: "clear", reconsentApprovalRef: randomUUID(),
        reviewedAt: first.state.now, effectiveFrom: first.state.now, ...changes }); append(review, "203"); return review;
    };
    return { ...f, state, config, authority, queries, calls, reader, make, budget, append, stopOther, clearOther, secondary,
      read: (signal = new AbortController().signal) => reader.readForRequest(first.request, signal),
      note: (review: OutboundContactReview) => value(encodeOutboundContactReview(review)) };
  } catch (error) { await f.close(); throw error; }
}
