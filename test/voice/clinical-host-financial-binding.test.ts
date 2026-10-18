import assert from "node:assert/strict";
import test from "node:test";
import { callIdFor } from "../../src/voice/admission.ts";
import { ClinikoVoiceClinicalHost } from "../../src/standalone/cliniko-voice-clinical-host.ts";
import { financialClassBookingFixture } from "../support/financial-class-booking.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
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
  const ledger = config.ledger; assert.ok(ledger instanceof MemoryLedger);
  const context = { receipt: config.receipt, inbound: config.inbound, sessionId: config.sessionId, ledger, policies: config.policies,
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

test("shared voice host constructs a fresh financial policy for each admitted call", async t => {
  const f = await fixture(); t.after(f.f.close); const { policy, ...common } = f.config.financial!;
  const contexts: import("../../src/standalone/cliniko-financial-booking-preparation.ts").FinancialBookingPolicyCallContext[] = [];
  const policies: object[] = [];
  const host = new ClinikoVoiceClinicalHost({ ...f.config, scope: f.f.scope, greeting: f.host.greeting,
    intent: () => async () => ok({ kind: "model" as const }), financial: { ...common, policyForCall(context) {
      contexts.push(context); const next = { ...policy }; policies.push(next); return next;
    } } });
  const presentation = { play: async () => undefined };
  const first = host.workflow(f.approval).create({ ...f.context, financialPresentation: presentation }); t.after(() => first.dispose());
  const key = { ...f.context.inbound.key, providerCallRef: "second-financial-call" };
  const receipt = { ...f.context.receipt, callId: callIdFor(key), admission: { ...f.context.receipt.admission, key } };
  const secondContext = { ...f.context, receipt, inbound: { ...f.context.inbound, key }, sessionId: "second-session", financialPresentation: presentation };
  const second = host.workflow(f.approval).create(secondContext); t.after(() => second.dispose());
  assert.equal(contexts.length, 2); assert.notEqual(policies[0], policies[1]);
  assert.equal(contexts[0]!.callId, f.context.receipt.callId); assert.equal(contexts[1]!.callId, receipt.callId);
  assert.equal(contexts[1]!.sessionId, "second-session"); assert.ok(Object.isFrozen(contexts[1]!.scope));
  assert.equal(f.f.funding.rows.size, 0); assert.equal(f.f.writes.length, 0);
});

test("financial policy factory cannot reuse a mutable owner across separate workflow objects", async t => {
  const f = await fixture(); t.after(f.f.close); const { policy, ...common } = f.config.financial!;
  const host = new ClinikoVoiceClinicalHost({ ...f.config, scope: f.f.scope, greeting: f.host.greeting,
    intent: () => async () => ok({ kind: "model" as const }), financial: { ...common, policyForCall: () => policy } });
  const context = { ...f.context, financialPresentation: { play: async () => undefined } };
  const owner = host.workflow(f.approval).create(context); t.after(() => owner.dispose());
  assert.throws(() => host.workflow(f.approval).create(context), /financial policy unavailable/);
});

test("call-owned financial policy cannot be installed as a shared voice policy", async t => {
  const f = await fixture(); t.after(f.f.close); const financial = f.config.financial!;
  assert.throws(() => new ClinikoVoiceClinicalHost({ ...f.config, scope: f.f.scope, greeting: f.host.greeting,
    intent: () => async () => ok({ kind: "model" as const }), financial: { ...financial, policy: { ...financial.policy, ownership: "call" } } }), /policy ownership/);
});
for (const failure of ["throw", "invalid", "aborted", "wrong-call"] as const)
test(`financial per-call factory refuses ${failure} without provider or listener effects`, async t => {
  const f = await fixture(); t.after(f.f.close); const { policy, ...common } = f.config.financial!; let calls = 0;
  const host = new ClinikoVoiceClinicalHost({ ...f.config, scope: f.f.scope, greeting: f.host.greeting,
    intent: () => async () => ok({ kind: "model" as const }), financial: { ...common, policyForCall() {
      calls++; if (failure === "throw") throw new Error("private-upstream-error-must-not-escape");
      return failure === "invalid" ? {} as never : { ...policy };
    } } });
  const context = { ...f.context, financialPresentation: { play: async () => undefined } };
  if (failure === "aborted") context.signal = AbortSignal.abort();
  if (failure === "wrong-call") context.receipt = { ...context.receipt, callId: "wrong-call" };
  assert.throws(() => host.workflow(f.approval).create(context), error => error instanceof Error && !error.message.includes("private-upstream-error"));
  assert.equal(calls, failure === "aborted" || failure === "wrong-call" ? 0 : 1);
  assert.equal(f.f.funding.rows.size, 0); assert.equal(f.f.writes.length, 0);
});
