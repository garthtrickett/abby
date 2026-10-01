import assert from "node:assert/strict";
import test from "node:test";
import { StandaloneOperationalCounters } from "../../src/standalone/operational-counters.ts";

test("standalone operational counters expose only fixed, clinic-scoped totals", () => {
  const counters = new StandaloneOperationalCounters();
  const first = { tenantId: "tenant", clinicId: "first", locationId: "main" };
  const second = { tenantId: "tenant", clinicId: "second", locationId: "main" };
  counters.record(first, "admissionDenied");
  counters.record(first, "callOwnerStarted");
  counters.record(first, "callEnded");
  counters.record(first, "caller-number-canary" as "voiceFailure");
  assert.deepEqual(counters.snapshot(first), { admissionDenied: 1, callOwnerStarted: 1,
    voiceFailure: 0, callEnded: 1, clinikoBudgetDenied: 0,
    clinikoBudgetUnavailable: 0, clinikoProvider429: 0, clinikoProviderUnavailable: 0 });
  assert.deepEqual(counters.snapshot(second), { admissionDenied: 0, callOwnerStarted: 0,
    voiceFailure: 0, callEnded: 0, clinikoBudgetDenied: 0,
    clinikoBudgetUnavailable: 0, clinikoProvider429: 0, clinikoProviderUnavailable: 0 });
  assert.doesNotMatch(JSON.stringify(counters.snapshot(first)), /caller-number-canary|tenant|first/);
});

test("volatile daily operations use UTC days, zero-fill gaps and isolate clinics", () => {
  let now = "2026-09-30T23:59:59.000Z";
  const counters = new StandaloneOperationalCounters(() => now);
  const scope = { tenantId: "tenant", clinicId: "first", locationId: "main" };
  counters.record(scope, "clinikoProvider429");
  now = "2026-10-01T00:00:01.000Z";
  counters.record(scope, "clinikoProviderUnavailable");
  const daily = counters.daily(scope);
  assert.equal(daily.days.length, 7);
  assert.deepEqual(daily.days.slice(-2).map(row => [row.date, row.counts.clinikoProvider429,
    row.counts.clinikoProviderUnavailable]), [
    ["2026-09-30", 1, 0], ["2026-10-01", 0, 1],
  ]);
  assert.equal(counters.daily({ ...scope, clinicId: "other" }).days.at(-1)?.counts.clinikoProviderUnavailable, 0);
  now = "2026-10-07T00:00:00.000Z";
  assert.equal(counters.daily(scope).days[0]?.date, "2026-10-01");
  assert.equal(counters.snapshot(scope).clinikoProvider429, 1, "the original lifetime total remains available");
});
