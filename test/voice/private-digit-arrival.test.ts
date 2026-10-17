import assert from "node:assert/strict";
import test from "node:test";
import { privateKeypadCallFixture } from "../support/private-keypad-call.ts";

for (const fails of [false, true]) test(`private digit admission is captured in wire order and ${fails ? "fails closed on owner error" : "arrives unchanged at the private input"}`, async () => {
  let captured: object | undefined, accepted: object | undefined, pendingAtCapture: boolean | undefined;
  const f = await privateKeypadCallFixture({ wrapPrivateInput: input => ({
    claim: input.claim.bind(input), start: input.start.bind(input), blocked: input.blocked.bind(input), stop: input.stop.bind(input),
    captureDigit: (_digit, pending) => { if (fails) throw new Error("Synthetic arrival admission failure"); pendingAtCapture = pending; return captured = Object.freeze({}); },
    accept: (digit, arrival) => { accepted = arrival; return input.accept(digit, arrival); },
  }) });
  try {
    await f.start();
    const result = await f.digit("1");
    if (fails) assert.deepEqual(result, { ok: false, error: { kind: "privateInputUnavailable" } });
    else { assert.ok(result.ok); assert.ok(captured); assert.equal(accepted, captured); assert.equal(pendingAtCapture, true); }
  } finally { await f.close(); }
});
