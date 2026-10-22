import assert from "node:assert/strict";
import test from "node:test";
import { missedCallText } from "../../src/core/missed-call.ts";
import { incomingCallFlowFixture as composed } from "../support/incoming-call-flow.ts";
import { incomingCallContextFixture } from "../support/incoming-call-context.ts";
import { value } from "../support/outbound-records.ts";


for (const sickDay of [false, true]) {
  test(`actual incoming call flow resolves verified ${sickDay ? "sick-day" : "follow-up"} purpose without automatic proof or new work`, async t => {
    const f = await incomingCallContextFixture({ sickDay }); t.after(f.close);
    const c = await composed(f); t.after(c.close);
    const unknown = value(await c.reception.respondMissedCall(f.scope, c.turn("Why did the clinic call me?")));
    assert.equal(unknown.callerMessages.at(-1), missedCallText); assert.equal(f.mail.length, 0); assert.equal(f.lists, 0);
    await c.verify();
    const answer = value(await c.reception.respondMissedCall(f.scope, c.turn("Why did the clinic call me?")));
    assert.equal(answer.callerMessages.at(-1), sickDay
      ? "The clinic called about rescheduling your appointment. I can help with that, or you can contact reception."
      : "The clinic called about arranging a follow-up appointment. I can help with that, or you can contact reception.");
    assert.equal(f.lists, 2); assert.equal(f.mail.length, 1);
    assert.equal(Object.keys(answer.actions).length, 0); assert.ok(f.native.calls.slice(1).every(call => call.method === "GET"));
  });
}

test("the composed incoming route retains the public reply when native disclosure is withdrawn", async t => {
  const f = await incomingCallContextFixture({ sickDay: true }); t.after(f.close); const c = await composed(f); t.after(c.close);
  await c.verify(); f.state.live = false;
  const reply = value(await c.reception.respondMissedCall(f.scope, c.turn("Why did the clinic call me?")));
  assert.equal(reply.callerMessages.at(-1), missedCallText); assert.equal(f.lists, 0); assert.equal(f.mail.length, 1);
});

test("the composed incoming route preserves the verified subject's monotonic identity denial", async t => {
  const f = await incomingCallContextFixture({ sickDay: true }); t.after(f.close); const c = await composed(f); t.after(c.close);
  await c.verify(); value(await c.reception.respondMissedCall(f.scope, c.turn("Why did the clinic call me?")));
  const before = f.lists;
  value(await f.runtime.acceptTurn(c.turn("That's not me"), { kind: "callerIdentityDenied", reason: "identityDisagreement" }, f.inbound.receivedAt));
  const reply = value(await c.reception.respondMissedCall(f.scope, c.turn("Why did the clinic call me?")));
  assert.equal(reply.callerMessages.at(-1), missedCallText); assert.equal(reply.callerIdentityDenied, "identityDisagreement"); assert.equal(f.lists, before);
});

test("actual incoming call flow explains a verified unanswered original without granting answered-call or clinical authority", async t => {
  const f = await incomingCallContextFixture(); t.after(f.close); f.replaceWithUnanswered();
  const c = await composed(f); t.after(c.close); await c.verify();
  const answer = value(await c.reception.respondMissedCall(f.scope, c.turn("Why did the clinic call me?")));
  assert.equal(answer.callerMessages.at(-1), "The clinic called about arranging a follow-up appointment. I can help with that, or you can contact reception.");
  assert.equal(Object.keys(answer.actions).length, 0); assert.equal(f.mail.length, 1);
});
