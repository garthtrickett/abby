import assert from "node:assert/strict";
import { ClinikoTwilioOutboundStaffReview } from "../../src/standalone/cliniko-twilio-outbound-staff-review.ts";
import type { TwilioOutboundStaffReviewConfig, TwilioOutboundStaffReviewPorts } from "../../src/standalone/cliniko-twilio-outbound-staff-review.ts";
import { outboundStaffReviewRecordBinding } from "../../src/cliniko/outbound-staff-review-records.ts";
import { twilioTerminalHistoryFixture } from "./twilio-outbound-terminal-history.ts";
import { value } from "./outbound-records.ts";

export async function twilioOutboundStaffReviewFixture() {
  const f = await twilioTerminalHistoryFixture();
  const reviews = { ...f.config, outboundStaffReviewRecallTypeId: "75", staffReviewPolicyDigest: "d".repeat(64) };
  const config: TwilioOutboundStaffReviewConfig = { observations: f.config, attempts: f.attempts, reviews, maximumNativeRequests: 180 };
  const owner = outboundStaffReviewRecordBinding(reviews)!;
  const state: { allowed: boolean; producer: boolean; live: boolean; historyAllowed: boolean; decoded: boolean;
    response?: (row: Record<string, unknown>) => Response | Promise<Response>; beforeRead?: () => void } = {
    allowed: true, producer: true, live: true, historyAllowed: true, decoded: true
  };
  const reviewCalls: string[] = [];
  const native: typeof fetch = async (input, init) => {
    if (init?.method !== "POST") { state.beforeRead?.(); return f.historyPort(input, init); }
    assert.equal(String(input), "https://api.au5.cliniko.com/v1/recalls"); assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("authorization"), `Basic ${Buffer.from(`${reviews.apiKey}:`).toString("base64")}`);
    const body = JSON.parse(String(init.body)); assert.equal(body.recall_type_id, "75");
    assert.deepEqual(Object.keys(body).sort(), ["notes", "patient_id", "recall_at", "recall_type_id", "recalled"]);
    reviewCalls.push("POST"); const id = String(400 + reviewCalls.length), base = "https://api.au5.cliniko.com/v1";
    const row = { id, links: { self: `${base}/recalls/${id}` }, patient: { links: { self: `${base}/patients/${body.patient_id}` } },
      recall_type: { links: { self: `${base}/recall_types/75` } }, notes: body.notes, recall_at: body.recall_at,
      recalled: false, recalled_at: null, archived_at: null, created_at: f.observation.recordedAt, updated_at: f.observation.recordedAt };
    f.native.rows.set(id, row); return state.response ? state.response(row) : Response.json(row, { status: 201 });
  };
  const records: TwilioOutboundStaffReviewPorts["records"] = {
    allows: async q => state.allowed && (!q.request || state.decoded), current: () => state.live, producerAdmitted: async () => state.producer
  };
  const ports: TwilioOutboundStaffReviewPorts = { authentication: f.auth, native, sources: f.historyAuthority, records,
    history: { allowsHistoryRead: async () => state.historyAllowed, allowsRecordRead: records.allows, current: records.current },
    effects: { matches: (scope, binding) => JSON.stringify(scope) === JSON.stringify(reviews.scope) && binding === owner,
      claimOnce: async ref => { const claimed = !f.burned.has(ref); f.burned.add(ref); return { ok: true, value: { claimed } }; } } };
  const make = (c = config, p = ports) => ClinikoTwilioOutboundStaffReview.create(c, p), review = value(make());
  const run = () => review.retainForRuntime(f.identity, f.observation.accountSid, new AbortController().signal);
  return { ...f, reviewConfig: config, reviewPorts: ports, reviewState: state, reviewCalls, makeReview: make, review, runReview: run };
}
