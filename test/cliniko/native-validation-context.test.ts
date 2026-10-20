import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoAppointmentSelection } from "../../src/standalone/cliniko-appointment-selection.ts";
import { reschedulingAuthorityFixture } from "../support/rescheduling-authority.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow, verificationCanaries } from "../support/caller-verification.ts";

test("E2E-383 native public-destination context requires exact one-use evidence and the same private proof owner", async () => {
  const f = await reschedulingAuthorityFixture();
  let source: ClinikoAppointmentSelection | undefined;
  try {
    const proof = await f.verify();
    source = resultValue(ClinikoAppointmentSelection.create({ scope: f.scope, callId: f.callId, sessionId: f.sessionId,
      policyVersion: f.sessionConfig.policyVersion, apiKey: "synthetic-session-au5", contactEmail: "test@example.test", businessId: "11",
      proof: f.session.proof, policy: f.feePolicy, rateBudget: f.ownerPorts.rateBudget, clock: f.sessionConfig.clock }, f.ownerPorts.fetchPort));
    const listed = resultValue(await source.list(f.scope, proof, verificationNow, "2026-10-09T06:00:00.000Z", verificationNow));
    const query = { scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.sessionConfig.policyVersion,
      patientId: verificationCanaries[2]!, verificationRef: proof, targetRef: listed.appointments[0]!.appointmentRef,
      kind: "reschedule" as const, phase: "proposal" as const, now: verificationNow, signal: new AbortController().signal };
    const evidence = resultValue(await source.resolveTarget(query));
    assert.equal(source.consumeResolvedEvidence(structuredClone(evidence), query, f.session.proof), false);
    assert.equal(source.consumeResolvedEvidence(evidence, query, f.session.proof), true);
    assert.equal(source.consumeResolvedEvidence(evidence, query, f.session.proof), false);
    const another = resultValue(await source.resolveTarget(query));
    assert.equal(source.consumeResolvedEvidence(another, { ...query, patientId: "43" }, f.session.proof), false);
    const last = resultValue(await source.resolveTarget(query)); source.dispose();
    assert.equal(source.consumeResolvedEvidence(last, query, f.session.proof), false);
  } finally { source?.dispose(); await f.close(); }
});
