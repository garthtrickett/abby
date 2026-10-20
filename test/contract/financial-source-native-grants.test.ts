import assert from "node:assert/strict";
import test from "node:test";
import { financialSourceApprovalFixture } from "../support/financial-source-approval.ts";
import { value, observation, reviewDate, stop } from "../support/financial-retention.ts";
import { bindFinancialSourceGrants } from "../../src/standalone/financial-source-grants.ts";
import type { FinancialNativeGrants } from "../../src/standalone/financial-source-grants.ts";
import { ClinikoFinancialReviewReader } from "../../src/cliniko/financial-review-read.ts";
import { ClinikoFinancialRecordRetainer } from "../../src/cliniko/financial-record-retention.ts";
import { ClinikoFinancialPendingDiscovery } from "../../src/cliniko/financial-pending-discovery.ts";
import { ClinikoFinancialWorkDiscovery } from "../../src/cliniko/financial-work-discovery.ts";
import { declareClinikoRequestCost, clinikoRequestCeiling } from "../../src/cliniko/request-cost.ts";

async function composed(overrides: Partial<FinancialNativeGrants> = {}) {
  const f = await financialSourceApprovalFixture(); f.retained.seedIntent();
  const independent: FinancialNativeGrants = { review: { allows: async () => true }, records: f.retained.authority,
    pending: { allowsPendingRead: async () => true, allowsRecordRead: async () => true, current: () => true },
    history: { allowsAccountRead: async () => true, allowsRecordRead: async () => true, current: () => true }, ...overrides };
  const grants = value(bindFinancialSourceGrants(f.native, f.selection.contentPolicy, f.definition, independent));
  let reads = 0;
  const port: typeof fetch = (input, init) => { reads++; return f.retained.port(input, init); };
  const binding = { recallRef: "cliniko:recall:30", actionRef: f.retained.intent.actionRef };
  return { ...f, grants, independent, port, binding, get reads() { return reads; },
    read: () => value(ClinikoFinancialReviewReader.create(f.native, grants.review, port)).read(binding, stop()) };
}

test("approved source composes an exact native private read without producer admission", async t => {
  let producerCalls = 0;
  const f = await composed({ records: { allows: async () => true, producerAdmitted: async () => { producerCalls++; return false; }, current: () => true } }); t.after(f.close);
  assert.equal((await f.read()).ok, true); assert.equal(f.reads, 1);
  assert.equal(f.retained.burned.size, 0); assert.equal(producerCalls, 0);
});

test("source approval alone cannot authorize a private native read", async t => {
  const f = await composed({ review: { allows: async () => false } }); t.after(f.close);
  assert.equal((await f.read()).ok, false); assert.equal(f.reads, 0);
});

test("native read refuses a source withdrawn while physical quota was awaited", { timeout: 3_000 }, async t => {
  const f = await composed(); t.after(f.close); let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(r => { entered = r; }), held = new Promise<void>(r => { release = r; }); t.after(() => release?.());
  Reflect.set(f.native.rateBudget, "claim", async () => { entered(); await held; return null; });
  const pending = f.read(); await ready; await f.replace({ enabled: false }); release();
  assert.equal((await pending).ok, false); assert.equal(f.reads, 0);
});

test("source withdrawn while native body was read cannot disclose the intent", async t => {
  const f = await composed(); t.after(f.close);
  const port: typeof fetch = async (input, init) => { const response = await f.retained.port(input, init); await f.replace({ enabled: false }); return response; };
  const reader = value(ClinikoFinancialReviewReader.create(f.native, f.grants.review, port));
  assert.deepEqual(await reader.read(f.binding, stop()), { ok: false, error: { kind: "forbidden" } });
});

