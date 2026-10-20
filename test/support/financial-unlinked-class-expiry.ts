import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expiryFixture, value, stop } from "./financial-checkout-expiry.ts";
import { intentValue, keys, keyRef, uuid, now, base } from "./financial-retention.ts";
import { callerVerificationFixture } from "./caller-verification.ts";
import { classAttendanceFixture, classAttendee, classLink } from "./class-attendance.ts";
import { OwnerFileClassPolicy } from "../../src/standalone/owner-file-class-policy.ts";
import type { ClassApproval } from "../../src/standalone/owner-file-class-policy.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { financialBookingObservationPayload, financialBookingObservationMessage, formatFinancialBookingObservation, financialIntentDigest } from "../../src/cliniko/financial-booking-observation.ts";
import { financialConsentReadback, financialConsentDigest } from "../../src/standalone/financial-consent-readback.ts";
import { ClinikoFinancialUnlinkedClassExpiryOwner } from "../../src/standalone/cliniko-financial-unlinked-class-expiry.ts";
import type { FinancialUnlinkedClassExpiryAuthority, FinancialUnlinkedClassApproval } from "../../src/standalone/cliniko-financial-unlinked-class-expiry.ts";
import type { ClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import type { FinancialRecordRetentionConfig } from "../../src/cliniko/financial-record-retention.ts";
import type { FinancialEffectBarrier } from "../../src/standalone/financial-effect-barrier.ts";
export const classExpiryTerms = "If this exact class deposit remains unpaid and unwaived after the deadline, the clinic may cancel this attendance.";
export async function unlinkedClassExpiryFixture(options: {
  intent?: ClinikoFinancialIntent; barrierFor?: (config: FinancialRecordRetentionConfig) => FinancialEffectBarrier;
  legacy?: boolean; requestedCase?: string; deadlineMs?: number; authority?: Partial<FinancialUnlinkedClassExpiryAuthority>;
  retained?(row: Record<string, unknown>): void | Promise<void>;
  read?(path: string, count: number, signal: AbortSignal): void | Promise<void>;
  beforeCancel?(): void | Promise<void>; cancel?(row: Record<string, unknown>): Response | Promise<Response>;
} = {}) {
  const i = options.intent ?? intentValue(), intent = { ...i, booking: { ...i.booking, kind: "classBook" as const, sessionId: "91", practitionerId: "22", appointmentTypeId: "33" } };
  const f = await expiryFixture({ checkout: { native: { intent, ...(options.barrierFor ? { barrierFactory: options.barrierFor } : {}) }, bookingObservation: i => {
    const row = { actionRef: uuid(8), financialActionRef: i.actionRef, intentRecallRef: "cliniko:recall:30", intentDigest: financialIntentDigest(i)!,
      bookingActionRef: i.booking.actionRef, targetRef: "cliniko:attendee:91", observedAt: now, producerKeyRef: keyRef,
      financialConsent: { presentationRef: uuid(40), presentationDigest: financialConsentDigest(financialConsentReadback(i, classExpiryTerms, "Australia/Sydney")!),
        playedAt: now, acceptedAt: now, acceptanceRef: uuid(41) },
      ...(options.legacy ? {} : { classCreationRequest: { sessionId: "91", ...(options.requestedCase ? { patientCaseId: options.requestedCase } : {}) } }) };
    const payload = financialBookingObservationPayload(row)!;
    return formatFinancialBookingObservation(row, sign(null, financialBookingObservationMessage(payload, options.legacy ? 2 : 3), keys.privateKey).toString("base64url"))!;
  } }, ...(options.retained ? { retained: options.retained } : {}) });
  f.naturallyExpired();
  const directory = await callerVerificationFixture({ scope: intent.scope, apiKey: f.config.cliniko.apiKey, now: f.config.cliniko.clock!() });
  try {
    const path = join(directory.folder, "financial-class-expiry-policy.json");
    const approval: ClassApproval = { scope: intent.scope, revision: "class-expiry-1", approverRef: directory.account.actor.actorRef,
      approvedAt: intent.createdAt, effectiveFrom: intent.createdAt, effectiveUntil: intent.booking.startsAt, approved: true, enabled: true,
      policyVersion: "class-policy-1", businessId: "11", practitionerId: "22", appointmentTypeId: "33", credentialFingerprint: intent.credentialFingerprint,
      recallTypeId: "7", timeZone: "Australia/Sydney", attendance: "existingOccurrence", writeContract: "bestEffort", notificationOwner: "cliniko",
      membership: "independentHost", serviceRef: "mat-pilates", className: "Mat Pilates", practitionerName: "Demo Instructor", locationName: "Demo Clinic",
      durationMinutes: 30, bookingTerms: { version: "class-terms-1", approvedText: "The clinic independently checks class payments." },
      minNoticeMinutes: 60, maxAdvanceDays: 30, offerTtlSeconds: 120 };
    await writeFile(path, JSON.stringify(approval), { mode: 0o600 });
    const classPolicy = value(await OwnerFileClassPolicy.capture({ path, ...approval, directory: new OwnerFileAdminDirectory(directory.accountPath, intent.scope), clock: f.config.cliniko.clock! }));
    const attendance = classAttendanceFixture({ scope: intent.scope, patientId: intent.patientId, rateBudget: f.config.cliniko.rateBudget });
    attendance.config.contactEmail = f.config.cliniko.contactEmail;
    attendance.groups.splice(1); attendance.groups[0]!.starts_at = intent.booking.startsAt; attendance.groups[0]!.ends_at = intent.booking.endsAt;
    const attendee: Record<string, unknown> = { ...classAttendee("91", "91", intent.patientId), arrived: null, cancellation_reason: null,
      notes: `Abby attendance ${intent.booking.actionRef}` };
    attendance.attendees.splice(0, attendance.attendees.length, attendee);
    let reference = true, financial = true, provider = true, admitted = true, live = true, reads = 0;
    let clinical: FinancialUnlinkedClassApproval | null = { kind: "cancelUnpaidUnlinkedClass", classPolicyVersion: approval.policyVersion,
      policyVersion: intent.payment.policyVersion, termsVersion: intent.payment.termsVersion, approvedTerms: classExpiryTerms,
      timeZone: approval.timeZone, cancellationReason: 50 };
    const cancellations: Record<string, unknown>[] = [], filters: string[][] = [];
    const native: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/v1/recalls")) return f.nativePort(input, init);
      assert.equal(init?.redirect, "error");
      if (init?.method === "PATCH") {
        assert.equal(url.pathname, "/v1/attendees/91/cancel"); const body = JSON.parse(String(init.body));
        assert.deepEqual(body, { cancellation_reason: 50, apply_to_repeats: false });
        assert.ok(f.rows.size >= 4); if (options.beforeCancel) await options.beforeCancel(); else assert.ok(f.burned.has(intent.effects.clinicalExpiry));
        cancellations.push(body); if (options.cancel) return options.cancel(attendee);
        attendee.cancelled_at = f.config.cliniko.clock!(); attendee.cancellation_reason = 50; return new Response(null, { status: 204 });
      }
      reads++; await options.read?.(url.pathname, reads, init!.signal!);
      if (url.pathname === "/v1/attendees" && url.searchParams.getAll("q[]").includes("patient_case_id:!?")) {
        const q = url.searchParams.getAll("q[]"); filters.push(q);
        assert.deepEqual(q, ["id:=91", `patient_id:=${intent.patientId}`, "booking_id:=91", "patient_case_id:!?", ...(attendee.cancelled_at ? ["cancelled_at:*"] : [])]);
        const selected = attendee.patient_case == null ? [attendee] : [];
        return Response.json({ total_entries: selected.length, attendees: selected });
      }
      return attendance.fetchPort(input, init);
    };
    const authority: FinancialUnlinkedClassExpiryAuthority = { sources: f.expiryAuthority.sources, referenceAuthorized: async () => reference,
      financialAuthorized: async () => financial, providerBindingAuthorized: async () => provider, clinicalApproval: async () => clinical,
      producerAdmitted: async () => admitted, current: () => live, ...options.authority };
    const config = { ...f.config, classPolicy, ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }) };
    const make = () => ClinikoFinancialUnlinkedClassExpiryOwner.create(config, authority, f.recordsAuthority, f.barrier, native, f.expiryStripePort);
    const owner = value(make());
    return { ...f, classConfig: config, classAuthority: authority, classNative: native, classPolicy, approval, directory, attendee, attendance,
      classPolicyPath: path, classDirectoryPath: directory.accountPath, cancellations, filters, makeClass: make, expireClass: (signal = stop()) => owner.expireOnce(f.binding, signal),
      denyReference: () => { reference = false; }, denyFinancial: () => { financial = false; }, denyProvider: () => { provider = false; },
      denyProducer: () => { admitted = false; }, retire: () => { live = false; }, denyClinical: () => { clinical = null; },
      changeApproval: (change: Partial<FinancialUnlinkedClassApproval>) => { clinical = { ...clinical!, ...change }; },
      changePolicy: async (change: Partial<ClassApproval>) => { await writeFile(path, JSON.stringify({ ...approval, ...change }), { mode: 0o600 }); },
      linkCase: () => { attendee.patient_case = classLink("patient_cases", "71"); }, close: () => directory.close() };
  } catch (error) { await directory.close(); throw error; }
}
export { value, stop };
