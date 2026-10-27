import assert from "node:assert/strict";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import type { ClinikoCallFlowConfig } from "../../src/standalone/cliniko-call-flow.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { patientCorrectionCallFlowFixture } from "./patient-correction-call-flow.ts";
import { syntheticTaskSequence } from "./call-task-sequence.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { verificationNow } from "./caller-verification.ts";

/** Real correction/task owners with synthetic clinic authority and native records. */
export async function correctionTasksFixture(options: Readonly<{ enquiry?: true; maximumTasks?: number }> = {}) {
  const f = await patientCorrectionCallFlowFixture(); f.flow.dispose();
  let activeFlow: ClinikoCallFlow | undefined;
  try {
    let enquiry: ClinikoCallFlowConfig["enquiry"];
    if (options.enquiry) {
      const caller = JSON.parse(await readFile(f.path, "utf8"));
      const callerPath = join(f.folder, "task-enquiry-caller.json"), readPath = join(f.folder, "task-enquiry-read.json");
      await writeFile(callerPath, JSON.stringify({ ...caller, revision: "task-enquiry-caller-1", operations: ["appointments.read"] }), { mode: 0o600 });
      await writeFile(readPath, JSON.stringify({ scope: f.scope, revision: "task-enquiry-read-1", approverRef: caller.approverRef,
        approved: true, enabled: true, approvedAt: caller.approvedAt, effectiveFrom: caller.effectiveFrom, effectiveUntil: caller.effectiveUntil,
        policyVersion: f.flowConfig.policyVersion, businessId: f.flowConfig.cliniko.businessId,
        credentialFingerprint: clinikoCredentialFingerprint(f.flowConfig.cliniko.apiKey), timeZone: f.flowConfig.cliniko.timeZone, searchDays: 30 }), { mode: 0o600 });
      enquiry = { callerApprovalPath: callerPath, readApprovalPath: readPath,
        permission: { allows: async (_scope, _patient, operation) => operation === "appointments.read" && await f.sessionConfig.permission.allows() } };
    }
    const patches: unknown[] = [];
    let reviews = 0, loseResponse = false;
    const fetchPort: typeof fetch = async (value, init) => {
      const path = new URL(String(value)).pathname, method = init?.method ?? "GET";
      if (enquiry && method === "GET" && path === "/v1/individual_appointments")
        return Response.json({ total_entries: 0, individual_appointments: [] });
      const response = await f.flowConfig.fetchPort!(value, init);
      if (method === "PATCH") {
        patches.push(JSON.parse(String(init?.body)));
        if (loseResponse) throw new Error("synthetic lost patient correction response");
      }
      if (method === "POST" && path === "/v1/recalls") {
        const row = await response.json(); row.id = String(71 + reviews++);
        return Response.json(row, { status: response.status });
      }
      return response;
    };
    const sequence = await syntheticTaskSequence({ ...f.flowConfig, fetchPort, ...(enquiry ? { enquiry } : {}) }, f.folder, options.maximumTasks ?? 2);
    const flow = resultValue(ClinikoCallFlow.create(sequence.config)); activeFlow = flow;
    const reception = new TextReception(f.ledger, f.policies, flow);
    const turn = (text: string) => ({ callId: f.callId, sessionId: f.sessionId, turnId: crypto.randomUUID(), text, quality: "clear" as const, at: verificationNow });
    const play = async () => {
      const id = (await f.state()).pendingPresentationId; if (!id) return;
      resultValue(await f.runtime.startPresentation(f.callId, id, f.sessionId, verificationNow));
      resultValue(await f.runtime.resolvePresentation(f.callId, id, "played", f.sessionId, verificationNow));
    };
    const start = async (operation: "patientUpdate" | "appointments.read" = "patientUpdate") => {
      const count = f.mail.length;
      resultValue(await reception.startWorkflow(f.scope, turn(operation === "patientUpdate" ? "Update my contact details" : "Check my appointments"), operation, verificationNow)); await play();
      const until = Date.now() + 5000; while (f.mail.length === count && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(f.mail.length, count + 1);
    };
    const commit = async () => {
      assert.ok(flow.patientCorrectionRef);
      resultValue(await reception.proposePatientCorrection(f.scope, turn("Save this correction"), flow.patientCorrectionRef, verificationNow));
      const action = Object.values((await f.state()).actions).at(-1)!; assert.equal(action.status, "awaitingConfirmation");
      const sent = patches.length;
      assert.equal((await reception.affirm(f.scope, turn("Yes"), action.key, action.digest, verificationNow)).ok, false);
      assert.equal(patches.length, sent); await play();
      resultValue(await reception.affirm(f.scope, turn("Yes"), action.key, action.digest, verificationNow));
      resultValue(await reception.drain(f.scope, f.callId, verificationNow)); await play();
      return (await f.state()).actions[action.key]!;
    };
    const correct = async (city: string) => {
      assert.equal((await flow.submitCode(f.mail.at(-1)!.code)).verified, true);
      const correction = flow.patientCorrection!; assert.ok(correction);
      const terms = resultValue(await correction.begin()); assert.equal(await correction.acknowledge(terms.consentRef, true), true);
      const collected = resultValue(await flow.collectPatientCorrection({ city })); assert.equal(collected.codeRequired, false);
      return commit();
    };
    await play();
    return { ...f, flow, reception, sequence, patches, start, correct, commit, turn, playTaskPresentation: play, get patient() { return f.patient; },
      reviews: () => reviews, loseResponse: () => { loseResponse = true; },
      closeTasks: async () => { flow.dispose(); await f.close(); } };
  } catch (error) { activeFlow?.dispose(); await f.close(); throw error; }
}
