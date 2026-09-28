import assert from "node:assert/strict";
import test from "node:test";
import { failure, now, setup, success } from "./fixture.ts";

test("TXT-01 booking requires played details, later affirmation, and exact host receipt", async () => {
  const app = setup("booking");
  app.turn("request-1", "Book physio tomorrow", { kind: "requestAction", request: app.book() });
  const action = app.pendingAction();
  assert.equal(app.host.writes.length, 0);
  assert.equal(Object.keys(app.state().effects).length, 0);
  failure(app.runtime.acceptTurn({ callId: app.callId, turnId: "affirm-early", text: "yes", quality: "clear", at: now }, { kind: "affirm", actionKey: action.key, digest: action.digest, affirmative: true }, now), "confirmationMissing");
  success(app.runtime.startPresentation(app.callId, action.presentationId));
  failure(app.runtime.acceptTurn({ callId: app.callId, turnId: "affirm-during", text: "yes", quality: "clear", at: now }, { kind: "affirm", actionKey: action.key, digest: action.digest, affirmative: true }, now), "confirmationMissing");
  success(app.runtime.resolvePresentation(app.callId, action.presentationId, "played"));
  app.turn("affirm-later", "yes", { kind: "affirm", actionKey: action.key, digest: action.digest, affirmative: true });
  assert.equal(app.state().actions[action.key]?.status, "ready");
  assert.equal(app.state().callerMessages.some(message => message.includes("confirmed")), false);
  await app.worker.process(app.callId, `${action.key}:write`, now);
  assert.equal(app.host.writes.length, 1);
  assert.equal(app.host.writes[0]?.actionKey, action.key);
  assert.equal(app.state().actions[action.key]?.status, "committed");
  assert.equal(app.state().actions[action.key]?.hostRef, "host-booking-1");
  assert.equal(app.state().callerMessages.at(-1), "Your booking is confirmed.");
});

test("ledger compare-and-swap rejects stale writes and duplicates do not replay a turn", () => {
  const app = setup("ledger");
  const version = app.state().version;
  app.turn("request-1", "Book physio", { kind: "requestAction", request: app.book() });
  const after = app.state();
  failure(app.runtime.apply(app.callId, version, { kind: "callerTurn", turn: { callId: app.callId, turnId: "other", text: "again", quality: "clear", at: now }, interpretation: { kind: "requestAction", request: app.book() }, now }), "versionConflict");
  app.turn("request-1", "Book physio", { kind: "requestAction", request: app.book() });
  assert.deepEqual(app.state(), after);
});
