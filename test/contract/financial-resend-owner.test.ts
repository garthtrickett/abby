import assert from "node:assert/strict";
import test from "node:test";
import { financialResendFixture, value } from "../support/financial-resend-owner.ts";
for (const purpose of ["linkDelivery", "receiptDelivery"] as const)
  test(`one explicitly approved ${purpose} uses its new approval/effect and preserves original one-use delivery`, async () => {
    const f = await financialResendFixture({ purpose }); if (purpose === "receiptDelivery") f.paid();
    assert.deepEqual(value(await f.resend()), { kind: "accepted" }); assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0]!.ref, f.selected.request.effectRef); assert.equal(f.messages[0]!.mail.purpose, purpose);
    assert.equal(f.burned.has(f.selected.request.approvalRef), true); assert.equal(f.burned.has(f.selected.request.effectRef), true);
    assert.equal(f.burned.has(f.intent.effects[purpose]), false); assert.equal(f.claims <= 180, true);
    const before = f.messages.length; assert.equal((await f.resend()).ok, false); assert.equal(f.messages.length, before);
  });
for (const gate of ["denySource", "denyHistory", "denyBinding", "denyMessage", "unadmit", "expireMessageOwner", "denyResend", "denyFinancial", "retireResend"] as const)
  test(`explicit financial resend cannot borrow independent current ${gate}`, async () => {
    const f = await financialResendFixture(); f[gate](); assert.equal((await f.resend()).ok, false); assert.equal(f.messages.length, 0);
    assert.equal(f.burned.has(f.selected.request.approvalRef), false); assert.equal(f.burned.has(f.selected.request.effectRef), false);
  });
test("received money prevents a stale payment-link resend without changing payment or creating another Checkout", async () => {
  const f = await financialResendFixture(); f.paid(); assert.equal((await f.resend()).ok, false); assert.equal(f.messages.length, 0);
  assert.equal(f.requests.filter(r => r.method === "POST").length, 1); assert.equal(f.burned.has(f.selected.request.effectRef), false);
});
test("current sender selection and recipient permission remain separate from the native request", async () => {
  for (const changed of ["sender", "recipient"] as const) {
    const f = await financialResendFixture(); if (changed === "sender") f.changeSender(); else f.changeApprovedRecipient();
    assert.equal((await f.resend()).ok, false); assert.equal(f.messages.length, 0); assert.equal(f.burned.has(f.selected.request.effectRef), false);
  }
});
test("the admitted remaining plan bounds every physical native request after the new send effect", async () => {
  const f = await financialResendFixture(); assert.equal(value(await f.resend()).kind, "accepted");
  const admitted = f.headrooms.at(-1), at = f.claimsAtEffect.get(f.selected.request.effectRef); assert.ok(admitted?.admitted); assert.ok(at !== undefined);
  assert.equal(admitted.required, 8); assert.equal(f.claims - at, admitted.required); assert.ok(f.claims <= 180);
});
test("insufficient physical headroom refuses before either new approval or send effect is consumed", async () => {
  const f = await financialResendFixture(); for (let i = f.claims; i < 165; i++) assert.equal(await f.budget.claim(), null);
  assert.equal((await f.resend()).ok, false); assert.equal(f.headrooms.at(-1)?.required, 8); assert.equal(f.headrooms.at(-1)?.admitted, false);
  assert.equal(f.burned.has(f.selected.request.approvalRef), false); assert.equal(f.burned.has(f.selected.request.effectRef), false); assert.equal(f.messages.length, 0);
});
for (const change of ["paid", "financial", "approval", "source", "closedRequest"] as const)
  test(`fresh ${change} after native possible-send retention prevents dispatch without clearing its consumed IDs`, async () => {
    let f!: Awaited<ReturnType<typeof financialResendFixture>>;
    f = await financialResendFixture({ message: { checkout: { native: { response(row, method) {
      if (method === "POST" && String(row.notes).includes("Abby financial resend attempt v1")) {
        if (change === "paid") f.paid(); if (change === "financial") f.denyFinancial(); if (change === "approval") f.denyResend();
        if (change === "source") f.denySource(); if (change === "closedRequest") f.rows.get(f.selected.binding.recallRef.split(":").at(-1)!)!.recalled = true;
      }
      return Response.json(row, { status: method === "POST" ? 201 : 200 });
    } } } } });
    assert.equal((await f.resend()).ok, false); assert.equal(f.messages.length, 0);
    assert.equal(f.burned.has(f.selected.request.approvalRef), true); assert.equal(f.burned.has(f.selected.request.effectRef), true);
  });
test("closed native possible history denies a cold resend after every local claim is lost", async () => {
  let sends = 0; const f = await financialResendFixture({ message: { send: async () => { sends++; return { kind: "unknown" }; } } });
  assert.deepEqual(value(await f.resend()), { kind: "unknown" }); assert.equal(sends, 1);
  const possible = [...f.rows.values()].find(row => String(row.notes).includes("Abby financial resend attempt v1"))!;
  possible.recalled = true; possible.archived_at = f.config.cliniko.clock!(); f.burned.clear();
  const cold = value(f.makeResend());
  assert.deepEqual(await cold.sendOnce(f.binding, f.selected.request.purpose, f.selected.binding, new AbortController().signal), { ok: false, error: { kind: "alreadyClaimed" } });
  assert.equal(sends, 1); assert.equal(f.burned.size, 0);
});
test("another explicitly approved request needs fresh action approval and effect identities", async () => {
  const f = await financialResendFixture(); assert.equal(value(await f.send()).kind, "accepted");
  assert.equal(value(await f.resend()).kind, "accepted"); assert.equal(f.messages.length, 2);
  const next = await f.createRequest(); assert.notEqual(next.request.approvalRef, f.selected.request.approvalRef);
  assert.notEqual(next.request.effectRef, f.selected.request.effectRef); assert.equal(value(await f.resend(next)).kind, "accepted");
  assert.equal(f.messages.length, 3); assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
});
