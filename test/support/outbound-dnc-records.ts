import assert from "node:assert/strict";
import { ClinikoOutboundDncRecords, outboundDncRecordBinding } from "../../src/cliniko/outbound-dnc-records.ts";
import type { OutboundDncRecordQuery } from "../../src/cliniko/outbound-dnc-records.ts";
import { decodeOutboundContactReview } from "../../src/cliniko/outbound-contact-review.ts";
import { outboundContactSourceFixture } from "./outbound-contact-source.ts";
import { ClinikoOutboundContactSource } from "../../src/cliniko/outbound-contact-source.ts";
import type { OutboundEffectBarrier } from "../../src/core/outbound-effect-barrier.ts";
import type { LocationScope } from "../../src/core/model.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import { value } from "./outbound-records.ts";

export async function outboundDncRecordFixture(options: { Records?: typeof ClinikoOutboundDncRecords; apiKey?: string; scope?: LocationScope;
  budget?: ClinikoRequestBudget; barrierFactory?: (scope: LocationScope, owner: string) => OutboundEffectBarrier } = {}) {
  const f = await outboundContactSourceFixture(options), Records = options.Records ?? ClinikoOutboundDncRecords;
  const config = { source: options.budget ? { ...f.config, rateBudget: options.budget } : f.config, automationPrincipalRef: "clinic-approved-optout-automation" };
  const review = f.next(f.first, { reviewerRef: config.automationPrincipalRef, consent: "unknown", doNotCall: "blocked",
    reviewedAt: f.state.now, effectiveFrom: f.state.now });
  const controls: { allow: boolean; producer: boolean; current: boolean;
    onAllow?: (query: OutboundDncRecordQuery) => void | Promise<void>;
    response?: (row: Record<string, unknown>) => Response | Promise<Response> } = { allow: true, producer: true, current: true };
  const queries: OutboundDncRecordQuery[] = [], burned = new Set<string>(), calls: { method: string; url: URL }[] = [];
  const owner = outboundDncRecordBinding(config)!;
  const barrier = options.barrierFactory?.(config.source.scope, owner) ?? { matches: (scope: typeof f.config.scope, binding: string) => binding === owner && JSON.stringify(scope) === JSON.stringify(f.config.scope),
    claimOnce: async (ref: string) => { const claimed = !burned.has(ref); burned.add(ref); return { ok: true as const, value: { claimed } }; } };
  const authority = { allows: async (q: OutboundDncRecordQuery) => { queries.push(q); await controls.onAllow?.(q); return controls.allow; },
    current: () => f.state.live && controls.current, producerAdmitted: async () => controls.producer };
  const port: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push({ method: init?.method ?? "GET", url });
    assert.equal(url.origin, "https://api.au5.cliniko.com"); assert.equal(init?.redirect, "error");
    if (init?.method !== "POST") return f.port(input, init);
    assert.equal(url.pathname, "/v1/recalls"); assert.equal(url.search, "");
    const payload = JSON.parse(String(init.body)); assert.deepEqual(Object.keys(payload).sort(), ["notes", "patient_id", "recall_at", "recall_type_id", "recalled"]);
    const decision = value(decodeOutboundContactReview(payload.notes));
    assert.equal(payload.patient_id, decision.patientId); assert.equal(payload.recall_type_id, f.config.contactReviewRecallTypeId); assert.equal(payload.recalled, false);
    const row = { ...f.row(decision, "102"), recall_at: payload.recall_at, created_at: f.state.now, updated_at: f.state.now };
    f.controls.rows.push(row);
    return controls.response ? controls.response(row) : Response.json(row, { status: 201 });
  };
  const make = () => Records.create(config, f.definition, authority, barrier, port);
  const records = value(make());
  return { ...f, config, review, dncControls: controls, dncQueries: queries, dncCalls: calls, burned, barrier, dncAuthority: authority, dncPort: port, records, make,
    read: (signal = new AbortController().signal) => value(ClinikoOutboundContactSource.create(config.source, f.definition, f.authority, port)).readCurrentForRequest(f.request, signal),
    retain: (signal = new AbortController().signal) => records.retainDecisionOnce(review, "2026-11-02", signal) };
}
