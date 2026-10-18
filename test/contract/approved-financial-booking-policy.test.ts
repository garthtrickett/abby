import assert from "node:assert/strict";
import test from "node:test";
import { financialFeePolicyFixture } from "../support/financial-fee-policy.ts";
import { value } from "../support/financial-retention.ts";
import { ApprovedFinancialBookingPolicy } from "../../src/standalone/approved-financial-booking-policy.ts";
import type { FinancialBookingRecipient } from "../../src/standalone/approved-financial-booking-policy.ts";
const signal = () => new AbortController().signal;
async function fixture() {
  const f = await financialFeePolicyFixture();
  const state = Object.assign(f.state, { address: "registered-financial@example.invalid", allowed: true, current: true, reads: 0, recipientUntil: f.selection.expiresAt });
  const recipient: FinancialBookingRecipient = {
    read: async selection => { state.reads++; assert.equal(selection.patientId, "21"); return state.allowed ? { recipient: { kind: "email", address: state.address }, expiresAt: state.recipientUntil } : undefined; },
    currentForSend: () => state.current
  };
  const fees = value(await f.capture());
  return { ...f, state, recipient, fees, policy: new ApprovedFinancialBookingPolicy({ fees, recipient, clock: () => f.state.now }) };
}

test("approved fee and independently admitted current recipient produce exact private quote", async t => {
  const f = await fixture(); t.after(f.close); const assessment = await f.policy.quote(f.selection, signal()); assert.ok(assessment?.kind === "required");
  assert.deepEqual(assessment.payment, { amount: 5000, currency: "aud", policyVersion: "fees-v1", termsVersion: "terms-v1", deadline: "2026-11-02T01:00:00.000Z" });
  assert.deepEqual(assessment.recipient, { kind: "email", address: f.state.address });
  assert.equal(assessment.reviewDate, "2026-11-02"); assert.equal(assessment.expiresAt, f.selection.expiresAt);
  assert.equal(f.policy.currentForSend(f.selection, assessment, signal()), false);
  assert.equal(await f.policy.current(f.selection, structuredClone(assessment), signal()), true);
  assert.equal(f.policy.currentForSend(f.selection, structuredClone(assessment), signal()), true);
  assert.equal(f.state.reads, 2); assert.equal(JSON.stringify(f.policy), "{}");
});
for (const change of ["amount", "terms", "recipient", "patient", "offer", "verification", "time", "class"] as const)
test(`composed fee quote refuses changed ${change}`, async t => {
  const f = await fixture(); t.after(f.close); const q = await f.policy.quote(f.selection, signal()); assert.ok(q?.kind === "required");
  const selection = { ...f.selection }, changed = structuredClone(q);
  if (change === "amount") changed.payment.amount++;
  if (change === "terms") changed.approvedTerms = "Different terms";
  if (change === "recipient") changed.recipient = { kind: "email", address: "other@example.invalid" };
  if (change === "patient") selection.patientId = "99";
  if (change === "offer") selection.offerRef = "other";
  if (change === "verification") selection.verificationRef = "other";
  if (change === "time") selection.startsAt = "2026-11-04T00:00:00.000Z";
  if (change === "class") selection.bookingKind = "classBook";
  assert.equal(await f.policy.current(selection, changed, signal()), false);
  assert.equal(f.policy.currentForSend(selection, changed, signal()), false);
});
for (const change of ["financial-denial", "current-denial", "changed-address", "expired-recipient", "withdrawn-fees", "changed-membership", "backwards", "expired-quote"] as const)
test(`composed fee quote refuses ${change}`, async t => {
  const f = await fixture(); t.after(f.close); const q = await f.policy.quote(f.selection, signal()); assert.ok(q);
  assert.equal(await f.policy.current(f.selection, q, signal()), true);
  if (change === "financial-denial") f.state.allowed = false;
  if (change === "current-denial") f.state.current = false;
  if (change === "changed-address") f.state.address = "other@example.invalid";
  if (change === "expired-recipient") f.state.recipientUntil = f.state.now;
  if (change === "withdrawn-fees") await f.replace({ enabled: false });
  if (change === "changed-membership") f.state.account = undefined;
  if (change === "backwards") f.state.now = "2026-11-01T23:59:00.000Z";
  if (change === "expired-quote") f.state.now = q.expiresAt;
  assert.equal(await f.policy.current(f.selection, q, signal()), false);
  assert.equal(f.policy.currentForSend(f.selection, q, signal()), false);
});

test("explicit no-deposit policy needs no patient recipient read and still rechecks approval", async t => {
  const f = await fixture(); t.after(f.close); await f.replace({ terms: { kind: "notRequired", version: "none-v1" } });
  const policy = new ApprovedFinancialBookingPolicy({ fees: value(await f.capture()), recipient: f.recipient, clock: () => f.state.now });
  f.state.allowed = false;
  const q = await policy.quote(f.selection, signal()); assert.deepEqual(q, { kind: "notRequired", version: "none-v1", expiresAt: f.selection.expiresAt });
  assert.equal(f.state.reads, 0); assert.equal(await policy.current(f.selection, q!, signal()), true);
  await f.replace({ enabled: false, terms: { kind: "notRequired", version: "none-v1" } });
  assert.equal(await policy.current(f.selection, q!, signal()), false);
});

test("quote snapshots selection and observes fee withdrawal while private recipient read is held", async t => {
  const f = await fixture(); t.after(f.close); let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; }); t.after(() => release?.());
  const recipient: FinancialBookingRecipient = { ...f.recipient, read: async selection => { entered(); await gate; assert.equal(selection.patientId, "21"); return f.recipient.read(selection, signal()); } };
  const policy = new ApprovedFinancialBookingPolicy({ fees: f.fees, recipient, clock: () => f.state.now }), selection = { ...f.selection };
  const pending = policy.quote(selection, signal()); await ready; selection.patientId = "99"; await f.replace({ enabled: false }); release();
  assert.equal(await pending, undefined);
});

test("aborted held recipient observation cannot publish a quote", { timeout: 3000 }, async t => {
  const f = await fixture(); t.after(f.close); let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
  const recipient: FinancialBookingRecipient = { ...f.recipient, read: async () => { entered(); return new Promise(() => {}); } };
  const policy = new ApprovedFinancialBookingPolicy({ fees: f.fees, recipient, clock: () => f.state.now }), controller = new AbortController();
  const pending = policy.quote(f.selection, controller.signal); await ready; controller.abort(); assert.equal(await pending, undefined);
});

test("a new quote invalidates the prior send fence and an expired fresh recipient cannot extend it", async t => {
  const f = await fixture(); t.after(f.close); const q = await f.policy.quote(f.selection, signal()); assert.ok(q);
  assert.equal(await f.policy.current(f.selection, q, signal()), true);
  f.state.recipientUntil = "2026-11-02T00:01:00.000Z";
  assert.equal(await f.policy.current(f.selection, q, signal()), true);
  f.state.now = f.state.recipientUntil; assert.equal(f.policy.currentForSend(f.selection, q, signal()), false);
  const replacement = await f.policy.quote({ ...f.selection, offerRef: "new-offer" }, signal()); assert.equal(replacement, undefined);
  assert.equal(f.policy.currentForSend(f.selection, q, signal()), false);
});
