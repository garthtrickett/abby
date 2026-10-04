import assert from "node:assert/strict";
import { ClinikoVerificationContactReader } from "../../src/cliniko/verification-contact.ts";
import { ok } from "../../src/core/model.ts";
import { EmailPatientAuthority } from "../../src/standalone/email-patient-authority.ts";
import type { PatientVerificationBudget } from "../../src/standalone/email-patient-authority.ts";
import { TransientPatientProofHost } from "../../src/standalone/transient-patient-proof.ts";
import type { CallerCandidates } from "../../src/voice/caller-candidates.ts";

export const scope = { tenantId: "otp-tenant", clinicId: "clinic", locationId: "location" };
export const initial = Date.parse("2026-10-04T04:00:00Z");
export const apiKey = "synthetic-otp-key-au5";
const number = "+61400111222";
const base = "https://api.au5.cliniko.com/v1";
export function emailFixture(options: { scope?: typeof scope; patientId?: string; budget?: PatientVerificationBudget; deadlineMs?: number;
  delivery?: (email: string, code: string, signal: AbortSignal) => Promise<boolean> } = {}) {
  const boundScope = options.scope ?? scope;
  const patientId = options.patientId ?? "42";
  let time = initial, enabled = true, permitted = true, version = "policy", email = "registered@example.test", phone = number;
  let candidates: CallerCandidates = { kind: "one", candidateIds: [patientId] };
  const mail: Array<{ email: string; code: string }> = [], reads: string[] = [];
  const config = { scope: boundScope, callId: "otp-call", sessionId: "otp-session", policyVersion: "policy", presentedNumber: number,
    operations: ["appointments.read"] as const, lookup: { candidates: async () => ok(candidates) },
    contact: new ClinikoVerificationContactReader({ scope: boundScope, apiKey, contactEmail: "test@example.test", countryCallingCode: "61" },
      async url => {
        reads.push(String(url)); assert.equal(String(url), `${base}/patients/${patientId}`);
        return Response.json({ id: patientId, email, archived_at: null,
          patient_phone_numbers: [{ number: phone, phone_type: "Mobile" }], notes: "private-contact-canary" });
      }),
    policy: { current: async () => ok({ scope: boundScope, enabled, version }) }, budget: options.budget ?? { reserve: async () => true },
    permission: { allows: async () => permitted },
    delivery: { send: options.delivery ?? (async (email: string, code: string) => { mail.push({ email, code }); return true; }) },
    clock: () => time, ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }) };
  const authority = new EmailPatientAuthority(config);
  const proof = new TransientPatientProofHost({ scope: boundScope, callId: config.callId, sessionId: config.sessionId,
    presentedCallerNumber: number, policyVersion: "policy", maxAttempts: 3, lookup: config.lookup, authority,
    policy: config.policy, clock: () => new Date(time).toISOString() });
  return { authority, proof, config, mail, reads, setTime: (value: number) => { time = value; },
    setEnabled: (value: boolean) => { enabled = value; }, setVersion: (value: string) => { version = value; },
    setPermitted: (value: boolean) => { permitted = value; },
    setEmail: (value: string) => { email = value; }, setPhone: (value: string) => { phone = value; },
    setCandidates: (value: CallerCandidates) => { candidates = value; } };
}