test("approved definition supplies neither pending collection nor archived history collection permission", async t => {
  const f = await composed({ pending: { allowsPendingRead: async () => false, allowsRecordRead: async () => true, current: () => true },
    history: { allowsAccountRead: async () => false, allowsRecordRead: async () => true, current: () => true } }); t.after(f.close);
  const pending = value(ClinikoFinancialPendingDiscovery.create(f.native, f.grants.pending, f.port));
  assert.equal((await pending.scanPending(stop())).ok, false);
  const history = value(ClinikoFinancialWorkDiscovery.create(f.native, f.grants.history, f.port));
  assert.equal((await history.scanPatient({ patientId: f.retained.intent.patientId,
    createdFrom: "2026-11-01T08:00:00.000Z", createdThrough: "2026-11-01T11:00:00.000Z" }, stop())).ok, false);
  assert.equal(f.reads, 0);
});

test("financial source cannot replace independent producer admission before retaining a record", async t => {
  const f = await composed(); t.after(f.close);
  const grants = value(bindFinancialSourceGrants(f.native, f.selection.contentPolicy, f.definition, {
    ...f.independent, records: { ...f.independent.records, producerAdmitted: async () => false } }));
  const records = value(ClinikoFinancialRecordRetainer.create(f.native, grants.records, f.retained.barrier, f.port));
  assert.equal((await records.retainBookingObservationOnce(observation(f.retained.intent),
    { intent: f.retained.intent, intentRecallRef: f.binding.recallRef }, reviewDate, stop())).ok, false);
  assert.equal(f.retained.burned.size, 0); assert.equal(f.reads, 0);
});

test("exact native record acknowledgement survives subsequent source withdrawal", async t => {
  const f = await composed(); t.after(f.close); let posts = 0;
  const port: typeof fetch = async (input, init) => { const response = await f.retained.port(input, init);
    if (init?.method === "POST") { posts++; await f.replace({ enabled: false }); } return response; };
  const records = value(ClinikoFinancialRecordRetainer.create(f.native, f.grants.records, f.retained.barrier, port));
  const result = value(await records.retainBookingObservationOnce(observation(f.retained.intent),
    { intent: f.retained.intent, intentRecallRef: f.binding.recallRef }, reviewDate, stop()));
  assert.equal(result.kind, "accepted"); assert.equal(posts, 1);
  assert.equal((await records.retainBookingObservationOnce(observation(f.retained.intent),
    { intent: f.retained.intent, intentRecallRef: f.binding.recallRef }, reviewDate, stop())).ok, false);
  assert.equal(posts, 1);
});

test("additional source checks cannot inherit an unreviewed upstream native request ceiling", async t => {
  const f = await composed(); t.after(f.close);
  const binding = { scope: f.native.scope, credentialFingerprint: f.selection.credentialFingerprint, budget: f.native.rateBudget };
  const upstream = declareClinikoRequestCost(f.independent.review.allows, binding, 3);
  assert.equal(clinikoRequestCeiling(upstream, binding), 3);
  const grants = value(bindFinancialSourceGrants(f.native, f.selection.contentPolicy, f.definition,
    { ...f.independent, review: { allows: upstream } }));
  assert.equal(clinikoRequestCeiling(grants.review.allows, binding), undefined);
  // A trusted host can price the whole port after reviewing its actual source
  // and admin implementation; a record or callback name cannot supply that cost.
  assert.equal(clinikoRequestCeiling(declareClinikoRequestCost(grants.review.allows, binding, 5), binding), 5);
});

test("source composition preserves the upstream query and operation signal identities", async t => {
  const f = await composed(); t.after(f.close);
  const { producer: _, contentPolicy: __, ...selection } = f.selection;
  const query = { ...selection, ...f.binding }, external = stop(); let called = false;
  const grants = value(bindFinancialSourceGrants(f.native, f.selection.contentPolicy, f.definition,
    { ...f.independent, review: { allows: async (q, signal) => {
      assert.equal(q, query); assert.equal(signal, external); called = true; return true;
    } } }));
  assert.equal(await grants.review.allows(query, external), true); assert.equal(called, true);
});
