import assert from "node:assert/strict";
import test from "node:test";
import { financialClassResendFixture } from "../support/financial-class-resend.ts";
import { value } from "../support/financial-resend-owner.ts";

for (const patientCaseId of [undefined, "71"]) for (const purpose of ["linkDelivery", "receiptDelivery"] as const)
  test(`independently approved class ${purpose} retains exact original case request=${patientCaseId ?? "none"} without class or money mutation`, async () => {
    const f = await financialClassResendFixture({ purpose, ...(patientCaseId ? { patientCaseId } : {}) });
    if (purpose === "receiptDelivery") f.paid();
    assert.equal(value(await f.send(purpose)).kind, "accepted");
    assert.equal(f.selected.request.targetRef, "cliniko:attendee:91");
    assert.deepEqual(value(await f.resend()), { kind: "accepted" }); assert.equal(f.messages.length, 2);
    assert.equal(f.messages[0]!.mail.purpose, purpose); assert.equal(f.messages[1]!.mail.purpose, purpose);
    assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
    assert.equal(f.nativeCalls.every(r => r.url.pathname.startsWith("/v1/recalls")), true);
    assert.equal((await f.resend()).ok, false); assert.equal(f.messages.length, 2);
  });
test("a separately retained class resend request for another attendee cannot consume approved send IDs", async () => {
  const f = await financialClassResendFixture({ patientCaseId: "71" });
  const wrong = await f.createRequest("linkDelivery", { targetRef: "cliniko:attendee:92" });
  assert.equal((await f.resend(wrong)).ok, false); assert.equal(f.messages.length, 0);
  assert.equal(f.burned.has(wrong.request.approvalRef), false); assert.equal(f.burned.has(wrong.request.effectRef), false);
});
for (const change of ["occurrence", "case"] as const)
  test(`editing the signed original class ${change} cannot authorize a financial resend`, async () => {
    const f = await financialClassResendFixture({ patientCaseId: "71" });
    const row = f.rows.get(f.binding.observationRecallRef.split(":").at(-1)!)!;
    row.notes = String(row.notes).replace('["91","71"]', change === "occurrence" ? '["92","71"]' : '["91","72"]');
    assert.equal((await f.resend()).ok, false); assert.equal(f.messages.length, 0);
    assert.equal(f.burned.has(f.selected.request.approvalRef), false); assert.equal(f.burned.has(f.selected.request.effectRef), false);
  });
