import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClinikoGuardianContactReader } from "../../src/cliniko/guardian-contact.ts";
import type { ClinicGuardianIdentityRecord } from "../../src/cliniko/guardian-contact.ts";
import { ClinikoReadBudget, clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { declareClinikoRequestCost } from "../../src/cliniko/request-cost.ts";
import { ok } from "../../src/core/model.ts";
import { GuardianVerificationSession } from "../../src/standalone/guardian-verification-session.ts";
import { OwnerFileGuardianPolicy } from "../../src/standalone/owner-file-guardian-policy.ts";
import { callerVerificationFixture } from "./caller-verification.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

export async function guardianVerificationFixture(options: Readonly<{ declaredCosts?: boolean; allowedAuthorities?: readonly ("guardian" | "adultRepresentative")[] }> = {}) {
  const budget = new ClinikoReadBudget(180), f = await callerVerificationFixture({ rateBudget: budget });
  let session: GuardianVerificationSession | undefined;
  try {
    f.setCandidates({ kind: "none", candidateIds: [] });
    const apiKey = "synthetic-session-au5", fingerprint = clinikoCredentialFingerprint(apiKey), now = f.sessionConfig.clock();
    const path = join(f.folder, "guardian-process.json"), contactId = "981764385019276543";
    let approval = { scope: f.scope, revision: "guardian-process-1", approverRef: f.account.actor.actorRef,
      approvedAt: f.approval.approvedAt, effectiveFrom: now, effectiveUntil: f.approval.effectiveUntil, approved: true, enabled: true,
      policyVersion: f.sessionConfig.policyVersion, businessId: "11", credentialFingerprint: fingerprint, timeZone: "Australia/Sydney",
      subjects: "clinicApprovedGuardianRecords", identity: "exactNameAndBirthDate", caller: "freshGuardianRegisteredChannelProof",
      authority: "independentClinicHost", recipient: "selectedPatientRegisteredEmail", allowedAuthorities: [...(options.allowedAuthorities ?? ["guardian"])], adultAgeYears: 18,
      leapDayBirthday: "march1", operations: ["appointments.book"] };
    await writeFile(path, JSON.stringify(approval), { mode: 0o600 });
    const state: { record: ClinicGuardianIdentityRecord; email: string; beforeNative?: () => Promise<void>; beforeRecord?: () => Promise<void> } = {
      record: { scope: f.scope, revision: "identity-approval-1", approverRef: f.account.actor.actorRef, approvedAt: f.approval.approvedAt,
        effectiveFrom: now, effectiveUntil: f.approval.effectiveUntil, approved: true, enabled: true, kind: "guardianIdentity",
        policyVersion: f.sessionConfig.policyVersion, businessId: "11", credentialFingerprint: fingerprint,
        recordRef: "guardian-private-identity-record-273847", recordVersion: "identity-record-1", contactId },
      email: "guardian-private@example.test",
    };
    const binding = { scope: f.scope, credentialFingerprint: fingerprint, budget };
    const directory = f.config.directory;
    if (options.declaredCosts) {
      const original = directory.findByRef;
      directory.findByRef = declareClinikoRequestCost(ref => original.call(directory, ref), binding, 0);
    }
    const records = { read: async () => { await state.beforeRecord?.(); return ok(state.record); } };
    if (options.declaredCosts) records.read = declareClinikoRequestCost(records.read, binding, 0);
    const contact = new ClinikoGuardianContactReader({ scope: f.scope, apiKey, contactEmail: "test@example.test", countryCallingCode: "61",
      policyVersion: f.sessionConfig.policyVersion, businessId: "11", rateBudget: budget, records, directory, clock: f.sessionConfig.clock },
    async (url, init) => {
      assert.equal(String(url), `https://api.au5.cliniko.com/v1/contacts/${contactId}`); assert.equal(init?.method, "GET");
      native.push(String(url)); await state.beforeNative?.();
      return Response.json({ id: contactId, type_code: 2, type: "Standard", archived_at: null, deleted_at: null,
        updated_at: "2026-10-04T05:30:00Z", links: { self: `https://api.au5.cliniko.com/v1/contacts/${contactId}` },
        email: state.email, phone_numbers: [{ number: f.inbound.presentedCallerNumber, phone_type: "Mobile" }], notes: "guardian-private-note-canary" });
    });
    const native: string[] = [], mail: { email: string; code: string }[] = [], reservations: string[] = [], lifetime = new AbortController();
    const policy = resultValue(await OwnerFileGuardianPolicy.capture({ path, scope: f.scope, policyVersion: f.sessionConfig.policyVersion,
      businessId: "11", credentialFingerprint: fingerprint, timeZone: "Australia/Sydney", directory, clock: f.sessionConfig.clock }));
    if (options.declaredCosts) {
      const current = policy.current;
      policy.current = declareClinikoRequestCost(bound => current.call(policy, bound), binding, 0);
    }
    const config: Parameters<typeof GuardianVerificationSession.create>[0] = { receipt: f.receipt, inbound: f.inbound, sessionId: f.sessionId,
      policyVersion: f.sessionConfig.policyVersion, operation: "appointments.book", signal: lifetime.signal, ledger: f.ledger, policyStore: f.policies,
      account: { businessId: "11", credentialFingerprint: fingerprint, budget }, contact, policy, clock: f.sessionConfig.clock,
      budget: { reserve: async (scope, kind) => { assert.deepEqual(scope, f.scope); reservations.push(kind); return true; } },
      delivery: { send: async (email, code) => { mail.push({ email, code }); return true; } } };
    session = resultValue(GuardianVerificationSession.create(config));
    const owner = session;
    const issue = async () => {
      owner.begin(); const until = Date.now() + 5000;
      while (!mail.length && Date.now() < until) await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(mail.length, 1); assert.deepEqual(await owner.submitCode(mail[0]!.code), { verified: true });
      const proof = await owner.verifiedGuardian("appointments.book"); assert.ok(proof); return proof;
    };
    return { f, state, contact, policy, config, session: owner, native, mail, reservations, lifetime, binding, issue,
      replaceApproval: async (patch: Partial<typeof approval>) => { approval = { ...approval, ...patch }; await writeFile(path, JSON.stringify(approval), { mode: 0o600 }); },
      close: async () => { lifetime.abort(); owner.dispose(); await f.close(); } };
  } catch (error) { session?.dispose(); await f.close(); throw error; }
}
