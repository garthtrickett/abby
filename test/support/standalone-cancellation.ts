import assert from "node:assert/strict";
import { ClinikoCancellationWriter } from "../../src/cliniko/cancellation-write.ts";
import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { ClinikoRecallWriter } from "../../src/cliniko/recall-write.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { ClinikoVerificationContactReader } from "../../src/cliniko/verification-contact.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { LocationScope } from "../../src/core/model.ts";
import { ok } from "../../src/core/model.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { ClinikoCancellationHost } from "../../src/standalone/cliniko-cancellation-host.ts";
import type { PatientVerificationBudget } from "../../src/standalone/email-patient-authority.ts";
import { EmailPatientAuthority } from "../../src/standalone/email-patient-authority.ts";
import { TransientPatientProofHost } from "../../src/standalone/transient-patient-proof.ts";
import { approvedSyntheticPolicy } from "./approved-voice.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

export type CancellationScenario = "success" | "recallLost" | "recallAltered" | "writeLost" | "changedTerms" |
  "changedTarget" | "stop" | "revokedProof" | "disabled" | "disconnect" | "heldWrite" | "lateStop" | "lateRevoke" | "lateTerms";
export const cancellationNow = "2026-10-04T04:00:00.000Z";
const base = "https://api.au5.cliniko.com/v1", apiKey = "synthetic-cancel-path-au5", phone = "+61400111222";
export const cancellationCanaries = ["private-chart-note", "registered-cancel@example.test", "private-caller-request"];

class CancellationPolicy extends MemoryPolicyStore {
  constructor() { super("requestOnly", () => cancellationNow, async () => ok(true), { cancellation: "execute" }); }
  override async read(scope: Parameters<MemoryPolicyStore["read"]>[0]) {
    const value = await super.read(scope);
    return value.ok ? ok({ ...value.value, staffWorkEnabled: true }) : value;
  }
}

