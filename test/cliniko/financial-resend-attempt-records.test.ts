import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoFinancialResendRecords } from "../../src/cliniko/financial-resend-records.ts";
import { resendRequestValue, resendAttemptValue } from "../support/financial-resend.ts";
import { fixture, value, uuid, now, stop, reviewDate } from "../support/financial-retention.ts";
async function setup(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(options); f.seedIntent();
  const request = resendRequestValue(f.intent, { observationRecallRef: "cliniko:recall:80", checkoutAttemptRecallRef: "cliniko:recall:81" });
  const make = () => ClinikoFinancialResendRecords.create(f.config, f.authority, f.barrier, f.port), records = value(make());
  const retained = value(await records.retainRequestOnce(request, f.intent, reviewDate, stop())); assert.equal(retained.kind, "accepted");
  if (retained.kind !== "accepted") throw new Error("Synthetic request unavailable");
  const source = { intent: f.intent, request, requestRecallRef: retained.recallRef }, attempt = resendAttemptValue(request, retained.recallRef);
  return { ...f, records, make, source, attempt, retain: () => records.retainAttemptOnce(attempt, source, reviewDate, stop()) };
}
test("possible resend evidence retains once, stays private and does not itself grant or consume send permission", async () => {
  const f = await setup(), retained = value(await f.retain()); assert.equal(retained.kind, "accepted"); if (retained.kind !== "accepted") return;
  assert.deepEqual([...f.burned], [f.source.request.actionRef, f.attempt.actionRef]);
  assert.equal(f.burned.has(f.attempt.approvalRef), false); assert.equal(f.burned.has(f.attempt.effectRef), false);
  f.rows.get("32")!.recalled = true; f.rows.get("32")!.archived_at = now; f.unadmit();
  const cold = value(f.make()), read = value(await cold.readAttempt({ recallRef: retained.recallRef, actionRef: f.attempt.actionRef,
    intentRecallRef: f.attempt.intentRecallRef }, f.source, stop()));
  assert.deepEqual(read.attempt, f.attempt); assert.equal(read.recalled, true); assert.equal(read.archivedAt, now);
  assert.equal(JSON.stringify(read).includes("private-native-record-canary"), false);
});
test("concurrent possible-evidence retention and new adapters cannot replay a consumed record action", async () => {
  const f = await setup(), results = await Promise.all([f.retain(), value(f.make()).retainAttemptOnce(f.attempt, f.source, reviewDate, stop())]);
  assert.equal(results.filter(r => r.ok && r.value.kind === "accepted").length, 1); assert.equal(f.events.filter(e => e === "POST").length, 2);
  assert.deepEqual(await f.retain(), { ok: false, error: { kind: "alreadyClaimed" } });
});
for (const change of [{ effectRef: uuid(4) }, { approvalRef: uuid(201) }, { requestRecallRef: "cliniko:recall:99" },
  { attemptedAt: "2026-11-01T10:30:00.000Z" }, { requestDigest: "b".repeat(64) }])
  test(`mismatched possible resend ${Object.keys(change)[0]} cannot consume native permission`, async () => {
    const f = await setup(); f.events.length = 0;
    assert.equal((await f.records.retainAttemptOnce({ ...f.attempt, ...change }, f.source, reviewDate, stop())).ok, false);
    assert.deepEqual(f.events, []); assert.equal(f.burned.has(f.attempt.actionRef), false);
  });
test("a read-only history capability has no usable native write or journal claim path", async () => {
  const f = await setup(), retained = value(await f.retain()); assert.equal(retained.kind, "accepted"); if (retained.kind !== "accepted") return;
  const reader = value(ClinikoFinancialResendRecords.createReadOnly(f.config, f.authority, f.port)); f.events.length = 0;
  const context = value(await reader.readAttempt({ recallRef: retained.recallRef, actionRef: f.attempt.actionRef,
    intentRecallRef: f.attempt.intentRecallRef }, f.source, stop())); assert.deepEqual(context.attempt, f.attempt);
  const before = f.events.length, dynamic = reader as ClinikoFinancialResendRecords;
  assert.deepEqual(await dynamic.retainRequestOnce(f.source.request, f.intent, reviewDate, stop()), { ok: false, error: { kind: "forbidden" } });
  assert.deepEqual(await dynamic.retainAttemptOnce(f.attempt, f.source, reviewDate, stop()), { ok: false, error: { kind: "forbidden" } });
  assert.equal(f.events.length, before); assert.equal(f.events.includes("claim"), false); assert.equal(f.events.includes("POST"), false);
});
test("lost possible-resend acknowledgement is uncertain and never enables another POST", async () => {
  const f = await setup({ response(row, method) { if (method === "POST" && String(row.notes).includes("resend attempt v1")) throw new Error("synthetic lost evidence response"); return Response.json(row, { status: method === "POST" ? 201 : 200 }); } });
  assert.deepEqual(await f.retain(), { ok: true, value: { kind: "uncertain" } });
  assert.deepEqual(await f.retain(), { ok: false, error: { kind: "alreadyClaimed" } }); assert.equal(f.events.filter(e => e === "POST").length, 2);
});
