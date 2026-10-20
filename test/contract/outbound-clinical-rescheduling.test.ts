import assert from "node:assert/strict";
import test from "node:test";
import { outboundClinicalReschedulingFixture } from "../support/outbound-clinical-rescheduling.ts";
import { ClinikoReschedulingSession } from "../../src/standalone/cliniko-rescheduling-session.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";

test("outgoing OTP and played SAM move only the original sick-day appointment among multiple bookings", { timeout: 15000 }, async t => {
  const f = await outboundClinicalReschedulingFixture(); t.after(f.close);
  assert.equal(f.receipt.admission.direction, "outbound");
  await f.verify();
  assert.equal((await f.readMenu("targets")).ok, true);
  assert.doesNotMatch((await f.state()).callerMessages.at(-1)!, /Option two/);
  await f.play(); assert.equal((await f.selectMenu("targets")).ok, true);
  await f.play(); assert.equal((await f.readMenu("offers")).ok, true);
  await f.play(); assert.equal((await f.selectMenu("offers")).ok, true);
  const action = Object.values((await f.state()).actions)[0]!;
  assert.equal(action.mutation.request.kind, "reschedule");
  if (action.mutation.request.kind !== "reschedule") throw Error("Expected exact move");
  assert.equal(action.mutation.request.target.appointmentRef, "91");
  assert.equal(f.patches, 0);
  assert.equal((await f.confirm()).ok, true); await f.drain();
  assert.equal(f.patches, 1);
  assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
  assert.ok(f.targetState.targetReads > 1);
});

for (const cause of ["targetVersion", "originalRequest", "targetGrant", "nativeGrant", "clinicalGrant", "patientPermission"] as const)
test(`changed ${cause} after a played outgoing menu prevents a clinical proposal`, { timeout: 15000 }, async t => {
  const f = await outboundClinicalReschedulingFixture(); t.after(f.close);
  await f.verify(); assert.equal((await f.readMenu("targets")).ok, true); await f.play();
  assert.equal((await f.selectMenu("targets")).ok, true); await f.play();
  assert.equal((await f.readMenu("offers")).ok, true); await f.play();
  if (cause === "targetVersion") f.targetState.targetVersion = "2026-10-03T00:00:00.000Z";
  if (cause === "originalRequest") f.editOriginalRequest();
  if (cause === "targetGrant") f.targetState.targetLive = false;
  if (cause === "nativeGrant") f.targetState.nativeLive = false;
  if (cause === "clinicalGrant") f.targetState.live = false;
  if (cause === "patientPermission") f.setPermitted(false);
  await f.selectMenu("offers"); await f.drain();
  assert.equal(Object.keys((await f.state()).actions).length, 0);
  assert.equal(f.patches, 0);
});

for (const decoded of [false, true]) test(`clinical grant withdrawn during ${decoded ? "decoded" : "body"} target approval cannot disclose a menu`, { timeout: 15000 }, async t => {
  const f = await outboundClinicalReschedulingFixture(); t.after(f.close); await f.verify();
  const reads = f.targetState.targetReads;
  f.targetState.beforeTargetApproval = async q => { if (!!q.target === decoded) { await Promise.resolve(); f.targetState.live = false; } };
  await f.readMenu("targets");
  assert.equal(Object.keys((await f.state()).actions).length, 0);
  assert.doesNotMatch((await f.state()).callerMessages.at(-1)!, /Option one|Option two/);
  if (!decoded) assert.equal(f.targetState.targetReads, reads);
  assert.equal(f.patches, 0);
});

for (const cause of ["targetVersion", "originalRequest", "clinicalGrant", "targetGrant"] as const)
test(`${cause} changed after played confirmation still fences the final reviewed PATCH`, { timeout: 15000 }, async t => {
  const f = await outboundClinicalReschedulingFixture(); t.after(f.close); await f.verify();
  await f.readMenu("targets"); await f.play(); await f.selectMenu("targets"); await f.play();
  await f.readMenu("offers"); await f.play(); await f.selectMenu("offers");
  assert.equal(Object.keys((await f.state()).actions).length, 1);
  await f.play();
  if (cause === "targetVersion") f.targetState.targetVersion = "2026-10-03T00:00:00.000Z";
  if (cause === "originalRequest") f.editOriginalRequest();
  if (cause === "clinicalGrant") f.targetState.live = false;
  if (cause === "targetGrant") f.targetState.targetLive = false;
  const action = Object.values((await f.state()).actions)[0]!;
  await f.reception.affirm(f.scope, { callId: f.callId, sessionId: f.sessionId, turnId: "affirm-late", text: "Yes", quality: "clear", at: "2026-10-04T06:00:00.000Z" },
    action.key, action.digest, "2026-10-04T06:00:00.000Z");
  await f.drain(); assert.equal(f.patches, 0);
});

test("outgoing rescheduling cannot reset the shared physical native budget", { timeout: 15000 }, async t => {
  const f = await outboundClinicalReschedulingFixture(); t.after(f.close);
  assert.equal((await ClinikoReschedulingSession.createOutbound({ ...f.outgoingConfig, cliniko: { ...f.outgoingConfig.cliniko,
    rateBudget: { claim: async () => null, observe429: async () => ({ kind: "rateLimited" }) } } })).ok, false);
});

for (const competing of [false, true]) test(`actual physical180 ${competing ? "peer consumption fences" : "admits"} the complete outgoing clinical move`, { timeout: 15000 }, async t => {
  const physical = new ClinikoReadBudget(180, () => Date.parse("2026-10-04T06:00:00.000Z"));
  let accepted = 0, denied = 0;
  const budget = { claim: () => { const result = physical.claim(); if (result === null) accepted++; else denied++; return result; },
    observe429: physical.observe429.bind(physical) };
  const f = await outboundClinicalReschedulingFixture({ budget }); t.after(f.close);
  await f.verify(); await f.readMenu("targets"); await f.play(); await f.selectMenu("targets"); await f.play();
  await f.readMenu("offers"); await f.play(); await f.selectMenu("offers");
  assert.equal(Object.keys((await f.state()).actions).length, 1);
  if (competing) while (physical.claim() === null) { /* Same API-user peer consumes its remaining minute. */ }
  assert.equal((await f.confirm()).ok, true); await f.drain();
  assert.equal(f.patches, competing ? 0 : 1);
  assert.ok(accepted <= 180);
  assert.equal(denied === 0, !competing);
  assert.equal(physical.claim()?.kind, competing ? "rateLimited" : undefined);
});
