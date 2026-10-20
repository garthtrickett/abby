import assert from "node:assert/strict";
import test from "node:test";
import { financialMessageFixture, value, stop, now } from "../support/financial-message-owner.ts";
import { decodeFinancialMessageAttempt } from "../../src/cliniko/financial-message-attempt.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";

test("original message quota denial before its permanent claim permits fresh recovery without replay", async () => {
  let clock = Date.now();
  const budget = new ClinikoReadBudget(180, () => clock);
  const f = await financialMessageFixture({ checkout: { native: { config: { rateBudget: budget } } } });
  f.paid();
  // Leave enough for source/history preparation, but fewer than the complete
  // message's ten observed native requests. Every read claims the real budget.
  while (budget.checkHeadroom(10) === null) assert.equal(budget.claim(), null);
  const before = f.nativeCalls.filter(r => r.method === "POST").length;
  assert.equal((await f.send("receiptDelivery")).ok, false);
  assert.equal(f.messages.length, 0); assert.equal(f.burned.has(f.intent.effects.receiptDelivery), false);
  assert.equal(f.nativeCalls.filter(r => r.method === "POST").length, before);
  clock += 60_001;
  assert.deepEqual(value(await f.send("receiptDelivery")), { kind: "accepted" });
  assert.equal(f.messages.length, 1); assert.equal(f.burned.has(f.intent.effects.receiptDelivery), true);
  assert.equal((await f.send("receiptDelivery")).ok, false); assert.equal(f.messages.length, 1);
});

test("original message quota lost after claim remains consumed and cannot be replayed", async () => {
  let clock = Date.now(), drain = false;
  const budget = new ClinikoReadBudget(180, () => clock);
  const f = await financialMessageFixture({ checkout: { native: { config: { rateBudget: budget }, response(row, method) {
    if (drain && method === "POST" && String(row.notes).includes("financial message attempt")) {
      while (budget.claim() === null) { /* A competing actor consumes remaining capacity. */ }
    }
    return Response.json(row, { status: method === "POST" ? 201 : 200 });
  } } } });
  f.paid(); drain = true;
  assert.equal((await f.send("receiptDelivery")).ok, false);
  assert.equal(f.burned.has(f.intent.effects.receiptDelivery), true); assert.equal(f.messages.length, 0);
  clock += 60_001; drain = false;
  assert.equal((await f.send("receiptDelivery")).ok, false); assert.equal(f.messages.length, 0);
  assert.equal(f.nativeCalls.filter(r => r.method === "POST").length, 1);
});

for (const headroom of [undefined, () => undefined, () => false, () => ({ kind: "rateLimited", retryAfterMs: 0 })])
test("missing or malformed original message headroom cannot consume its delivery claim", async () => {
  const f = await financialMessageFixture(); f.paid();
  Reflect.set(f.config.cliniko.rateBudget, "checkHeadroom", headroom);
  assert.equal((await f.send("receiptDelivery")).ok, false);
  assert.equal(f.burned.has(f.intent.effects.receiptDelivery), false); assert.equal(f.messages.length, 0);
  assert.equal(f.nativeCalls.filter(r => r.method === "POST").length, 0);
});

test("one exact financial link is retained before SMTP and never reconstructed from a local retry payload", async () => {
  const f = await financialMessageFixture(); assert.deepEqual(value(await f.send()), { kind: "accepted" });
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0]!.ref, f.intent.effects.linkDelivery);
  assert.equal(f.messages[0]!.mail.email, f.intent.recipient.address); assert.equal(f.messages[0]!.mail.purpose, "linkDelivery");
  assert.equal(f.burned.has(f.intent.effects.linkDelivery), true);
  const possible = value(decodeFinancialMessageAttempt(f.rows.get("33")!.notes));
  assert.equal(possible.effectRef, f.intent.effects.linkDelivery); assert.equal(possible.checkoutRef, f.binding.checkoutRef);
  assert.ok(f.queries.length >= 2); assert.ok(Object.isFrozen(f.queries[0]!.message));
  assert.equal((await f.send()).ok, false); assert.equal(f.messages.length, 1); assert.equal(JSON.stringify(f.owner), "{}");
  assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
});

test("received money and Stripe receipt delivery are separate from the link's one-use outcome", async () => {
  const f = await financialMessageFixture(); value(await f.send()); f.paid();
  assert.deepEqual(value(await f.send("receiptDelivery")), { kind: "accepted" });
  assert.equal(f.messages.length, 2); assert.equal(f.messages[1]!.ref, f.intent.effects.receiptDelivery);
  assert.equal(f.messages[1]!.mail.url, "https://pay.stripe.com/receipts/private-message-receipt");
  assert.equal((await f.send("receiptDelivery")).ok, false); assert.equal(f.messages.length, 2);
});

for (const denial of ["denySource", "denyHistory", "denyMessage", "denyBinding", "unadmit", "expireMessageOwner", "changeApprovedRecipient", "changeSender"] as const)
test(`${denial} cannot admit a financial message or consume its effect`, async () => {
  const f = await financialMessageFixture(); f[denial](); assert.equal((await f.send()).ok, false);
  assert.equal(f.messages.length, 0); assert.equal(f.burned.has(f.intent.effects.linkDelivery), false);
});

