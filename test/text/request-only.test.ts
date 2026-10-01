import assert from "node:assert/strict";
import test from "node:test";
import { now, setup } from "./fixture.ts";

test("TXT-05 request-only reschedule and intake open staff tasks, never PMS writes", async () => {
  const app = await setup("request-only", { intake: "requestOnly" });
  const target = { scope: app.scope, appointmentRef: "appointment-1", patientRef: app.patient.patientRef,
    startsAt: "2026-09-29T10:00:00.000Z", endsAt: "2026-09-29T10:30:00.000Z", timeZone: "Australia/Sydney" };
  const terms = { version: "terms-1", approvedText: "No rescheduling fee applies.", expiresAt: "2026-09-29T10:00:00.000Z" };
  await app.turn("reschedule", "Move my appointment", { kind: "requestAction", request: { kind: "reschedule", patient: app.patient, target, offer: app.offer(), terms } });
  await app.turn("intake", "Register me", { kind: "requestAction", request: app.intake });
  assert.equal(Object.values((await app.state()).effects).filter(effect => effect.kind === "hostWrite").length, 0);
  const items = Object.values((await app.state()).staffItems);
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.deepEqual(item.destination, app.policy.staffDestination);
    assert.ok(item.request);
    assert.ok(Date.parse(item.dueAt) > Date.parse(now));
    await app.worker.process(app.callId, `${item.key}:open`, now);
  }
  assert.equal(app.host.tasks.length, 2);
  assert.equal(app.host.writes.length, 0);
  assert.equal(Object.values((await app.state()).staffItems).every(item => item.status === "open"), true);
  assert.equal((await app.state()).callerMessages.every(message => message.includes("request staff follow-up")), true);
});
