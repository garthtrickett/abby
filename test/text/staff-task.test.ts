import assert from "node:assert/strict";
import test from "node:test";
import { now, setup } from "./fixture.ts";

for (const resultKind of ["rejected", "uncertain"] as const) {
  test(`TXT-09 ${resultKind} staff task goes to operator review without receipt claim`, async () => {
    const app = setup(`staff-${resultKind}`);
    app.turn("handoff", "Please have staff call me", { kind: "handoff", reason: "callerRequested" });
    const item = Object.values(app.state().staffItems)[0];
    assert.ok(item);
    app.host.taskResult = task => ({ kind: resultKind, taskKey: task.key });
    await app.worker.process(app.callId, `${item.key}:open`, now);
    assert.equal(app.state().staffItems[item.key]?.status, "needsReview");
    assert.deepEqual(app.state().staffItems[item.key]?.destination, app.policy.operatorQueue);
    assert.equal(app.state().staffItems[item.key]?.hostTaskRef, undefined);
    assert.equal(app.state().callerMessages.some(message => message.includes("staff received")), false);
    assert.equal(app.host.tasks.length, 1);
  });
}

test("TXT-09 staff transport failure remains in operator review", async () => {
  const app = setup("staff-transport");
  app.turn("handoff", "Call me", { kind: "handoff", reason: "callerRequested" });
  const item = Object.values(app.state().staffItems)[0];
  assert.ok(item);
  app.host.openTask = async () => { throw new Error("connection lost"); };
  await app.worker.process(app.callId, `${item.key}:open`, now);
  assert.equal(app.state().staffItems[item.key]?.status, "needsReview");
  assert.deepEqual(app.state().staffItems[item.key]?.destination, app.policy.operatorQueue);
});
