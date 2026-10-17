import assert from "node:assert/strict";
import test from "node:test";
import { outboundContactTime } from "../../src/standalone/outbound-contact-time.ts";
import type { OutboundContactSchedule } from "../../src/standalone/outbound-contact-time.ts";
const policy: OutboundContactSchedule = { notBefore: "2026-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z",
  timeZone: "UTC", weekdays: [1, 2, 3, 4, 5], opensAt: "09:00", closesAt: "17:00" };
const check = (now: string, kind: string, patch: Partial<OutboundContactSchedule> = {}) => assert.deepEqual(outboundContactTime({ ...policy, ...patch }, now), { kind });
test("schedule bounds and local opening/closing boundaries are exact and independently required", () => {
  check("2025-12-31T23:59:59.999Z", "beforeSchedule"); check("2027-01-01T00:00:00.000Z", "expired");
  check("2026-11-02T08:59:59.999Z", "quiet"); check("2026-11-02T09:00:00.000Z", "due");
  check("2026-11-02T16:59:59.999Z", "due"); check("2026-11-02T17:00:00.000Z", "quiet");
  check("2026-11-01T12:00:00.000Z", "quiet");
});
test("recipient timezone rather than server/UTC time governs civil hours", () => {
  check("2026-11-01T21:59:59.999Z", "quiet", { timeZone: "Australia/Sydney" });
  check("2026-11-01T22:00:00.000Z", "due", { timeZone: "Australia/Sydney" });
  check("2026-11-02T06:00:00.000Z", "quiet", { timeZone: "Australia/Sydney" });
});
test("overnight contact belongs to the explicitly approved starting weekday across midnight", () => {
  const patch = { weekdays: [1], opensAt: "22:00", closesAt: "06:00" };
  check("2026-11-02T21:59:59.999Z", "quiet", patch); check("2026-11-02T22:00:00.000Z", "due", patch);
  check("2026-11-03T00:00:00.000Z", "due", patch); check("2026-11-03T05:59:59.999Z", "due", patch);
  check("2026-11-03T06:00:00.000Z", "quiet", patch); check("2026-11-03T22:00:00.000Z", "quiet", patch);
  check("2026-11-02T02:00:00.000Z", "due", { ...patch, weekdays: [7] });
});
test("explicit24:00 supports a full day without inventing one from equal clock boundaries", () => {
  check("2026-11-02T00:00:00.000Z", "due", { opensAt: "00:00", closesAt: "24:00" });
  check("2026-11-02T23:59:59.999Z", "due", { opensAt: "00:00", closesAt: "24:00" });
  check("2026-11-03T00:00:00.000Z", "quiet", { weekdays: [1], opensAt: "00:00", closesAt: "24:00" });
  check("2026-11-02T00:00:00.000Z", "quiet", { opensAt: "22:00", closesAt: "00:00" });
});
test("spring DST's nonexistent local hour never becomes a dispatch instant", () => {
  const patch = { timeZone: "Europe/London", weekdays: [7], opensAt: "01:00", closesAt: "02:00" };
  check("2026-03-29T00:59:59.999Z", "quiet", patch); check("2026-03-29T01:00:00.000Z", "quiet", patch);
});
test("both fall DST occurrences use the same approved civil window, with an exact closing fence", () => {
  const patch = { timeZone: "Europe/London", weekdays: [7], opensAt: "01:00", closesAt: "02:00" };
  check("2026-10-25T00:30:00.000Z", "due", patch); check("2026-10-25T01:30:00.000Z", "due", patch);
  check("2026-10-25T02:00:00.000Z", "quiet", patch);
});
for (const patch of [{ timeZone: "Missing/Zone" }, { timeZone: " UTC" }, { weekdays: [] }, { weekdays: [0] }, { weekdays: [8] },
  { weekdays: [1, 1] }, { weekdays: [1.5] }, { opensAt: "9:00" }, { opensAt: "24:00" }, { closesAt: "24:01" },
  { opensAt: "09:00", closesAt: "09:00" }, { expiresAt: policy.notBefore }, { notBefore: "2028-01-01T00:00:00.000Z" },
  { notBefore: "2026-02-30T00:00:00.000Z" }, { notBefore: "2026-01-01T00:00:00Z" }, { expiresAt: "not-a-date" }])
  test(`invalid contact schedule fails closed ${JSON.stringify(patch)}`, () => { check("2026-11-02T12:00:00.000Z", "invalid", patch); });
for (const now of ["2026-11-02T12:00:00Z", "2026-11-02T12:00:00+00:00", "2026-02-30T00:00:00.000Z", "", "invalid"])
  test(`noncanonical or invalid current time cannot become due ${now}`, () => check(now, "invalid"));
test("unknown schedule fields and missing explicit policy are refused rather than supplied defaults", () => {
  assert.deepEqual(outboundContactTime({ ...policy, enabled: false } as OutboundContactSchedule, "2026-11-02T12:00:00.000Z"), { kind: "invalid" });
  assert.deepEqual(outboundContactTime(undefined as unknown as OutboundContactSchedule, "2026-11-02T12:00:00.000Z"), { kind: "invalid" });
  check("2025-01-01T00:00:00.000Z", "invalid", { timeZone: "Missing/Zone" });
});
