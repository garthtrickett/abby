import assert from "node:assert/strict";
import test from "node:test";
import { classMoveFixture } from "../support/class-move.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

for (const boundary of ["live", "revision", "ended", "lease", "stopped", "aborted", "backwardsClock", "invalidClock"] as const)
test(`E2E-419 continuation gateway preserves ${boundary} authority after an asynchronous private preparation`, async () => {
  const f = await classMoveFixture(false, false, undefined, true), external = new AbortController();
  const at = () => f.config.clock();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.verify(); const initial = await f.prepare(); await f.play(); await f.pause(61);
    resultValue(await f.reception.affirm(f.scope, f.turn("initial-yes", "Yes"), initial.key, initial.digest, at()));
    resultValue(await f.reception.drain(f.scope, f.callId, at())); await f.play(); await f.pause(61);
    const prepare = f.host.prepareClassMovement.bind(f.host);
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.host.prepareClassMovement = async query => { const result = await prepare(query); entered(); await held; return result; };
    const turn = f.turn("continue", "Continue my class move");
    const pending = f.reception.continueClassMovement(f.scope, turn, undefined, external.signal);
    await started;
    if (boundary === "revision") resultValue(await f.runtime.acceptTurn(f.turn("newer", "Another request"),
      { kind: "unavailableAction", actionKind: "book" }, at()));
    if (boundary === "ended") resultValue(await f.runtime.endCall(f.callId, f.sessionId, at()));
    if (boundary === "lease") f.setTime(new Date(Date.parse((await f.state()).sessionLease!.expiresAt)).toISOString());
    if (boundary === "stopped") resultValue(await f.ledger.stopWrites(f.scope, "synthetic-owner", "stop before phase readback"));
    if (boundary === "aborted") external.abort();
    if (boundary === "backwardsClock") f.setTime(new Date(Date.parse(at()) - 1).toISOString());
    if (boundary === "invalidClock") f.setTime("invalid");
    const before = await f.state(); release(); const result = await pending, after = await f.state();
    assert.equal(result.ok, boundary === "live");
    if (boundary === "live") {
      assert.equal(after.actions[initial.key]!.status, "awaitingConfirmation");
      assert.ok(after.processedTurnIds.includes(turn.turnId));
    } else assert.deepEqual(after, before, "a late preparation cannot revive lost authority or publish its readback");
    assert.equal(f.writes.length, 1); assert.equal(f.recalls.length, 1);
  } finally { release?.(); await f.close(); }
});
