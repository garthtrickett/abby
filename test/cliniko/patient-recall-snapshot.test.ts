import assert from "node:assert/strict";
import test from "node:test";
import { PatientRecallSnapshot } from "../../src/cliniko/internal/patient-recall-snapshot.ts";
import { ClinikoOutboundRecipientRecords } from "../../src/cliniko/outbound-recipient-records.ts";
import type { OutboundRecordQuery } from "../../src/cliniko/outbound-recipient-records.ts";
import { incomingCallContextFixture } from "../support/incoming-call-context.ts";
import { value } from "../support/outbound-records.ts";

/** Admin/native read grants here are synthetic. These do not issue patient
 * proof; the incoming consumer separately tests its actual verifier boundary. */
async function fixture() {
  const f = await incomingCallContextFixture(), owner = new AbortController();
  const state = { current: true, decoded: true }, queries: OutboundRecordQuery[] = [];
  const current = () => { if (!state.current || owner.signal.aborted) throw Error("Synthetic native read unavailable"); };
  const snapshot = await PatientRecallSnapshot.read({ base: "https://api.au5.cliniko.com/v1", patientId: f.attempt.patientId,
    typeIds: ["61", "62", "66"], apiKey: f.native.config.apiKey, contactEmail: f.native.config.contactEmail, rateBudget: f.native.config.rateBudget },
    { signal: owner.signal, now: f.native.config.clock!, current, permit: async () => current(), wait: async <T>(task: Promise<T>) => { const v = await task; current(); return v; } }, f.config.fetchPort);
  const authority = { allows: async (q: OutboundRecordQuery) => { queries.push(q); return !q.request || state.decoded; }, current: () => state.current };
  const reader = value(ClinikoOutboundRecipientRecords.createReadOnly(f.native.config, authority, f.config.fetchPort));
  const binding = { recallRef: "cliniko:recall:30", actionRef: f.native.request.actionRef, patientId: f.attempt.patientId };
  return { f, owner, state, queries, snapshot, authority, reader, binding,
    close: async () => { owner.abort(); await f.close(); } };
}

test("a fetched patient snapshot preserves independent decoded record grants without another request or budget claim", async t => {
  const c = await fixture(); t.after(c.close); const before = c.f.native.claims;
  const read = value(await c.reader.readRequest(c.binding, c.owner.signal, c.snapshot));
  assert.deepEqual(read.request, c.f.native.request); assert.equal(c.f.native.claims, before); assert.equal(c.f.lists, 1);
  assert.ok(c.queries.some(q => q.includeArchived && !q.request)); assert.ok(c.queries.some(q => q.request && q.requestDigest));
  assert.equal(JSON.stringify(c.snapshot), "{}");
});

for (const fault of ["plain-object", "lookalike", "different-signal", "closed", "current", "decoded", "patient", "account", "family"] as const) {
  test(`a patient snapshot refuses ${fault} without falling back to an unapproved fresh request`, async t => {
    const c = await fixture(); t.after(c.close); const before = c.f.native.claims;
    let reader = c.reader, binding = c.binding, signal = c.owner.signal, snapshot = c.snapshot;
    if (fault === "plain-object") snapshot = {} as PatientRecallSnapshot;
    if (fault === "lookalike") snapshot = Object.create(PatientRecallSnapshot.prototype);
    if (fault === "different-signal") signal = new AbortController().signal;
    if (fault === "closed") c.owner.abort();
    if (fault === "current") c.state.current = false;
    if (fault === "decoded") c.state.decoded = false;
    if (fault === "patient") binding = { ...binding, patientId: "22" };
    if (fault === "account" || fault === "family") reader = value(ClinikoOutboundRecipientRecords.createReadOnly({ ...c.f.native.config,
      ...(fault === "account" ? { apiKey: "other-native-au5" } : { outboundRecallTypeId: "99" }) }, c.authority, c.f.config.fetchPort));
    assert.equal((await reader.readRequest(binding, signal, snapshot)).ok, false);
    assert.equal(c.f.native.claims, before); assert.equal(c.f.lists, 1);
  });
}

for (const fault of ["missing-owner", "forged-owner"] as const) {
  test(`a patient snapshot refuses direct ${fault} construction from unfetched native rows`, () => {
    const control = { signal: new AbortController().signal, current: () => {} };
    const selection = { base: "https://api.au5.cliniko.com/v1", apiKey: "unfetched-snapshot-au5", patientId: "21", typeIds: ["61"] };
    const rows = { rows: [], scanned: 0 };
    const args = fault === "missing-owner" ? [selection, control, rows] : [Symbol("patient recall snapshot owner"), selection, control, rows];
    assert.throws(() => Reflect.construct(PatientRecallSnapshot, args), /Native patient history unavailable/);
  });
}
