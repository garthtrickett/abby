import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoOutboundStaffReviewRecords, outboundStaffReviewRecordBinding } from "../../src/cliniko/outbound-staff-review-records.ts";
import { encodeOutboundStaffReviewRequest } from "../../src/cliniko/outbound-staff-review-request.ts";
import { outboundStaffReviewFixture } from "../support/outbound-staff-review.ts";
import { value } from "../support/outbound-records.ts";

test("native pending review retains its exact private sources under a separate current type/content/producer grant", async () => {
  const f = outboundStaffReviewFixture(), retained = value(await f.retain()); assert.equal(retained.kind, "accepted");
  if (retained.kind !== "accepted") assert.fail();
  assert.deepEqual(retained, { kind: "accepted", recallRef: "cliniko:recall:400", actionRef: f.request.actionRef });
  assert.equal(f.state.claims, 1); assert.deepEqual([...f.burned], [f.request.actionRef]);
  const read = value(await f.records.readRequest({ recallRef: retained.recallRef, actionRef: f.request.actionRef, patientId: f.request.patientId }, new AbortController().signal));
  assert.deepEqual(read.record, f.request); assert.equal(read.kind, "nativeOutboundContext");
  assert.equal(f.state.claims, 2);
  assert.ok(f.queries.some(q => q.operation === "retainStaffReview" && q.request?.notification.digest === f.request.notification.digest &&
    q.outboundStaffReviewRecallTypeId === "75" && q.staffReviewPolicyDigest === f.config.staffReviewPolicyDigest && q.requestDigest));
  for (const method of ["release", "settle", "clearDnc", "resolve"]) assert.equal(method in f.records, false);
});

for (const denied of ["allowed", "producer", "live", "decoded"] as const) test(`staff review ${denied} refusal cannot claim or send a native request`, async () => {
  const f = outboundStaffReviewFixture(); f.state[denied] = false;
  assert.equal((await f.retain()).ok, false); assert.equal(f.burned.size, 0); assert.equal(f.calls.length, 0); assert.equal(f.state.claims, 0);
});

test("broad read permission cannot reveal a pending request without its decoded source/content grant", async () => {
  const f = outboundStaffReviewFixture(), retained = value(await f.retain()); if (retained.kind !== "accepted") assert.fail();
  f.state.decoded = false;
  const read = await f.records.readRequest({ recallRef: retained.recallRef, actionRef: f.request.actionRef, patientId: f.request.patientId }, new AbortController().signal);
  assert.equal(read.ok, false);
});

test("foreign account/scope or future recorded time cannot use the pending review selection", async () => {
  for (const patch of [{ businessId: "99" }, { credentialFingerprint: "f".repeat(64) }, { scope: { tenantId: "other", clinicId: "clinic", locationId: "location" } },
    { recordedAt: "2026-11-01T10:05:00.000Z" }]) {
    const f = outboundStaffReviewFixture();
    assert.equal((await f.records.retainRequestOnce({ ...f.request, ...patch }, f.possible.recallAt, new AbortController().signal)).ok, false);
    assert.equal(f.burned.size, 0); assert.equal(f.calls.length, 0);
  }
});

test("lost stored staff review ACK remains spent and a fresh reader discovers only its exact native context", async () => {
  const f = outboundStaffReviewFixture(); f.state.response = (row, method) => {
    if (method === "POST") throw Error("synthetic lost native response"); return Response.json(row);
  };
  assert.deepEqual(value(await f.retain()), { kind: "uncertain" });
  assert.equal((await value(f.make()).retainRequestOnce(f.request, f.possible.recallAt, new AbortController().signal)).ok, false);
  const reader = value(ClinikoOutboundStaffReviewRecords.createReadOnly(f.config, f.authority, f.port));
  assert.deepEqual(Object.keys(reader), ["readRequest"]);
  const read = value(await reader.readRequest({ recallRef: "cliniko:recall:400", actionRef: f.request.actionRef, patientId: f.request.patientId }, new AbortController().signal));
  assert.deepEqual(read.record, f.request); assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
});