/** Synthetic approved permission/mail/provider ports; actual SAM/gateway/proof/writer/recovery code. */
export async function cancellationFixture(scenario: CancellationScenario = "success", budgetFor?: (scope: { tenantId: string; clinicId: string; locationId: string }) => PatientVerificationBudget, external: { scope?: LocationScope; fetchPort?: typeof fetch } = {}) {
  const scope = external.scope ?? { tenantId: `cancel-${crypto.randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const callId = `call-${crypto.randomUUID()}`, sessionId = `session-${crypto.randomUUID()}`;
  const ledger = new MemoryLedger(async () => ok(true)), policy = new CancellationPolicy();
  resultValue(await policy.changeAutomationEnabled(scope, "0", true, "synthetic-admin"));
  resultValue(await policy.changeCancellationEnabled(scope, "0", true, "synthetic-admin"));
  const captured = approvedSyntheticPolicy(resultValue(await policy.read(scope)));
  let permitted = true, termsVersion = "fee-1", start = "2026-10-08T04:00:00.000Z", cancelled = false;
  let patches = 0, contactReads = 0, appointmentReads = 0;
  const recalls: Record<string, unknown>[] = [], mail: { email: string; code: string }[] = [], calls: string[] = [];
  let host: ClinikoCancellationHost;
  let releaseWrite: () => void = () => undefined;
  const heldWrite = new Promise<Response>(resolve => { releaseWrite = () => resolve(new Response(null, { status: 204 })); });
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET";
    assert.equal(url.origin, "https://api.au5.cliniko.com"); assert.equal(init?.redirect, "error");
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === "/v1/patients/42") {
      contactReads++;
      return Response.json({ id: "42", archived_at: null, email: cancellationCanaries[1],
        patient_phone_numbers: [{ number: phone, phone_type: "Mobile" }], notes: cancellationCanaries[0] });
    }
    if (url.pathname === "/v1/recalls" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      const row = { id: "71", archived_at: null, recalled: false, recall_at: body.recall_at, notes: body.notes,
        patient: { links: { self: `${base}/patients/42` } }, recall_type: { links: { self: `${base}/recall_types/7` } } };
      recalls.push(row);
      if (scenario === "changedTerms") termsVersion = "fee-changed";
      if (scenario === "changedTarget") start = "2026-10-09T04:00:00.000Z";
      if (scenario === "revokedProof") permitted = false;
      if (scenario === "stop") resultValue(await ledger.stopWrites(scope, "synthetic-admin", "stop"));
      if (scenario === "disabled") resultValue(await policy.changeAutomationEnabled(scope, "1", false, "synthetic-admin"));
      if (scenario === "disconnect") host.dispose();
      if (scenario === "recallLost") throw new Error("lost recall acknowledgment after commit");
      return Response.json(scenario === "recallAltered" ? { ...row, notes: "altered notes" } : row, { status: 201 });
    }
    if (url.pathname === "/v1/recalls") return Response.json({ recalls, total_entries: recalls.length });
    if (url.pathname.endsWith("/cancel") && method === "PATCH") {
      patches++; assert.equal(recalls.length, 1); assert.equal(JSON.parse(String(init?.body)).cancellation_reason, 50);
      const action = Object.values(resultValue(await ledger.read(callId, scope)).actions)[0]!;
      assert.equal(action.status, "dispatched");
      assert.equal(resultValue(await ledger.read(callId, scope)).presentations[action.presentationId]?.status, "played");
      cancelled = true;
      if (scenario === "writeLost") throw new Error("lost cancellation acknowledgment after commit");
      if (scenario === "heldWrite") return heldWrite;
      return new Response(null, { status: 204 });
    }
    assert.equal(url.pathname, "/v1/individual_appointments/91"); assert.equal(method, "GET"); appointmentReads++;
    if (appointmentReads === 2 && recalls.length === 1) {
      if (scenario === "lateStop") resultValue(await ledger.stopWrites(scope, "synthetic-admin", "late stop"));
      if (scenario === "lateRevoke") permitted = false;
      if (scenario === "lateTerms") termsVersion = "late-fee-change";
    }
    return Response.json({ id: "91", starts_at: start, ends_at: "2026-10-08T04:30:00.000Z", archived_at: null,
      deleted_at: null, cancelled_at: cancelled ? cancellationNow : null, notes: cancellationCanaries[0],
      patient: { links: { self: `${base}/patients/42` } }, business: { links: { self: `${base}/businesses/11` } },
      practitioner: { links: { self: `${base}/practitioners/22` } }, appointment_type: { links: { self: `${base}/appointment_types/33` } } });
  };
  const providerPort = external.fetchPort ?? fetchPort;
  const clinicConfig = { scope, apiKey, contactEmail: "test@example.test" }, credentialFingerprint = clinikoCredentialFingerprint(apiKey);
  const lookup = { candidates: async () => ok({ kind: "one" as const, candidateIds: ["42"] }) };
  const verificationPolicy = { current: async () => ok({ scope, enabled: true, version: captured.policyVersion }) };
  const email = new EmailPatientAuthority({ scope, callId, sessionId, presentedNumber: phone,
    policyVersion: captured.policyVersion, operations: ["appointments.cancel"], lookup,
    contact: new ClinikoVerificationContactReader({ ...clinicConfig, countryCallingCode: "61" }, providerPort),
    policy: verificationPolicy, budget: budgetFor?.(scope) ?? { reserve: async () => true }, permission: { allows: async () => permitted },
    delivery: { send: async (address, code) => { mail.push({ email: address, code }); return true; } },
    clock: () => Date.parse(cancellationNow) });
  const proof = new TransientPatientProofHost({ scope, callId, sessionId, policyVersion: captured.policyVersion,
    presentedCallerNumber: phone, maxAttempts: 3, lookup, authority: email, policy: verificationPolicy, clock: () => cancellationNow });
  const writer = resultValue(ClinikoCancellationWriter.create({ ...clinicConfig, businessId: "11" }, providerPort, () => cancellationNow));
  host = new ClinikoCancellationHost({ scope, callId, sessionId, policyVersion: captured.policyVersion,
    ledger, policy, proof, cancellation: writer, businessId: "11", credentialFingerprint, timeZone: "Australia/Sydney",
    recallTypeId: "7", recallWriter: resultValue(ClinikoRecallWriter.create(clinicConfig, providerPort)), clock: () => cancellationNow,
    authority: { async resolve(query) { return ok({ scope, callId, sessionId, policyVersion: captured.policyVersion,
      patientId: "42", targetRef: query.targetRef, businessId: "11", credentialFingerprint, practitionerId: "22", appointmentTypeId: "33",
      kind: "cancel" as const, cancellationReason: 50 as const,
      target: { scope, appointmentRef: "91", patientRef: "42", startsAt: start, endsAt: "2026-10-08T04:30:00.000Z", timeZone: "Australia/Sydney" },
      terms: { version: termsVersion, approvedText: "A cancellation fee of $20 applies.", expiresAt: "2026-10-04T04:04:00.000Z" } }); } } });
  const reception = new TextReception(ledger, policy, host), runtime = new CallRuntime(ledger, scope);
  const agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope }, policy, reception, undefined, undefined, undefined, ledger);
  resultValue(await runtime.admit(callId, captured, { key: { accountRef: "synthetic-account", providerCallRef: callId },
    dialedNumber: "+6125550199", acceptedAt: cancellationNow, deadline: "2026-10-04T04:00:30.000Z" }));
  resultValue(await runtime.activate(callId, sessionId, cancellationNow));
  async function verify() {
    await email.start("appointments.cancel"); assert.equal(mail.length, 1);
    const token = resultValue(await email.answer(mail[0]!.code));
    return resultValue(await proof.issue(token, "appointments.cancel")).verificationRef;
  }
  async function propose(verificationRef: string) {
    return agent.submit({ kind: "appointments.change.propose.v1", now: cancellationNow,
      turn: { callId, sessionId, turnId: "cancel-proposal", text: cancellationCanaries[2]!, quality: "clear", at: cancellationNow },
      selection: { kind: "cancel", verificationRef, targetRef: "selected-91" } });
  }
  const state = async () => resultValue(await ledger.read(callId, scope));
  async function confirm() {
    const action = Object.values((await state()).actions)[0]!;
    resultValue(await runtime.startPresentation(callId, action.presentationId, sessionId, cancellationNow));
    resultValue(await runtime.resolvePresentation(callId, action.presentationId, "played", sessionId, cancellationNow));
    resultValue(await reception.affirm(scope, { callId, sessionId, turnId: "caller-yes", text: "Yes", quality: "clear", at: cancellationNow },
      action.key, action.digest, cancellationNow));
  }
  const drain = async (at = cancellationNow) => resultValue(await reception.drain(scope, callId, at));
  async function discovery() {
    return resultValue(await resultValue(ClinikoRecallReader.create(clinicConfig, providerPort)).discoverPendingReviews(scope, "7"));
  }
  return { scope, callId, sessionId, ledger, policy, host, runtime, reception, agent, email, mail, recalls, calls,
    verify, propose, confirm, drain, state, discovery, releaseWrite, revoke: () => { permitted = false; },
    get patches() { return patches; }, get appointmentReads() { return appointmentReads; }, get contactReads() { return contactReads; } };
}
