import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import type { ClinikoCallFlowConfig } from "../../src/standalone/cliniko-call-flow.ts";
import { err } from "../../src/core/model.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { incomingCallContextFixture } from "./incoming-call-context.ts";
import { value } from "./outbound-records.ts";

type Fixture = Awaited<ReturnType<typeof incomingCallContextFixture>>;
export async function incomingCallFlowFixture(f: Fixture, options: { fetchPort?: typeof fetch; approvals?: ClinikoCallFlowConfig["approvals"] } = {}) {
  f.session.dispose();
  const path = join(f.folder, "incoming-call-read-approval.json"), lifetime = new AbortController();
  await writeFile(path, JSON.stringify({ scope: f.scope, revision: "read-original-call-1", approverRef: f.approval.approverRef,
    approved: true, enabled: true, approvedAt: f.approval.approvedAt, effectiveFrom: f.approval.effectiveFrom,
    effectiveUntil: f.approval.effectiveUntil, policyVersion: f.sessionConfig.policyVersion, businessId: "11",
    credentialFingerprint: f.attempt.credentialFingerprint, timeZone: "Australia/Sydney", searchDays: 30 }), { mode: 0o600 });
  const fetchPort: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    return url.pathname.startsWith("/v1/recalls") || url.pathname.startsWith("/v1/individual_appointments/")
      ? f.config.fetchPort(input, init) : f.fetchPort(input, init);
  };
  const config: ClinikoCallFlowConfig = { ...f.sessionConfig, policies: f.policies, directory: f.callerConfig.directory,
    verificationBudget: f.sessionConfig.budget,
    cliniko: { apiKey: f.native.config.apiKey, contactEmail: f.native.config.contactEmail, businessId: "11", practitionerId: "31",
      appointmentTypeId: "41", recallTypeId: "7", timeZone: "Australia/Sydney", countryCallingCode: "61", rateBudget: f.native.config.rateBudget },
    approvals: options.approvals ?? { bookCaller: "disabled", cancelCaller: "disabled", rescheduleCaller: "disabled", booking: "disabled", cancellation: "disabled", rescheduling: "disabled" },
    enquiry: { callerApprovalPath: f.path, readApprovalPath: path, permission: f.sessionConfig.permission },
    missedCall: f.provision, signal: lifetime.signal, fetchPort: options.fetchPort ?? fetchPort };
  const flow = value(ClinikoCallFlow.create(config));
  const reception = new TextReception(f.ledger, f.policies, flow, undefined, {
    list: (...args) => flow.appointments?.list(...args) ?? Promise.resolve(err({ kind: "unavailable" as const })),
    select: (...args) => flow.appointments?.select(...args) ?? Promise.resolve(err({ kind: "unavailable" as const })),
  }, undefined, undefined, f.sessionConfig.clock);
  let turns = 0;
  const turn = (text: string) => ({ callId: f.callId, sessionId: f.sessionId, turnId: `incoming-${++turns}`,
    text, quality: "clear" as const, at: f.inbound.receivedAt });
  const verify = async (operation: "appointments.read" | "cancel" | "reschedule" = "appointments.read") => {
    const count = f.mail.length;
    const before = value(await f.ledger.read(f.callId, f.scope));
    const requested = turn(operation === "appointments.read" ? "Read my appointments" : operation === "cancel" ? "Cancel my appointment" : "Move my appointment");
    const started = value(await reception.startWorkflow(f.scope, requested, operation, f.inbound.receivedAt, before.conversationRevision));
    assert.deepEqual(started.lastWorkflowStart, { turnId: requested.turnId, operation, next: "codeRequired" });
    if (started.pendingPresentationId) {
      value(await f.runtime.startPresentation(f.callId, started.pendingPresentationId, f.sessionId, f.inbound.receivedAt));
      value(await f.runtime.resolvePresentation(f.callId, started.pendingPresentationId, "played", f.sessionId, f.inbound.receivedAt));
    }
    flow.beginVerification(); const deadline = Date.now() + 5000;
    while (f.mail.length === count && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
    assert.equal(f.mail.length, count + 1); assert.deepEqual(await flow.submitCode(f.mail.at(-1)!.code), { verified: true });
  };
  return { flow, config, reception, turn, verify, close: () => { lifetime.abort(); flow.dispose(); } };
}
