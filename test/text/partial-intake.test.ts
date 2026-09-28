import assert from "node:assert/strict";
import test from "node:test";
import { deadline, now, setup } from "./fixture.ts";

test("TXT-06 committed intake survives rejected booking and links follow-up", async () => {
  const app = await setup("partial-intake");
  await app.turn("intake", "Register me", { kind: "requestAction", request: app.intake });
  const intake = (await app.pendingAction());
  await app.confirm(intake.key, "intake-yes");
  app.host.writeResult = mutation => ({ kind: "committed", actionKey: mutation.actionKey, hostRef: "patient-created-1" });
  await app.worker.process(app.callId, `${intake.key}:write`, now);
  await app.turn("booking", "Book physio", { kind: "requestAction", request: app.book() });
  const booking = (await app.pendingAction());
  await app.confirm(booking.key, "booking-yes");
  app.host.writeResult = mutation => ({ kind: "rejected", actionKey: mutation.actionKey, reason: "conflict" });
  await app.worker.process(app.callId, `${booking.key}:write`, now);
  assert.equal((await app.state()).actions[intake.key]?.hostRef, "patient-created-1");
  assert.equal((await app.state()).actions[intake.key]?.status, "committed");
  assert.equal((await app.state()).actions[booking.key]?.status, "rejected");
  assert.equal(Object.values((await app.state()).staffItems)[0]?.linkedActionKey, booking.key);
  assert.equal((await app.state()).callerMessages.at(-1), "That action was not completed.");
  assert.equal((await app.state()).callerMessages.some(message => message === "Your booking is confirmed."), false);
});

test("TXT-06 uncertain booking after intake keeps patient and unresolved booking", async () => {
  const app = await setup("partial-uncertain");
  await app.turn("intake", "Register", { kind: "requestAction", request: app.intake });
  const intake = (await app.pendingAction());
  await app.confirm(intake.key, "intake-yes");
  app.host.writeResult = mutation => ({ kind: "committed", actionKey: mutation.actionKey, hostRef: "patient-created-2" });
  await app.worker.process(app.callId, `${intake.key}:write`, now);
  await app.turn("booking", "Book", { kind: "requestAction", request: app.book() });
  const booking = (await app.pendingAction());
  await app.confirm(booking.key, "booking-yes");
  app.host.writeResult = mutation => ({ kind: "uncertain", actionKey: mutation.actionKey, reconcileAfter: now, deadline });
  await app.worker.process(app.callId, `${booking.key}:write`, now);
  assert.equal((await app.state()).actions[intake.key]?.hostRef, "patient-created-2");
  assert.equal((await app.state()).actions[booking.key]?.status, "uncertain");
  assert.equal(Object.values((await app.state()).staffItems)[0]?.linkedActionKey, booking.key);
  assert.equal((await app.state()).callerMessages.at(-1)?.includes("can't confirm"), true);
  assert.equal((await app.state()).callerMessages.some(message => message === "Your booking is confirmed."), false);
});