test("uncertain creation metadata cannot authorize a message without independent recovered binding approval", async () => {
  const f = await financialMessageFixture({ checkout: { stripe: (row, method) => { if (method === "POST") throw new Error("Synthetic lost ACK"); return Response.json(row); } } });
  assert.equal((await f.send()).ok, false); assert.equal(f.messages.length, 0);
  f.approveRecoveredBinding(); assert.deepEqual(value(await f.send()), { kind: "accepted" });
  assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
});

test("restored missing local claim still cannot resend after a recalled/archived native message attempt", async () => {
  const f = await financialMessageFixture(); value(await f.send());
  f.burned.delete(f.intent.effects.linkDelivery); const row = f.rows.get("33")!;
  row.recalled = true; row.recalled_at = now; row.archived_at = now;
  assert.equal((await value(f.make()).sendOnce(f.binding, "linkDelivery", stop())).ok, false);
  assert.equal(f.messages.length, 1); assert.equal(f.rows.size, 4);
});

for (const id of ["30", "31", "32"]) test(`closed native source${id} cannot authorize delivery`, async () => {
  const f = await financialMessageFixture(); f.rows.get(id)!.recalled = true;
  assert.equal((await f.send()).ok, false); assert.equal(f.messages.length, 0);
});

test("changed native, provider or recipient context during retained handoff is refused after the permanent claim", async () => {
  for (const change of ["native", "money", "recipient", "sender"] as const) {
    let mutate = () => {};
    const f = await financialMessageFixture({ checkout: { native: { response: (row, method) => {
      if (method === "POST" && String(row.notes).includes("financial message attempt")) mutate();
      return Response.json(row, { status: method === "POST" ? 201 : 200 });
    } } } });
    mutate = () => { if (change === "native") f.rows.get("31")!.recalled = true;
      else if (change === "money") f.paid(); else if (change === "recipient") f.changeApprovedRecipient(); else f.changeSender(); };
    assert.equal((await f.send()).ok, false); assert.equal(f.messages.length, 0); assert.equal(f.burned.has(f.intent.effects.linkDelivery), true);
  }
});

test("uncertain native attempt retention never reaches SMTP or permits a fresh owner's retry", async () => {
  const f = await financialMessageFixture({ checkout: { native: { response: (row, method) => {
    if (method === "POST" && String(row.notes).includes("financial message attempt")) throw new Error("Synthetic native ACK loss");
    return Response.json(row, { status: method === "POST" ? 201 : 200 });
  } } } });
  assert.deepEqual(await f.send(), { ok: false, error: { kind: "attemptUncertain" } }); assert.equal(f.messages.length, 0);
  f.burned.delete(f.intent.effects.linkDelivery);
  assert.equal((await value(f.make()).sendOnce(f.binding, "linkDelivery", stop())).ok, false); assert.equal(f.messages.length, 0);
});

test("accepted/unknown/definitively-unsent SMTP outcomes remain distinct and permanently fenced", async () => {
  for (const outcome of ["accepted", "unknown", "definitiveUnsent", "throw", "wrongRef"] as const) {
    let calls = 0, revoke = () => {};
    const f = await financialMessageFixture({ send: async (_mail, _signal, ref) => {
      calls++; revoke(); if (outcome === "throw") throw new Error("private SMTP failure canary");
      return outcome === "accepted" || outcome === "wrongRef" ? { kind: "accepted", messageRef: outcome === "accepted" ? ref : "foreign" } : { kind: outcome };
    } });
    revoke = () => f.expireMessageOwner();
    const result = value(await f.send());
    assert.equal(result.kind, outcome === "accepted" || outcome === "definitiveUnsent" ? outcome : "unknown");
    assert.equal(calls, 1); assert.equal((await f.send()).ok, false); assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(result), /private|SMTP|stripe|clinic:|@/);
  }
});

test("held financial approval, an aborted owner and invalid bindings never submit", async () => {
  const held = await financialMessageFixture({ authority: { messageAuthorized: async () => new Promise<boolean>(() => {}) }, deadlineMs: 30 });
  assert.equal((await held.send()).ok, false); assert.equal(held.messages.length, 0);
  const f = await financialMessageFixture(), aborted = new AbortController(); aborted.abort();
  assert.equal((await f.send("linkDelivery", aborted.signal)).ok, false);
  for (const patch of [{ checkoutRef: "cs_test_wrong/path" }, { checkoutAttemptRecallRef: f.binding.intentRecallRef },
    { observationActionRef: f.binding.financialActionRef }, { callerConsent: true }]) {
    assert.equal((await f.owner.sendOnce({ ...f.binding, ...patch }, "linkDelivery", stop())).ok, false);
  }
  assert.equal(f.nativeCalls.length, 0); assert.equal(f.stripeReads.length, 0); assert.equal(f.messages.length, 0);
});
