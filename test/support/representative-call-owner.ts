import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { bookingOffersFixture } from "./booking-offers.ts";
import { representativeFixture } from "./representative-selection.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { verificationNow, verificationCanaries } from "./caller-verification.ts";

export function representativeInputOptions(f: Awaited<ReturnType<typeof representativeCallOwnerFixture>>) {
  const { callerApprovalPath, callerPermission, representativeApprovalPath, representativeCallerApprovalPath, permission } = f.config;
  return { callerApprovalPath, callerPermission, representativeApprovalPath, representativeCallerApprovalPath, permission };
}

export async function representativeCallOwnerFixture() {
  const f = await bookingOffersFixture({ budget: new ClinikoReadBudget(200, () => Date.parse(verificationNow)) });
  const r = await representativeFixture(f.ownerPorts.rateBudget, { fixture: f, operation: "appointments.book" });
  const callerPath = join(f.folder, "representative-actor-caller.json");
  const approval = JSON.parse(await readFile(f.config.path, "utf8"));
  await writeFile(callerPath, JSON.stringify({ ...approval, operations: ["appointments.read"] }), { mode: 0o600 });
  const mail: { email: string; code: string }[] = [];
  let actorPermission = true, subjectPermission = true, writes = 0;
  const fetchPort: typeof fetch = async (value, init) => {
    const path = new URL(String(value)).pathname;
    if (path.startsWith("/v1/relationships") || path === "/v1/patients/43" || path === "/v1/patients/44") return r.config.fetchPort!(value, init);
    if (path === "/v1/recalls" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)); assert.equal(body.patient_id, "43");
      const row = { id: "71", archived_at: null, recalled: false, recall_at: body.recall_at, notes: body.notes,
        patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/43" } },
        recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/7" } } };
      f.recalls.push(row); return Response.json(row, { status: 201 });
    }
    if (path === "/v1/individual_appointments" && init?.method === "POST") {
      assert.equal(JSON.parse(String(init.body)).patient_id, "43"); writes++;
    }
    return f.ownerPorts.fetchPort(value, init);
  };
  const context = { receipt: f.receipt, inbound: f.inbound, sessionId: f.sessionId, policyVersion: f.sessionConfig.policyVersion,
    ledger: f.ledger, policies: f.policies, lookup: f.sessionConfig.lookup, verificationBudget: { reserve: async () => true },
    delivery: { send: async (email: string, code: string) => { mail.push({ email, code }); return true; } },
    directory: f.directory, cliniko: r.config.cliniko, signal: r.lifetime.signal, fetchPort, clock: f.sessionConfig.clock };
  const flowConfig = { ...context, permission: { allows: async (_scope: unknown, id: string) => id === "43" && subjectPermission },
    approvals: { bookCaller: r.config.representativeCallerApprovalPath, cancelCaller: r.config.representativeCallerApprovalPath,
      rescheduleCaller: r.config.representativeCallerApprovalPath, booking: f.path, cancellation: f.path, rescheduling: f.path } };
  const flow = resultValue(ClinikoCallFlow.create(flowConfig));
  const config = { context, flow, operation: "book" as const, callerApprovalPath: callerPath,
    callerPermission: { allows: async (_scope: unknown, id: string, operation: string) => actorPermission && id === verificationCanaries[2] && operation === "appointments.read" },
    representativeApprovalPath: r.policyConfig.path, representativeCallerApprovalPath: r.config.representativeCallerApprovalPath, permission: r.config.permission };
  async function waitForMail(count: number) {
    const deadline = Date.now() + 5000;
    while (mail.length < count && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
    assert.equal(mail.length, count);
  }
  async function play() {
    const pending = (await f.state()).pendingPresentationId!; assert.ok(pending);
    resultValue(await f.runtime.startPresentation(f.callId, pending, f.sessionId, verificationNow));
    resultValue(await f.runtime.resolvePresentation(f.callId, pending, "played", f.sessionId, verificationNow));
  }
  return { f, r, config, flow, flowConfig, mail, callerPath, waitForMail, play, get writes() { return writes; },
    revokeActor: () => { actorPermission = false; }, revokeSubject: () => { subjectPermission = false; },
    close: async () => { flow.dispose(); await r.close(); } };
}
