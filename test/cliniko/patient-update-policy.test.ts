import assert from "node:assert/strict";
import { chmod, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import type { AdminAccount } from "../../src/standalone/identity/magic-link.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { OwnerFilePatientUpdatePolicy, patientUpdateScopeText } from "../../src/standalone/owner-file-patient-update-policy.ts";
import type { PatientCorrectionPolicyQuery, PatientUpdateApproval } from "../../src/standalone/owner-file-patient-update-policy.ts";
import { callerVerificationFixture } from "../support/caller-verification.ts";

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "abby-update-policy-"));
  const path = join(folder, "correction.json"), accountPath = join(folder, "admin.json");
  const scope = { tenantId: "correction", clinicId: "clinic", locationId: "main" };
  let now = "2026-10-04T06:00:00.000Z";
  let approval: PatientUpdateApproval = { scope, revision: "correction-1", approverRef: "synthetic-admin", approved: true, enabled: true,
    approvedAt: "2026-01-01T00:00:00.000Z", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil: "2027-01-01T00:00:00.000Z",
    policyVersion: "policy-1", correctionVersion: "1", businessId: "11", credentialFingerprint: clinikoCredentialFingerprint("synthetic-correction-au5"),
    timeZone: "Australia/Sydney", operation: "patients.update", recordScope: "clinikoAccount", callerEligibility: "selfOnly", minors: "deny", representatives: "deny",
    minimumAgeYears: 18, leapDayBirthday: "march1", patientPermission: "independentClinicHost", verificationMethod: "registeredEmailOtp",
    emailChangeVerification: "prospectiveEmailOtp", confirmation: "privateReadback", contactSynchronization: "revokeProofsAndInvalidateAccountLookups",
    allowedFields: ["email", "post_code", "date_of_birth"], privacyTerms: { version: "privacy-1", approvedText: "Your details are held in Cliniko." },
    correctionTerms: { version: "correction-1", approvedText: patientUpdateScopeText } };
  let account: AdminAccount = { email: "synthetic-admin@example.test", actor: { actorRef: approval.approverRef, role: "clinicAdmin", scope }, membershipVersion: "1" };
  const replace = async (file: string, value: unknown) => { await writeFile(`${file}.new`, JSON.stringify(value), { mode: 0o600 }); await rename(`${file}.new`, file); };
  try {
    await replace(path, approval); await replace(accountPath, [account]);
    const config = { path, scope, directory: new OwnerFileAdminDirectory(accountPath, scope), policyVersion: approval.policyVersion,
      correctionVersion: approval.correctionVersion, businessId: approval.businessId, credentialFingerprint: approval.credentialFingerprint,
      timeZone: approval.timeZone, correctionsEnabled: true, clock: () => now };
    const captured = await OwnerFilePatientUpdatePolicy.capture(config); assert.ok(captured.ok);
    const query: PatientCorrectionPolicyQuery = { scope, caller: "patient", existingBirthDate: "1980-01-01", changes: { email: "new@example.test", post_code: "3001" },
      privacyAccepted: true, privacyTermsVersion: approval.privacyTerms.version, correctionAccepted: true, correctionTermsVersion: approval.correctionTerms.version };
    return { folder, path, accountPath, scope, config, query, policy: captured.value,
      get approval() { return approval; }, get account() { return account; }, setTime(value: string) { now = value; },
      replaceApproval: async (patch: Partial<PatientUpdateApproval>) => { approval = { ...approval, ...patch }; await replace(path, approval); },
      replaceAccount: async (patch: Partial<AdminAccount>) => { account = { ...account, ...patch }; await replace(accountPath, [account]); },
      close: () => rm(folder, { recursive: true, force: true }) };
  } catch (error) { await rm(folder, { recursive: true, force: true }); throw error; }
}

test("E2E-361 patient correction clinic policy binds exact account, terms and fields without issuing patient authority", async () => {
  const f = await fixture();
  try {
    const checked = await f.policy.checkCorrection(f.query); assert.ok(checked.ok);
    assert.deepEqual(checked.value, { scope: f.scope, revision: f.approval.revision, correctionVersion: "1", allowedFields: f.approval.allowedFields, expiresAt: f.approval.effectiveUntil });
    assert.equal(JSON.stringify(checked).includes("new@example.test"), false);
    const binding = f.policy.binding(); (binding.scope as { locationId: string }).locationId = "other";
    assert.deepEqual(f.policy.binding().scope, f.scope);
    assert.equal((await f.policy.current({ ...f.scope, locationId: "other" })).ok, false);
    for (const patch of [{ correctionsEnabled: false }, { policyVersion: "other" }, { correctionVersion: "other" }, { businessId: "12" },
      { credentialFingerprint: "0".repeat(64) }, { timeZone: "UTC" }]) {
      assert.equal((await OwnerFilePatientUpdatePolicy.capture({ ...f.config, ...patch })).ok, false);
    }
  } finally { await f.close(); }
});

