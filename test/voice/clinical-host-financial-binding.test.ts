import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoVoiceClinicalHost } from "../../src/standalone/cliniko-voice-clinical-host.ts";
import { financialClassBookingFixture } from "../support/financial-class-booking.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { ok } from "../../src/core/model.ts";
import type { ClinikoSelectionApproval } from "../../src/cliniko/catalogue-setup.ts";
async function fixture() {
  const f = await financialClassBookingFixture(), config = f.flowConfig;
  const greeting = resultValue(await config.policies.read(f.scope)).greeting!;
  const host = new ClinikoVoiceClinicalHost({ ...config, scope: f.scope, greeting, intent: () => async () => ok({ kind: "model" as const }) });
  const approval: ClinikoSelectionApproval = { scope: f.scope, route: { accountRef: "test", dialedNumber: f.inbound.dialedNumber, routeVersion: "test" },
    selection: { businessId: config.cliniko.businessId, practitionerId: config.cliniko.practitionerId, appointmentTypeId: config.cliniko.appointmentTypeId, policyVersion: config.policyVersion },
    alternatives: [], businessTimeZone: config.cliniko.timeZone, credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey),
    catalogueObservedAt: config.clock!(), approvedAt: config.clock!(), approvedBy: "synthetic-admin", patientActionMode: "unavailable", patientRequestMode: "unavailable" };
  const context = { receipt: config.receipt, inbound: config.inbound, sessionId: config.sessionId, ledger: config.ledger, policies: config.policies,
    signal: config.signal, clock: config.clock!, privatePresentation: { play: async () => true } };
  return { f, config, host, approval, context };
}
test("a financial clinical host refuses an admitted call without its own private financial playback port", async t => {
  const f = await fixture(); t.after(f.f.close);
  assert.throws(() => f.host.workflow(f.approval).create(f.context), /clinical voice admission mismatch/);
});
test("the real clinical host accepts only a callable financial port owned by this admitted call", async t => {
  const f = await fixture(); t.after(f.f.close);
  assert.throws(() => f.host.workflow(f.approval).create({ ...f.context, financialPresentation: {} as never }), /clinical voice admission mismatch/);
  let plays = 0;
  const owner = f.host.workflow(f.approval).create({ ...f.context, financialPresentation: { play: async () => { plays++; return undefined; } } });
  t.after(() => owner.dispose()); assert.equal(plays, 0, "construction alone never presents private terms or mints consent");
  assert.equal(f.f.funding.rows.size, 0); assert.equal(f.f.writes.length, 0);
});
for (const mismatch of ["scope", "business", "credential", "budget"] as const)
  test(`financial ${mismatch} cannot attach to another admitted clinical account`, async t => {
    const f = await fixture(); t.after(f.f.close); const financial = f.config.financial!;
    const native = { ...financial.native,
      ...(mismatch === "scope" ? { scope: { ...financial.native.scope, clinicId: "different-clinic" } } : {}),
      ...(mismatch === "business" ? { businessId: "99" } : {}),
      ...(mismatch === "credential" ? { apiKey: "other-key-au5" } : {}),
      ...(mismatch === "budget" ? { rateBudget: { claim: () => null, observe429: () => ({ kind: "rateLimited" as const }) } } : {}) };
    assert.throws(() => new ClinikoVoiceClinicalHost({ ...f.config, financial: { ...financial, native }, scope: f.f.scope,
      greeting: f.host.greeting, intent: () => async () => ok({ kind: "model" as const }) }), /invalid clinical financial binding/);
  });
