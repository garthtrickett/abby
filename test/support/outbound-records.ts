import type { OutboundRecipientRequest } from "../../src/cliniko/outbound-recipient-request.ts";
import assert from "node:assert/strict";
import { outboundRequestValue } from "./outbound-recipient-request.ts";
import { ClinikoOutboundRecipientRecords, outboundRecordOwnerBinding } from "../../src/cliniko/outbound-recipient-records.ts";
import type { OutboundRecordConfig, OutboundRecordAuthority, OutboundRecordQuery } from "../../src/cliniko/outbound-recipient-records.ts";
import type { OutboundEffectBarrier } from "../../src/core/outbound-effect-barrier.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
export function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T { assert.ok(r.ok, JSON.stringify(r)); return r.value; }
export const outboundNow = "2026-11-01T10:00:00.000Z", outboundReviewDate = "2026-11-02";
export async function outboundRecordsFixture(options: {
  request?: OutboundRecipientRequest;
  response?(row: Record<string, unknown>, method: string): Response | Promise<Response>;
  authority?: Partial<OutboundRecordAuthority>; deadlineMs?: number;
  barrierFactory?(config: OutboundRecordConfig): OutboundEffectBarrier;
} = {}) {
  let now = outboundNow, allowed = true, producer = true, live = true, claims = 0, next = 30;
  const apiKey = "synthetic-outbound-au5", original = options.request ?? outboundRequestValue(), request = { ...original, credentialFingerprint: clinikoCredentialFingerprint(apiKey) };
  const rows = new Map<string, Record<string, unknown>>(), burned = new Set<string>(), queries: OutboundRecordQuery[] = [], calls: { method: string; path: string }[] = [];
  const config: OutboundRecordConfig = { scope: request.scope, apiKey, contactEmail: "clinic@example.invalid", businessId: request.businessId,
    outboundRecallTypeId: "61", recordPolicyDigest: "d".repeat(64), clock: () => now, ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    rateBudget: { claim: async () => { claims++; return null; }, observe429: async () => ({ kind: "rateLimited" }) } };
  const binding = outboundRecordOwnerBinding(config)!;
  const barrier: OutboundEffectBarrier = options.barrierFactory?.(config) ?? {
    matches: (scope, owner) => JSON.stringify(scope) === JSON.stringify(config.scope) && owner === binding,
    claimOnce: async ref => { const claimed = !burned.has(ref); burned.add(ref); return { ok: true, value: { claimed } }; },
  };
  const authority: OutboundRecordAuthority = { allows: async q => { queries.push(q); return allowed; },
    producerAdmitted: async () => producer, current: () => live, ...options.authority };
  const base = "https://api.au5.cliniko.com/v1";
  const port: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    assert.equal(url.origin, "https://api.au5.cliniko.com"); assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`);
    calls.push({ method, path: url.pathname }); let row: Record<string, unknown>;
    if (method === "POST") {
      assert.equal(url.pathname, "/v1/recalls"); const body = JSON.parse(String(init?.body));
      assert.deepEqual(Object.keys(body).sort(), ["notes", "patient_id", "recall_at", "recall_type_id", "recalled"]);
      assert.equal(body.recall_type_id, config.outboundRecallTypeId);
      const id = String(next++); row = { id, links: { self: `${base}/recalls/${id}` }, patient: { links: { self: `${base}/patients/${body.patient_id}` } },
        recall_type: { links: { self: `${base}/recall_types/${body.recall_type_id}` } }, notes: body.notes, recall_at: body.recall_at,
        recalled: false, recalled_at: null, archived_at: null, created_at: now, updated_at: now, private_unknown: "discard-native-outbound-private" };
      rows.set(id, row);
    } else { assert.equal(method, "GET");assert.deepEqual(url.searchParams.getAll("q[]"),["archived_at:*"]);assert.deepEqual([...url.searchParams.keys()],["q[]"]); row = rows.get(url.pathname.split("/").at(-1)!)!; }
    return options.response ? options.response(row, method) : Response.json(row, { status: method === "POST" ? 201 : 200 });
  };
  const make = () => ClinikoOutboundRecipientRecords.create(config, authority, barrier, port), records = value(make());
  return { request, config, binding, barrier, records, rows, burned, queries, calls, port, authority, make, get claims() { return claims; },
    deny: () => { allowed = false; }, denyProducer: () => { producer = false; }, retire: () => { live = false; }, setNow: (at: string) => { now = at; },
    retain: (signal = new AbortController().signal) => records.retainRequestOnce(request, outboundReviewDate, signal) };
}
