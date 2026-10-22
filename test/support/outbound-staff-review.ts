import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { outboundContactOutcomeValue } from "./outbound-contact-outcome.ts";
import { value } from "./outbound-records.ts";
import { outboundStaffReviewActionRef } from "../../src/cliniko/outbound-staff-review-request.ts";
import type { OutboundStaffReviewRequest } from "../../src/cliniko/outbound-staff-review-request.ts";
import { ClinikoOutboundStaffReviewRecords, outboundStaffReviewRecordBinding } from "../../src/cliniko/outbound-staff-review-records.ts";
import type { OutboundStaffReviewQuery, OutboundStaffReviewConfig, OutboundStaffReviewWriteAuthority } from "../../src/cliniko/outbound-staff-review-records.ts";
import { ClinikoOutboundStaffReviewHistory } from "../../src/cliniko/outbound-staff-review-history.ts";
import type { OutboundStaffReviewHistoryAuthority, OutboundStaffReviewHistoryQuery } from "../../src/cliniko/outbound-staff-review-history.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";

export function outboundStaffReviewValue(fingerprint?: string) {
  const { possible, outcome } = outboundContactOutcomeValue(fingerprint);
  const request: OutboundStaffReviewRequest = {
    actionRef: outboundStaffReviewActionRef(possible.attempt.actionRef)!, scope: possible.attempt.scope,
    businessId: possible.attempt.businessId, credentialFingerprint: possible.attempt.credentialFingerprint, patientId: possible.attempt.patientId,
    attempt: outcome.attempt, notification: { recallRef: "cliniko:recall:301", actionRef: randomUUID(), digest: "a".repeat(64) },
    state: "needsClinicReview", reason: "contactCoverageUnresolved", recordedAt: outcome.recordedAt
  };
  return { possible, request };
}
export function outboundStaffReviewFixture(options: { deadlineMs?: number } = {}) {
  const apiKey = "synthetic-staff-review-au5", { possible, request } = outboundStaffReviewValue(clinikoCredentialFingerprint(apiKey));
  const state: { now: string; live: boolean; allowed: boolean; producer: boolean; decoded: boolean; historyAllowed: boolean; claims: number;
    response?: (row: Record<string, unknown>, method: string) => Response | Promise<Response>;
    page?: (rows: Record<string, unknown>[], page: number) => Response | Promise<Response> } = {
    now: request.recordedAt, live: true, allowed: true, producer: true, decoded: true, historyAllowed: true, claims: 0
  };
  const config: OutboundStaffReviewConfig = { scope: request.scope, businessId: request.businessId, apiKey, contactEmail: "clinic@example.invalid",
    outboundStaffReviewRecallTypeId: "75", staffReviewPolicyDigest: "d".repeat(64), clock: () => state.now,
    rateBudget: { claim: async () => { state.claims++; return null; }, observe429: async () => ({ kind: "rateLimited" }) }, ...options };
  const owner = outboundStaffReviewRecordBinding(config)!, burned = new Set<string>(), rows = new Map<string, Record<string, unknown>>();
  const calls: { method: string; path: string }[] = [], queries: OutboundStaffReviewQuery[] = [];
  const authority: OutboundStaffReviewWriteAuthority = {
    allows: async q => { queries.push(q); return state.allowed && (!q.request || state.decoded); },
    current: () => state.live, producerAdmitted: async () => state.producer
  };
  const historyQueries: OutboundStaffReviewHistoryQuery[] = [];
  const historyAuthority: OutboundStaffReviewHistoryAuthority = {
    allowsHistoryRead: async q => { historyQueries.push(q); return state.historyAllowed; },
    allowsRecordRead: authority.allows, current: authority.current
  };
  const effects = { matches: (scope: typeof request.scope, binding: string) => JSON.stringify(scope) === JSON.stringify(config.scope) && binding === owner,
    claimOnce: async (ref: string) => { const claimed = !burned.has(ref); burned.add(ref); return { ok: true as const, value: { claimed } }; } };
  const base = "https://api.au5.cliniko.com/v1";
  const port: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    assert.equal(url.origin, "https://api.au5.cliniko.com"); assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`);
    calls.push({ method, path: url.pathname }); let row: Record<string, unknown>;
    if (method === "GET" && url.pathname === "/v1/recalls") {
      assert.deepEqual(url.searchParams.getAll("q[]"), ["archived_at:*"]);
      const page = Number(url.searchParams.get("page")), all = [...rows.values()].sort((a, b) => Number(a.id) - Number(b.id));
      const selected = all.slice((page - 1) * 100, page * 100);
      return state.page ? state.page(selected, page) : Response.json({ recalls: selected, total_entries: all.length });
    }
    if (method === "POST") {
      assert.equal(url.pathname, "/v1/recalls"); const body = JSON.parse(String(init?.body));
      assert.deepEqual(Object.keys(body).sort(), ["notes", "patient_id", "recall_at", "recall_type_id", "recalled"]);
      assert.equal(body.recall_type_id, config.outboundStaffReviewRecallTypeId); const id = String(400 + rows.size);
      row = { id, links: { self: `${base}/recalls/${id}` }, patient: { links: { self: `${base}/patients/${body.patient_id}` } },
        recall_type: { links: { self: `${base}/recall_types/${body.recall_type_id}` } }, notes: body.notes, recall_at: body.recall_at,
        recalled: false, recalled_at: null, archived_at: null, created_at: state.now, updated_at: state.now };
      rows.set(id, row);
    } else {
      assert.equal(method, "GET"); assert.deepEqual(url.searchParams.getAll("q[]"), ["archived_at:*"]);
      row = rows.get(url.pathname.split("/").at(-1)!)!; assert.ok(row);
    }
    return state.response ? state.response(row, method) : Response.json(row, { status: method === "POST" ? 201 : 200 });
  };
  const make = () => ClinikoOutboundStaffReviewRecords.create(config, authority, effects, port), records = value(make());
  const history = () => value(ClinikoOutboundStaffReviewHistory.create(config, historyAuthority, port));
  return { possible, request, config, owner, effects, authority, port, make, records, state, rows, calls, burned, queries, history, historyAuthority, historyQueries,
    find: (signal = new AbortController().signal) => history().findForAttempt(possible, signal),
    retain: (signal = new AbortController().signal) => records.retainRequestOnce(request, possible.recallAt, signal) };
}
