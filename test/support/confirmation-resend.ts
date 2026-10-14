import assert from "node:assert/strict";
import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Kysely } from "kysely";
import type Database from "../../src/storage/generated/Database.ts";
import { PostgresClinikoContactRevision } from "../../src/storage/postgres-cliniko-contact-revision.ts";
import { PostgresConfirmationResendJournal } from "../../src/storage/postgres-confirmation-resend-journal.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { OwnerFileConfirmationResendPolicy } from "../../src/standalone/owner-file-confirmation-resend-policy.ts";
import type { ConfirmationResendApproval } from "../../src/standalone/owner-file-confirmation-resend-policy.ts";
import { ClinikoConfirmationResendSession } from "../../src/standalone/cliniko-confirmation-resend-session.ts";
import { SmtpAppointmentConfirmationDelivery } from "../../src/standalone/smtp-appointment-confirmation-delivery.ts";
import type { SmtpPatientCodeConfig } from "../../src/standalone/smtp-patient-code-delivery.ts";
import type { PatientOperation } from "../../src/standalone/transient-patient-proof.ts";
import { callerVerificationFixture, verificationCanaries } from "./caller-verification.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

export async function confirmationResendFixture(db: Kysely<Database>, smtp: SmtpPatientCodeConfig, operation: PatientOperation = "appointments.resend") {
  const apiKey = "synthetic-session-au5", fp = clinikoCredentialFingerprint(apiKey), scope = { tenantId: `resend-owner-${crypto.randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const revision = new PostgresClinikoContactRevision(db, scope.tenantId, [fp]);
  const f = await callerVerificationFixture({ scope, operation, contactRevision: revision });
  const lifetime = new AbortController(), path = join(f.folder, "resend-approval.json");
  const traffic: string[] = [], recalls: Record<string, unknown>[] = [], readbacks: string[] = [];
  let confirmed: string | undefined, play = true, appointmentPatch: Record<string, unknown> = {}, businessPatch: Record<string, unknown> = {},
    reviewUnknown = false, afterReadback: () => Promise<void> = async () => undefined, afterReview: () => Promise<void> = async () => undefined;
  const approval: ConfirmationResendApproval = { scope, revision: "resend-1", approverRef: f.approval.approverRef,
    approvedAt: f.approval.approvedAt, effectiveFrom: f.approval.effectiveFrom, effectiveUntil: f.approval.effectiveUntil,
    approved: true, enabled: true, policyVersion: f.sessionConfig.policyVersion, businessId: "11", credentialFingerprint: fp,
    timeZone: "Australia/Sydney", owner: "abby", sender: smtp.from, template: "appointmentDetails.v1", recipient: "verifiedRegisteredEmail",
    patientPermission: "independentClinicHost", consent: "separatePlayedConfirmation", submission: "durableSingleAttempt",
    recallTypeId: "7", reviewProcess: "clinikoRecallsFullType", reviewOwnerRef: "primary", reviewBackupRef: "backup", reviewCadenceMinutes: 15 };
  const replace = async (patch: Partial<ConfirmationResendApproval> = {}) => {
    await writeFile(`${path}.new`, JSON.stringify({ ...approval, ...patch }), { mode: 0o600 }); await rename(`${path}.new`, path);
  };
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET"; traffic.push(`${method} ${url.pathname}`);
    if (url.pathname.startsWith("/v1/patients/")) return originalFetch(value, init);
    if (method === "POST") {
      assert.equal(url.pathname, "/v1/recalls");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>; recalls.push(body); await afterReview();
      return Response.json({ id: "907", notes: body.notes, recall_at: body.recall_at, recalled: false, archived_at: reviewUnknown ? "2026-10-04T06:00:00.000Z" : null,
        patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${verificationCanaries[2]}` } }, recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/7" } } }, { status: 201 });
    }
    assert.equal(method, "GET");
    if (url.pathname === "/v1/individual_appointments/81") return Response.json({ id: "81", starts_at: "2026-10-08T04:00:00.000Z", ends_at: "2026-10-08T04:30:00.000Z",
      cancelled_at: null, archived_at: null, deleted_at: null, notes: verificationCanaries[1],
      patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${verificationCanaries[2]}` } }, business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/11" } },
      practitioner: { links: { self: "https://api.au5.cliniko.com/v1/practitioners/22" } }, appointment_type: { links: { self: "https://api.au5.cliniko.com/v1/appointment_types/33" } }, ...appointmentPatch });
    if (url.pathname === "/v1/businesses/11") return Response.json({ id: "11", archived_at: null, time_zone_identifier: "Australia/Sydney",
      business_name: "Synthetic Clinic", display_name: "Synthetic Branch", address_1: "20 Fixture Road", city: "Sydney", post_code: "2000", ...businessPatch });
    if (url.pathname === "/v1/practitioners/22") return Response.json({ id: "22", display_name: "Séamus Example", first_name: "Séamus", last_name: "Example", private_notes: verificationCanaries[1] });
    if (url.pathname === "/v1/appointment_types/33") return Response.json({ id: "33", archived_at: null, name: "Follow up", duration_in_minutes: 30 });
    throw new Error("unexpected synthetic confirmation read");
  };
  // The registered-channel verifier keeps the original reader. Both readers share the same native revision owner.
  const originalFetch: typeof fetch = async value => {
    const url = new URL(String(value));
    assert.ok(url.pathname.startsWith("/v1/patients/"));
    // Obtain the current registered address through the existing native reader, so f.setEmail affects both boundaries.
    const address = await f.sessionConfig.contact.read(scope, verificationCanaries[2]!, f.inbound.presentedCallerNumber!, new AbortController().signal);
    return Response.json({ id: verificationCanaries[2], email: address.ok ? address.value : null, archived_at: null,
      patient_phone_numbers: [{ number: f.inbound.presentedCallerNumber, phone_type: "Mobile" }], notes: verificationCanaries[1] });
  };
  try {
    await replace();
    const policy = resultValue(await OwnerFileConfirmationResendPolicy.capture({ ...approval, path, directory: f.config.directory, clock: f.sessionConfig.clock }));
    const journal = new PostgresConfirmationResendJournal(db, scope, policy.bindingFingerprint());
    const config = { receipt: f.receipt, inbound: f.inbound, sessionId: f.sessionId, policyVersion: f.sessionConfig.policyVersion,
      ledger: f.ledger, policies: f.policies, policy, verification: f.session, permission: f.sessionConfig.permission, contactRevision: revision,
      cliniko: { apiKey, contactEmail: "test@example.test", businessId: "11", recallTypeId: "7", timeZone: "Australia/Sydney", countryCallingCode: "61",
        rateBudget: { claim: async () => null, observe429: async () => ({ kind: "rateLimited" as const }) } }, signal: lifetime.signal, fetchPort,
      clock: f.sessionConfig.clock, journal, email: new SmtpAppointmentConfirmationDelivery(smtp),
      presentation: { play: async (text: string) => { readbacks.push(text); await afterReadback(); return play; } },
      isConfirmed: async (ref: string) => confirmed === ref };
    const session = resultValue(await ClinikoConfirmationResendSession.create(config));
    return { ...f, lifetime, traffic, recalls, readbacks, journal, revision, config, session,
      verify: async () => { f.session.begin(); const deadline = Date.now() + 5000;
        while (!f.mail.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(f.mail.length, 1); assert.equal((await f.session.submitCode(f.mail[0]!.code)).verified, true); },
      confirm: (ref: string) => { confirmed = ref; }, setPlay: (value: boolean) => { play = value; },
      setAppointment: (patch: Record<string, unknown>) => { appointmentPatch = patch; }, setBusiness: (patch: Record<string, unknown>) => { businessPatch = patch; },
      setReviewUnknown: () => { reviewUnknown = true; }, afterReadback: (run: () => Promise<void>) => { afterReadback = run; },
      afterReview: (run: () => Promise<void>) => { afterReview = run; }, replace,
      close: async () => { session.dispose(); lifetime.abort(); await f.close(); } };
  } catch (error) { lifetime.abort(); await f.close(); throw error; }
}
