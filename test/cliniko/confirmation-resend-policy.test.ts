import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { OwnerFileConfirmationResendPolicy } from "../../src/standalone/owner-file-confirmation-resend-policy.ts";
import type { ConfirmationResendApproval } from "../../src/standalone/owner-file-confirmation-resend-policy.ts";
import { callerVerificationFixture, verificationNow } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

async function fixture() {
  const f = await callerVerificationFixture({ operation: "appointments.resend" }), path = join(f.folder, "resend.json");
  let approval: ConfirmationResendApproval = { scope: f.scope, revision: "resend-1", approverRef: f.approval.approverRef,
    approvedAt: f.approval.approvedAt, effectiveFrom: f.approval.effectiveFrom, effectiveUntil: f.approval.effectiveUntil, approved: true, enabled: true,
    policyVersion: f.sessionConfig.policyVersion, businessId: "11", credentialFingerprint: clinikoCredentialFingerprint("synthetic-session-au5"),
    timeZone: "Australia/Sydney", owner: "abby", sender: "clinic@example.test", template: "appointmentDetails.v1", recipient: "verifiedRegisteredEmail",
    patientPermission: "independentClinicHost", consent: "separatePlayedConfirmation", submission: "durableSingleAttempt",
    recallTypeId: "7", reviewProcess: "clinikoRecallsFullType", reviewOwnerRef: "primary", reviewBackupRef: "backup", reviewCadenceMinutes: 15 };
  const replace = async (patch: Record<string, unknown> = {}) => {
    await writeFile(`${path}.new`, JSON.stringify({ ...approval, ...patch }), { mode: 0o600 }); await rename(`${path}.new`, path);
  };
  await replace();
  const config = { path, directory: f.config.directory, clock: f.config.clock, scope: f.scope, policyVersion: approval.policyVersion,
    businessId: approval.businessId, credentialFingerprint: approval.credentialFingerprint, timeZone: approval.timeZone, sender: approval.sender, recallTypeId: approval.recallTypeId };
  return { ...f, config, path, replace, approval };
}

test("E2E-371 resend approval binds the current administrator, account, location, sender, content, consent and review process", async () => {
  const f = await fixture();
  try {
    const policy = resultValue(await OwnerFileConfirmationResendPolicy.capture(f.config));
    assert.deepEqual(resultValue(await policy.current(f.scope)), f.approval);
    assert.match(policy.bindingFingerprint(), /^[a-f0-9]{64}$/);
    assert.equal((await policy.current({ ...f.scope, locationId: "other" })).ok, false);
    for (const patch of [{ sender: "other@example.test" }, { businessId: "12" }, { credentialFingerprint: "f".repeat(64) }, { timeZone: "Europe/London" }, { recallTypeId: "8" }]) {
      assert.equal((await OwnerFileConfirmationResendPolicy.capture({ ...f.config, ...patch })).ok, false);
    }
    await f.replace({ enabled: false }); assert.equal((await policy.current(f.scope)).ok, false);
    assert.equal((await OwnerFileConfirmationResendPolicy.capture(f.config)).ok, false);
    await f.replace(); await f.replaceAccount({ membershipVersion: "member-2" });
    assert.equal((await policy.current(f.scope)).ok, false);
  } finally { await f.close(); }
});

test("E2E-371 read-like, automatic-owner, arbitrary-recipient/template and incomplete review approvals cannot enable a resend", async () => {
  const f = await fixture();
  try {
    for (const patch of [{ owner: "host" }, { recipient: "callerSuppliedEmail" }, { template: "arbitrary" }, { consent: "verificationCode" },
      { submission: "retryAllowed" }, { patientPermission: "emailPossession" }, { reviewOwnerRef: "backup" }, { reviewCadenceMinutes: 0 },
      { reviewProcess: "localOnly" }, { sender: "clinic@example.test\r\nBcc: other@example.test" }, { content: "patient note" }]) {
      await f.replace(patch); assert.equal((await OwnerFileConfirmationResendPolicy.capture(f.config)).ok, false, JSON.stringify(patch));
    }
    await f.replace();
    f.setTime("2026-10-05T06:00:00.000Z"); assert.equal((await OwnerFileConfirmationResendPolicy.capture(f.config)).ok, false);
  } finally { await f.close(); }
});

test("E2E-371 actual registered-code resend proof has its own operation; read proof cannot authorize send", async () => {
  const resend = await callerVerificationFixture({ operation: "appointments.resend" });
  const read = await callerVerificationFixture({ operation: "appointments.read" });
  try {
    for (const f of [resend, read]) {
      f.session.begin();
      const deadline = Date.now() + 5000;
      while (!f.mail.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(f.mail.length, 1);
      assert.equal((await f.session.submitCode(f.mail[0]!.code)).verified, true);
    }
    const resendGrant = await resend.session.verified(), readGrant = await read.session.verified();
    assert.ok(resendGrant); assert.ok(readGrant);
    assert.equal((await resend.session.proof.verifyOperation(resend.scope, resendGrant.verificationRef, "appointments.resend", verificationNow)).ok, true);
    assert.equal((await resend.session.proof.verifyOperation(resend.scope, resendGrant.verificationRef, "appointments.read", verificationNow)).ok, false);
    assert.equal((await read.session.proof.verifyOperation(read.scope, readGrant.verificationRef, "appointments.resend", verificationNow)).ok, false);
    resend.setPermitted(false); assert.equal(await resend.session.verified(), undefined);
  } finally { await resend.close(); await read.close(); }
});

test("E2E-371 independent resend permission denial stops code delivery; proof is not produced from a phone match", async () => {
  const f = await callerVerificationFixture({ operation: "appointments.resend" });
  try {
    f.setPermitted(false); f.session.begin();
    assert.equal((await f.session.submitCode("123456")).verified, false);
    assert.equal(f.mail.length, 0); assert.equal(await f.session.verified(), undefined);
  } finally { await f.close(); }
});

test("E2E-380 extended content needs a versioned explicit owner approval; legacy records cannot opt in by extra fields", async () => {
  const f = await fixture();
  try {
    for (const patch of [{ template: "appointmentDetails.v2" }, { template: "appointmentDetails.v2", contentKinds: [] },
      { template: "appointmentDetails.v2", contentKinds: ["cancelled", "cancelled"] }, { template: "appointmentDetails.v2", contentKinds: ["arbitrary"] },
      { template: "appointmentDetails.v1", contentKinds: ["activeTelehealth"] }]) {
      await f.replace(patch); assert.equal((await OwnerFileConfirmationResendPolicy.capture(f.config)).ok, false);
    }
    await f.replace({ template: "appointmentDetails.v2", contentKinds: ["activeTelehealth", "cancelled"] });
    const policy = resultValue(await OwnerFileConfirmationResendPolicy.capture(f.config));
    assert.deepEqual(resultValue(await policy.current(f.scope)).contentKinds, ["activeTelehealth", "cancelled"]);
    await f.replace({ template: "appointmentDetails.v2", contentKinds: ["activeInPerson", "activeTelehealth", "cancelled"] });
    assert.equal((await policy.current(f.scope)).ok, false, "content expansion revokes the captured authority");
  } finally { await f.close(); }
});
