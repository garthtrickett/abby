import assert from "node:assert/strict";
import test from "node:test";
import { financialFeePolicyFixture } from "../support/financial-fee-policy.ts";
import { value } from "../support/financial-retention.ts";
import { approvedFinancialVoicePolicy } from "../../src/standalone/approved-financial-voice-policy.ts";
import type { FinancialRecipientQuery } from "../../src/cliniko/financial-booking-recipient.ts";
const signal = () => new AbortController().signal;
async function fixture(required = true) {
  const f = await financialFeePolicyFixture(), credentialFingerprint = f.retained.intent.credentialFingerprint;
  await f.replace({ selection: { ...f.approval.selection, credentialFingerprint }, ...(required ? {} : { terms: { kind: "notRequired", version: "none-v1" } }) });
  const fees = value(await f.capture()), controls = [new AbortController(), new AbortController()], queries: FinancialRecipientQuery[] = [];
  const state = { reads: 0, allowed: new Map([["call-1", true], ["call-2", true]]) };
  const native = { ...f.native, clock: () => f.state.now };
  const selection = { ...f.selection, credentialFingerprint };
  const contexts = controls.map((control, i) => ({ scope: selection.scope, callId: `call-${i + 1}`, sessionId: `session-${i + 1}`, signal: control.signal, clock: () => f.state.now }));
  const create = approvedFinancialVoicePolicy({ fees, native,
    recipientAuthority: { allows: async q => { queries.push(q); return state.allowed.get(q.booking.callId) === true; }, current: q => state.allowed.get(q.booking.callId) === true },
    fetchPort: async input => { state.reads++; const id = new URL(String(input)).pathname.split("/").at(-1); return Response.json({ id, archived_at: null, email: `patient-${id}@example.invalid` }); } });
  return { ...f, fees, native, selection, contexts, controls, state, queries, create };
}

test("two admitted financial calls keep independent quotes and fresh native recipients", async t => {
  const f = await fixture(); t.after(f.close);
  const [a, b] = f.contexts.map(c => f.create(c)); assert.ok(a && b); assert.notEqual(a, b);
  const selectionA = { ...f.selection }, selectionB = { ...f.selection, callId: "call-2", sessionId: "session-2", patientId: "99", offerRef: "other-offer" };
  const [qa, qb] = await Promise.all([a.quote(selectionA, signal()), b.quote(selectionB, signal())]); assert.ok(qa?.kind === "required" && qb?.kind === "required");
  assert.equal(qa.recipient.address, "patient-21@example.invalid"); assert.equal(qb.recipient.address, "patient-99@example.invalid");
  assert.deepEqual(await Promise.all([a.current(selectionA, qa, signal()), b.current(selectionB, qb, signal())]), [true, true]);
  assert.equal(a.currentForSend(selectionA, qa, signal()), true); assert.equal(b.currentForSend(selectionB, qb, signal()), true);
  f.controls[0]!.abort();
  assert.equal(a.currentForSend(selectionA, qa, signal()), false); assert.equal(await b.current(selectionB, qb, signal()), true);
});
for (const required of [false, true])
test(`call-bound financial policy rejects another call/session even when required=${required}`, async t => {
  const f = await fixture(required); t.after(f.close); const policy = f.create(f.contexts[0]!);
  assert.equal(await policy.quote({ ...f.selection, callId: "call-2" }, signal()), undefined);
  assert.equal(await policy.quote({ ...f.selection, sessionId: "session-2" }, signal()), undefined); assert.equal(f.state.reads, 0);
});

test("one financial call's permission withdrawal does not invalidate another caller's quote", async t => {
  const f = await fixture(); t.after(f.close); const a = f.create(f.contexts[0]!), b = f.create(f.contexts[1]!);
  const other = { ...f.selection, callId: "call-2", sessionId: "session-2" };
  const qa = await a.quote(f.selection, signal()), qb = await b.quote(other, signal()); assert.ok(qa && qb);
  f.state.allowed.set("call-1", false);
  assert.equal(await a.current(f.selection, qa, signal()), false); assert.equal(await b.current(other, qb, signal()), true);
});

test("financial call factory snapshots owner binding and performs no construction I/O", async t => {
  const f = await fixture(); t.after(f.close); const context = { ...f.contexts[0]!, scope: { ...f.selection.scope } };
  const policy = f.create(context); assert.equal(f.state.reads, 0); context.callId = "call-2"; context.scope.locationId = "other";
  const q = await policy.quote(f.selection, signal()); assert.ok(q);
  assert.equal(await policy.quote({ ...f.selection, callId: "call-2" }, signal()), undefined);
  assert.equal(JSON.stringify(policy).includes("patientId"), false);
});

test("aborted and wrong-scope call contexts cannot construct a financial quote owner", async t => {
  const f = await fixture(); t.after(f.close); f.controls[0]!.abort();
  assert.throws(() => f.create(f.contexts[0]!), /financial call binding/);
  assert.throws(() => f.create({ ...f.contexts[1]!, scope: { ...f.selection.scope, locationId: "other" } }), /financial call binding/);
  assert.equal(f.state.reads, 0);
});
