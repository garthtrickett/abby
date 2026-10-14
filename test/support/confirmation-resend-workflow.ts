import assert from "node:assert/strict";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { confirmationResendFixture } from "./confirmation-resend.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

export async function resendWorkflow(f: Awaited<ReturnType<typeof confirmationResendFixture>>, request = "Please resend my appointment email") {
  const flow = resultValue(ClinikoCallFlow.create({ ...f.config,
    directory: new OwnerFileAdminDirectory(f.accountPath, f.scope), lookup: f.sessionConfig.lookup,
    verificationBudget: f.sessionConfig.budget, delivery: f.sessionConfig.delivery,
    approvals: { bookCaller: f.path, cancelCaller: f.path, rescheduleCaller: f.path, booking: f.path, cancellation: f.path, rescheduling: f.path },
    cliniko: { ...f.config.cliniko, practitionerId: "22", appointmentTypeId: "33", contactRevision: f.revision },
    resend: { ...f.config, callerApprovalPath: f.path },
  }));
  const now = f.sessionConfig.clock(), state = await f.state(), greeting = state.pendingPresentationId!;
  resultValue(await f.runtime.startPresentation(f.callId, greeting, f.sessionId, now));
  resultValue(await f.runtime.resolvePresentation(f.callId, greeting, "played", f.sessionId, now));
  const reception = new TextReception(f.ledger, f.policies, flow, undefined, undefined, undefined, undefined, f.sessionConfig.clock);
  const turn = (id: string, text: string) => ({ callId: f.callId, sessionId: f.sessionId, turnId: id, text, quality: "clear" as const, at: f.sessionConfig.clock() });
  resultValue(await reception.startWorkflow(f.scope, turn("start", request), "confirmationResend", now));
  const pending = (await f.state()).pendingPresentationId!;
  resultValue(await f.runtime.startPresentation(f.callId, pending, f.sessionId, now));
  resultValue(await f.runtime.resolvePresentation(f.callId, pending, "played", f.sessionId, now));
  const verify = async () => {
    const deadline = Date.now() + 5000;
    while (!f.mail.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.mail.length, 1); assert.equal((await flow.submitCode(f.mail[0]!.code)).verified, true);
  };
  return { flow, reception, verify, turn };
}
