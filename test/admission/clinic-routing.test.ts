import assert from "node:assert/strict";
import test, { after } from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import type { LocationScope, Result } from "../../src/core/model.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { ClinicPolicyRouter, ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { CallAdmissionService, callIdFor } from "../../src/voice/admission.ts";
import { AdmissionFallbackCoordinator } from "../../src/voice/admission-fallback.ts";

const now = "2026-09-28T10:00:00.000Z";
const kinds = process.env.ABBY_LEDGER === "postgres" ? ["memory", "postgres"] as const : ["memory"] as const;
const db = process.env.DATABASE_URL ? connectPostgres(process.env.DATABASE_URL) : undefined;
after(async () => { await db?.destroy(); });

function value<T>(result: Result<T, { kind: string }>): T {
  assert.ok(result.ok, result.ok ? "" : result.error.kind);
  return result.value;
}

let sequence = 0;
function fixture(kind: "memory" | "postgres") {
  const id = `${kind}-${++sequence}`;
  const main: LocationScope = { tenantId: `tenant-${id}`, clinicId: `clinic-${id}`, locationId: "main" };
  const otherLocation: LocationScope = { ...main, locationId: "other" };
  const foreign: LocationScope = { tenantId: `foreign-tenant-${id}`, clinicId: `foreign-clinic-${id}`, locationId: "foreign" };
  const ledger: LedgerStore = kind === "postgres" ? new PostgresLedger(db!, suggested => suggested) : new MemoryLedger();
  const policy = kind === "postgres"
    ? new PostgresPolicyStore(db!, referenceDefaultPolicy, "requestOnly", async () => ok(true))
    : new MemoryPolicyStore("requestOnly", () => now, async () => ok(true));
  const account = `account-${id}`;
  const number = "+6125550100";
  const sharedNumber = "+6125550101";
  const ambiguousNumber = "+6125550102";
  const assignments = [
    { accountRef: account, dialedNumber: number, ...main, routeVersion: "route-v1" },
    { accountRef: account, dialedNumber: sharedNumber, ...main, spokenName: "Main Street", routeVersion: "route-v1" },
    { accountRef: account, dialedNumber: sharedNumber, ...otherLocation, spokenName: "Northside", routeVersion: "route-v1" },
    { accountRef: account, dialedNumber: ambiguousNumber, ...main, routeVersion: "route-v1" },
    { accountRef: account, dialedNumber: ambiguousNumber, ...foreign, routeVersion: "route-v1" },
    { accountRef: `other-${account}`, dialedNumber: number, ...foreign, routeVersion: "foreign-route-v1" },
  ];
  let routeHost = new ReferenceNumberRoutingHost(assignments);
  let identityReads = 0;
  let policyReads = 0;
  const router = new ClinicPolicyRouter({ identifyCall(accountRef, dialedNumber) {
    identityReads += 1;
    return routeHost.identifyCall(accountRef, dialedNumber);
  } }, { read(scope) { policyReads += 1; return policy.read(scope); } });
  const admission = new CallAdmissionService(ledger, router.resolve, () => now, async () => ok(true));
  const fallbackRequests: string[] = [];
  const alerts: string[] = [];
  const coordinator = new AdmissionFallbackCoordinator(admission, { async attempt(request) {
    fallbackRequests.push(request.dialedNumber);
    return { kind: "connected", providerConnectionRef: `fallback:${request.callId}` };
  } }, { async notify(alert) { alerts.push(alert.reason); } });
  const event = (providerCallRef: string, dialedNumber = number, accountRef = account) =>
    ({ key: { accountRef, providerCallRef }, dialedNumber, receivedAt: now });
  return { main, otherLocation, foreign, ledger, policy, router, account, number, sharedNumber, ambiguousNumber, coordinator, admission,
    event, fallbackRequests, alerts, identityReads: () => identityReads, policyReads: () => policyReads,
    replaceHost(host: ReferenceNumberRoutingHost) { routeHost = host; } };
}

