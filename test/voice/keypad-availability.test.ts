import assert from "node:assert/strict";
import test from "node:test";
import { keypadAvailabilityDate, keypadAvailabilityRange } from "../../src/standalone/keypad-availability.ts";

test("clinic-local keypad dates advance by calendar day, including leap day and year end", () => {
  assert.equal(keypadAvailabilityDate(() => "2028-02-28", "1"), "2028-02-28");
  assert.equal(keypadAvailabilityDate(() => "2028-02-28", "2"), "2028-02-29");
  assert.equal(keypadAvailabilityDate(() => "2026-12-31", "2"), "2027-01-01");
  assert.equal(keypadAvailabilityDate(() => "2026-02-29", "1"), undefined);
  assert.equal(keypadAvailabilityDate(() => "2026-09-29", "9"), undefined);
});

test("a clinic-approved seven-day keypad choice stays inside seven calendar dates", () => {
  assert.deepEqual(keypadAvailabilityRange(() => "2028-02-28", "3", true),
    { from: "2028-02-28", to: "2028-03-05" });
  assert.deepEqual(keypadAvailabilityRange(() => "2026-12-31", "3", true),
    { from: "2026-12-31", to: "2027-01-06" });
  assert.equal(keypadAvailabilityRange(() => "2028-02-28", "3", false), null);
  assert.equal(keypadAvailabilityRange(() => "2028-02-28", "9", true), null);
  assert.equal(keypadAvailabilityRange(() => "2026-02-29", "3", true), undefined);
});
