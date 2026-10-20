import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { chmod, symlink, writeFile, readFile } from "node:fs/promises";
import { financialSourceApprovalFixture } from "../support/financial-source-approval.ts";
import { value } from "../support/financial-retention.ts";
import { OwnerFileFinancialSource, financialSourceSelection } from "../../src/standalone/owner-file-financial-source.ts";
const signal = () => new AbortController().signal;

test("current financial source approval binds actual non-patient account, producer key and content policy", async t => {
  const f = await financialSourceApprovalFixture(); t.after(f.close);
  assert.equal(value(await f.definition.currentFor(f.selection, signal())), true);
  const data = await readFile(f.path, "utf8");
  for (const secret of [f.native.apiKey, "patientId", "recipient", "checkoutRef", "financialAuthorized", "manualPaid", "privateKey"])
    assert.equal(data.includes(secret), false);
  assert.equal(JSON.stringify(f.definition), "{}");
});

for (const field of ["businessId", "credentialFingerprint", "recallTypeId", "stripeAccount", "stripeMode", "producerRef", "producerKey", "contentVersion", "contentDigest", "scope"] as const)
test(`financial source refuses a changed ${field}`, async t => {
  const f = await financialSourceApprovalFixture(); t.after(f.close);
  const s = { ...f.selection, scope: { ...f.selection.scope }, stripe: { ...f.selection.stripe },
    producer: { ...f.selection.producer }, contentPolicy: { ...f.selection.contentPolicy } };
  if (field === "businessId" || field === "recallTypeId") s[field] = "92";
  if (field === "credentialFingerprint") s.credentialFingerprint = "b".repeat(64);
  if (field === "stripeAccount") s.stripe.accountRef = "acct_other";
  if (field === "stripeMode") s.stripe.livemode = !s.stripe.livemode;
  if (field === "producerRef") s.producer.keyRef = "other-producer";
  if (field === "producerKey") s.producer.publicKeyFingerprint = "b".repeat(64);
  if (field === "contentVersion") s.contentPolicy.version = "other-v1";
  if (field === "contentDigest") s.contentPolicy.digest = "b".repeat(64);
  if (field === "scope") s.scope.locationId = "other";
  assert.deepEqual(await f.definition.currentFor(s, signal()), { ok: true, value: false });
});

for (const change of ["disabled", "unapproved", "source", "role", "membership", "removed", "expired", "backwards"] as const)
test(`captured financial source refuses ${change}`, async t => {
  const f = await financialSourceApprovalFixture(); t.after(f.close);
  if (change === "disabled") await f.replace({ enabled: false });
  if (change === "unapproved") await f.replace({ approved: false });
  if (change === "source") await f.replace({ source: { ...f.approval.source, recallTypeId: "92" } });
  if (change === "role") f.state.account = { ...f.state.account!, actor: { ...f.state.account!.actor, role: "staff" } };
  if (change === "membership") f.state.account = { ...f.state.account!, membershipVersion: "2" };
  if (change === "removed") f.state.account = undefined;
  if (change === "expired") f.state.now = f.approval.effectiveUntil;
  if (change === "backwards") f.state.now = "2026-11-01T12:00:00.000Z";
  const result = await f.definition.currentFor(f.selection, signal()); assert.ok(!result.ok || !result.value);
});

for (const patch of [{ patientId: "21" }, { recipient: "private@example.invalid" }, { paid: true }, { waived: true }, { producerAdmitted: true },
  { source: { businessId: "11" } }, { source: null }])
test("financial approval files refuse private context, effect grants and incomplete schemas", async t => {
  const f = await financialSourceApprovalFixture(); t.after(f.close); await f.replace(patch);
  assert.equal((await OwnerFileFinancialSource.capture(f.config, signal())).ok, false);
});