for (const kind of kinds) {
  test(`${kind}: E2E-001 unknown number invokes fallback before policy or patient access`, async () => {
    const app = fixture(kind);
    const event = app.event("unknown", "+6125550199");
    const outcome = value(await app.coordinator.begin(event));
    assert.equal(outcome.kind, "fallback");
    assert.equal(outcome.outcome.kind, "connected");
    assert.deepEqual(app.fallbackRequests, [event.dialedNumber]);
    assert.deepEqual(app.alerts, ["unknownNumber"]);
    assert.equal(app.policyReads(), 0);
    assert.equal(value(await app.ledger.findAdmission(callIdFor(event.key))), null);
  });

  test(`${kind}: E2E-054 provider account separates identical numbers and ambiguous clinic routes fail closed`, async () => {
    const app = fixture(kind);
    const ambiguous = app.event("ambiguous", app.ambiguousNumber);
    const outcome = value(await app.coordinator.begin(ambiguous));
    assert.equal(outcome.kind, "fallback");
    assert.deepEqual(app.alerts, ["ambiguousClinic"]);
    assert.equal(app.policyReads(), 0);
    assert.equal(value(await app.ledger.findAdmission(callIdFor(ambiguous.key))), null);
    value(await app.policy.changeAutomationEnabled(app.main, "0", true, "clinic-admin"));
    value(await app.policy.changeAutomationEnabled(app.foreign, "0", true, "foreign-admin"));
    const first = value(await app.admission.begin(app.event("same-number", app.number)));
    assert.equal(first.kind, "created");
    const other = value(await app.admission.begin(app.event("same-number", app.number, `other-${app.account}`)));
    assert.equal(other.kind, "created");
    assert.notEqual(first.receipt.callId, other.receipt.callId);
    const localState = value(await new CallRuntime(app.ledger, app.main).read(first.receipt.callId));
    const foreignState = value(await new CallRuntime(app.ledger, app.foreign).read(other.receipt.callId));
    assert.equal(localState.policy.numberRouteVersion, "route-v1");
    assert.equal(foreignState.policy.numberRouteVersion, "foreign-route-v1");
    assert.equal((await new CallRuntime(app.ledger, app.main).read(other.receipt.callId)).ok, false);
  });

  test(`${kind}: shared number without a location choice uses fallback and never guesses a location`, async () => {
    const app = fixture(kind);
    value(await app.policy.changeAutomationEnabled(app.main, "0", true, "clinic-admin"));
    const event = app.event("shared", app.sharedNumber);
    const outcome = value(await app.coordinator.begin(event));
    assert.equal(outcome.kind, "fallback");
    assert.deepEqual(app.alerts, ["locationChoiceRequired"]);
    assert.equal(app.policyReads(), 0);
    assert.equal(value(await app.ledger.findAdmission(callIdFor(event.key))), null);
  });

  test(`${kind}: number reassignment does not reroute a replayed admitted call`, async () => {
    const app = fixture(kind);
    value(await app.policy.changeAutomationEnabled(app.main, "0", true, "clinic-admin"));
    const event = app.event("reassigned");
    const created = value(await app.admission.begin(event));
    assert.equal(created.kind, "created");
    assert.equal(value(await new CallRuntime(app.ledger, app.main).read(created.receipt.callId)).policy.numberRouteVersion, "route-v1");
    const reads = app.identityReads();
    app.replaceHost(new ReferenceNumberRoutingHost([]));
    const replay = value(await app.admission.begin(event));
    assert.equal(replay.kind, "duplicate");
    assert.equal(app.identityReads(), reads);
    const conflicting = await app.admission.begin({ ...event, dialedNumber: "+6125550199" });
    assert.ok(!conflicting.ok);
    assert.equal(conflicting.error.kind, "callConflict");
    assert.equal(app.identityReads(), reads);
  });

  test(`${kind}: malformed identity and cross-clinic policy cannot admit a call`, async () => {
    const app = fixture(kind);
    let policyReads = 0;
    const wrongIdentity = new ClinicPolicyRouter({ async identifyCall(accountRef, dialedNumber) {
      return ok({ accountRef: `wrong-${accountRef}`, dialedNumber, tenantId: app.main.tenantId,
        clinicId: app.main.clinicId, candidateLocationIds: [app.main.locationId], routeVersion: "route-v1" });
    } }, { async read(scope) { policyReads += 1; return app.policy.read(scope); } });
    const rejectedIdentity = await new CallAdmissionService(app.ledger, wrongIdentity.resolve, () => now,
      async () => ok(true)).begin(app.event("wrong-identity"));
    assert.ok(!rejectedIdentity.ok);
    assert.equal(rejectedIdentity.error.kind, "routeUnavailable");
    assert.equal(policyReads, 0);

    const wrongPolicy = new ClinicPolicyRouter({ async identifyCall(accountRef, dialedNumber) {
      return ok({ accountRef, dialedNumber, tenantId: app.main.tenantId,
        clinicId: app.main.clinicId, candidateLocationIds: [app.main.locationId], routeVersion: "route-v1" });
    } }, { async read() { return ok(referenceDefaultPolicy(app.foreign)); } });
    const rejectedPolicyEvent = app.event("wrong-policy");
    const rejectedPolicy = await new CallAdmissionService(app.ledger, wrongPolicy.resolve, () => now,
      async () => ok(true)).begin(rejectedPolicyEvent);
    assert.ok(!rejectedPolicy.ok);
    assert.equal(rejectedPolicy.error.kind, "routeUnavailable");
    assert.equal(value(await app.ledger.findAdmission(callIdFor(rejectedPolicyEvent.key))), null);
  });

  test(`${kind}: selected shared-number location binds policy and rejects other scopes`, async () => {
    const app = fixture(kind);
    const identity = value(await app.router.identify(app.account, app.sharedNumber));
    assert.deepEqual(identity.candidateLocationIds, ["main", "other"]);
    assert.equal(app.policyReads(), 0);
    const choice = { tenantId: identity.tenantId, clinicId: identity.clinicId,
      locationId: app.otherLocation.locationId, routeVersion: identity.routeVersion };
    const invalid = await app.router.resolveSelected(app.account, app.sharedNumber, { ...choice, locationId: "foreign" });
    assert.ok(!invalid.ok);
    assert.equal(invalid.error.kind, "invalidLocationChoice");
    assert.equal(app.policyReads(), 0);
    const stale = await app.router.resolveSelected(app.account, app.sharedNumber, { ...choice, tenantId: app.foreign.tenantId });
    assert.ok(!stale.ok);
    assert.equal(stale.error.kind, "staleLocationChoice");
    assert.equal(app.policyReads(), 0);

    value(await app.policy.changeAutomationEnabled(app.otherLocation, "0", true, "clinic-admin"));
    const event = app.event("chosen-location", app.sharedNumber);
    const chosenAdmission = new CallAdmissionService(app.ledger,
      (dialedNumber, accountRef) => app.router.resolveSelected(accountRef, dialedNumber, choice), () => now, async () => ok(true));
    const admitted = value(await chosenAdmission.begin(event));
    assert.equal(admitted.kind, "created");
    assert.deepEqual(admitted.receipt.scope, app.otherLocation);
    assert.equal(value(await new CallRuntime(app.ledger, app.otherLocation).read(admitted.receipt.callId)).policy.numberRouteVersion,
      choice.routeVersion);
    assert.equal((await new CallRuntime(app.ledger, app.main).read(admitted.receipt.callId)).ok, false);
    assert.equal((await new CallRuntime(app.ledger, app.foreign).read(admitted.receipt.callId)).ok, false);
  });

  test(`${kind}: changed shared-number route invalidates a pending choice`, async () => {
    const app = fixture(kind);
    const identity = value(await app.router.identify(app.account, app.sharedNumber));
    const choice = { tenantId: identity.tenantId, clinicId: identity.clinicId,
      locationId: app.main.locationId, routeVersion: identity.routeVersion };
    app.replaceHost(new ReferenceNumberRoutingHost([
      { accountRef: app.account, dialedNumber: app.sharedNumber, ...app.main, spokenName: "Main Street", routeVersion: "route-v2" },
      { accountRef: app.account, dialedNumber: app.sharedNumber, ...app.otherLocation, spokenName: "Northside", routeVersion: "route-v2" },
    ]));
    const event = app.event("stale-choice", app.sharedNumber);
    const selected = new CallAdmissionService(app.ledger,
      (dialedNumber, accountRef) => app.router.resolveSelected(accountRef, dialedNumber, choice), () => now, async () => ok(true));
    const outcome = await selected.begin(event);
    assert.ok(!outcome.ok);
    assert.equal(outcome.error.kind, "staleLocationChoice");
    assert.equal(app.policyReads(), 0);
    assert.equal(value(await app.ledger.findAdmission(callIdFor(event.key))), null);
  });
}
