import assert from "node:assert/strict";
import test, { after } from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import { err, ok } from "../../src/core/model.ts";
import type { Result } from "../../src/core/model.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { CallAdmissionService, callIdFor } from "../../src/voice/admission.ts";
import { AdmissionFallbackCoordinator } from "../../src/voice/admission-fallback.ts";
import type { AdmissionFailureAlert, FallbackOutcome, FallbackRequest } from "../../src/voice/admission-fallback.ts";

const now = "2026-09-28T10:00:00.000Z";
const kinds = process.env.ABBY_LEDGER === "postgres" ? ["memory", "postgres"] as const : ["memory"] as const;
const db = process.env.DATABASE_URL ? connectPostgres(process.env.DATABASE_URL) : undefined;
after(async () => { await db?.destroy(); });

function value<T>(result: Result<T, { kind: string }>): T {
  assert.equal(result.ok, true, result.ok ? "" : result.error.kind);
  return result.value;
}

function fixture(kind: "memory" | "postgres", suffix: string) {
  const scope = { tenantId: `fallback-tenant-${suffix}`, clinicId: `fallback-clinic-${suffix}`, locationId: `fallback-location-${suffix}` };
  const ledger: LedgerStore = kind === "postgres" ? new PostgresLedger(db!, suggestedAt => suggestedAt) : new MemoryLedger();
  let routeAvailable = true;
  let automationEnabled = true;
  let ready = true;
  const admission = new CallAdmissionService(ledger, async dialedNumber =>
    routeAvailable && dialedNumber === "+6125550100" ? ok({ ...referenceDefaultPolicy(scope), automationEnabled }) : err({ kind: "routeUnavailable" as const }), () => now,
  async () => ready ? ok(true) : err({ kind: "readinessFailed", missing: ["mediaTestCall"] }));
  const attempts: FallbackRequest[] = [];
  const alerts: AdmissionFailureAlert[] = [];
  let fallbackOutcome: FallbackOutcome = { kind: "connected", providerConnectionRef: `connection-${suffix}` };
  let fallbackThrows = false;
  let alertThrows = false;
  const coordinator = new AdmissionFallbackCoordinator(admission, {
    async attempt(request) {
      attempts.push(request);
      if (fallbackThrows) throw new Error("provider unavailable");
      return fallbackOutcome;
    },
  }, {
    async notify(alert) {
      alerts.push(alert);
      if (alertThrows) throw new Error("alert unavailable");
    },
  });
  return {
    ledger, coordinator, attempts, alerts,
    setRouteAvailable(value: boolean) { routeAvailable = value; },
    setAutomationEnabled(value: boolean) { automationEnabled = value; },
    setReady(value: boolean) { ready = value; },
    setFallbackOutcome(value: FallbackOutcome) { fallbackOutcome = value; },
    setFallbackThrows(value: boolean) { fallbackThrows = value; },
    setAlertThrows(value: boolean) { alertThrows = value; },
  };
}

