import assert from "node:assert/strict";
import test from "node:test";
import { bookingDateRangeLanguage } from "../../src/standalone/booking-date-range-language.ts";
import { bookingMenuPresentation } from "../../src/core/booking-menu.ts";
import type { BookingMenuRead } from "../../src/core/booking-menu.ts";

test("E2E-356 exact calendar pairs preserve caller bounds and reject invalid/reversed dates without clock guesses", () => {
  for (const text of ["Show times between October 5 and November 30.", "Could you check availability from 5 October to 30 November, please?",
    "What appointments are available between 2026-10-05 and 2026-11-30?"]) {
    assert.deepEqual(bookingDateRangeLanguage(text, "2026-10-04"), { kind: "range", from: "2026-10-05", to: "2026-11-30" });
  }
  assert.deepEqual(bookingDateRangeLanguage("from December 20 2026 through January 5 2027", "2026-10-04"), { kind: "range", from: "2026-12-20", to: "2027-01-05" });
  for (const text of ["between November 30 and October 5", "between October 3 and October 5", "from February 30 2027 to March 5 2027",
    "from December 20 to January 5"]) assert.deepEqual(bookingDateRangeLanguage(text, "2026-10-04"), { kind: "ambiguous" });
  for (const text of ["between 11 am and 2 pm", "the second time", "cancel between October 5 and November 30",
    "between October 5 and November 30 or next year"]) assert.equal(bookingDateRangeLanguage(text, "2026-10-04"), undefined);
});

test("E2E-356 longer menu presentation requires bounded current-host evidence while legacy evidence stays limited", () => {
  const scope = { tenantId: "tenant", clinicId: "clinic", locationId: "main" }, now = "2026-10-04T06:00:00.000Z";
  const binding = { scope, callId: "call", sessionId: "session", policyVersion: "policy" };
  const read: BookingMenuRead = { ...binding, observedAt: now, timeZone: "Australia/Sydney", practitionerName: "Practitioner",
    appointmentTypeName: "Service", reservable: false, locationName: "North", choices: [],
    searchScope: { locationName: "North", practitioners: ["Practitioner"], from: "2026-10-05", to: "2026-11-30", selection: "default" } };
  assert.equal(bookingMenuPresentation(read, binding, now).ok, false);
  assert.equal(bookingMenuPresentation({ ...read, maxSearchDays: 90 }, binding, now).ok, true);
  for (const maxSearchDays of [0, 7, 91, "90", true]) assert.equal(bookingMenuPresentation({ ...read, maxSearchDays } as BookingMenuRead, binding, now).ok, false);
});
