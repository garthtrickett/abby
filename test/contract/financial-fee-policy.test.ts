import assert from "node:assert/strict";
import test from "node:test";
import { chmod, writeFile } from "node:fs/promises";
import { financialSourceApprovalFixture } from "../support/financial-source-approval.ts";
import { value } from "../support/financial-retention.ts";
import { OwnerFileFinancialFeePolicy } from "../../src/standalone/owner-file-financial-fee-policy.ts";
import type { FinancialFeeApproval } from "../../src/standalone/owner-file-financial-fee-policy.ts";
import type { FinancialBookingSelection } from "../../src/standalone/cliniko-financial-booking-preparation.ts";
const signal = () => new AbortController().signal;
async function fixture() {
  const f = await financialSourceApprovalFixture();
  const approval: FinancialFeeApproval = { ...f.approval, selection: { policyVersion: "voice-v1", businessId: "11", credentialFingerprint: "a".repeat(64),
    practitionerId: "31", appointmentTypeId: "41", timeZone: "Australia/Sydney", bookingKind: "book", passUse: "none" },
    terms: { kind: "required", amount: 5000, currency: "aud", policyVersion: "fees-v1", termsVersion: "terms-v1",
      approvedTerms: "A deposit is required. Please pay using the secure link.", paymentWindowMinutes: 60 } };
  delete (approval as unknown as Record<string, unknown>).source;
  const selection: FinancialBookingSelection = { scope: approval.scope, ...approval.selection, callId: "call-1", sessionId: "session-1",
    verificationRef: "verification-1", offerRef: "offer-1", patientId: "21", startsAt: "2026-11-03T00:00:00.000Z", endsAt: "2026-11-03T00:30:00.000Z",
    expiresAt: "2026-11-02T00:05:00.000Z", clinicalDigest: "b".repeat(64) };
  const replace = (patch: Record<string, unknown>) => writeFile(f.path, JSON.stringify({ ...approval, ...patch }));
  await replace({});
  return { ...f, approval, selection, replace, capture: () => OwnerFileFinancialFeePolicy.capture(f.config, signal()) };
}

test("clinic fee source returns current approved exact service terms without private storage", async t => {
  const f = await fixture(); t.after(f.close); const policy = value(await f.capture());
  assert.deepEqual(value(await policy.currentFor(f.selection, signal())), f.approval);
  assert.equal(JSON.stringify(policy), "{}");
  assert.equal(policy.bindingFingerprint().length, 64);
  assert.equal(JSON.stringify(f.approval).includes("patientId"), false);
});
for (const field of ["businessId", "credentialFingerprint", "practitionerId", "appointmentTypeId", "policyVersion", "timeZone", "bookingKind", "scope", "classPass"] as const)
test(`clinic fee source refuses changed ${field}`, async t => {
  const f = await fixture(); t.after(f.close); const policy = value(await f.capture());
  const changed = { ...f.selection };
  if (field === "scope") changed.scope = { ...changed.scope, locationId: "other" };
  else if (field === "bookingKind") changed.bookingKind = "classBook";
  else if (field === "classPass") changed.classPass = {} as NonNullable<FinancialBookingSelection["classPass"]>;
  else changed[field] = field === "credentialFingerprint" ? "b".repeat(64) : "99";
  assert.equal(value(await policy.currentFor(changed, signal())), undefined);
});
for (const patch of [{ terms: { kind: "notRequired" } }, { terms: { kind: "unknown" } }, { patientId: "21" }, { paid: true }, { waived: true },
  { recipient: "private@example.invalid" }, { producerAdmitted: true }, { selection: { businessId: "11" } }])
test("clinic fee source rejects implicit no-requirement and private or grant-bearing fields", async t => {
  const f = await fixture(); t.after(f.close); await f.replace(patch); assert.equal((await f.capture()).ok, false);
});
for (const patch of [{ amount: 0 }, { amount: 0.1 }, { amount: 100_000_000 }, { currency: "jpy" }, { approvedTerms: "bad\ntext" },
  { approvedTerms: " " }, { approvedTerms: "x".repeat(351) }, { paymentWindowMinutes: 0 }, { paymentWindowMinutes: 10081 },
  { termsVersion: "" }, { policyVersion: "" }, { recipient: "private@example.invalid" }])
test("clinic fee source rejects malformed approved payment terms", async t => {
  const f = await fixture(); t.after(f.close); await f.replace({ terms: { ...f.approval.terms, ...patch } });
  assert.equal((await f.capture()).ok, false);
});

test("only explicit versioned current approval permits no deposit", async t => {
  const f = await fixture(); t.after(f.close); await f.replace({ terms: { kind: "notRequired", version: "no-deposit-v1" } });
  const policy = value(await f.capture());
  assert.deepEqual(value(await policy.currentFor(f.selection, signal()))?.terms, { kind: "notRequired", version: "no-deposit-v1" });
  await f.replace({ enabled: false, terms: { kind: "notRequired", version: "no-deposit-v1" } });
  assert.equal(value(await policy.currentFor(f.selection, signal())), undefined);
});
for (const change of ["withdrawal", "membership", "role", "expired", "backwards", "changedTerms"] as const)
test(`clinic fee source refuses ${change} after capture`, async t => {
  const f = await fixture(); t.after(f.close); const policy = value(await f.capture());
  if (change === "withdrawal") await f.replace({ enabled: false });
  if (change === "membership") f.state.account = undefined;
  if (change === "role") f.state.account = { ...f.state.account!, actor: { ...f.state.account!.actor, role: "staff" } };
  if (change === "expired") f.state.now = f.approval.effectiveUntil;
  if (change === "backwards") f.state.now = "2026-11-01T23:59:00.000Z";
  if (change === "changedTerms") await f.replace({ terms: { ...f.approval.terms, amount: 6000 } });
  const found = await policy.currentFor(f.selection, signal()); assert.ok(!found.ok || !found.value);
});

test("selected class pass requires its own explicit public service approval", async t => {
  const f = await fixture(); t.after(f.close);
  await f.replace({ selection: { ...f.approval.selection, bookingKind: "classBook", passUse: "selected" } });
  const policy = value(await f.capture()), selection = { ...f.selection, bookingKind: "classBook" as const, classSessionId: "51", classPass: {} as NonNullable<FinancialBookingSelection["classPass"]> };
  assert.equal(value(await policy.currentFor(selection, signal()))?.terms.kind, "required");
  assert.equal(value(await policy.currentFor({ ...selection, classPass: undefined }, signal())), undefined);
});

test("fee source snapshots selection before membership I/O and refuses abort", async t => {
  const f = await fixture(); t.after(f.close); let hold = false, entered!: () => void, release!: () => void;
  const ready = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; }), original = f.directory.findByRef;
  t.after(() => release?.());
  f.directory.findByRef = async ref => { if (hold) { entered(); await gate; } return original(ref); };
  const policy = value(await f.capture()); hold = true;
  const selection = { ...f.selection, businessId: "99" }, controller = new AbortController();
  const pending = policy.currentFor(selection, controller.signal); await ready; selection.businessId = "11"; release();
  assert.equal(value(await pending), undefined);
  controller.abort(); assert.equal((await policy.currentFor(f.selection, controller.signal)).ok, false);
});

test("fee source refuses non-owner-readable approval files", async t => {
  const f = await fixture(); t.after(f.close); await chmod(f.path, 0o644); assert.equal((await f.capture()).ok, false);
});
