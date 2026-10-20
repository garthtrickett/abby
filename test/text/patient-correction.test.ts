import assert from "node:assert/strict";
import test from "node:test";
import { now, setup } from "./fixture.ts";
import type { PatientCorrectionAction } from "../../src/core/patient-correction.ts";

function request(app: Awaited<ReturnType<typeof setup>>): PatientCorrectionAction {
  return { kind: "patientUpdate", patient: { ...app.patient, expiresAt: "2026-09-28T10:04:00.000Z" },
    correctionRef: "private-correction-1", consentRef: "private-consent-1", correctionVersion: "1", expiresAt: "2026-09-28T10:03:00.000Z" };
}

test("E2E-362 patient correction has independent capability and cannot inherit booking or intake", async () => {
  const app = await setup("correction-disabled");
  await app.turn("correction", "Save my correction", { kind: "requestAction", request: request(app) });
  assert.equal(Object.keys((await app.state()).actions).length, 0); assert.equal(app.host.writes.length, 0);
});

test("E2E-362 correction requires separately played SAM confirmation and reports existing-record outcome", async () => {
  const app = await setup("correction-confirm", { patientUpdate: "execute" });
  await app.turn("correction", "Save my correction", { kind: "requestAction", request: request(app) });
  const action = await app.pendingAction();
  const premature = await app.runtime.acceptTurn({ callId: app.callId, turnId: "too-early", text: "yes", quality: "clear", at: now },
    { kind: "affirm", actionKey: action.key, digest: action.digest, affirmative: true }, now);
  assert.equal(premature.ok, false); assert.equal(app.host.writes.length, 0);
  await app.confirm(action.key); await app.worker.process(app.callId, `${action.key}:write`, now);
  assert.equal((await app.state()).actions[action.key]?.status, "committed");
  assert.match((await app.state()).callerMessages.at(-1)!, /patient details match.*appointments remain unchanged/);
  assert.equal(app.host.writes[0]!.kind, "patientUpdate");
  assert.equal(JSON.stringify(await app.state()).includes("new@example.test"), false);
});

test("E2E-362 secret correction values, foreign subjects, expired evidence and changed references cannot authorize SAM", async () => {
  const app = await setup("correction-invalid", { patientUpdate: "execute" });
  const original = request(app);
  for (const patch of [{ email: "new@example.test" }, { changes: { first_name: "private" } }, { expiresAt: now },
    { expiresAt: "2026-09-28T10:05:00.000Z" }, { patient: { ...original.patient, scope: { ...app.scope, clinicId: "other" } } }]) {
    const result = await app.runtime.acceptTurn({ callId: app.callId, turnId: crypto.randomUUID(), text: "Save correction", quality: "clear", at: now },
      { kind: "requestAction", request: { ...original, ...patch } }, now);
    assert.equal(result.ok, false);
  }
  await app.turn("good", "Save correction", { kind: "requestAction", request: original });
  const action = await app.pendingAction();
  const expired = await app.runtime.acceptTurn({ callId: app.callId, turnId: "expired", text: "yes", quality: "clear", at: "2026-09-28T10:03:00.000Z" },
    { kind: "affirm", actionKey: action.key, digest: action.digest, affirmative: true }, "2026-09-28T10:03:00.000Z");
  assert.equal(expired.ok, false); assert.equal(app.host.writes.length, 0);
});

test("E2E-362 uncertain correction stays separate from registration and is never sent twice", async () => {
  const app = await setup("correction-uncertain", { patientUpdate: "execute" });
  await app.turn("correction", "Save correction", { kind: "requestAction", request: request(app) });
  const action = await app.pendingAction(); await app.confirm(action.key);
  app.host.writeResult = mutation => ({ kind: "uncertain", actionKey: mutation.actionKey, reconcileAfter: now, deadline: "2026-09-28T10:05:00.000Z" });
  await app.worker.process(app.callId, `${action.key}:write`, now);
  await assert.rejects(app.worker.process(app.callId, `${action.key}:write`, now));
  assert.equal(app.host.writes.length, 1); assert.equal((await app.state()).actions[action.key]?.status, "uncertain");
  assert.match((await app.state()).callerMessages.at(-1)!, /can't confirm/);
  assert.equal((await app.state()).callerMessages.some(text => /Your details were saved/.test(text)), false);
});
