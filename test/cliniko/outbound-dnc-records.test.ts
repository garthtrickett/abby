import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ClinikoOutboundDncRecords } from "../../src/cliniko/outbound-dnc-records.ts";
import { outboundContactReviewDigest } from "../../src/cliniko/outbound-contact-review.ts";
import { outboundDncRecordFixture } from "../support/outbound-dnc-records.ts";
import { value } from "../support/outbound-records.ts";

test("blocked-only native decision consumes its own opaque action and cannot claim a call or contact activation", async t => {
  const f = await outboundDncRecordFixture(); t.after(f.close);
  const result = value(await f.retain()); assert.equal(result.kind, "accepted"); assert.deepEqual([...f.burned], [f.review.actionRef]);
  assert.equal(f.burned.has(f.review.approvalRef), false); assert.equal(f.dncCalls.length, 1);
  assert.equal(f.dncQueries[0]!.operation, "retainDncDecision"); assert.equal(f.dncQueries[0]!.reviewDigest, outboundContactReviewDigest(f.review));
  assert.deepEqual(await value(f.make()).retainDecisionOnce(f.review, "2026-11-02", new AbortController().signal), { ok: false, error: { kind: "alreadyClaimed" } });
  assert.equal(f.dncCalls.length, 1);
  const contact = value(await f.read()); assert.equal(contact.disposition, "blocked"); assert.equal(contact.head?.review.doNotCall, "blocked");
});
for (const change of [{ consent: "granted" }, { consent: "withdrawn" }, { doNotCall: "clear" }, { doNotCall: "unknown" }, { reviewerRef: "forged-human" },
  { reconsentApprovalRef: randomUUID() }, { policy: { version: "foreign", digest: "d".repeat(64) } }, { contactRecallTypeId: "92" }] as const)
  test(`DNC writer refuses non-blocking or foreign decision ${JSON.stringify(change)}`, async t => {
    const f = await outboundDncRecordFixture(); t.after(f.close);
    assert.equal((await f.records.retainDecisionOnce({ ...f.review, ...change }, "2026-11-02", new AbortController().signal)).ok, false);
    assert.equal(f.burned.size, 0); assert.equal(f.dncCalls.length, 0);
  });
for (const denied of ["record", "producer", "source", "current"] as const)
  test(`independent DNC ${denied} denial prevents native append and effect consumption`, async t => {
    const f = await outboundDncRecordFixture(); t.after(f.close);
    if (denied === "record") f.dncControls.allow = false;
    if (denied === "producer") f.dncControls.producer = false;
    if (denied === "source") await f.replace({ enabled: false });
    if (denied === "current") f.dncControls.current = false;
    assert.deepEqual(await f.retain(), { ok: false, error: { kind: "forbidden" } });
    assert.equal(f.burned.size, 0); assert.equal(f.dncCalls.length, 0);
  });
