import assert from "node:assert/strict";
import test from "node:test";
import { clinicDateAt } from "../../scripts/serve-cliniko-voice.ts";

test("E2E-209 configured clinic zone controls today at a UTC date boundary", () => {
  const instant = new Date("2026-09-30T14:30:00.000Z");
  assert.equal(clinicDateAt("Australia/Sydney", instant), "2026-10-01");
  assert.equal(clinicDateAt("Etc/UTC", instant), "2026-09-30");
  assert.throws(() => clinicDateAt("not-a-zone", instant), RangeError);
});
