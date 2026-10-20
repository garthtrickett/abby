import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoClassBookingHost } from "../../src/standalone/cliniko-class-booking-host.ts";
import { ClinikoClassCancellationHost } from "../../src/standalone/cliniko-class-cancellation-host.ts";
import { ClinikoClassMoveHost } from "../../src/standalone/cliniko-class-move-host.ts";
import { OwnerFileClassPolicy } from "../../src/standalone/owner-file-class-policy.ts";
import { OwnerFileClassMovePolicy } from "../../src/standalone/owner-file-class-move-policy.ts";
import { OwnerFileCancellationPolicy } from "../../src/standalone/owner-file-cancellation-policy.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { classBookingFixture } from "../support/class-booking.ts";
import { classCancellationFixture } from "../support/class-cancellation.ts";
import { classMoveFixture } from "../support/class-move.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

for (const operation of ["booking", "cancellation", "movement"] as const) test(`E2E-413 ${operation} rejects a same-call proof from another Cliniko credential despite current target approvals`, async () => {
  const f = operation === "booking" ? await classBookingFixture() : operation === "cancellation" ? await classCancellationFixture() : await classMoveFixture();
  const lifetime = new AbortController(); let nativeRequests = 0;
  try {
    await f.verify();
    const apiKey = "synthetic-other-account-au5", credentialFingerprint = clinikoCredentialFingerprint(apiKey), clock = f.classSessionConfig.clock;
    const binding = { scope: f.scope, policyVersion: f.sessionConfig.policyVersion, businessId: "11", credentialFingerprint, recallTypeId: "7", timeZone: "Australia/Sydney",
      directory: new OwnerFileAdminDirectory(f.accountPath, f.scope), clock };
    const captureClass = async (path: string, practitionerId: string, appointmentTypeId: string) => {
      const policy = resultValue(await OwnerFileClassPolicy.capture({ ...binding, path, practitionerId, appointmentTypeId }));
      assert.equal(resultValue(await policy.current(f.scope)).credentialFingerprint, credentialFingerprint); return policy;
    };
    assert.equal(f.session.proof.matchesCall(f.scope, f.callId, f.sessionId, binding.policyVersion), true);
    assert.equal(f.session.matchesClinikoAccount(credentialFingerprint), false);
    const common = { scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: binding.policyVersion, ledger: f.ledger, policies: f.policies,
      verification: f.session, permission: { allows: async () => true }, cliniko: { ...f.native.config, apiKey }, clock, signal: lifetime.signal,
      fetchPort: (async () => { nativeRequests++; throw new Error("foreign-account native access"); }) as typeof fetch };
    let created;
    if ("replaceSource" in f) {
      const source = resultValue(await f.config.sourcePolicy.current(f.scope)), destination = resultValue(await f.config.destinationPolicy.current(f.scope));
      await f.replaceSource({ credentialFingerprint }); await f.replaceDestination({ credentialFingerprint }); await f.replaceMove({ credentialFingerprint });
      const sourcePolicy = await captureClass(f.sourcePath, source.practitionerId, source.appointmentTypeId);
      const destinationPolicy = await captureClass(f.destinationPath, destination.practitionerId, destination.appointmentTypeId);
      const movePolicy = resultValue(await OwnerFileClassMovePolicy.capture({ ...binding, path: f.movePath, sourceServiceRef: source.serviceRef, destinationServiceRef: destination.serviceRef }));
      assert.equal(resultValue(await movePolicy.current(f.scope)).credentialFingerprint, credentialFingerprint);
      created = await ClinikoClassMoveHost.create({ ...common, sourcePolicy, destinationPolicy, movePolicy });
    } else {
      await f.replacePolicy({ credentialFingerprint });
      const classPolicy = await captureClass(f.path, f.native.config.practitionerId, f.native.config.appointmentTypeId);
      if ("replaceCancellation" in f) {
        await f.replaceCancellation({ credentialFingerprint });
        const cancellationPolicy = resultValue(await OwnerFileCancellationPolicy.capture({ ...binding, path: f.cancellationPath }));
        assert.equal(resultValue(await cancellationPolicy.current(f.scope)).credentialFingerprint, credentialFingerprint);
        created = await ClinikoClassCancellationHost.create({ ...common, classPolicy, cancellationPolicy });
      } else created = await ClinikoClassBookingHost.create({ ...common, classPolicy });
    }
    if (created.ok) created.value.dispose();
    assert.equal(created.ok, false, "current owner approval cannot transfer a patient proof between Cliniko credentials");
    assert.equal(nativeRequests, 0); assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
  } finally { lifetime.abort(); await f.close(); }
});
