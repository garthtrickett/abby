import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoFinancialResendRecords } from "../../src/cliniko/financial-resend-records.ts";
import { fixture, uuid, now, reviewDate, value, stop } from "../support/financial-retention.ts";
import { resendRequestValue } from "../support/financial-resend.ts";
function setup(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(options); f.seedIntent();
  const request = resendRequestValue(f.intent, { observationRecallRef: "cliniko:recall:80", checkoutAttemptRecallRef: "cliniko:recall:81" });
  const make = () => ClinikoFinancialResendRecords.create(f.config, f.authority, f.barrier, f.port);
  const owner = value(make());
  return { ...f, request, make, owner, retain: (signal = stop()) => owner.retainRequestOnce(request, f.intent, reviewDate, signal) };
}
test("prospective resend retention consumes only its new record action, and a cold read preserves context and native closure", async () => {
  const f = setup(); const retained = value(await f.retain()); assert.equal(retained.kind, "accepted");
  if (retained.kind !== "accepted") return;
  assert.equal(retained.recallRef, "cliniko:recall:31");
  assert.deepEqual([...f.burned], [f.request.actionRef]); assert.equal(f.burned.has(f.request.effectRef), false);
  assert.equal(f.burned.has(f.intent.effects.linkDelivery), false);
  const query = f.queries[0] as { operation: string; resendRequest: unknown };
  assert.equal(query.operation, "retainResendRequest"); assert.deepEqual(query.resendRequest, f.request); assert.equal(Object.isFrozen(query.resendRequest), true);
  f.rows.get("31")!.recalled = true; f.rows.get("31")!.archived_at = now; f.unadmit();
  const cold = value(f.make()); const read = value(await cold.readRequest({ recallRef: retained.recallRef, actionRef: f.request.actionRef,
    intentRecallRef: f.request.intentRecallRef }, f.intent, stop()));
  assert.equal(read.recalled, true); assert.equal(read.archivedAt, now); assert.deepEqual(read.request, f.request);
  assert.equal(JSON.stringify(read).includes("private-native-record-canary"), false); assert.equal(JSON.stringify(cold), "{}");
  assert.equal(f.events.filter(e => e === "POST").length, 1);
});
test("concurrent and cold adapters cannot retain another request using the same consumed action", async () => {
  const f = setup(); const results = await Promise.all([f.retain(), value(f.make()).retainRequestOnce(f.request, f.intent, reviewDate, stop())]);
  assert.equal(results.filter(r => r.ok).length, 1); assert.equal(f.events.filter(e => e === "POST").length, 1);
  assert.deepEqual(await f.retain(), { ok: false, error: { kind: "alreadyClaimed" } });
});
for (const gate of ["deny", "unadmit", "expire"] as const) test(`independent current ${gate} refuses prospective retention`, async () => {
  const f = setup(); f[gate](); assert.equal((await f.retain()).ok, false); assert.equal(f.events.includes("POST"), false);
});
test("a request cannot borrow an original send effect or another clinic/account intent", async () => {
  const f = setup();
  for (const request of [{ ...f.request, effectRef: f.intent.effects.linkDelivery }, { ...f.request, approvalRef: f.intent.booking.actionRef }])
    assert.equal((await f.owner.retainRequestOnce(request, f.intent, reviewDate, stop())).ok, false);
  for (const intent of [{ ...f.intent, businessId: "12" }, { ...f.intent, stripe: { ...f.intent.stripe, accountRef: "acct_other" } }])
    assert.equal((await f.owner.retainRequestOnce(f.request, intent, reviewDate, stop())).ok, false);
  assert.equal(f.events.includes("claim"), false);
});
test("lost or mismatched native request acknowledgement remains uncertain and consumed", async () => {
  for (const lost of [true, false]) {
    const f = setup({ response(row, method) { if (method === "POST") { if (lost) throw new Error("synthetic response loss"); return Response.json({ ...row, patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/22" } } }, { status: 201 }); } return Response.json(row); } });
    assert.deepEqual(await f.retain(), { ok: true, value: { kind: "uncertain" } });
    assert.deepEqual(await f.retain(), { ok: false, error: { kind: "alreadyClaimed" } }); assert.equal(f.events.filter(e => e === "POST").length, 1);
  }
});
test("expired requests and current permission withdrawn during quota never POST", async () => {
  const expired = setup({ config: { clock: () => "2026-11-01T10:30:00.000Z" } }); assert.equal((await expired.retain()).ok, false); assert.equal(expired.events.includes("POST"), false);
  let f!: ReturnType<typeof setup>; f = setup({ quota: async () => { f.deny(); return null; } });
  assert.equal((await f.retain()).ok, false); assert.equal(f.events.includes("POST"), false); assert.equal(f.burned.has(f.request.actionRef), true);
});
test("new operation grants can inspect exact request context without authorizing old operations", async () => {
  const f = setup({ authority: { allows: async q => q.operation === "retainResendRequest" && q.resendRequest?.approvalRef === uuid(102) } });
  assert.equal(value(await f.retain()).kind, "accepted"); assert.equal((await f.retainer.retainIntentOnce({ ...f.intent, actionRef: uuid(200) }, reviewDate, stop())).ok, false);
});