test("policy changes cannot mint another purpose after an uncertain pending review write", async () => {
  const f = outboundStaffReviewFixture(); f.state.response = () => { throw Error("synthetic ACK loss"); };
  assert.deepEqual(value(await f.retain()), { kind: "uncertain" });
  const config = { ...f.config, staffReviewPolicyDigest: "b".repeat(64) }, owner = outboundStaffReviewRecordBinding(config)!;
  assert.notEqual(owner, f.owner);
  const records = value(ClinikoOutboundStaffReviewRecords.create(config, f.authority, {
    matches: (scope, binding) => JSON.stringify(scope) === JSON.stringify(config.scope) && binding === owner,
    claimOnce: f.effects.claimOnce
  }, f.port));
  const next = await records.retainRequestOnce(f.request, f.possible.recallAt, new AbortController().signal);
  assert.equal(next.ok, false); if (!next.ok) assert.equal(next.error.kind, "alreadyClaimed");
  assert.deepEqual([...f.burned], [f.request.actionRef]); assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
});

test("pending review grants withdrawn across the shared budget wait consume no native POST", async () => {
  const f = outboundStaffReviewFixture(), config = { ...f.config, rateBudget: {
    claim: async () => { f.state.live = false; return null; }, observe429: f.config.rateBudget.observe429
  } };
  const records = value(ClinikoOutboundStaffReviewRecords.create(config, f.authority, f.effects, f.port));
  assert.equal((await records.retainRequestOnce(f.request, f.possible.recallAt, new AbortController().signal)).ok, false);
  assert.deepEqual([...f.burned], [f.request.actionRef]); assert.equal(f.calls.length, 0);
});

test("closed and archived pending review stays pending without turning staff closure into contact authority", async () => {
  const f = outboundStaffReviewFixture(), retained = value(await f.retain()); if (retained.kind !== "accepted") assert.fail();
  const row = f.rows.get("400")!; row.recalled = true; row.recalled_at = f.state.now; row.archived_at = f.state.now;
  const reader = value(ClinikoOutboundStaffReviewRecords.createReadOnly(f.config, f.authority, f.port));
  const read = value(await reader.readRequest({ recallRef: retained.recallRef, actionRef: f.request.actionRef, patientId: f.request.patientId }, new AbortController().signal));
  assert.equal(read.archivedAt, f.state.now); assert.equal(read.record.state, "needsClinicReview");
  assert.equal(Object.hasOwn(read.record, "contact"), false); assert.equal((await f.retain()).ok, false);
});

for (const changed of ["patient", "type", "notes"] as const) test(`native pending review ${changed} mismatch cannot establish retention or reset its action`, async () => {
  const f = outboundStaffReviewFixture(); f.state.response = (row, method) => {
    if (method !== "POST") return Response.json(row);
    if (changed === "patient") return Response.json({ ...row, patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/999" } } }, { status: 201 });
    if (changed === "type") return Response.json({ ...row, recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/999" } } }, { status: 201 });
    return Response.json({ ...row, notes: value(encodeOutboundStaffReviewRequest({ ...f.request, notification: { ...f.request.notification, digest: "b".repeat(64) } })) }, { status: 201 });
  };
  assert.deepEqual(value(await f.retain()), { kind: "uncertain" }); assert.equal((await f.retain()).ok, false);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
});

test("a stalled owned response body has a bounded uncertain result and cannot reopen staff review", async () => {
  const f = outboundStaffReviewFixture({ deadlineMs: 50 });
  f.state.response = () => new Response(new ReadableStream({ start() { /* Synthetic body never resolves. */ } }), { status: 201 });
  assert.deepEqual(value(await f.retain()), { kind: "uncertain" }); assert.equal((await f.retain()).ok, false);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
});