for (const kind of kinds) {
  test(`${kind}: disabled automation uses the configured number fallback and records no new call`, async () => {
    const app = fixture(kind, `${kind}-automation-disabled`);
    app.setAutomationEnabled(false);
    const event = { key: { accountRef: `account-${kind}`, providerCallRef: "disabled" }, dialedNumber: "+6125550100", receivedAt: now };
    const routed = value(await app.coordinator.begin(event));
    assert.equal(routed.kind, "fallback");
    assert.equal(app.attempts.length, 1);
    assert.equal(app.alerts[0]?.reason, "automationDisabled");
    assert.equal(value(await app.ledger.findAdmission(callIdFor(event.key))), null);
  });

  test(`${kind}: lapsed readiness uses fallback without accepting a new call`, async () => {
    const app = fixture(kind, `${kind}-readiness-lapsed`);
    app.setReady(false);
    const event = { key: { accountRef: `account-${kind}`, providerCallRef: "not-ready" }, dialedNumber: "+6125550100", receivedAt: now };
    const routed = value(await app.coordinator.begin(event));
    assert.equal(routed.kind, "fallback");
    assert.equal(app.attempts.length, 1);
    assert.equal(app.alerts[0]?.reason, "readinessFailed");
    assert.equal(value(await app.ledger.findAdmission(callIdFor(event.key))), null);
  });

  test(`${kind}: admitted call and replay never invoke provider fallback`, async () => {
    const app = fixture(kind, `${kind}-admitted`);
    const event = { key: { accountRef: `account-${kind}`, providerCallRef: "normal" }, dialedNumber: "+6125550100", receivedAt: now };
    const created = value(await app.coordinator.begin(event));
    assert.equal(created.kind, "admitted");
    if (created.kind === "admitted") assert.equal(created.admission.kind, "created");
    app.setRouteAvailable(false);
    const replay = value(await app.coordinator.begin(event));
    assert.equal(replay.kind, "admitted");
    if (replay.kind === "admitted") assert.equal(replay.admission.kind, "duplicate");
    const conflict = await app.coordinator.begin({ ...event, dialedNumber: "+6125550199" });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.error.kind, "callConflict");
    const invalid = await app.coordinator.begin({ ...event, key: { ...event.key, providerCallRef: "" } });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.error.kind, "invalidTransition");
    assert.deepEqual(app.attempts, []);
    assert.deepEqual(app.alerts, []);
  });

  test(`${kind}: routing failure invokes account-scoped independent fallback and alert`, async () => {
    const app = fixture(kind, `${kind}-route-failure`);
    const event = { key: { accountRef: `account-${kind}`, providerCallRef: "unrouted" }, dialedNumber: "+6125550199", receivedAt: now };
    const result = value(await app.coordinator.begin(event));
    assert.deepEqual(result, { kind: "fallback", callId: callIdFor(event.key), outcome: { kind: "connected", providerConnectionRef: `connection-${kind}-route-failure` }, alerted: true });
    assert.deepEqual(app.attempts, [{ callId: callIdFor(event.key), accountRef: event.key.accountRef, providerCallRef: event.key.providerCallRef, dialedNumber: event.dialedNumber }]);
    assert.deepEqual(app.alerts, [{ callId: callIdFor(event.key), reason: "routeUnavailable", fallback: { kind: "connected", providerConnectionRef: `connection-${kind}-route-failure` } }]);
    assert.equal(value(await app.ledger.findAdmission(callIdFor(event.key))), null);
  });

  test(`${kind}: missing or uncertain provider route cannot claim a connection`, async () => {
    const app = fixture(kind, `${kind}-unproven`);
    const event = { key: { accountRef: `account-${kind}`, providerCallRef: "fallback-unproven" }, dialedNumber: "+6125550199", receivedAt: now };
    app.setFallbackOutcome({ kind: "notConfigured" });
    assert.deepEqual(value(await app.coordinator.begin(event)), { kind: "fallback", callId: callIdFor(event.key), outcome: { kind: "notConfigured" }, alerted: true });
    app.setFallbackOutcome({ kind: "connected", providerConnectionRef: "" });
    assert.deepEqual(value(await app.coordinator.begin({ ...event, key: { ...event.key, providerCallRef: "fallback-invalid" } })), {
      kind: "fallback", callId: callIdFor({ ...event.key, providerCallRef: "fallback-invalid" }), outcome: { kind: "unproven" }, alerted: true,
    });
    app.setFallbackThrows(true);
    app.setAlertThrows(true);
    assert.deepEqual(value(await app.coordinator.begin({ ...event, key: { ...event.key, providerCallRef: "fallback-throws" } })), {
      kind: "fallback", callId: callIdFor({ ...event.key, providerCallRef: "fallback-throws" }), outcome: { kind: "unproven" }, alerted: false,
    });
  });
}

for (const failureKind of ["storageFailure", "storageCorrupt"] as const) {
  test(`${failureKind} still tries independent fallback`, async () => {
    class UnavailableLedger extends MemoryLedger {
      override async findAdmission() { return err({ kind: failureKind }); }
    }
    const ledger = new UnavailableLedger();
    const admission = new CallAdmissionService(ledger, async () => { throw new Error("routing should not be called"); }, () => now);
    const alerts: AdmissionFailureAlert[] = [];
    const coordinator = new AdmissionFallbackCoordinator(admission, {
      async attempt() { return { kind: "failed" as const }; },
    }, { async notify(alert) { alerts.push(alert); } });
    const event = { key: { accountRef: "account-storage", providerCallRef: `call-${failureKind}` }, dialedNumber: "+6125550100", receivedAt: now };
    assert.deepEqual(value(await coordinator.begin(event)), { kind: "fallback", callId: callIdFor(event.key), outcome: { kind: "failed" }, alerted: true });
    assert.deepEqual(alerts, [{ callId: callIdFor(event.key), reason: failureKind, fallback: { kind: "failed" } }]);
  });
}
