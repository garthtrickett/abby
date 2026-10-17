import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { expiryFixture, value, stop } from "./financial-checkout-expiry.ts";
import { base, keys, keyRef, uuid, now } from "./financial-retention.ts";
import { financialBookingObservationMessage, financialBookingObservationPayload, financialIntentDigest, formatFinancialBookingObservation } from "../../src/cliniko/financial-booking-observation.ts";
import { ClinikoFinancialClinicalExpiryOwner } from "../../src/standalone/cliniko-financial-clinical-expiry.ts";
import type { FinancialClinicalExpiryAuthority, FinancialClinicalApproval } from "../../src/standalone/cliniko-financial-clinical-expiry.ts";
import { financialConsentReadback, financialConsentDigest } from "../../src/standalone/financial-consent-readback.ts";

export const approvedTerms = "If the deposit remains unpaid and unwaived at the deadline, the clinic may cancel this exact appointment.";
export async function clinicalExpiryFixture(options: {
  authority?: Partial<FinancialClinicalExpiryAuthority>; legacyConsent?: boolean; deadlineMs?: number;
  checkout?: NonNullable<Parameters<typeof expiryFixture>[0]>["checkout"];
  retained?(row: Record<string, unknown>): void | Promise<void>;
  read?(row: Record<string, unknown>, count: number, signal: AbortSignal): void | Promise<void>;
  cancel?(row: Record<string, unknown>): Response | Promise<Response>;
} = {}) {
  const f = await expiryFixture({ checkout: { ...options.checkout, bookingObservation: i => {
    const row = { actionRef: uuid(8), financialActionRef: i.actionRef, intentRecallRef: "cliniko:recall:30", intentDigest: financialIntentDigest(i)!,
      bookingActionRef: i.booking.actionRef, targetRef: i.booking.kind === "book" ? "cliniko:appointment:91" : "cliniko:attendee:91", observedAt: now, producerKeyRef: keyRef,
      ...(options.legacyConsent ? {} : { financialConsent: { presentationRef: uuid(40), presentationDigest: financialConsentDigest(financialConsentReadback(i, approvedTerms, "Etc/UTC")!),
        playedAt: now, acceptedAt: now, acceptanceRef: uuid(41) } }) };
    const payload = financialBookingObservationPayload(row)!;
    return formatFinancialBookingObservation(row, sign(null, financialBookingObservationMessage(payload, options.legacyConsent ? 1 : 2), keys.privateKey).toString("base64url"))!;
  } }, retained: options.retained });
  f.naturallyExpired();
  let reference = true, provider = true, financial = true, admitted = true, live = true, reads = 0;
  let approval: FinancialClinicalApproval | null = { kind: "cancelUnpaidIndividual", policyVersion: f.intent.payment.policyVersion,
    termsVersion: f.intent.payment.termsVersion, approvedTerms, timeZone: "Etc/UTC", cancellationReason: 50 };
  const appointment: Record<string, unknown> = { id: "91", starts_at: f.intent.booking.startsAt, ends_at: f.intent.booking.endsAt,
    cancelled_at: null, archived_at: null, deleted_at: null, cancellation_reason: null,
    patient: { links: { self: `${base}/patients/${f.intent.patientId}` } }, business: { links: { self: `${base}/businesses/${f.intent.businessId}` } },
    practitioner: { links: { self: `${base}/practitioners/${f.intent.booking.practitionerId}` } }, appointment_type: { links: { self: `${base}/appointment_types/${f.intent.booking.appointmentTypeId}` } } };
  const cancellations: { path: string; body: Record<string, unknown> }[] = [];
  const native: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.startsWith("/v1/individual_appointments/")) return f.nativePort(input, init);
    assert.equal(init?.redirect, "error"); assert.equal(init?.signal?.aborted, false);
    assert.equal(new Headers(init.headers).get("Authorization"), `Basic ${Buffer.from(`${f.config.cliniko.apiKey}:`).toString("base64")}`);
    if (init?.method === "GET") {
      assert.equal(url.pathname, "/v1/individual_appointments/91"); reads++;
      await options.read?.(appointment, reads, init.signal!); return Response.json(appointment);
    }
    assert.equal(init?.method, "PATCH"); assert.equal(url.pathname, "/v1/individual_appointments/91/cancel");
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body, { cancellation_note: null, cancellation_reason: 50, apply_to_repeats: false });
    assert.ok(f.rows.size >= 4, "possible-expiry native review precedes cancellation");
    assert.ok(f.burned.has(f.intent.effects.clinicalExpiry), "opaque permanent exclusion precedes cancellation");
    cancellations.push({ path: url.pathname, body });
    if (options.cancel) return options.cancel(appointment);
    appointment.cancelled_at = f.config.cliniko.clock!(); appointment.cancellation_reason = 50;
    return new Response(null, { status: 204 });
  };
  const authority: FinancialClinicalExpiryAuthority = { sources: f.expiryAuthority.sources,
    referenceAuthorized: async () => reference, providerBindingAuthorized: async () => provider,
    financialAuthorized: async () => financial, clinicalApproval: async () => approval,
    producerAdmitted: async () => admitted, current: () => live, ...options.authority };
  const config = { ...f.config, ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }) };
  const make = () => ClinikoFinancialClinicalExpiryOwner.create(config, authority, f.recordsAuthority, f.barrier, native, f.expiryStripePort);
  const owner = value(make());
  return { ...f, clinicalConfig: config, clinicalAuthority: authority, appointment, cancellations, makeClinical: make,
    expireClinical: (signal = stop()) => owner.expireOnce(f.binding, signal),
    denyClinical: () => { approval = null; }, changeApproval: (change: Partial<FinancialClinicalApproval>) => { approval = { ...approval!, ...change }; },
    denyFinancial: () => { financial = false; }, denyReference: () => { reference = false; }, denyProvider: () => { provider = false; },
    denyProducer: () => { admitted = false; }, retire: () => { live = false; } };
}
export { value, stop };
