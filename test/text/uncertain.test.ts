import assert from "node:assert/strict";
import test from "node:test";
import { deadline, now, setup, success } from "./fixture.ts";

test("TXT-02 uncertain booking retains original key and reconciles without replay", async () => {
  const app = await setup("uncertain");
  app.host.writeResult = mutation => ({ kind: "uncertain", actionKey: mutation.actionKey, reconcileAfter: now, deadline });
  await app.turn("request", "Book", { kind: "requestAction", request: app.book() });
  const action = (await app.pendingAction());
  await app.confirm(action.key);
  await app.worker.process(app.callId, `${action.key}:write`, now);
  assert.equal((await app.state()).actions[action.key]?.status, "uncertain");
  assert.match((await app.state()).callerMessages.at(-1) ?? "", /can't confirm/);
  assert.equal(app.host.writes.length, 1);
  assert.equal((await app.state()).effects[`${action.key}:write:reconcile`]?.kind, "hostReconcile");
  app.host.reconcileResult = mutation => ({ kind: "stillUnknown", actionKey: mutation.actionKey });
  await app.worker.process(app.callId, `${action.key}:write:reconcile`, now);
  assert.equal((await app.state()).actions[action.key]?.status, "uncertain");
  success(await app.runtime.expireReconciliation(app.callId, action.key, deadline));
  assert.equal((await app.state()).actions[action.key]?.status, "needsReview");
  assert.equal(Object.values((await app.state()).staffItems)[0]?.linkedActionKey, action.key);
  assert.equal(app.host.writes.length, 1);
  assert.equal((await app.state()).callerMessages.some(message => message.includes("confirmed")), false);
});

test("TXT-02 transport failure after possible send becomes uncertain", async () => {
  const app = await setup("transport-error");
  await app.turn("request", "Book", { kind: "requestAction", request: app.book() });
  const action = (await app.pendingAction());
  await app.confirm(action.key);
  app.host.write = async mutation => {
    app.host.writes.push(mutation);
    throw new Error("connection lost after send");
  };
  await app.worker.process(app.callId, `${action.key}:write`, now);
  assert.equal((await app.state()).actions[action.key]?.status, "uncertain");
  assert.equal((await app.state()).effects[`${action.key}:write:reconcile`]?.kind, "hostReconcile");
  assert.equal(app.host.writes.length, 1);
});
