import assert from "node:assert/strict";
import test from "node:test";
import { chmod } from "node:fs/promises";
import { outboundDncPolicyFixture } from "../support/outbound-dnc-policy.ts";
import { value } from "../support/outbound-records.ts";

test("current clinic policy binds automatic unknown-consent DNC to exact non-patient source provider and automation identity", async t => {
  const f = await outboundDncPolicyFixture(); t.after(f.close); const policy = value(await f.capturePolicy());
  const current = value(await policy.currentFor(f.selection, new AbortController().signal)); assert.deepEqual(current, f.policyApproval);
  assert.ok(current && Object.isFrozen(current) && Object.isFrozen(current.dnc) && Object.isFrozen(current.dnc.provider));
  assert.equal(JSON.stringify(current).includes(f.request.recipient.number), false); assert.equal(Object.hasOwn(current.dnc, "patientId"), false);
});
for (const patch of [{ patientId: "21" }, { number: "+61400000999" }, { transcript: "private" }, { financialReviewRef: "private" }])
  test(`closed DNC policy rejects private context ${Object.keys(patch)[0]}`, async t => {
    const f = await outboundDncPolicyFixture(); t.after(f.close); await f.replacePolicy({ dnc: { ...f.policyApproval.dnc, ...patch } });
    assert.equal((await f.capturePolicy()).ok, false);
  });
for (const patch of [{ consent: "granted" }, { consent: "withdrawn" }, { doNotCall: "clear" }, { reconsent: "automatic" },
  { automationPrincipalRef: "contact-admin" }, { participant: "verifiedPatientOnly" }])
  test(`automatic DNC policy cannot silently change owner-selected policy ${JSON.stringify(patch)}`, async t => {
    const f = await outboundDncPolicyFixture(); t.after(f.close); await f.replacePolicy({ dnc: { ...f.policyApproval.dnc, ...patch } });
    assert.equal((await f.capturePolicy()).ok, false);
  });
for (const field of ["source", "provider", "principal", "scope"] as const)
  test(`current automatic DNC policy refuses foreign ${field}`, async t => {
    const f = await outboundDncPolicyFixture(); t.after(f.close); const policy = value(await f.capturePolicy());
    const selection = { ...f.selection, ...(field === "source" ? { sourceBinding: "d".repeat(64) } : {}),
      ...(field === "provider" ? { provider: { ...f.selection.provider, ref: "foreign" } } : {}),
      ...(field === "principal" ? { automationPrincipalRef: "foreign" } : {}), ...(field === "scope" ? { scope: { ...f.selection.scope, clinicId: "foreign" } } : {}) };
    assert.equal(value(await policy.currentFor(selection, new AbortController().signal)), undefined);
  });
test("changed policy snapshot never silently reauthorizes an existing automatic DNC owner", async t => {
  const f = await outboundDncPolicyFixture(); t.after(f.close); const policy = value(await f.capturePolicy());
  await f.replacePolicy({ revision: "replacement" }); assert.equal(value(await policy.currentFor(f.selection, new AbortController().signal)), undefined);
});
test("withdrawn clinic-admin membership blocks automatic DNC policy", async t => {
  const f = await outboundDncPolicyFixture(); t.after(f.close); const policy = value(await f.capturePolicy());
  f.state.account = { ...f.state.account!, membershipVersion: "replacement" };
  assert.equal(value(await policy.currentFor(f.selection, new AbortController().signal)), undefined);
});
test("policy file replacement during current membership lookup is refused", async t => {
  const f = await outboundDncPolicyFixture(); t.after(f.close); const policy = value(await f.capturePolicy());
  f.policyControls.beforeLookup = () => f.replacePolicy({ enabled: false });
  assert.equal(value(await policy.currentFor(f.selection, new AbortController().signal)), undefined);
});
test("automatic DNC policy expiry at the final observed clock cannot escape the boundary", async t => {
  const f = await outboundDncPolicyFixture(); t.after(f.close); const policy = value(await f.capturePolicy()); let reads = 0;
  f.policyControls.readClock = () => ++reads === 3 ? f.policyApproval.effectiveUntil : f.state.now;
  assert.equal(value(await policy.currentFor(f.selection, new AbortController().signal)), undefined);
});
test("pre-aborted automatic policy capture performs no identity lookup", async t => {
  const f = await outboundDncPolicyFixture(); t.after(f.close); const aborted = new AbortController(); aborted.abort();
  assert.equal((await f.capturePolicy(aborted.signal)).ok, false); assert.equal(f.policyControls.lookups, 0);
});
test("blocked identity lookup is bounded under current automatic DNC policy", async t => {
  const f = await outboundDncPolicyFixture(); t.after(f.close); f.policyConfig.deadlineMs = 100;
  const policy = value(await f.capturePolicy()); f.policyControls.beforeLookup = () => new Promise<void>(() => {});
  assert.deepEqual(await policy.currentFor(f.selection, new AbortController().signal), { ok: false, error: { kind: "unavailable" } });
});
test("automatic DNC file retains owner-only permissions", async t => {
  const f = await outboundDncPolicyFixture(); t.after(f.close); await chmod(f.policyPath, 0o644);
  assert.equal((await f.capturePolicy()).ok, false);
});
for (const flag of ["approved", "enabled"] as const)
  test(`capturing a policy with ${flag} false supplies no automatic DNC approval`, async t => {
    const f = await outboundDncPolicyFixture(); t.after(f.close); await f.replacePolicy({ [flag]: false });
    const policy = value(await f.capturePolicy());
    assert.equal(value(await policy.currentFor(f.selection, new AbortController().signal)), undefined);
  });
test("reusing a provider reference after credential rotation cannot borrow old automatic DNC approval", async t => {
  const f = await outboundDncPolicyFixture(); t.after(f.close); const policy = value(await f.capturePolicy());
  assert.equal(value(await policy.currentFor({ ...f.selection, provider: { ...f.selection.provider, bindingDigest: "c".repeat(64) } }, new AbortController().signal)), undefined);
});
test("clock rollback during policy lookup does not produce automatic DNC authority", async t => {
  const f = await outboundDncPolicyFixture(); t.after(f.close); const policy = value(await f.capturePolicy()); let reads = 0;
  f.policyControls.readClock = () => ++reads === 1 ? f.state.now : f.policyApproval.effectiveFrom;
  assert.deepEqual(await policy.currentFor(f.selection, new AbortController().signal), { ok: false, error: { kind: "unavailable" } });
});
