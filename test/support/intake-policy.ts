import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import type { AdminAccount } from "../../src/standalone/identity/magic-link.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { callerMediatedRecoveryText, intakeRequiredFields, OwnerFileIntakePolicy } from "../../src/standalone/owner-file-intake-policy.ts";
import type { IntakeApproval, IntakeDraftQuery } from "../../src/standalone/owner-file-intake-policy.ts";
import { intakeCredential, intakeDraft, intakeNow } from "./intake-edge.ts";

export async function intakePolicyFixture(suppliedFolder?: string) {
  const folder = suppliedFolder ?? await mkdtemp(join(tmpdir(), "abby-intake-policy-"));
  const path = join(folder, "intake.json"), accountPath = join(folder, "accounts.json");
  const scope = { tenantId: "intake-policy", clinicId: "clinic", locationId: "main" };
  let now = intakeNow;
  let approval: IntakeApproval = { scope, revision: "intake-clinic-1", approverRef: "intake-admin",
    approvedAt: "2026-01-01T00:00:00.000Z", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil: "2027-01-01T00:00:00.000Z",
    approved: true, enabled: true, policyVersion: "policy-1", intakeVersion: "1", businessId: "11",
    credentialFingerprint: clinikoCredentialFingerprint(intakeCredential), countryCallingCode: "61", timeZone: "Australia/Sydney",
    operation: "patients.intake", callerEligibility: "selfOnly", minors: "deny", representatives: "deny", minimumAgeYears: 18,
    leapDayBirthday: "march1", callerPhone: "admittedCallerOnly", verificationMethod: "prospectiveEmailOtp",
    patientPermission: "independentClinicHost", duplicatePolicy: "exactEmailAndBirthDateDenyCandidates", requiredFields: [...intakeRequiredFields],
    recoveryContract: "callerMediated", recoveryTerms: { version: "caller-recovery-1", approvedText: callerMediatedRecoveryText },
    privacyTerms: { version: "privacy-1", approvedText: "Your registration details will be kept in Cliniko." },
    intakeTerms: { version: "registration-1", approvedText: "Registering your details does not book an appointment." } };
  let account: AdminAccount = { email: "intake-admin@example.test", actor: { actorRef: approval.approverRef, role: "clinicAdmin", scope }, membershipVersion: "membership-1" };
  const replace = async (file: string, value: unknown) => { await writeFile(`${file}.new`, JSON.stringify(value), { mode: 0o600 }); await rename(`${file}.new`, file); };
  try {
    await replace(path, approval); await replace(accountPath, [account]);
    const directory = new OwnerFileAdminDirectory(accountPath, scope);
    const config = { path, scope, policyVersion: approval.policyVersion, intakeVersion: approval.intakeVersion, businessId: approval.businessId,
      credentialFingerprint: approval.credentialFingerprint, countryCallingCode: approval.countryCallingCode, timeZone: approval.timeZone,
      intakeEnabled: true, directory, clock: () => now };
    const captured = await OwnerFileIntakePolicy.capture(config); assert.ok(captured.ok);
    const query: IntakeDraftQuery = { scope, draft: intakeDraft, admittedCallerPhone: intakeDraft.patientPhone,
      caller: "patient", privacyAccepted: true, intakeAccepted: true,
      privacyTermsVersion: approval.privacyTerms.version, intakeTermsVersion: approval.intakeTerms.version, recoveryAccepted: true, recoveryTermsVersion: approval.recoveryTerms.version };
    return { folder, path, accountPath, scope, config, directory, policy: captured.value, query,
      get approval() { return approval; }, get account() { return account; },
      setTime(value: string) { now = value; },
      replaceApproval: async (patch: Partial<IntakeApproval>) => { approval = { ...approval, ...patch }; await replace(path, approval); },
      replaceAccount: async (patch: Partial<AdminAccount>) => { account = { ...account, ...patch }; await replace(accountPath, [account]); },
      close: () => rm(folder, { recursive: true, force: true }) };
  } catch (error) { await rm(folder, { recursive: true, force: true }); throw error; }
}
