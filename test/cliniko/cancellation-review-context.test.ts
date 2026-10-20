import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { ClinikoRecallWriter } from "../../src/cliniko/recall-write.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { decodeClinikoReview, encodeClinikoReview } from "../../src/cliniko/review-request.ts";
import type { ClinikoReviewRequest } from "../../src/cliniko/review-request.ts";
import { ClinikoReviewedSend } from "../../src/standalone/cliniko-reviewed-send.ts";

const scope = { tenantId: "cancel-review-tenant", clinicId: "clinic", locationId: "location" };
const apiKey = "synthetic-cancel-review-au5", base = "https://api.au5.cliniko.com/v1";
const now = "2026-10-04T04:00:00Z", marker = "7a6b240c-94fa-45d8-ae0b-f4ee91cb2bd1";
const request: ClinikoReviewRequest & { operation: Extract<ClinikoReviewRequest["operation"], { kind: "cancel" }> } = { scope, patientId: "42", businessId: "11",
  credentialFingerprint: clinikoCredentialFingerprint(apiKey), policyVersion: "policy", termsVersion: "fee-terms",
  timeZone: "Asia/Jakarta", createdAt: now, operation: { kind: "cancel", appointmentId: "71", cancellationReason: 10,
    practitionerId: "22", appointmentTypeId: "33", startsAt: "2026-10-08T04:00:00Z", endsAt: "2026-10-08T04:30:00Z" } };
const config = { scope, apiKey, contactEmail: "test@example.test" };

test("E2E-270 every approved cancellation reason survives provider acknowledgment and independent review discovery", async () => {
  for (const cancellationReason of [10, 20, 30, 40, 50, 60] as const) {
    let row: Record<string, unknown> | undefined, mutations = 0;
    const confirmed: ClinikoReviewRequest = { ...request, operation: { ...request.operation, kind: "cancel", appointmentId: "71", cancellationReason } };
    const fetchPort: typeof fetch = async (_url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        row = { id: "91", notes: body.notes, recall_at: body.recall_at, recalled: false, archived_at: null,
          patient: { links: { self: `${base}/patients/42` } }, recall_type: { links: { self: `${base}/recall_types/7` } } };
        return Response.json(row, { status: 201 });
      }
      return Response.json({ total_entries: row ? 1 : 0, recalls: row ? [row] : [] });
    };
    const writer = ClinikoRecallWriter.create(config, fetchPort); assert.ok(writer.ok);
    const gate = new ClinikoReviewedSend({ scope, businessId: "11", credentialFingerprint: request.credentialFingerprint,
      policyVersion: "policy", timeZone: request.timeZone, recallTypeId: "7", writer: writer.value, clock: () => Date.parse(now) });
    const result = await gate.run(confirmed, { authorize: async () => true, send: async exact => {
      assert.ok(row); const review = decodeClinikoReview(row.notes); assert.ok(review.ok);
      assert.equal(review.value.request.operation.kind, "cancel");
      assert.equal(review.value.request.operation.cancellationReason, cancellationReason);
      assert.deepEqual(exact, confirmed); mutations += 1; return "synthetic-inspection-outcome";
    } }, new AbortController().signal); assert.ok(result.ok); assert.equal(mutations, 1);
    const reader = ClinikoRecallReader.create(config, fetchPort); assert.ok(reader.ok);
    const found = await reader.value.discoverPendingReviews(scope, "7"); assert.ok(found.ok);
    assert.equal(found.value.pending.length, 1); const item = found.value.pending[0]!; assert.equal(item.kind, "review");
    assert.deepEqual(item.envelope.request.operation, confirmed.operation);
  }
});

test("E2E-270 missing, unknown or wrongly typed cancellation reasons never become current review context", () => {
  const encoded = encodeClinikoReview(marker, request); assert.ok(encoded.ok);
  const parts = encoded.value.split("\n");
  for (const reason of [undefined, null, "10", 0, 70, 10.5]) {
    const value = JSON.parse(parts[2]!);
    if (reason === undefined) delete value.operation.cancellationReason;
    else value.operation.cancellationReason = reason;
    const notes = [parts[0], parts[1], JSON.stringify(value), parts[3]].join("\n");
    assert.deepEqual(decodeClinikoReview(notes), { ok: false, error: { kind: "invalidReviewRequest" } });
  }
});

test("E2E-270 legacy cancellation notes without the approved reason stay visible for manual review, never silently upgraded", async () => {
  const encoded = encodeClinikoReview(marker, request); assert.ok(encoded.ok);
  const parts = encoded.value.split("\n"), value = JSON.parse(parts[2]!); delete value.operation.cancellationReason;
  const legacy = [parts[0], "Abby appointment review v1", JSON.stringify(value), parts[3]].join("\n");
  const reader = ClinikoRecallReader.create(config, async () => Response.json({ total_entries: 1, recalls: [{ id: "91",
    notes: legacy, recalled: false, archived_at: null, recall_at: "2026-10-04",
    patient: { links: { self: `${base}/patients/42` } }, recall_type: { links: { self: `${base}/recall_types/7` } } }] }));
  assert.ok(reader.ok); const found = await reader.value.discoverPendingReviews(scope, "7"); assert.ok(found.ok);
  assert.deepEqual(found.value.pending.map(item => item.kind), ["invalidEnvelope"]);
});
