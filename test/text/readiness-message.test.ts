import assert from "node:assert/strict";
import test from "node:test";
import { automationReadinessFailureMessage } from "../../src/standalone/dashboard/readiness-message.ts";

test("R09 automation readiness explains the current missing requirement and a supervised next step", () => {
  const message = automationReadinessFailureMessage(["mediaTestCall"]);
  assert.match(message, /Clinic setup incomplete: passed media test call\./);
  assert.match(message, /Next:.*supervised representative call test/);
  assert.match(message, /cannot be enabled until the clinic's readiness checks pass/);
});

test("R09 multiple readiness reasons share one stable explanation without duplicate instructions", () => {
  const message = automationReadinessFailureMessage(["mediaTestCall", "approvedGreeting", "mediaTestCall"]);
  assert.equal(message, automationReadinessFailureMessage(["approvedGreeting", "mediaTestCall"]));
  assert.equal(message.match(/passed media test call/g)?.length, 1);
  assert.equal(message.match(/Review and approve the current clinic greeting/g)?.length, 1);
  assert.match(message, /an approved greeting/);
  assert.doesNotMatch(message, /other readiness evidence/);
});

test("R09 unknown or malformed readiness details retain a blocked explanation without exposing raw values", () => {
  const privateValue = "synthetic-private-readiness-detail-872643";
  for (const missing of [undefined, null, [], {}, privateValue, [privateValue], [null], ["mediaTestCall", privateValue]]) {
    const message = automationReadinessFailureMessage(missing);
    assert.match(message, /readiness evidence/);
    assert.match(message, /recheck the clinic's current readiness evidence/);
    assert.match(message, /cannot be enabled/);
    assert.equal(message.includes(privateValue), false);
  }
});
