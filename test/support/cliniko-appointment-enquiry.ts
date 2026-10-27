import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { err } from "../../src/core/model.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import type { ClinikoCallFlowConfig } from "../../src/standalone/cliniko-call-flow.ts";
import type { AppointmentReadApproval } from "../../src/standalone/owner-file-appointment-read-policy.ts";
import type { PatientVerificationPermission } from "../../src/standalone/email-patient-authority.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { callerVerificationFixture, verificationCanaries, verificationNow } from "./caller-verification.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { bookingCallFlowFixture } from "./cliniko-call-flow.ts";

/** Real read verifier/source and call owner with no clinical write activation or approval files. */
export async function appointmentEnquiryFixture() {
  const f = await callerVerificationFixture({ operation: "appointments.read" }); f.session.dispose();
  const lifetime = new AbortController(), path = join(f.folder, "appointment-read.json"), apiKey = "synthetic-session-au5";
  let record: AppointmentReadApproval = { scope: f.scope, revision: "read-1", approverRef: "synthetic-admin", approved: true, enabled: true,
    approvedAt: "2026-10-04T05:59:00.000Z", effectiveFrom: verificationNow, effectiveUntil: "2026-10-05T06:00:00.000Z",
    policyVersion: f.sessionConfig.policyVersion, businessId: "11", credentialFingerprint: clinikoCredentialFingerprint(apiKey), timeZone: "Australia/Sydney", searchDays: 30 };
  let multiple = false, empty = false, changed = false, failure = false, wrongBusiness = false, timeZone = "Australia/Sydney";
  let email = verificationCanaries[0]!, reads = 0, onRead: () => Promise<void> = async () => undefined;
  const traffic: string[] = [], permissionOperations: string[] = [];
  const replace = async () => { await writeFile(`${path}.new`, JSON.stringify(record), { mode: 0o600 }); await rename(`${path}.new`, path); };
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET"; traffic.push(`${method} ${url.pathname}`);
    if (method !== "GET") throw new Error("read fixture has no writer");
    if (url.pathname.startsWith("/v1/patients/")) return Response.json({ id: verificationCanaries[2], email, archived_at: null,
      patient_phone_numbers: [{ number: "+61400111222", phone_type: "Mobile" }], notes: verificationCanaries[1] });
    if (url.pathname === "/v1/businesses/11") return Response.json({ id: "11", archived_at: null, time_zone_identifier: timeZone });
    if (url.pathname !== "/v1/individual_appointments") throw new Error("unsupported synthetic read");
    reads++; await onRead();
    if (failure) return new Response(null, { status: 503 });
    const target = (id: string) => ({ id, starts_at: id === "91" ? "2026-10-08T04:00:00.000Z" : changed ? "2026-10-08T06:00:00.000Z" : "2026-10-08T05:00:00.000Z",
      ends_at: id === "91" ? "2026-10-08T04:30:00.000Z" : changed ? "2026-10-08T06:30:00.000Z" : "2026-10-08T05:30:00.000Z",
      cancelled_at: null, archived_at: null, deleted_at: null, notes: verificationCanaries[1],
      patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${verificationCanaries[2]}` } },
      business: { links: { self: `https://api.au5.cliniko.com/v1/businesses/${wrongBusiness ? "12" : "11"}` } } });
    const rows = empty ? [] : [target("91"), ...(multiple ? [target("92")] : [])];
    return Response.json({ individual_appointments: rows, total_entries: rows.length });
  };
  try {
    await replace();
    const permission: PatientVerificationPermission = { allows: async (_scope, _patientId, operation) => {
      permissionOperations.push(operation); return operation === "appointments.read" && await f.sessionConfig.permission.allows();
    } };
    const flowConfig: ClinikoCallFlowConfig = { ...f.sessionConfig, verificationBudget: f.sessionConfig.budget, policies: f.policies, directory: f.config.directory,
      cliniko: { apiKey, contactEmail: "test@example.test", businessId: "11", practitionerId: "22", appointmentTypeId: "33", recallTypeId: "7",
        timeZone: "Australia/Sydney", countryCallingCode: "61", rateBudget: { claim: async () => null, observe429: async () => ({ kind: "rateLimited" }) } },
      approvals: { bookCaller: "disabled", cancelCaller: "disabled", rescheduleCaller: "disabled", booking: "disabled", cancellation: "disabled", rescheduling: "disabled" },
      permission, enquiry: { callerApprovalPath: f.path, readApprovalPath: path, permission }, signal: lifetime.signal, fetchPort };
    const flow = resultValue(ClinikoCallFlow.create(flowConfig));
    const reception = new TextReception(f.ledger, f.policies, flow, undefined, { list: (...args) => flow.appointments?.list(...args) ?? Promise.resolve(err({ kind: "unavailable" })) }, undefined, undefined, f.sessionConfig.clock);
    return { ...f, flow, reception, flowConfig, traffic, permissionOperations, lifetime,
      replaceRead: async (patch: Partial<AppointmentReadApproval>) => { record = { ...record, ...patch }; await replace(); },
      setMultiple: () => { multiple = true; }, setEmpty: () => { empty = true; }, setChanged: () => { changed = true; },
      setFailure: () => { failure = true; }, setWrongBusiness: () => { wrongBusiness = true; }, setTimeZone: (value: string) => { timeZone = value; },
      setReadEmail: (value: string) => { email = value; }, setOnRead: (run: () => Promise<void>) => { onRead = run; },
      get reads() { return reads; }, close: async () => { flow.dispose(); lifetime.abort(); await f.close(); } };
  } catch (error) { lifetime.abort(); await f.close(); throw error; }
}

/** Separate synthetic read approval/permission alongside an independently enabled booking owner. */
export async function enquiryThenBookingFixture() {
  const f = await bookingCallFlowFixture(); f.flow.dispose();
  const callerPath = join(f.folder, "enquiry-caller.json"), readPath = join(f.folder, "enquiry-read.json");
  const caller = JSON.parse(await readFile(f.config.callerApprovalPath, "utf8"));
  await writeFile(callerPath, JSON.stringify({ ...caller, revision: "read-method-1", operations: ["appointments.read"] }), { mode: 0o600 });
  const approval: AppointmentReadApproval = { scope: f.scope, revision: "read-1", approverRef: caller.approverRef,
    approvedAt: caller.approvedAt, effectiveFrom: caller.effectiveFrom, effectiveUntil: caller.effectiveUntil,
    approved: true, enabled: true, policyVersion: f.flowConfig.policyVersion, businessId: "11", timeZone: "Australia/Sydney", searchDays: 30,
    credentialFingerprint: clinikoCredentialFingerprint(f.flowConfig.cliniko.apiKey) };
  await writeFile(readPath, JSON.stringify(approval), { mode: 0o600 });
  const original = f.flowConfig.fetchPort!;
  const fetchPort: typeof fetch = (value, init) => {
    const url = new URL(String(value));
    if ((init?.method ?? "GET") === "GET" && url.pathname === "/v1/individual_appointments" && url.searchParams.getAll("q[]").some(filter => filter.startsWith("starts_at:>"))) return Promise.resolve(Response.json({ total_entries: 1,
      individual_appointments: [{ id: "81", starts_at: "2026-10-08T04:00:00.000Z", ends_at: "2026-10-08T04:30:00.000Z",
        patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${verificationCanaries[2]}` } }, business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/11" } } }] }));
    return original(value, init);
  };
  const flowConfig: ClinikoCallFlowConfig = { ...f.flowConfig, fetchPort, enquiry: { callerApprovalPath: callerPath, readApprovalPath: readPath,
    permission: { allows: async (_scope, _patient, operation) => operation === "appointments.read" } } };
  const flow = resultValue(ClinikoCallFlow.create(flowConfig));
  return { ...f, flow, flowConfig, close: async () => { flow.dispose(); await f.close(); } };
}