test("lost native DNC ACK remains consumed and unknown across cold adapter construction", async t => {
  const f = await outboundDncRecordFixture(); t.after(f.close);
  f.dncControls.response = () => { throw new Error("Synthetic lost private ACK"); };
  assert.deepEqual(await f.retain(), { ok: true, value: { kind: "uncertain" } });
  assert.equal((await f.retain()).ok, false); assert.equal(f.dncCalls.length, 1);
  const reader = value(ClinikoOutboundDncRecords.createReadOnly(f.config, f.definition, f.dncAuthority, f.dncPort));
  const found = value(await reader.readDecision({ recallRef: "cliniko:recall:102", actionRef: f.review.actionRef, patientId: f.review.patientId }, new AbortController().signal));
  assert.deepEqual(found.record, f.review); assert.equal(value(await f.read()).disposition, "blocked");
});
test("genuine readonly DNC history includes archived closed decisions and has no producer capability", async t => {
  const f = await outboundDncRecordFixture(); t.after(f.close); value(await f.retain());
  const row = f.controls.rows.find(r => r.id === "102")!; row.archived_at = f.state.now; row.recalled = true; row.recalled_at = f.state.now;
  f.dncControls.producer = false;
  const reader = value(ClinikoOutboundDncRecords.createReadOnly(f.config, f.definition, f.dncAuthority, f.dncPort));
  const found = value(await reader.readDecision({ recallRef: "cliniko:recall:102", actionRef: f.review.actionRef, patientId: f.review.patientId }, new AbortController().signal));
  assert.equal(found.archivedAt, f.state.now); assert.equal(found.recalled, true);
  assert.deepEqual(f.dncCalls.at(-1)!.url.searchParams.getAll("q[]"), ["archived_at:*"]);
  const next = { ...f.review, actionRef: randomUUID(), approvalRef: randomUUID() };
  assert.deepEqual(await (reader as ClinikoOutboundDncRecords).retainDecisionOnce(next, "2026-11-02", new AbortController().signal), { ok: false, error: { kind: "forbidden" } });
});
test("decoded independent grants are reevaluated after a physical budget wait", async t => {
  const f = await outboundDncRecordFixture(); t.after(f.close);
  const config = { ...f.config, source: { ...f.config.source, rateBudget: { ...f.config.source.rateBudget,
    claim: async () => { f.dncControls.current = false; return null; } } } };
  const records = value(ClinikoOutboundDncRecords.create(config, f.definition, f.dncAuthority, f.barrier, f.dncPort));
  assert.deepEqual(await records.retainDecisionOnce(f.review, "2026-11-02", new AbortController().signal), { ok: false, error: { kind: "forbidden" } });
  assert.deepEqual([...f.burned], [f.review.actionRef]); assert.equal(f.dncCalls.length, 0);
});
test("exact known native DNC retention survives later permission withdrawal", async t => {
  const f = await outboundDncRecordFixture(); t.after(f.close);
  f.dncControls.response = row => { f.dncControls.current = false; return Response.json(row, { status: 201 }); };
  assert.equal(value(await f.retain()).kind, "accepted"); assert.equal(f.dncCalls.length, 1);
});
test("wrong-patient native DNC acknowledgement is uncertain and never retried", async t => {
  const f = await outboundDncRecordFixture(); t.after(f.close);
  f.dncControls.response = row => Response.json({ ...row, patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/999" } } }, { status: 201 });
  assert.deepEqual(await f.retain(), { ok: true, value: { kind: "uncertain" } });
  assert.equal((await f.retain()).ok, false); assert.equal(f.dncCalls.length, 1);
});
test("DNC input cancellation performs no claim or native request", async t => {
  const f = await outboundDncRecordFixture(); t.after(f.close); const abort = new AbortController(); abort.abort();
  assert.equal((await f.retain(abort.signal)).ok, false); assert.equal(f.burned.size, 0); assert.equal(f.dncCalls.length, 0);
});
test("current clinic source withdrawal during the budget wait consumes but never submits the decision", async t => {
  const f = await outboundDncRecordFixture(); t.after(f.close);
  const config = { ...f.config, source: { ...f.config.source, rateBudget: { ...f.config.source.rateBudget,
    claim: async () => { await f.replace({ enabled: false }); return null; } } } };
  const writer = value(ClinikoOutboundDncRecords.create(config, f.definition, f.dncAuthority, f.barrier, f.dncPort));
  assert.deepEqual(await writer.retainDecisionOnce(f.review, "2026-11-02", new AbortController().signal), { ok: false, error: { kind: "forbidden" } });
  assert.deepEqual([...f.burned], [f.review.actionRef]); assert.equal(f.dncCalls.length, 0);
});
test("decision expiry during a physical wait cannot submit an outdated DNC note", async t => {
  const f = await outboundDncRecordFixture(); t.after(f.close);
  const config = { ...f.config, source: { ...f.config.source, rateBudget: { ...f.config.source.rateBudget,
    claim: async () => { f.state.now = f.review.effectiveUntil; return null; } } } };
  const writer = value(ClinikoOutboundDncRecords.create(config, f.definition, f.dncAuthority, f.barrier, f.dncPort));
  assert.deepEqual(await writer.retainDecisionOnce(f.review, "2026-11-02", new AbortController().signal), { ok: false, error: { kind: "forbidden" } });
  assert.equal(f.dncCalls.length, 0); assert.equal(f.burned.size, 1);
});
test("changing caller configuration cannot replace the captured automation principal", async t => {
  const f = await outboundDncRecordFixture(); t.after(f.close); const selected = f.config.automationPrincipalRef;
  f.config.automationPrincipalRef = "replacement-principal";
  assert.equal(value(await f.retain()).kind, "accepted");
  assert.ok(f.dncQueries.every(q => q.automationPrincipalRef === selected));
});
test("a read-only DNC adapter does not reinterpret an earlier consenting review as an opt-out", async t => {
  const f = await outboundDncRecordFixture(); t.after(f.close);
  const reader = value(ClinikoOutboundDncRecords.createReadOnly(f.config, f.definition, f.dncAuthority, f.dncPort));
  assert.deepEqual(await reader.readDecision({ recallRef: "cliniko:recall:101", actionRef: f.first.actionRef, patientId: f.first.patientId }, new AbortController().signal),
    { ok: false, error: { kind: "mismatched" } });
});