test("financial source selection derives actual producer and refuses invalid policy or native configuration", async t => {
  const f = await financialSourceApprovalFixture(); t.after(f.close);
  const changed = value(financialSourceSelection({ ...f.native, producer: { ...f.native.producer, publicKey: generateKeyPairSync("ed25519").publicKey } }, f.selection.contentPolicy));
  assert.notEqual(changed.producer.publicKeyFingerprint, f.selection.producer.publicKeyFingerprint);
  assert.deepEqual(await f.definition.currentFor(changed, signal()), { ok: true, value: false });
  for (const policy of [{ version: "", digest: "a".repeat(64) }, { version: "v1", digest: "bad" }, { version: "v1", digest: "a".repeat(64), patientId: "21" }])
    assert.equal(financialSourceSelection(f.native, policy).ok, false);
  assert.equal(financialSourceSelection({ ...f.native, apiKey: "invalid" }, f.selection.contentPolicy).ok, false);
});

test("financial source rejects readable, linked and oversized local approval files", async t => {
  const f = await financialSourceApprovalFixture(); t.after(f.close);
  await chmod(f.path, 0o644); assert.equal((await OwnerFileFinancialSource.capture(f.config, signal())).ok, false);
  await chmod(f.path, 0o600); await symlink(f.path, f.path + ".link");
  assert.equal((await OwnerFileFinancialSource.capture({ ...f.config, path: f.path + ".link" }, signal())).ok, false);
  await writeFile(f.path, " ".repeat(8193)); assert.equal((await OwnerFileFinancialSource.capture(f.config, signal())).ok, false);
});

for (const change of ["patient", "stripe", "producer", "content"] as const)
test(`financial source refuses private or grant-bearing nested ${change} additions`, async t => {
  const f = await financialSourceApprovalFixture(); t.after(f.close);
  const source = { ...f.approval.source,
    ...(change === "patient" ? { patientId: "21" } : {}),
    ...(change === "stripe" ? { stripe: { ...f.approval.source.stripe, paid: true } } : {}),
    ...(change === "producer" ? { producer: { ...f.approval.source.producer, admitted: true } } : {}),
    ...(change === "content" ? { contentPolicy: { ...f.approval.source.contentPolicy, notes: "private" } } : {}) };
  await f.replace({ source }); assert.equal((await OwnerFileFinancialSource.capture(f.config, signal())).ok, false);
});

test("financial selection is snapshotted before a held membership lookup", { timeout: 3_000 }, async t => {
  const f = await financialSourceApprovalFixture(); t.after(f.close); let hold = false, entered!: () => void, release!: () => void;
  const ready = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; }), original = f.directory.findByRef;
  t.after(() => release?.());
  f.directory.findByRef = async ref => { if (hold) { entered(); await gate; } return original(ref); };
  const definition = value(await OwnerFileFinancialSource.capture(f.config, signal())); hold = true;
  const selection = { ...f.selection, stripe: { ...f.selection.stripe, accountRef: "acct_other" } };
  const pending = definition.currentFor(selection, signal()); await ready; selection.stripe.accountRef = f.selection.stripe.accountRef;
  release(); assert.deepEqual(await pending, { ok: true, value: false });
});

test("external cancellation bounds a held financial approval lookup", { timeout: 3_000 }, async t => {
  const f = await financialSourceApprovalFixture(); t.after(f.close); let hold = false, entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; }), original = f.directory.findByRef;
  f.directory.findByRef = async ref => { if (hold) { entered(); return new Promise(() => {}); } return original(ref); };
  const definition = value(await OwnerFileFinancialSource.capture(f.config, signal())); hold = true;
  const controller = new AbortController(), pending = definition.currentFor(f.selection, controller.signal); await ready; controller.abort();
  assert.deepEqual(await pending, { ok: false, error: { kind: "unavailable" } });
});

for (const phase of ["capture", "current"] as const)
test(`held financial ${phase} lookup honours its bounded source deadline`, { timeout: 3_000 }, async t => {
  const f = await financialSourceApprovalFixture(); t.after(f.close); let hold = phase === "capture", entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; }), original = f.directory.findByRef;
  f.directory.findByRef = async ref => { if (hold) { entered(); return new Promise(() => {}); } return original(ref); };
  const config = { ...f.config, deadlineMs: 1_000 };
  const definition = phase === "current" ? value(await OwnerFileFinancialSource.capture(config, signal())) : undefined;
  hold = true; t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = definition ? definition.currentFor(f.selection, signal()) : OwnerFileFinancialSource.capture(config, signal());
  await ready; t.mock.timers.tick(1_000);
  assert.deepEqual(await pending, { ok: false, error: { kind: "unavailable" } });
});
