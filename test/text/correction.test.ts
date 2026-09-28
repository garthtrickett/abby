import assert from "node:assert/strict";
import test from "node:test";
import { failure, now, setup } from "./fixture.ts";

test("TXT-03 A to B to A correction supersedes old details and keys", async () => {
  const app = await setup("correction");
  await app.turn("request-a1", "Book A", { kind: "requestAction", request: app.book("A", "offer-A") });
  const a1 = (await app.pendingAction());
  await app.turn("request-b", "Actually B", { kind: "requestAction", request: app.book("B", "offer-B") });
  const b = (await app.pendingAction());
  await app.turn("request-a2", "Actually A", { kind: "requestAction", request: app.book("A", "offer-A") });
  const a2 = (await app.pendingAction());
  assert.notEqual(a1.key, a2.key);
  assert.equal((await app.state()).actions[a1.key]?.status, "canceled");
  assert.equal((await app.state()).actions[b.key]?.status, "canceled");
  assert.equal((await app.state()).presentations[a1.presentationId]?.status, "superseded");
  failure(await app.runtime.acceptTurn({ callId: app.callId, turnId: "bad-affirm", text: "yes", quality: "clear", at: now }, { kind: "affirm", actionKey: a1.key, digest: a1.digest, affirmative: true }, now), "confirmationMissing");
  await app.confirm(a2.key);
  await app.worker.process(app.callId, `${a2.key}:write`, now);
  assert.deepEqual(app.host.writes.map(write => write.actionKey), [a2.key]);
});

test("possibly sent action remains visible after caller correction", async () => {
  const app = await setup("late-correction");
  await app.turn("request-a", "Book A", { kind: "requestAction", request: app.book("A", "offer-A") });
  const a = (await app.pendingAction());
  await app.confirm(a.key);
  const marked = await app.runtime.markHostPossiblySent(app.callId, `${a.key}:write`, now);
  assert.equal(marked.ok, true);
  await app.turn("request-b", "Wait, B", { kind: "requestAction", request: app.book("B", "offer-B") });
  assert.equal((await app.state()).actions[a.key]?.status, "dispatched");
  assert.equal((await app.state()).effects[`${a.key}:write`]?.status, "possiblySent");
  assert.equal((await app.pendingAction()).kind, "book");
});
