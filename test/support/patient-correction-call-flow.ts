import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { callerVerificationFixture, verificationCanaries, verificationNow } from "./caller-verification.ts";
import { SyntheticContactRevision } from "./contact-revision.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { patientDetailFields } from "../../src/cliniko/patient-details.ts";
import { OwnerFilePatientUpdatePolicy, patientUpdateScopeText } from "../../src/standalone/owner-file-patient-update-policy.ts";
import type { PatientUpdateApproval } from "../../src/standalone/owner-file-patient-update-policy.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import type { ClinikoCallFlowConfig } from "../../src/standalone/cliniko-call-flow.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

export async function patientCorrectionCallFlowFixture(options: Pick<NonNullable<Parameters<typeof callerVerificationFixture>[0]>, "scope"> = {}) {
  const f = await callerVerificationFixture({ ...options, operation: "patients.update", patientUpdateExecute: true });
  const apiKey = "synthetic-session-au5", credentialFingerprint = clinikoCredentialFingerprint(apiKey);
  const contactRevision = new SyntheticContactRevision(f.scope.tenantId, [credentialFingerprint]);
  const path = join(f.folder, "correction.json"), base = "https://api.au5.cliniko.com/v1", patientId = verificationCanaries[2]!;
  const approval: PatientUpdateApproval = { scope: f.scope, revision: "correction-1", approverRef: f.account.actor.actorRef, approved: true, enabled: true,
    approvedAt: "2026-01-01T00:00:00.000Z", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil: "2027-01-01T00:00:00.000Z",
    policyVersion: f.config.policyVersion, correctionVersion: "1", businessId: "11", credentialFingerprint, timeZone: "Australia/Sydney",
    operation: "patients.update", recordScope: "clinikoAccount", callerEligibility: "selfOnly", minors: "deny", representatives: "deny", minimumAgeYears: 18,
    leapDayBirthday: "march1", patientPermission: "independentClinicHost", verificationMethod: "registeredEmailOtp", emailChangeVerification: "prospectiveEmailOtp",
    confirmation: "privateReadback", contactSynchronization: "revokeProofsAndInvalidateAccountLookups", allowedFields: [...patientDetailFields],
    privacyTerms: { version: "privacy-1", approvedText: "Your details are held in Cliniko." }, correctionTerms: { version: "correction-1", approvedText: patientUpdateScopeText } };
  await writeFile(path, JSON.stringify(approval), { mode: 0o600 });
  const policy = resultValue(await OwnerFilePatientUpdatePolicy.capture({ ...approval, path, directory: f.config.directory, correctionsEnabled: true, clock: f.config.clock }));
  let patient: Record<string, unknown> = { id: patientId, archived_at: null, merged_at: null, updated_at: verificationNow, links: { self: `${base}/patients/${patientId}` },
    first_name: "Synthetic", last_name: "Patient", date_of_birth: "1980-01-02", email: verificationCanaries[0], patient_phone_numbers: [{ number: "+61400111222", phone_type: "Mobile" }],
    address_1: "1 Example Road", address_2: null, address_3: null, city: "Example", state: "VIC", post_code: "3000", country_code: "AU", notes: "correction-chart-canary" };
  const fetchPort: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    if (url.pathname === `/v1/patients/${patientId}`) {
      if (method === "PATCH") patient = { ...patient, ...JSON.parse(String(init?.body)), updated_at: "2026-10-04T06:00:01.000Z" };
      return Response.json(patient);
    }
    if (url.pathname === "/v1/recalls" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      return Response.json({ id: "71", notes: body.notes, recalled: false, archived_at: null, recall_at: body.recall_at,
        patient: { links: { self: `${base}/patients/${patientId}` } }, recall_type: { links: { self: `${base}/recall_types/7` } } }, { status: 201 });
    }
    const business = { id: "11", name: "Synthetic Clinic", archived_at: null, show_in_online_bookings: true, time_zone_identifier: "Australia/Sydney" };
    const practitioner = { id: "22", display_name: "Synthetic Practitioner", active: true, archived_at: null, show_in_online_bookings: true };
    const type = { id: "33", name: "Synthetic Consultation", archived_at: null, show_in_online_bookings: true, duration_in_minutes: 30 };
    if (url.pathname === "/v1/businesses/11") return Response.json(business);
    if (url.pathname === "/v1/practitioners/22") return Response.json(practitioner);
    if (url.pathname === "/v1/appointment_types/33") return Response.json(type);
    if (url.pathname === "/v1/businesses") return Response.json({ total_entries: 1, businesses: [business] });
    if (url.pathname === "/v1/practitioners" || url.pathname === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1, practitioners: [practitioner] });
    if (url.pathname === "/v1/appointment_types" || url.pathname === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1, appointment_types: [type] });
    if (url.pathname.endsWith("/available_times")) return Response.json({ total_entries: 0, available_times: [] });
    return new Response(null, { status: 404 });
  };
  const flowConfig: ClinikoCallFlowConfig = { receipt: f.receipt, inbound: f.inbound, sessionId: f.sessionId, policyVersion: f.config.policyVersion,
    ledger: f.ledger, policies: f.policies, lookup: f.sessionConfig.lookup, permission: f.sessionConfig.permission, verificationBudget: f.sessionConfig.budget,
    delivery: f.sessionConfig.delivery, directory: f.config.directory,
    approvals: { bookCaller: f.path, cancelCaller: f.path, rescheduleCaller: f.path, booking: f.path, cancellation: f.path, rescheduling: f.path },
    cliniko: { apiKey, contactEmail: "test@example.test", businessId: "11", practitionerId: "22", appointmentTypeId: "33", recallTypeId: "7",
      timeZone: "Australia/Sydney", countryCallingCode: "61", rateBudget: { claim: async () => null, observe429: async () => ({ kind: "rateLimited" }) }, contactRevision },
    correction: { policy, callerApprovalPath: f.path, permission: f.sessionConfig.permission, contactRevision, presentation: { play: async () => true } },
    signal: new AbortController().signal, fetchPort, clock: f.config.clock };
  const flow = resultValue(ClinikoCallFlow.create(flowConfig));
  return { ...f, flowConfig, flow, correctionPath: path, get patient() { return patient; }, close: async () => { flow.dispose(); await f.close(); } };
}
