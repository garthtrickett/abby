import assert from "node:assert/strict";
import test from "node:test";
import { err, ok } from "../../src/core/model.ts";
import { failure, now, setup, success } from "./fixture.ts";

test("emergency stop snapshots in-flight writes and routes unsent work to staff", async () => {
  let ready = false;
  const app = await setup("emergency-stop", undefined,
    async () => ready ? ok(true) : err({ kind: "readinessFailed", missing: ["mediaTestCall"] }));
  const before = success(await app.ledger.readWriteStop(app.scope));
  assert.equal(before.stopped, false);

  await app.turn("first-request", "Book first", { kind: "requestAction", request: app.book("first", "offer-first") });
  const first = await app.pendingAction();
  await app.confirm(first.key);
  success(await app.runtime.markHostPossiblySent(app.callId, `${first.key}:write`, now));

  await app.turn("second-request", "Book second", { kind: "requestAction", request: app.book("second", "offer-second") });
  const second = await app.pendingAction();
  await app.confirm(second.key, "second-affirm");

  const stopped = success(await app.ledger.stopWrites(app.scope, "clinic-admin", "Provider incident"));
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.actorRef, "clinic-admin");
  assert.equal(stopped.reason, "Provider incident");
  assert.deepEqual(stopped.inFlight.map(item => [item.callId, item.actionKey, item.status]),
    [[app.callId, first.key, "possiblySent"]]);
  assert.deepEqual(success(await app.ledger.stopWrites(app.scope, "second-admin", "another reason")), stopped);

  await app.worker.process(app.callId, `${second.key}:write`, now);
  const blocked = await app.state();
  assert.equal(blocked.actions[second.key]?.status, "unsupported");
  assert.equal(blocked.effects[`${second.key}:write`]?.status, "canceled");
  assert.equal(Object.values(blocked.staffItems).find(item => item.linkedActionKey === second.key)?.reason, "emergencyStopped");
  assert.equal(app.host.writes.length, 0);
  assert.match(blocked.callerMessages.at(-1) ?? "", /can't complete that action/);

  success(await app.runtime.acceptHostResult(app.callId, `${first.key}:write`,
    { kind: "committed", actionKey: first.key, hostRef: "existing-in-flight-write" }, now));
  assert.equal((await app.state()).actions[first.key]?.status, "committed");

  const denied = await app.ledger.resumeWrites(app.scope, "1", "clinic-admin", "Provider recovered");
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.kind, "readinessFailed");
  assert.equal(success(await app.ledger.readWriteStop(app.scope)).stopped, true);
  ready = true;
  const resumed = await app.ledger.resumeWrites(app.scope, "1", "clinic-admin", "Provider recovered");
  assert.ok(resumed.ok);
  assert.equal(resumed.value.stopped, false);
  assert.equal(resumed.value.version, "2");
  const stale = await app.ledger.resumeWrites(app.scope, "1", "clinic-admin", "Stale tab");
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.kind, "versionConflict");

  await app.turn("third-request", "Book third", { kind: "requestAction", request: app.book("third", "offer-third") });
  const third = await app.pendingAction();
  await app.confirm(third.key, "third-affirm");
  await app.worker.process(app.callId, `${third.key}:write`, now);
  assert.deepEqual(app.host.writes.map(item => item.actionKey), [third.key]);
  const stoppedAgain = success(await app.ledger.stopWrites(app.scope, "second-admin", "Second incident"));
  assert.equal(stoppedAgain.version, "3");
  assert.deepEqual(stoppedAgain.inFlight, []);
  assert.deepEqual(success(await app.ledger.listWriteStopChanges(app.scope)).entries.map(item => [item.version, item.stopped, item.actorRef]),
    [["1", true, "clinic-admin"], ["2", false, "clinic-admin"], ["3", true, "second-admin"]]);

  const other = await setup("emergency-other-clinic");
  await other.turn("request", "Book", { kind: "requestAction", request: other.book() });
  const otherAction = await other.pendingAction();
  await other.confirm(otherAction.key);
  await other.worker.process(other.callId, `${otherAction.key}:write`, now);
  assert.equal(other.host.writes.length, 1);
  failure(await app.ledger.stopWrites(app.scope, "", "reason"), "invalidTransition");
});

test("default recovery gate refuses to reopen writes without host proof", async () => {
  const app = await setup("emergency-default-recovery");
  success(await app.ledger.stopWrites(app.scope, "clinic-admin", "Incident"));
  const result = await app.ledger.resumeWrites(app.scope, "1", "clinic-admin", "Claimed recovery");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "readinessFailed");
  assert.equal(success(await app.ledger.readWriteStop(app.scope)).stopped, true);
});
