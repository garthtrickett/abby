import assert from "node:assert/strict";
import test from "node:test";
import { classBookingFixture } from "../support/class-booking.ts";

test("class verification waits for actual synthetic delivery across a held asynchronous budget", async t => {
  let release!: (allowed: boolean) => void, entered!: () => void;
  const gate = new Promise<boolean>(resolve => { release = resolve; }), budgetEntered = new Promise<void>(resolve => { entered = resolve; });
  const f = await classBookingFixture({ verificationBudget: { reserve: async () => { entered(); return gate; } } });
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let completed = false, failure: unknown;
    const verification = f.verify().then(() => { completed = true; }, error => { failure = error; completed = true; });
    await budgetEntered;
    for (let i = 0; i < 51; i++) { t.mock.timers.tick(2); await new Promise<void>(resolve => setImmediate(resolve)); }
    assert.equal(completed, false); assert.equal(f.mail.length, 0);
    release(true); await verification; assert.equal(failure, undefined); assert.equal(f.mail.length, 1); assert.ok(await f.session.verified());
  } finally { release(true); await f.close(); }
});
