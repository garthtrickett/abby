import assert from "node:assert/strict";
import test from "node:test";
import { setup } from "./fixture.ts";

test("TXT-04 ambiguous target creates staff item without disclosure or write", () => {
  const app = setup("ambiguous");
  app.turn("ambiguous", "Which of my appointments?", { kind: "ambiguousTarget" });
  assert.equal(app.host.writes.length, 0);
  assert.equal(Object.values(app.state().effects).some(effect => effect.kind === "hostWrite"), false);
  assert.equal(Object.values(app.state().staffItems)[0]?.reason, "verificationFailed");
  assert.equal(app.state().callerMessages.some(message => message.includes(app.patient.patientRef)), false);
});
