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
    clinikoBudgetUnavailable: 0, clinikoProvider429: 0 });
  assert.deepEqual(counters.snapshot(second), { admissionDenied: 0, callOwnerStarted: 0,
    voiceFailure: 0, callEnded: 0, clinikoBudgetDenied: 0,
    clinikoBudgetUnavailable: 0, clinikoProvider429: 0 });
  assert.doesNotMatch(JSON.stringify(counters.snapshot(first)), /caller-number-canary|tenant|first/);
});
