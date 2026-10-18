import assert from "node:assert/strict";
import test from "node:test";
import { financialExpiryObservation, FinancialExpiryObservations, attachFinancialExpiryObservation, financialExpiryFailureObservation, financialExpiryResultCode, financialExpiryProbeResult } from "../support/financial-expiry-observation.ts";
import { observeFinancialExpiry, expiryObservationCounts } from "../support/observe-financial-expiry.ts";
const sample = { code: 6, claims: 2, requests: 64, quotaRequired: 64, quotaDenials: 1, elapsedMs: 30_000 };

test("failure evidence retains consumed claims and slow work across later refusal cycles", () => {
  const observed = new FinancialExpiryObservations();
  assert.equal(observed.accept({ kind: "expiryObservation", observation: sample }), true);
  assert.equal(observed.accept({ kind: "expiryObservation", observation: { ...sample, code: 7, claims: 0, requests: 3, quotaRequired: 0, quotaDenials: 0, elapsedMs: 1 } }), true);
  assert.deepEqual(observed.value, { code: 7, claims: 2, requests: 67, quotaRequired: 64, quotaDenials: 1, elapsedMs: 30_000 });
});
for (const patch of [{ patientId: "private-patient" }, { error: "private-error" }, { checkoutRef: "cs_private" }, { recipient: "private@example.invalid" },
  { code: -1 }, { code: 11 }, { claims: 65536 }, { requests: Infinity }, { quotaRequired: 201 }, { elapsedMs: 600001 }, { quotaDenials: 1.1 }])
test("private-bearing and out-of-bound diagnostic IPC cannot replace existing evidence", () => {
  const observed = new FinancialExpiryObservations(); observed.accept({ kind: "expiryObservation", observation: sample }); const before = observed.value;
  assert.equal(observed.accept({ kind: "expiryObservation", observation: { ...sample, ...patch } }), false); assert.equal(observed.value, before);
  assert.equal(financialExpiryObservation({ ...sample, ...patch }), undefined);
});
for (const raw of [null, [], {}, "private-payload", { kind: "expiryObservation", observation: sample, private: "private" },
  { kind: "result", passed: true, observation: sample }, { kind: "expiryObservation", observation: { code: 1 } }])
test("diagnostic channel cannot become a result, partial schema or arbitrary payload channel", () => {
  const observed = new FinancialExpiryObservations(); assert.equal(observed.accept(raw), false); assert.equal(observed.value, undefined);
});

test("diagnostic accumulation saturates and keeps only an immutable numeric snapshot", () => {
  const observed = new FinancialExpiryObservations(), row = { ...sample, claims: 65535, requests: 65535, quotaDenials: 65535 };
  for (let i = 0; i < 5; i++) assert.equal(observed.accept({ kind: "expiryObservation", observation: row }), true);
  row.claims = 0; assert.equal(observed.value!.claims, 65535); assert.equal(observed.value!.requests, 65535); assert.equal(observed.value!.quotaDenials, 65535);
  assert.ok(Object.isFrozen(observed.value)); assert.equal(JSON.stringify(observed), "{}");
});

test("a known acknowledgement remains the same result when the observation sink fails", async () => {
  const result = { ok: true, value: { kind: "cancelled", privateContext: "private-value" } };
  const found = await observeFinancialExpiry(async () => result, () => { throw new Error("private-sink-error"); }); assert.equal(found, result);
});

test("operation failure retains exact identity and cannot leak through attached evidence", async () => {
  const failure = new Error("private-original-error"), observations: unknown[] = [];
  await assert.rejects(observeFinancialExpiry(async () => { throw failure; }, value => observations.push(value)), error => error === failure);
  const attached = attachFinancialExpiryObservation(failure, sample); assert.equal(attached, failure);
  assert.deepEqual(financialExpiryFailureObservation(failure), sample);
  assert.equal(JSON.stringify(financialExpiryFailureObservation(failure)).includes("private-original-error"), false);
  assert.equal(financialExpiryFailureObservation(new Error("another failure")), undefined);
  assert.equal((observations[0] as { code: number }).code, 0);
});

test("overlapping observations keep request and claim counts in their own asynchronous operation", async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }), snapshots: unknown[] = [];
  const first = observeFinancialExpiry(async () => { expiryObservationCounts.getStore()!.requests = 64; await gate; expiryObservationCounts.getStore()!.claims = 2; return { ok: false, error: { kind: "unavailable" } }; }, value => snapshots.push(value));
  await observeFinancialExpiry(async () => { expiryObservationCounts.getStore()!.requests = 3; return { ok: false, error: { kind: "forbidden" } }; }, value => snapshots.push(value));
  release(); await first;
  assert.deepEqual(snapshots.map(v => [ (v as typeof sample).requests, (v as typeof sample).claims ]), [[3, 0], [64, 2]]);
});

test("unrecognized private result kinds become only unknown numeric evidence", () => {
  assert.equal(financialExpiryResultCode({ ok: false, error: { kind: "private-patient-value" } }), 0);
  assert.equal(financialExpiryResultCode({ ok: true, value: { kind: "cancelled", private: "private" } }), 1);
  const getter = { get code() { throw new Error("private-getter"); } };
  assert.equal(financialExpiryObservation(getter), undefined);
});

for (let code = 0; code <= 10; code++) test(`expiry evidence code${code} cannot convert a failed caller into success`, () => {
  const raw = { kind: "result", passed: false, file: 1, line: 51, observation: { ...sample, code } };
  assert.equal(financialExpiryProbeResult(raw)?.passed, false);
  assert.equal(financialExpiryProbeResult({ ...raw, passed: true }), undefined);
  assert.equal(financialExpiryProbeResult({ ...raw, error: "private-error" }), undefined);
});
test("failure result channel preserves legacy results and rejects malformed source locations", () => {
  assert.deepEqual(financialExpiryProbeResult({ kind: "result", passed: true, file: 0, line: 0 }), { kind: "result", passed: true, file: 0, line: 0 });
  assert.equal(financialExpiryProbeResult({ kind: "result", passed: false, file: 4, line: 0 }), undefined);
  assert.equal(financialExpiryProbeResult({ kind: "result", passed: false, file: 1, line: 4097 }), undefined);
});
