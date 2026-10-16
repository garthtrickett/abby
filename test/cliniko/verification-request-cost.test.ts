import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoReadBudget, clinikoCredentialFingerprint, claimClinikoBudget } from "../../src/cliniko/read-budget.ts";
import { declareClinikoRequestCost } from "../../src/cliniko/request-cost.ts";
import { CallerVerificationSession } from "../../src/standalone/caller-verification-session.ts";
import { callerVerificationFixture } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

for (const revisionCost of [0, 1]) test(`E2E-419 actual proof ceiling covers lookup, permission, four policy reads and ${revisionCost ? "both native revision reads" : "native contact"}`, async () => {
  let claims = 0;
  const physical = new ClinikoReadBudget(), budget = { ...physical, claim: async () => { claims++; return physical.claim(); },
    observe429: physical.observe429.bind(physical), checkHeadroom: physical.checkHeadroom.bind(physical), withReservation: physical.withReservation.bind(physical) };
  const scope = { tenantId: `verification-cost-${revisionCost}`, clinicId: "clinic", locationId: "main" }, apiKey = "synthetic-cost-au5";
  const binding = { scope, credentialFingerprint: clinikoCredentialFingerprint(apiKey), budget };
  const revision = { matches: () => true, read: declareClinikoRequestCost(async () => {
    if (revisionCost) assert.equal(await claimClinikoBudget(budget), null);
    return { ok: true as const, value: { version: 0, blocked: false } };
  }, binding, revisionCost) };
  const f = await callerVerificationFixture({ scope, apiKey, rateBudget: budget, operation: "appointments.reschedule", contactRevision: revision });
  let session: CallerVerificationSession | undefined;
  try {
    assert.equal(f.session.nativeRequestCostCeilings(binding), undefined, "an account match does not invent unknown callback ceilings");
    f.session.dispose();
    const original = f.sessionConfig;
    const policy = { operation: original.operation, current: declareClinikoRequestCost(async (bound: Parameters<typeof original.policy.current>[0]) => {
      assert.equal(await claimClinikoBudget(budget), null); return original.policy.current(bound);
    }, binding, 1) };
    const lookup = { candidates: declareClinikoRequestCost(async (...args: Parameters<typeof original.lookup.candidates>) => {
      assert.equal(await claimClinikoBudget(budget), null); return original.lookup.candidates(...args);
    }, binding, 1) };
    const permission = { allows: declareClinikoRequestCost(async (...args: Parameters<typeof original.permission.allows>) => {
      assert.equal(await claimClinikoBudget(budget), null); return original.permission.allows(...args);
    }, binding, 1) };
    const config = { ...original, policy, lookup, permission };
    session = resultValue(CallerVerificationSession.create(config));
    const expected = { proof: 7 + 2 * revisionCost, ownership: 1 };
    assert.deepEqual(session.nativeRequestCostCeilings(binding), expected);
    assert.equal(session.nativeRequestCostCeilings({ ...binding, budget: physical }), undefined);
    for (const unknown of [{ ...config, lookup: original.lookup }, { ...config, policy: original.policy }, { ...config, permission: original.permission }]) {
      const other = resultValue(CallerVerificationSession.create(unknown));
      assert.equal(other.nativeRequestCostCeilings(binding), undefined); other.dispose();
    }
    session.begin();
    const until = Date.now() + 5000;
    while (!f.mail.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(f.mail.length, 1); assert.equal((await session.submitCode(f.mail[0]!.code)).verified, true);
    let before = claims;
    const patient = await session.verifiedSubject("appointments.reschedule"); assert.ok(patient);
    assert.equal(claims - before, expected.proof, "measure actual account-budget claims, including transitive callbacks");
    before = claims; assert.ok(await session.ownedGrant("appointments.reschedule", new AbortController().signal));
    assert.equal(claims - before, expected.ownership);
    const successor = resultValue(await session.renewOnce(patient.verificationRef, new AbortController().signal));
    session = successor;
    assert.deepEqual(successor.nativeRequestCostCeilings(binding), expected, "one-call same-subject lookup forwarding preserves its declared ceiling");
  } finally { session?.dispose(); await f.close(); }
});
