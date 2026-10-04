import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { encodeClinikoReview, decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import type { ClinikoReviewRequest } from "../../src/cliniko/review-request.ts";

const scope = { tenantId: "review-tenant", clinicId: "clinic" };
const base = "https://api.au5.cliniko.com/v1";
const marker = "7a6b240c-94fa-45d8-ae0b-f4ee91cb2bd1";
const config = { scope, apiKey: "synthetic-review-key-au5", contactEmail: "dev@example.test" };
const request: ClinikoReviewRequest = { scope: { ...scope, locationId: "requested-location" }, patientId: "42",
  businessId: "11", credentialFingerprint: "a".repeat(64), policyVersion: "policy-1", termsVersion: "terms-1",
  timeZone: "Asia/Jakarta", createdAt: "2026-10-04T04:00:00Z",
  operation: { kind: "book", practitionerId: "22", appointmentTypeId: "33",
    startsAt: "2026-10-08T04:00:00Z", endsAt: "2026-10-08T04:30:00Z" } };
function notes(value = request) {
  const result = encodeClinikoReview(marker, value); assert.ok(result.ok); return result.value;
}
function row(id: number, changes: Record<string, unknown> = {}) {
  return { id: String(id), notes: notes(), recalled: false, archived_at: null, recall_at: "2026-10-04",
    patient: { links: { self: `${base}/patients/42` } },
    recall_type: { links: { self: `${base}/recall_types/7` } }, ...changes };
}
function reader(fetchPort: typeof fetch) {
  const result = ClinikoRecallReader.create(config, fetchPort, () => "2026-10-04T04:00:00Z");
  assert.ok(result.ok); return result.value;
}

test("E2E-267 review envelopes retain exact approved context for all three appointment operations", () => {
  const selection = { practitionerId: "22", appointmentTypeId: "33",
    startsAt: "2026-10-08T04:00:00Z", endsAt: "2026-10-08T04:30:00Z" };
  const operations: ClinikoReviewRequest["operation"][] = [request.operation,
    { kind: "cancel", ...selection, appointmentId: "91", cancellationReason: 10 },
    { kind: "reschedule", ...selection, appointmentId: "91", newStartsAt: "2026-10-09T04:00:00Z",
      newEndsAt: "2026-10-09T04:30:00Z" }];
  for (const operation of operations) {
    const value = { ...request, operation };
    assert.deepEqual(decodeClinikoReview(notes(value)), { ok: true, value: { marker, request: value } });
  }
});

test("E2E-267 malformed, expanded and oversized review context cannot become a send permit", () => {
  const invalid = [
    { ...request, transcript: "private transcript canary" },
    { ...request, scope: { ...request.scope, tenantId: "" } },
    { ...request, patientId: "0" },
    { ...request, policyVersion: "x".repeat(256), termsVersion: "y".repeat(256) },
    { ...request, timeZone: "Invalid/Zone" },
    { ...request, createdAt: "2026-02-30T00:00:00Z" },
    { ...request, createdAt: "2026-10-04T24:00:00Z" },
    { ...request, operation: { ...request.operation, endsAt: request.operation.startsAt } },
    { ...request, operation: { ...request.operation, kind: "intake" } },
  ];
  for (const value of invalid) assert.deepEqual(encodeClinikoReview(marker, value as ClinikoReviewRequest),
    { ok: false, error: { kind: "invalidReviewRequest" } });
  for (const value of [null, "private note", notes().replace("review v2", "review v3"),
    notes().replace('"book"', '"intake"'), notes().replace(marker, "invalid-marker"), notes()+"\nextra"])
    assert.deepEqual(decodeClinikoReview(value), { ok: false, error: { kind: "invalidReviewRequest" } });
});

test("E2E-267 discovery needs only account/type configuration, scans all pages and retains every requested location", async () => {
  const rows = [...Array.from({ length: 100 }, (_, i) => row(i+1, {
    notes: "unrelated private provider note", recall_type: { links: { self: `${base}/recall_types/8` } } })), row(101)];
  const pages: number[] = [];
  const client = reader(async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.pathname, "/v1/recalls");
    assert.equal(url.searchParams.has("q[]"), false, "do not require the lost patient or marker");
    assert.equal(init?.method, "GET"); assert.equal(init.redirect, "error");
    const page = Number(url.searchParams.get("page")); pages.push(page);
    return Response.json({ total_entries: rows.length, recalls: rows.slice((page-1)*100,page*100) });
  });
  const result = await client.discoverPendingReviews(scope, "7"); assert.ok(result.ok);
  assert.deepEqual(pages,[1,2]); assert.equal(result.value.scanned,101);
  assert.deepEqual(result.value.pending,[{ kind:"review", recallRef:"cliniko:recall:101", patientRef:"cliniko:patient:42",
    recallAt:"2026-10-04", envelope:{marker,request} }]);
  assert.doesNotMatch(JSON.stringify(result), /unrelated private provider note/);
});

test("E2E-267 duplicate markers, edited context and changed patient associations stay visible as review work", async () => {
  const rows = [row(1),row(2,{recalled:true}),row(3,{notes:"edited private note canary"}),
    row(4,{notes:notes({...request,scope:{...request.scope,clinicId:"foreign"}})}),
    row(5,{patient:{links:{self:`${base}/patients/99`}}})];
  const result = await reader(async () => Response.json({total_entries:rows.length,recalls:rows}))
    .discoverPendingReviews(scope,"7"); assert.ok(result.ok);
  assert.deepEqual(result.value.pending.map(item=>item.kind),["ambiguousMarker","invalidEnvelope","invalidEnvelope","invalidEnvelope"]);
  assert.equal(result.value.pending.length,4);
  assert.doesNotMatch(JSON.stringify(result),/edited private note canary/);
});

test("E2E-267 failed, incomplete and oversized scans never report an empty recovered queue", async () => {
  const cases = [new Response(null,{status:503}),Response.json({total_entries:2,recalls:[row(1)]}),
    Response.json({total_entries:501,recalls:[]}),Response.json({total_entries:2,recalls:[row(1),row(1)]})];
  for (const response of cases) {
    const result = await reader(async()=>response).discoverPendingReviews(scope,"7");
    assert.equal(result.ok,false);
  }
  let reads=0; const client=reader(async()=>{reads+=1;throw new Error("unexpected read");});
  assert.deepEqual(await client.discoverPendingReviews({...scope,clinicId:"foreign"},"7"),
    {ok:false,error:{kind:"scopeMismatch"}});
  assert.deepEqual(await client.discoverPendingReviews(scope,"0"),{ok:false,error:{kind:"invalidQuery"}});
  assert.equal(reads,0);
});