test("E2E-361 correction approval cannot inherit booking, registration, proxy, clinical or marketing authority", async () => {
  const f = await fixture();
  try {
    for (const patch of [{ operation: "appointments.book" }, { operation: "patients.intake" }, { recordScope: "location" }, { callerEligibility: "any" },
      { representatives: "allow" }, { minors: "allow" }, { minimumAgeYears: 17 }, { verificationMethod: "phoneMatch" },
      { patientPermission: "emailPossession" }, { emailChangeVerification: "none" }, { confirmation: "spokenYes" }, { contactSynchronization: "none" },
      { allowedFields: [] }, { allowedFields: ["email", "email"] }, { allowedFields: ["notes"] }, { allowedFields: ["accepted_email_marketing"] },
      { privacyTerms: { ...f.approval.privacyTerms, patientId: "42" } }, { correctionTerms: { version: "1", approvedText: "Only this clinic changes." } },
      { patientId: "42" }, { email: "new@example.test" }, { scope: { ...f.scope, locationId: "other" } }]) {
      await writeFile(f.path, JSON.stringify({ ...f.approval, ...patch }));
      assert.equal((await OwnerFilePatientUpdatePolicy.capture(f.config)).ok, false, JSON.stringify(patch));
    }
  } finally { await f.close(); }
});

test("E2E-361 corrected fields need current private consent and adult self eligibility at the clinic date", async () => {
  const f = await fixture();
  try {
    for (const patch of [{ caller: "proxy" }, { privacyAccepted: false }, { correctionAccepted: false }, { privacyTermsVersion: "old" }, { correctionTermsVersion: "old" },
      { existingBirthDate: "2009-01-01" }, { existingBirthDate: "1980-02-30" }, { existingBirthDate: "2027-01-01" }, { changes: { email: null } },
      { changes: { date_of_birth: null } }, { changes: { date_of_birth: "2009-01-01" } }, { changes: { first_name: "Unapproved" } },
      { changes: { notes: "private-chart-canary" } }, { changes: {} }, { scope: { ...f.scope, clinicId: "other" } }, { patientId: "42" }]) {
      const checked = await f.policy.checkCorrection({ ...f.query, ...patch } as PatientCorrectionPolicyQuery);
      assert.equal(checked.ok, false); assert.equal(JSON.stringify(checked).includes("new@example.test"), false);
    }
    const birthday = { ...f.query, existingBirthDate: "2008-10-05" };
    f.setTime("2026-10-04T12:59:59.999Z"); assert.equal((await f.policy.checkCorrection(birthday)).ok, false);
    f.setTime("2026-10-04T13:00:00.000Z"); assert.equal((await f.policy.checkCorrection(birthday)).ok, true);
    const leap = { ...f.query, existingBirthDate: "2008-02-29" };
    f.setTime("2026-02-28T01:00:00.000Z"); assert.equal((await f.policy.checkCorrection(leap)).ok, false);
    f.setTime("2026-03-01T01:00:00.000Z"); assert.equal((await f.policy.checkCorrection(leap)).ok, true);
  } finally { await f.close(); }
});

test("E2E-361 approval, administrator and clock changes revoke patient correction use", async () => {
  for (const kind of ["revision", "enabled", "approved", "fields", "terms", "membership", "role", "removed", "future", "expired", "clock"] as const) {
    const f = await fixture();
    try {
      if (kind === "revision") await f.replaceApproval({ revision: "changed" });
      if (kind === "enabled" || kind === "approved") await f.replaceApproval({ [kind]: false });
      if (kind === "fields") await f.replaceApproval({ allowedFields: ["email"] });
      if (kind === "terms") await f.replaceApproval({ privacyTerms: { ...f.approval.privacyTerms, version: "other" } });
      if (kind === "membership") await f.replaceAccount({ membershipVersion: "other" });
      if (kind === "role") await f.replaceAccount({ actor: { ...f.account.actor, role: "staff" } });
      if (kind === "removed") await writeFile(f.accountPath, "[]");
      if (kind === "future") f.setTime("2025-12-31T23:59:59.999Z");
      if (kind === "expired") f.setTime(f.approval.effectiveUntil);
      if (kind === "clock") f.setTime("2026-02-30T00:00:00.000Z");
      assert.equal((await f.policy.current(f.scope)).ok, false, kind);
      assert.equal((await f.policy.checkCorrection(f.query)).ok, false, kind);
    } finally { await f.close(); }
  }
});

