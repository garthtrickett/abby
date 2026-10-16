// E2E-419: a native phase quota wait is listening metadata, never consent or a send.
import assert from "node:assert/strict";
import test from "node:test";
import { classMoveFixture } from "../support/class-move.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("staged caller waits for actual phase headroom before protected preparation without losing its owner", async () => {
  const f = await classMoveFixture(false, false, undefined, true), signal = new AbortController().signal;
  try {
    await f.verify(); const initial = await f.prepare(); await f.play(); await f.pause(61);
    resultValue(await f.reception.affirm(f.scope, f.turn("initial-yes", "Yes"), initial.key, initial.digest, f.config.clock()));
    resultValue(await f.reception.drain(f.scope, f.callId, f.config.clock())); await f.play();
    let claimed = 0;
    while (await f.config.cliniko.rateBudget.claim() === null) assert.ok(++claimed <= 180);
    const writes = f.writes.length, mail = f.mail.length;
    const next = resultValue(await f.reception.continueClassMovement(f.scope, f.turn("wait", "Continue my class move")));
    const id = next.pendingPresentationId!; assert.ok(id);
    const notice = next.presentations[id]!; assert.equal(notice.kind, "notice");
    assert.ok(notice.kind === "notice" && notice.confirmationWaitSeconds === 60);
    assert.match(notice.approvedText, /wait about 60 seconds.*ask to continue/);
    assert.equal(next.actions[initial.key]!.status, "pendingContinuation");
    assert.equal(next.actions[initial.key]!.classMovementConsent, undefined);
    assert.equal(f.writes.length, writes); assert.equal(f.mail.length, mail);
    await f.play(); await f.pause(61);
    const ready = resultValue(await f.reception.continueClassMovement(f.scope, f.turn("again", "Continue my class move")));
    assert.equal(ready.actions[initial.key]!.status, "awaitingConfirmation");
    assert.equal(f.writes.length, writes);
  } finally { await f.close(); }
});

for (const seconds of [0, 61, NaN]) test(`phase quota notice rejects invalid wait ${seconds} without changing the pending action`, async () => {
  const f = await classMoveFixture(false, false, undefined, true);
  try {
    await f.verify(); const initial = await f.prepare(); await f.play(); await f.pause(61);
    resultValue(await f.reception.affirm(f.scope, f.turn("initial-yes", "Yes"), initial.key, initial.digest, f.config.clock()));
    resultValue(await f.reception.drain(f.scope, f.callId, f.config.clock())); await f.play();
    const before = await f.state();
    const result = await f.runtime.acceptTurn(f.turn("bad-wait", "Continue my class move"),
      { kind: "classMovementPreparation", actionKey: initial.key, preparation: { kind: "quotaWait", seconds } }, f.config.clock());
    assert.equal(result.ok, false); assert.deepEqual(await f.state(), before); assert.equal(f.writes.length, 1);
  } finally { await f.close(); }
});

test("aborting a held phase headroom query preserves the private owner and cannot publish late", { timeout: 10000 }, async () => {
  const f = await classMoveFixture(false, false, undefined, true), external = new AbortController();
  let release!: (value: null) => void;
  const held = new Promise<null>(resolve => { release = resolve; });
  const budget = f.config.cliniko.rateBudget, check = budget.checkHeadroom;
  try {
    await f.verify(); const initial = await f.prepare(); await f.play(); await f.pause(61);
    resultValue(await f.reception.affirm(f.scope, f.turn("initial-yes", "Yes"), initial.key, initial.digest, f.config.clock()));
    resultValue(await f.reception.drain(f.scope, f.callId, f.config.clock())); await f.play(); await f.pause(61);
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    Object.defineProperty(budget, "checkHeadroom", { configurable: true, value: () => { entered(); return held; } });
    const pending = f.host.prepareClassMovementContinuation(initial.key, external.signal);
    await started; const before = await f.state(); external.abort();
    assert.equal((await pending).ok, false); assert.deepEqual(await f.state(), before);
    release(null); await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(await f.state(), before); assert.equal(f.writes.length, 1);
    Object.defineProperty(budget, "checkHeadroom", { configurable: true, value: check });
    assert.equal(resultValue(await f.host.prepareClassMovementContinuation(initial.key, new AbortController().signal)).kind, "ready");
  } finally { release(null); Object.defineProperty(budget, "checkHeadroom", { configurable: true, value: check }); await f.close(); }
});
