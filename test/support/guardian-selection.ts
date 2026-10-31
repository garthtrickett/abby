import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ok } from "../../src/core/model.ts";
import { ClinikoGuardianSelection } from "../../src/standalone/cliniko-guardian-selection.ts";
import { GuardianPatientAuthority } from "../../src/standalone/guardian-patient-authority.ts";
import type { ClinicGuardianPatientAuthorityRecord } from "../../src/standalone/guardian-patient-authority.ts";
import { guardianVerificationFixture } from "./guardian-verification.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

export async function guardianSelectionFixture(options: Readonly<{ adult?: boolean }> = {}) {
  const g = await guardianVerificationFixture(options.adult ? { allowedAuthorities: ["guardian", "adultRepresentative"] } : {});
  let owner: ClinikoGuardianSelection | undefined;
  try {
    const approval = g.state.record, subjectId = "192837465019283746", identity = { firstName: "PrivateChild", lastName: "GuardianSelectionCanary",
      dateOfBirth: options.adult ? "1982-03-05" : "2017-02-28" };
    const state: { authority: ClinicGuardianPatientAuthorityRecord | undefined; patient: Record<string, unknown>;
      afterPatient?: () => void | Promise<void>; beforePatient?: () => void | Promise<void>; status: number } = {
      authority: { scope: g.f.scope, revision: "subject-approval-1", approverRef: approval.approverRef, approvedAt: approval.approvedAt,
        effectiveFrom: approval.effectiveFrom, effectiveUntil: approval.effectiveUntil, approved: true, enabled: true,
        kind: "guardianPatientAuthority", policyVersion: approval.policyVersion, businessId: approval.businessId, credentialFingerprint: approval.credentialFingerprint,
        authorityRef: "private-guardian-subject-authority", authorityVersion: "authority-1", contactId: approval.contactId,
        identityRecordRef: approval.recordRef, identityRecordVersion: approval.recordVersion, identityRevision: approval.revision, subjectPatientId: subjectId,
        operation: "appointments.book", authorityKind: options.adult ? "adultRepresentative" : "guardian", subjectKind: options.adult ? "adult" : "minor",
        purposes: ["identify", "channel", "operation"] },
      patient: { id: subjectId, archived_at: null, first_name: identity.firstName, last_name: identity.lastName, date_of_birth: identity.dateOfBirth,
        email: "private-selected-patient@example.test", links: { self: `https://api.au5.cliniko.com/v1/patients/${subjectId}` },
        patient_phone_numbers: [{ number: g.f.inbound.presentedCallerNumber, phone_type: "Mobile" }], notes: "private-patient-notes-canary" }, status: 200,
    };
    const records = { read: async () => ok(state.authority) };
    const authority = new GuardianPatientAuthority({ scope: g.f.scope, callId: g.f.callId, sessionId: g.f.sessionId, policyVersion: approval.policyVersion,
      businessId: approval.businessId, credentialFingerprint: approval.credentialFingerprint, budget: g.config.account.budget,
      actor: g.session, policy: g.policy, records, directory: g.f.config.directory, clock: g.config.clock!, signal: g.lifetime.signal });
    const path = join(g.f.folder, "guardian-selected-subject-caller.json");
    let caller = { ...g.f.approval, operations: ["appointments.book"], representatives: "independentClinicHost", representativeRecipient: "selectedPatientRegisteredEmail" };
    await writeFile(path, JSON.stringify(caller), { mode: 0o600 });
    const requests: string[] = [], mail: { email: string; code: string }[] = [];
    const config: ConstructorParameters<typeof ClinikoGuardianSelection>[0] = { receipt: g.f.receipt, inbound: g.f.inbound, sessionId: g.f.sessionId,
      policyVersion: approval.policyVersion, ledger: g.f.ledger, policies: g.f.policies, lookup: g.f.sessionConfig.lookup,
      verificationBudget: { reserve: async () => true }, delivery: { send: async (email, code) => { mail.push({ email, code }); return true; } },
      directory: g.f.config.directory, actor: g.session, policy: g.policy, authority, representativeCallerApprovalPath: path,
      signal: g.lifetime.signal, clock: g.config.clock!, cliniko: { apiKey: "synthetic-session-au5", contactEmail: "test@example.test", businessId: "11",
        practitionerId: "22", appointmentTypeId: "33", recallTypeId: "7", countryCallingCode: "61", timeZone: "Australia/Sydney", rateBudget: g.config.account.budget },
      fetchPort: async (url, init) => {
        assert.equal(String(url), `https://api.au5.cliniko.com/v1/patients/${subjectId}`); assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
        requests.push(String(url)); await state.beforePatient?.();
        const response = state.status === 200 ? Response.json(state.patient) : new Response(null, { status: state.status });
        await state.afterPatient?.(); return response;
      } };
    owner = new ClinikoGuardianSelection(config); const selectedOwner = owner;
    const select = () => selectedOwner.select(identity, "appointments.book", g.lifetime.signal);
    const verifySubject = async () => {
      const selected = resultValue(await select()), verifier = resultValue(await selectedOwner.verifier(selected.selectionRef, g.lifetime.signal));
      verifier.begin(); const until = Date.now() + 5000;
      while (!mail.length && Date.now() < until) await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(mail.length, 1); assert.equal((await verifier.submitCode(mail[0]!.code)).verified, true); return verifier;
    };
    return { g, state, records, authority, config, owner: selectedOwner, identity, subjectId, requests, mail, select, verifySubject,
      replaceCaller: async (patch: Partial<typeof caller>) => { caller = { ...caller, ...patch }; await writeFile(path, JSON.stringify(caller), { mode: 0o600 }); },
      close: async () => { selectedOwner.dispose(); await g.close(); } };
  } catch (error) { owner?.dispose(); await g.close(); throw error; }
}
