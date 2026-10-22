// E2E-422: exact original-target signed outgoing cancellation; remote native/speech/grants are synthetic.
import assert from "node:assert/strict";
import test from "node:test";
import { outboundClinicalCancellationFixture } from "../support/outbound-clinical-cancellation.ts";
import { ClinikoCancellationSession } from "../../src/standalone/cliniko-cancellation-session.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { verificationNow } from "../support/caller-verification.ts";

async function propose(f: Awaited<ReturnType<typeof outboundClinicalCancellationFixture>>) {
  await f.verify(); assert.equal((await f.read()).ok, true); await f.play();
  assert.equal((await f.select()).ok, true); await f.play();
  assert.equal((await f.propose()).ok, true);
  const action = Object.values((await f.state()).actions)[0]!; assert.ok(action);
  assert.equal(action.mutation.request.kind, "cancel");
  if (action.mutation.request.kind !== "cancel") throw Error("Expected cancellation");
  assert.equal(action.mutation.request.target.appointmentRef, "91");
  return action;
}

test("outgoing cancellation verifies the actual distinct recipient and cancels only the original target after played consent", { timeout: 15000 }, async t => {
  const f = await outboundClinicalCancellationFixture(); t.after(f.close);
  assert.equal(f.receipt.admission.direction, "outbound"); assert.notEqual(f.recipientNumber, f.inbound.presentedCallerNumber);
  assert.equal(await f.owner.verified(), undefined);
  await propose(f); assert.equal(f.patches, 0);
  assert.doesNotMatch((await f.state()).callerMessages.join("\n"), /Option two/);
  assert.equal((await f.confirm()).ok, true); await f.drain();
  assert.equal(f.patches, 1); assert.equal(f.recalls.length, 1);
  assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
  assert.deepEqual(f.nativeCalls.filter(c => c.method === "PATCH"), [{ path: "/v1/individual_appointments/91/cancel", method: "PATCH" }]);
  await f.drain(); assert.equal(f.patches, 1);
});

for (const cause of ["original", "targetVersion", "targetGrant", "nativeGrant", "clinicalGrant", "contact", "patientPermission", "feeApproval", "closed"] as const)
test(`${cause} changed after played outgoing cancellation confirmation fences the final native write`, { timeout: 15000 }, async t => {
  const f = await outboundClinicalCancellationFixture(); t.after(f.close); const action = await propose(f); await f.play();
  if (cause === "original") f.editOriginalRequest();
  if (cause === "targetVersion") f.targetState.targetVersion = "2026-10-03T00:00:00.000Z";
  if (cause === "targetGrant") f.targetState.targetLive = false;
  if (cause === "nativeGrant") f.targetState.nativeLive = false;
  if (cause === "clinicalGrant") f.targetState.live = false;
  if (cause === "contact") f.setContactNumber("+61481937527");
  if (cause === "patientPermission") f.setPermitted(false);
  if (cause === "feeApproval") await f.replaceCancellation({ enabled: false });
  if (cause === "closed") f.lifetime.abort();
  await f.reception.affirm(f.scope, f.turn("late-yes", "Yes"), action.key, action.digest, verificationNow);
  await f.drain(); assert.equal(f.patches, 0);
  assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed");
});

for (const cause of ["original", "targetVersion", "clinicalGrant", "targetGrant", "nativeGrant", "contact", "patientPermission"] as const)
test(`${cause} withdrawn after native cancellation review still prevents PATCH`, { timeout: 15000 }, async t => {
  const f = await outboundClinicalCancellationFixture(); t.after(f.close); await propose(f); await f.confirm();
  f.setOnRecall(async () => {
    if (cause === "original") f.editOriginalRequest();
    if (cause === "targetVersion") f.targetState.targetVersion = "2026-10-03T00:00:00.000Z";
    if (cause === "clinicalGrant") f.targetState.live = false;
    if (cause === "targetGrant") f.targetState.targetLive = false;
    if (cause === "nativeGrant") f.targetState.nativeLive = false;
    if (cause === "contact") f.setContactNumber("+61481937527");
    if (cause === "patientPermission") f.setPermitted(false);
  });
  await f.drain(); assert.equal(f.recalls.length, 1); assert.equal(f.patches, 0);
});

for (const decoded of [false, true]) test(`grant withdrawn during ${decoded ? "decoded" : "body"} original cancellation target approval prevents disclosure`, { timeout: 15000 }, async t => {
  const f = await outboundClinicalCancellationFixture(); t.after(f.close); await f.verify();
  const reads = f.targetState.targetReads;
  f.targetState.beforeTargetApproval = async q => { if (!!q.target === decoded) { await Promise.resolve(); f.targetState.live = false; } };
  await f.read(); assert.doesNotMatch((await f.state()).callerMessages.at(-1)!, /Option one|Option two/);
  if (!decoded) assert.equal(f.targetState.targetReads, reads);
  assert.equal(f.patches, 0);
});

test("lost outgoing cancellation acknowledgement stays uncertain after native target changes and never sends twice", { timeout: 15000 }, async t => {
  const f = await outboundClinicalCancellationFixture({ lostWrite: true }); t.after(f.close);
  await propose(f); await f.confirm(); await f.drain();
  assert.equal(f.patches, 1); assert.equal(f.recalls.length, 1);
  const action = Object.values((await f.state()).actions)[0]!; assert.equal(action.status, "uncertain");
  assert.deepEqual(await f.owner.effects.reconcile(action.mutation), { kind: "stillUnknown", actionKey: action.key });
  await f.drain(); assert.equal(f.patches, 1);
});

test("outgoing cancellation rejects incoming identity, cross-admission bindings and replacement physical budgets", { timeout: 15000 }, async t => {
  const f = await outboundClinicalCancellationFixture(); t.after(f.close);
  const c = f.outgoingConfig;
  const bad = [ { ...c, inbound: undefined }, { ...c, representative: undefined }, { ...c, incomingOriginal: undefined },
    { ...c, outbound: {} }, { ...c, receipt: { ...c.receipt, admission: { ...c.receipt.admission, direction: "inbound" } } },
    { ...c, cliniko: { ...c.cliniko, businessId: "12" } },
    { ...c, cliniko: { ...c.cliniko, rateBudget: { claim: async () => null, observe429: async () => ({ kind: "rateLimited" }) } } } ];
  for (const candidate of bad) assert.equal((await ClinikoCancellationSession.createOutbound(candidate as typeof c)).ok, false);
  assert.equal((await ClinikoCancellationSession.create({ ...f.config, receipt: f.receipt })).ok, false);
  assert.equal((await ClinikoCancellationSession.create({ ...f.config, outbound: undefined } as typeof f.config)).ok, false);
});

for (const competing of [false, true]) test(`same physical180 budget ${competing ? "fences" : "admits"} the complete reviewed outgoing cancellation`, { timeout: 15000 }, async t => {
  const physical = new ClinikoReadBudget(180, () => Date.parse(verificationNow)); let accepted = 0, denied = 0;
  const budget = { claim: () => { const r = physical.claim(); if (r === null) accepted++; else denied++; return r; }, observe429: physical.observe429.bind(physical) };
  const f = await outboundClinicalCancellationFixture({ budget }); t.after(f.close); await propose(f);
  if (competing) while (physical.claim() === null) { /* Competing native actor spends this same API-user minute. */ }
  await f.confirm(); await f.drain(); assert.equal(f.patches, competing ? 0 : 1);
  assert.ok(accepted <= 180); assert.equal(denied === 0, !competing);
  if (!competing) assert.equal(accepted, f.nativeCalls.length);
});
