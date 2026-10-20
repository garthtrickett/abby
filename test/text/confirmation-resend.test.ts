import assert from "node:assert/strict";
import test from "node:test";
import { now, setup } from "./fixture.ts";
import type { ConfirmationResendAction } from "../../src/core/confirmation-resend.ts";
const version = "a".repeat(64);
function request(app: Awaited<ReturnType<typeof setup>>): ConfirmationResendAction {
  return { kind: "confirmationResend", scope: app.scope, requestRef: crypto.randomUUID(), resendVersion: version, expiresAt: "2026-09-28T10:02:00.000Z" };
}
const enabled = (id: string) => setup(id, { confirmationResend: "execute" }, undefined, { confirmationResendVersion: version });

test("E2E-373 resend cannot inherit booking/read/intake or request-only staff permission", async () => {
  for (const mode of [undefined, "requestOnly", "unavailable"] as const) {
    const app = await setup(`resend-denied-${mode}`, mode ? { confirmationResend: mode } : undefined);
    await app.turn("request", "Send confirmation", { kind: "requestAction", request: request(app) });
    assert.equal(Object.keys((await app.state()).actions).length, 0);
    assert.equal(Object.keys((await app.state()).staffItems).length, 0); assert.equal(app.host.writes.length, 0);
  }
});
test("E2E-373 resend uses a separately played SAM confirmation and reports SMTP acceptance without inbox or booking claims", async () => {
  const app = await enabled("resend-sam-confirm");
  await app.turn("request", "Send confirmation", { kind: "requestAction", request: request(app) });
  const action = await app.pendingAction();
  assert.equal((await app.runtime.acceptTurn({ callId: app.callId, turnId: "early", text: "yes", quality: "clear", at: now },
    { kind: "affirm", actionKey: action.key, digest: action.digest, affirmative: true }, now)).ok, false);
  await app.confirm(action.key); await app.worker.process(app.callId, `${action.key}:write`, now);
  const state = await app.state(); assert.equal(state.actions[action.key]!.status, "committed");
  assert.match(state.callerMessages.at(-1)!, /mail service accepted.*can't confirm.*inbox/);
  assert.equal(Object.values(state.effects).some(e => e.kind === "notification"), false);
  assert.equal(state.callerMessages.some(text => text.includes("Your booking is confirmed")), false);
});
test("E2E-373 exact references, source binding, scope, expiry and digest govern resend proposals", async () => {
  const app = await enabled("resend-sam-invalid"), good = request(app);
  for (const patch of [{ email: "private@example.test" }, { appointmentId: "918273" }, { details: "private appointment" },
    { scope: { ...app.scope, clinicId: "foreign" } }, { resendVersion: "b".repeat(64) }, { expiresAt: now }, { expiresAt: "2026-09-28T10:06:00.000Z" }]) {
    assert.equal((await app.runtime.acceptTurn({ callId: app.callId, turnId: crypto.randomUUID(), text: "Send confirmation", quality: "clear", at: now },
      { kind: "requestAction", request: { ...good, ...patch } }, now)).ok, false);
  }
  await app.turn("valid", "Send confirmation", { kind: "requestAction", request: good }); const action = await app.pendingAction();
  await app.runtime.startPresentation(app.callId, action.presentationId); await app.runtime.resolvePresentation(app.callId, action.presentationId, "played");
  assert.equal((await app.runtime.acceptTurn({ callId: app.callId, turnId: "wrong", text: "yes", quality: "clear", at: now },
    { kind: "affirm", actionKey: action.key, digest: "wrong", affirmative: true }, now)).ok, false);
  assert.equal(app.host.writes.length, 0);
});
test("E2E-373 uncertainty is retained without another email write and a query does not send", async () => {
  const app = await enabled("resend-sam-unknown");
  await app.turn("request", "Send confirmation", { kind: "requestAction", request: request(app) }); const action = await app.pendingAction();
  await app.confirm(action.key);
  app.host.writeResult = mutation => ({ kind: "uncertain", actionKey: mutation.actionKey, reconcileAfter: now, deadline: "2026-09-28T10:05:00.000Z" });
  await app.worker.process(app.callId, `${action.key}:write`, now);
  await app.turn("query", "Was the email sent?", { kind: "notificationOutcomeQuery" });
  assert.equal(app.host.writes.length, 1); assert.equal((await app.state()).actions[action.key]!.status, "uncertain");
  await assert.rejects(app.worker.process(app.callId, `${action.key}:write`, now)); assert.equal(app.host.writes.length, 1);
});
