import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClinikoReadBudget, clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import type { ClinicGuardianIdentityRecord } from "../../src/cliniko/guardian-contact.ts";
import { ok } from "../../src/core/model.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import type { RepresentativeInputConfig } from "../../src/standalone/representative-caller-sources.ts";
import type { ClinicGuardianPatientAuthorityRecord } from "../../src/standalone/guardian-patient-authority.ts";
import { representativeCallOwnerFixture, representativeInputOptions } from "./representative-call-owner.ts";
import { representativeChangeCallFixture } from "./representative-change-call.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

export async function guardianCallOwnerFixture(options: Readonly<{ both?: boolean; adult?: boolean; operation?: "book" | "appointments.read" | "cancel" | "reschedule";
  budget?: ClinikoRequestBudget; subjectIds?: readonly [string, string] }> = {}) {
  const fixtureOptions = { ...(!options.adult ? { guardian: true as const } : {}), budget: options.budget ?? new ClinikoReadBudget(180),
    ...(options.subjectIds ? { subjectIds: options.subjectIds } : {}) };
  const change = options.operation && options.operation !== "book" ? await representativeChangeCallFixture(options.operation, fixtureOptions) : undefined;
  const base = change ?? await representativeCallOwnerFixture(fixtureOptions);
  let flow: ClinikoCallFlow | undefined;
  try {
    const c = base.config.context, scope = c.receipt.scope, contactId = "981764385019276543", fingerprint = clinikoCredentialFingerprint(c.cliniko.apiKey);
    const common = { scope, revision: "guardian-process-1", approverRef: base.f.approval.approverRef, approvedAt: base.f.approval.approvedAt,
      effectiveFrom: base.f.approval.effectiveFrom, effectiveUntil: base.f.approval.effectiveUntil, approved: true, enabled: true };
    const patientOperation = { book: "appointments.book", cancel: "appointments.cancel", reschedule: "appointments.reschedule", "appointments.read": "appointments.read" } as const;
    let approval = { ...common, policyVersion: c.policyVersion, businessId: "11", credentialFingerprint: fingerprint, timeZone: "Australia/Sydney",
      subjects: "clinicApprovedGuardianRecords", identity: "exactNameAndBirthDate", caller: "freshGuardianRegisteredChannelProof", authority: "independentClinicHost",
      recipient: "selectedPatientRegisteredEmail", allowedAuthorities: options.adult ? ["guardian", "adultRepresentative"] : ["guardian"],
      adultAgeYears: 18, leapDayBirthday: "march1", operations: [patientOperation[base.config.operation]] };
    const path = join(base.f.folder, "guardian-record-process.json"); await writeFile(path, JSON.stringify(approval), { mode: 0o600 });
    const identity: ClinicGuardianIdentityRecord = { ...common, revision: "guardian-identity-1", kind: "guardianIdentity", policyVersion: c.policyVersion,
      businessId: "11", credentialFingerprint: fingerprint, recordRef: "private-guardian-identity-ref", recordVersion: "identity-1", contactId };
    const state: { identity: ClinicGuardianIdentityRecord | undefined; authority: ClinicGuardianPatientAuthorityRecord | undefined;
      guardianEmail: string; beforeIdentity?: () => Promise<void>; beforeContact?: () => Promise<void> } = {
      identity, guardianEmail: "private-record-guardian@example.test",
      authority: { ...common, revision: "guardian-subject-1", kind: "guardianPatientAuthority", policyVersion: c.policyVersion, businessId: "11",
        credentialFingerprint: fingerprint, authorityRef: "private-guardian-authority-ref", authorityVersion: "authority-1", contactId,
        identityRecordRef: identity.recordRef, identityRecordVersion: identity.recordVersion, identityRevision: identity.revision,
        subjectPatientId: base.r.subjectIds[0], operation: patientOperation[base.config.operation], authorityKind: options.adult ? "adultRepresentative" : "guardian",
        subjectKind: options.adult ? "adult" : "minor", purposes: ["identify", "channel", "operation"] },
    };
    const reads: string[] = [], counts = { identities: 0, authorities: 0 };
    const provision = { approvalPath: path, identities: { read: async () => { counts.identities++; await state.beforeIdentity?.(); return ok(state.identity); } },
      authorities: { read: async () => { counts.authorities++; return ok(state.authority); } } };
    const input: RepresentativeInputConfig = options.both ? { ...representativeInputOptions(base), guardian: provision }
      : { representativeCallerApprovalPath: base.config.representativeCallerApprovalPath, guardian: provision };
    const fetchPort: typeof fetch = async (url, init) => {
      if ((init?.method ?? "GET") === "GET") reads.push(String(url));
      if (String(url) !== `https://api.au5.cliniko.com/v1/contacts/${contactId}`) return base.flowConfig.fetchPort(url, init);
      assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error"); await state.beforeContact?.();
      return Response.json({ id: contactId, archived_at: null, deleted_at: null, type_code: 2, type: "Standard", updated_at: "2026-10-04T05:30:00Z",
        links: { self: `https://api.au5.cliniko.com/v1/contacts/${contactId}` }, email: state.guardianEmail,
        phone_numbers: [{ number: c.inbound.presentedCallerNumber, phone_type: "Mobile" }], notes: "private-guardian-contact-note-canary" });
    };
    base.flow.dispose();
    const flowConfig = { ...base.flowConfig, fetchPort, representativeInput: input };
    flow = resultValue(ClinikoCallFlow.create(flowConfig)); const ownerFlow = flow;
    const config = { context: { ...c, fetchPort }, flow: ownerFlow, operation: base.config.operation, ...input };
    return { base, change, state, provision, input, config, flow: ownerFlow, flowConfig, reads, counts,
      replaceApproval: async (patch: Partial<typeof approval>) => { approval = { ...approval, ...patch }; await writeFile(path, JSON.stringify(approval), { mode: 0o600 }); },
      close: async () => { ownerFlow.dispose(); await base.close(); } };
  } catch (error) { flow?.dispose(); await base.close(); throw error; }
}
