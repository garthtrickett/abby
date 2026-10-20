import assert from "node:assert/strict";
import test from "node:test";
import { decodeOutboundContactOutcome } from "../../src/cliniko/outbound-contact-outcome.ts";
import { twilioOutboundFinalityFixture } from "../support/twilio-outbound-finality.ts";
import { value } from "../support/outbound-records.ts";

test("actual signed voice, immutable native stop, both independent owners and cold replay compose", async t => {
  const f = await twilioOutboundFinalityFixture(); t.after(f.close); await f.speakStop();
  assert.equal(f.reportPosts.length, 1); assert.equal(f.dncPosts.length, 1); assert.equal(f.callHeld.size, 1); assert.equal(f.contactHeld.size, 1);
  const result = value(await f.recoverFinality());
  assert.deepEqual(value(result.contact), { kind: "nativeContactOutcomeRetained", recallRef: "cliniko:recall:400", contactHold: "released" });
  assert.deepEqual(value(result.call), { kind: "terminal", released: true });
  assert.equal(f.callHeld.size, 0); assert.equal(f.contactHeld.size, 0);
  const outcome = value(decodeOutboundContactOutcome(f.outcomePosts[0]!.notes));
  assert.equal(outcome.actionRef, f.attempt.contactReferences!.outcomeActionRef); assert.equal(outcome.result.kind, "stopRetained");
  // Native180 headroom is not reset by a new owner. A second purpose observes
  // the same physical budget; advance only this fixture's actual budget clock.
  f.state.now = "2026-11-02T00:01:04.000Z";
  const again = value(await f.recoverFinality()); assert.equal(value(again.contact).kind, "nativeContactOutcomeRetained"); assert.equal(value(again.call).kind, "terminal");
  assert.equal(f.outcomePosts.length, 1); assert.equal(f.dncPosts.length, 1); assert.equal(f.carrierCalls, 1); assert.deepEqual(f.intents, []);
});

for (const denied of ["source", "provider", "outcome", "callRelease", "contactRelease", "child", "active", "unclear"] as const)
test(`actual composed finality holds its independent boundary: ${denied}`, async t => {
  const f = await twilioOutboundFinalityFixture(denied === "unclear" ? { quality: "needsClarification" } : {}); t.after(f.close); await f.speakStop();
  if (["child", "active"].includes(denied)) f.finalityState[denied as "child" | "active"] = true;
  else if (denied !== "unclear") f.finalityState[denied] = false;
  const result = value(await f.recoverFinality());
  if (denied === "callRelease") { assert.equal(value(result.contact).kind, "nativeContactOutcomeRetained"); assert.equal(f.contactHeld.size, 0); assert.equal(f.callHeld.size, 1); }
  else if (denied === "contactRelease" || denied === "outcome") { assert.equal(f.contactHeld.size, 1); assert.equal(value(result.call).kind, "terminal"); assert.equal(f.callHeld.size, 0); }
  else { assert.equal(f.contactHeld.size, 1); assert.equal(f.callHeld.size, 1); assert.equal(f.outcomePosts.length, 0); }
  assert.equal(f.carrierCalls, 1);
});
