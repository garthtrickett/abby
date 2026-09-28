import assert from "node:assert/strict";
import test from "node:test";
import { setup } from "./fixture.ts";

test("TXT-07 unavailable reads do not become definite no-match claims", async () => {
  const app = await setup("read-failure");
  await app.turn("patient-unavailable", "Find me", { kind: "readFailure", target: "patient", failure: "unavailable" });
  await app.turn("offer-unavailable", "Any appointments?", { kind: "readFailure", target: "offer", failure: "unavailable" });
  assert.deepEqual((await app.state()).callerMessages, ["I can't check patient records right now.", "I can't check available times right now."]);
  assert.equal(Object.values((await app.state()).staffItems).length, 2);
  assert.equal(Object.values((await app.state()).effects).some(effect => effect.kind === "hostWrite"), false);
  await app.turn("no-offers", "Try another day", { kind: "readFailure", target: "offer", failure: "notFound" });
  assert.equal((await app.state()).callerMessages.at(-1), "I couldn't find an eligible time.");
});
