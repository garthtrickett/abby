import assert from "node:assert/strict";
import test from "node:test";
import { setup } from "./fixture.ts";

test("TXT-07 unavailable reads do not become definite no-match claims", () => {
  const app = setup("read-failure");
  app.turn("patient-unavailable", "Find me", { kind: "readFailure", target: "patient", failure: "unavailable" });
  app.turn("offer-unavailable", "Any appointments?", { kind: "readFailure", target: "offer", failure: "unavailable" });
  assert.deepEqual(app.state().callerMessages, ["I can't check patient records right now.", "I can't check available times right now."]);
  assert.equal(Object.values(app.state().staffItems).length, 2);
  assert.equal(Object.values(app.state().effects).some(effect => effect.kind === "hostWrite"), false);
  app.turn("no-offers", "Try another day", { kind: "readFailure", target: "offer", failure: "notFound" });
  assert.equal(app.state().callerMessages.at(-1), "I couldn't find an eligible time.");
});