test("E2E-361 unsafe files, held approval replacement and aborted reads cannot publish correction policy", async () => {
  const f = await fixture();
  try {
    await chmod(f.path, 0o644); assert.equal((await OwnerFilePatientUpdatePolicy.capture(f.config)).ok, false); await chmod(f.path, 0o600);
    await symlink(f.path, `${f.path}.link`); assert.equal((await OwnerFilePatientUpdatePolicy.capture({ ...f.config, path: `${f.path}.link` })).ok, false);
    let release = () => {}, entered = () => {};
    const started = new Promise<void>(resolve => { entered = resolve; });
    const directory = { findByEmail: f.config.directory.findByEmail.bind(f.config.directory), findByRef: async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; }); return { ok: true as const, value: f.account };
    } };
    const pending = OwnerFilePatientUpdatePolicy.capture({ ...f.config, directory });
    await started; await f.replaceApproval({ revision: "changed" }); release(); assert.equal((await pending).ok, false);
    await f.replaceApproval({ revision: "correction-1" });
    const abort = new AbortController(); abort.abort();
    assert.equal((await OwnerFilePatientUpdatePolicy.capture(f.config, abort.signal)).ok, false);
    assert.equal((await f.policy.checkCorrection(f.query, abort.signal)).ok, false);
    const held = OwnerFilePatientUpdatePolicy.capture({ ...f.config, directory, timeoutMs: 20 });
    assert.equal((await held).ok, false); release();
  } finally { await f.close(); }
});

test("E2E-361 actual call verifier issues only independently permitted patient-update proof and revokes stale contact", async () => {
  const f = await callerVerificationFixture({ operation: "patients.update" });
  try {
    f.session.begin(); assert.deepEqual(await f.session.submitCode("000000"), { verified: false });
    assert.equal(f.mail.length, 1);
    assert.deepEqual(await f.session.submitCode(f.mail[0]!.code), { verified: true });
    const grant = await f.session.verified(); assert.ok(grant);
    const proof = f.session.proof;
    assert.equal((await proof.verifyOperation(f.scope, grant.verificationRef, "patients.update", f.config.clock())).ok, true);
    assert.equal((await proof.verifyOperation(f.scope, grant.verificationRef, "appointments.book", f.config.clock())).ok, false);
    assert.equal((await proof.verifyPatient(f.scope, grant.verificationRef, f.config.clock())).ok, false);
    f.setEmail("changed@example.test"); assert.equal(await f.session.verified(), undefined);
    assert.equal(f.provider.some(path => path.includes("appointments")), false);
  } finally { await f.close(); }
  const denied = await callerVerificationFixture({ operation: "patients.update" });
  try {
    denied.setPermitted(false); denied.session.begin();
    assert.deepEqual(await denied.session.submitCode("123456"), { verified: false }); assert.equal(denied.mail.length, 0);
  } finally { await denied.close(); }
});

test("E2E-361 held policy checks retain the captured correction and reject clock expiry after the approval read", async () => {
  const f = await fixture();
  try {
    let hold = false, release = () => {}, entered = () => {};
    const directory = { findByEmail: f.config.directory.findByEmail.bind(f.config.directory), findByRef: async (ref: string) => {
      if (hold) { entered(); await new Promise<void>(resolve => { release = resolve; }); }
      return f.config.directory.findByRef(ref);
    } };
    const captured = await OwnerFilePatientUpdatePolicy.capture({ ...f.config, directory }); assert.ok(captured.ok);
    const query = structuredClone(f.query);
    const reading = new Promise<void>(resolve => { entered = resolve; }); hold = true;
    const checking = captured.value.checkCorrection(query); await reading;
    (query.changes as { first_name?: string }).first_name = "Unapproved";
    (query as { caller: string }).caller = "proxy";
    release(); assert.equal((await checking).ok, true, "the in-flight input remains the original permitted correction");
    let clockReads = 0;
    const expiring = await OwnerFilePatientUpdatePolicy.capture({ ...f.config, clock: () => ++clockReads >= 3 ? f.approval.effectiveUntil : f.config.clock() });
    assert.ok(expiring.ok); assert.equal((await expiring.value.checkCorrection(f.query)).ok, false);
  } finally { await f.close(); }
});
