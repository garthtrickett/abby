import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OwnerFileBookingPolicy } from "../../src/standalone/owner-file-booking-policy.ts";
import { OwnerFileServiceCatalogue } from "../../src/standalone/owner-file-service-catalogue.ts";
import type { ServiceCatalogueApproval } from "../../src/standalone/owner-file-service-catalogue.ts";
import { bookingOffersFixture } from "../support/booking-offers.ts";
import { verificationNow } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

async function fixture() {
  const f = await bookingOffersFixture(), path = join(f.folder, "bound-service.json");
  const { scope, approverRef, approvedAt, effectiveFrom, effectiveUntil, policyVersion, businessId, credentialFingerprint, timeZone } = f.approval;
  const approval: ServiceCatalogueApproval = { scope, approverRef, approvedAt, effectiveFrom, effectiveUntil, policyVersion, businessId, credentialFingerprint, timeZone,
    approved: true, enabled: true, revision: "bound-service-1", locationName: "Demo clinic", eligibilityBasis: "callerAttestation", services: [{
      serviceRef: f.approval.serviceRef, name: "Physiotherapy", appointmentTypeName: "Physiotherapy", appointmentTypeId: f.approval.appointmentTypeId,
      durationMinutes: f.approval.durationMinutes, visitKind: "initial", searchDays: 7, followUpRule: null,
      practitioners: [{ practitionerId: f.approval.practitionerId, name: "Demo Practitioner" }],
    }] };
  await writeFile(path, JSON.stringify(approval), { mode: 0o600 });
  const catalogue = resultValue(await OwnerFileServiceCatalogue.capture({ ...approval, path, directory: f.directory, clock: () => verificationNow }));
  const policy = resultValue(await OwnerFileBookingPolicy.capture({ ...f.bookingPolicy.binding(), path: f.path, directory: f.directory,
    clock: () => verificationNow, serviceBinding: { catalogue, serviceRef: f.approval.serviceRef } }));
  return { ...f, policy, catalogue, approval, servicePath: path };
}

for (const change of ["none", "child", "parent", "role", "membership"] as const)
test(`bound public approval reads overlap while both current sources still refuse ${change} changes`, { timeout: 10_000 }, async () => {
  const f = await fixture(), original = f.directory.findByRef.bind(f.directory), releases: (() => void)[] = [];
  let entered = 0, notify!: () => void;
  const both = new Promise<void>(resolve => { notify = resolve; });
  f.directory.findByRef = async ref => {
    entered++;
    await new Promise<void>(resolve => { releases.push(resolve); if (entered === 2) notify(); });
    return original(ref);
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const reading = f.policy.current(f.scope);
  try {
    await Promise.race([both, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Independent source lookup did not start")), 5000); })]);
    assert.equal(entered, 2);
    if (change === "child") await f.replacePolicy({ enabled: false });
    if (change === "parent") await writeFile(f.servicePath, JSON.stringify({ ...f.approval, enabled: false }), { mode: 0o600 });
    if (change === "role") await f.replaceAccount([{ ...f.account, actor: { ...f.account.actor, role: "staff" } }]);
    if (change === "membership") await f.replaceAccount([{ ...f.account, membershipVersion: "changed" }]);
    for (const release of releases) release();
    const result = await reading;
    assert.equal(result.ok, change === "none"); assert.equal(f.posts.length, 0);
  } finally {
    if (timeout) clearTimeout(timeout); for (const release of releases) release();
    f.directory.findByRef = original; await reading; await f.close();
  }
});
