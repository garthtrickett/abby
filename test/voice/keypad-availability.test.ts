import assert from "node:assert/strict";
import test from "node:test";
import { keypadAvailabilityDate } from "../../src/standalone/keypad-availability.ts";

test("clinic-local keypad dates advance by calendar day, including leap day and year end", () => {
  assert.equal(keypadAvailabilityDate(() => "2028-02-28", "1"), "2028-02-28");
  assert.equal(keypadAvailabilityDate(() => "2028-02-28", "2"), "2028-02-29");
  assert.equal(keypadAvailabilityDate(() => "2026-12-31", "2"), "2027-01-01");
  assert.equal(keypadAvailabilityDate(() => "2026-02-29", "1"), undefined);
  assert.equal(keypadAvailabilityDate(() => "2026-09-29", "9"), undefined);
});
