import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClinikoReadBudget, clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { bookingOffersFixture } from "./booking-offers.ts";
import { representativeFixture } from "./representative-selection.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { verificationNow, verificationCanaries } from "./caller-verification.ts";

export function representativeInputOptions(f: Awaited<ReturnType<typeof representativeCallOwnerFixture>>) {
  const { callerApprovalPath, callerPermission, representativeApprovalPath, representativeCallerApprovalPath, permission } = f.config;
  return { callerApprovalPath, callerPermission, representativeApprovalPath, representativeCallerApprovalPath, permission };
}

export async function representativeCallOwnerFixture(options: { multiplePatients?: true; operation?: "book" | "appointments.read" | "cancel" | "reschedule";
  allowedOperations?: readonly ("book" | "appointments.read" | "cancel" | "reschedule")[]; appointmentChanges?: true; budget?: ClinikoRequestBudget;
  subjectIds?: readonly [string, string]; guardian?: true } = {}) {
  const f = await bookingOffersFixture({ ...(options.appointmentChanges ? { appointmentChanges: true } : {}), budget: options.budget ?? new ClinikoReadBudget(200, () => Date.parse(verificationNow)) });
  const operation = options.operation ?? "book";
  const patientOperations = { book: "appointments.book", cancel: "appointments.cancel", reschedule: "appointments.reschedule", "appointments.read": "appointments.read" } as const;
  const r = await representativeFixture(f.ownerPorts.rateBudget, { fixture: f, operation: patientOperations[operation], ...(options.subjectIds ? { subjectIds: options.subjectIds } : {}) });
  const [firstId, secondId] = r.subjectIds;
  if (options.guardian) {
    r.identity.dateOfBirth = "2014-03-05";
    r.patients.get(firstId)!.date_of_birth = r.identity.dateOfBirth;
    r.authorizations.set(firstId, { ...r.authorizations.get(firstId)!, subjectKind: "minor", authorityKind: "guardian", authorityRef: "approved-first-guardian" });
  }
  if (options.allowedOperations) {
    const operations = options.allowedOperations.map(op => patientOperations[op]);
    await r.replaceApproval({ operations }); await r.replaceCaller({ operations });
  }
  const callerPath = join(f.folder, "representative-actor-caller.json");
  const approval = JSON.parse(await readFile(f.config.path, "utf8"));
  await writeFile(callerPath, JSON.stringify({ ...approval, operations: ["appointments.read"] }), { mode: 0o600 });
  const mail: { email: string; code: string }[] = [];
  let actorPermission = true, subjectPermission = true, writes = 0;
  const emptyReads = new Set<string>(); let readFailure = false;
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)), path = url.pathname;
    if (path.startsWith("/v1/relationships") || path === `/v1/patients/${firstId}` || path === `/v1/patients/${secondId}`) return r.config.fetchPort!(value, init);
    if (operation === "appointments.read" && path === "/v1/individual_appointments" && (init?.method ?? "GET") === "GET") {
      if (readFailure) return new Response(null, { status: 503 });
      const id = url.searchParams.getAll("q[]").map(filter => /^patient_id:=([0-9]+)$/.exec(filter)?.[1]).find(Boolean); assert.ok(id && [firstId, secondId].includes(id));
      const starts = id === firstId ? "2026-10-08T04:00:00.000Z" : "2026-10-08T05:00:00.000Z";
      const rows = emptyReads.has(id) ? [] : [{ id: id === firstId ? "81" : "82", starts_at: starts,
        ends_at: new Date(Date.parse(starts) + 30 * 60_000).toISOString(), cancelled_at: null, archived_at: null, deleted_at: null,
        patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${id}` } },
        business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/11" } } }];
      return Response.json({ total_entries: rows.length, individual_appointments: rows });
    }
    if (path === "/v1/recalls" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)); assert.ok(body.patient_id === firstId || options.multiplePatients && body.patient_id === secondId);
      const row = { id: "71", archived_at: null, recalled: false, recall_at: body.recall_at, notes: body.notes,
        patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${body.patient_id}` } },
        recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/7" } } };
      f.recalls.push(row); return Response.json(row, { status: 201 });
    }
    if (path === "/v1/individual_appointments" && init?.method === "POST") {
      assert.equal(JSON.parse(String(init.body)).patient_id, firstId); writes++;
    }
    return f.ownerPorts.fetchPort(value, init);
  };
  const context = { receipt: f.receipt, inbound: f.inbound, sessionId: f.sessionId, policyVersion: f.sessionConfig.policyVersion,
    ledger: f.ledger, policies: f.policies, lookup: f.sessionConfig.lookup, verificationBudget: { reserve: async () => true },
    delivery: { send: async (email: string, code: string) => { mail.push({ email, code }); return true; } },
    directory: f.directory, cliniko: r.config.cliniko, signal: r.lifetime.signal, fetchPort, clock: f.sessionConfig.clock };
  const flowConfig = { ...context, permission: { allows: async (_scope: unknown, id: string) => (id === firstId || options.multiplePatients && id === secondId) === true && subjectPermission },
    approvals: { bookCaller: r.config.representativeCallerApprovalPath, cancelCaller: r.config.representativeCallerApprovalPath,
      rescheduleCaller: r.config.representativeCallerApprovalPath, booking: f.path, cancellation: f.path, rescheduling: f.path } };
  let enquiry: import("../../src/standalone/cliniko-call-flow.ts").ClinikoCallFlowConfig["enquiry"];
  if (operation === "appointments.read" || options.allowedOperations?.includes("appointments.read")) {
    const path = join(f.folder, "representative-read.json");
    const common = Object.fromEntries(["scope", "revision", "approverRef", "approvedAt", "effectiveFrom", "effectiveUntil", "approved", "enabled"].map(key => [key, approval[key]]));
    await writeFile(path, JSON.stringify({ ...common, policyVersion: context.policyVersion, businessId: context.cliniko.businessId,
      credentialFingerprint: clinikoCredentialFingerprint(context.cliniko.apiKey),
      timeZone: context.cliniko.timeZone, searchDays: 30 }), { mode: 0o600 });
    enquiry = { callerApprovalPath: r.config.representativeCallerApprovalPath, readApprovalPath: path,
      permission: { allows: async (_scope, id, op) => op === "appointments.read" && await flowConfig.permission.allows(_scope, id) } };
  }
  const completeFlowConfig = { ...flowConfig, ...(enquiry ? { enquiry } : {}) };
  const flow = resultValue(ClinikoCallFlow.create(completeFlowConfig));
  const config = { context, flow, operation, callerApprovalPath: callerPath,
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
  return { f, r, config, flow, flowConfig: completeFlowConfig, mail, callerPath, waitForMail, play, get writes() { return writes; },
    setReadEmpty: (id: string) => { emptyReads.add(id); }, setReadFailure: () => { readFailure = true; },
    revokeActor: () => { actorPermission = false; }, revokeSubject: () => { subjectPermission = false; },
    close: async () => { flow.dispose(); await r.close(); } };
}
