import { ClinikoVerificationContactReader } from "../cliniko/verification-contact.ts";
import { boundedClinikoJson } from "../cliniko/bounded-json.ts";
import { claimClinikoBudget, clinikoCredentialFingerprint, isClinikoRequestBudget, observeCliniko429 } from "../cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import type { ClinikoContactRevisionReader } from "../cliniko/contact-revision.ts";
import type { AdmissionReceipt, VerifiedPatient } from "../core/model.ts";
import type { PolicyStore } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import type { AuthenticatedInboundCall } from "../voice/admission.ts";
import { callIdFor } from "../voice/admission.ts";
import { sameScope, validClinikoId } from "./appointment-change-authority.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import type { PatientVerificationPermission } from "./email-patient-authority.ts";
import { OwnerFileConfirmationResendPolicy } from "./owner-file-confirmation-resend-policy.ts";
import { appointmentConfirmationText } from "./smtp-appointment-confirmation-delivery.ts";
import type { AppointmentConfirmationMail } from "./smtp-appointment-confirmation-delivery.ts";

export type ConfirmationEvidenceConfig = Readonly<{
  receipt: AdmissionReceipt; inbound: AuthenticatedInboundCall; sessionId: string; policyVersion: string;
  ledger: Pick<LedgerStore, "read" | "readWriteStop">; policies: Pick<PolicyStore, "read">;
  policy: OwnerFileConfirmationResendPolicy; verification: CallerVerificationSession; permission: PatientVerificationPermission;
  contactRevision: ClinikoContactRevisionReader;
  cliniko: Readonly<{ apiKey: string; contactEmail: string; businessId: string; recallTypeId: string; timeZone: string;
    countryCallingCode: string; rateBudget: ClinikoRequestBudget }>;
  signal: AbortSignal; fetchPort?: typeof fetch; clock?: () => string;
}>;
/** Transient native evidence only. Never return or persist this snapshot in standalone SAM/model state. */
export type ConfirmationEvidence = Readonly<{ patientId: string; appointmentId: string; practitionerId: string; appointmentTypeId: string;
  verificationRef: string; mail: AppointmentConfirmationMail }>;
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const label = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 255 && !/[\p{Cc}\p{Cf}]/u.test(value);
function instant(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return undefined;
  const normalized = value.replace(/Z$/, value.includes(".") ? "Z" : ".000Z");
  return new Date(value).toISOString() === normalized ? normalized : undefined;
}

/** Protected exact GETs under resend authority. Native links are checked, never followed as arbitrary URLs. */
export class ClinikoConfirmationEvidenceReader {
  readonly #config: ConfirmationEvidenceConfig;
  readonly #contact: ClinikoVerificationContactReader;
  readonly #base: string;
  readonly #fingerprint: string;
  readonly #fetch: typeof fetch;
  constructor(incoming: ConfirmationEvidenceConfig) {
    const c = this.#config = Object.freeze({ ...incoming, receipt: structuredClone(incoming.receipt), inbound: structuredClone(incoming.inbound), cliniko: Object.freeze({ ...incoming.cliniko }) });
    const binding = c.verification?.binding(), scope = c.receipt.scope;
    this.#fingerprint = clinikoCredentialFingerprint(c.cliniko.apiKey);
    if (!(c.signal instanceof AbortSignal) || c.signal.aborted || !(c.policy instanceof OwnerFileConfirmationResendPolicy) ||
        !(c.verification instanceof CallerVerificationSession) || !isClinikoRequestBudget(c.cliniko.rateBudget) ||
        !validClinikoId(c.cliniko.businessId) || !validClinikoId(c.cliniko.recallTypeId) ||
        !c.contactRevision?.matches(scope.tenantId, this.#fingerprint) || !c.verification.usesContactRevision(c.contactRevision) ||
        !c.verification.matchesClinikoAccount(this.#fingerprint) || binding?.callId !== c.receipt.callId || binding.sessionId !== c.sessionId ||
        c.receipt.callId !== callIdFor(c.inbound.key) || c.receipt.admission.key.accountRef !== c.inbound.key.accountRef ||
        c.receipt.admission.key.providerCallRef !== c.inbound.key.providerCallRef || c.receipt.admission.dialedNumber !== c.inbound.dialedNumber ||
        typeof c.permission?.allows !== "function") throw new TypeError("invalid confirmation evidence owner");
    this.#fetch = c.fetchPort ?? fetch;
    this.#contact = new ClinikoVerificationContactReader({ ...c.cliniko, scope, contactRevision: c.contactRevision }, this.#fetch);
    this.#base = `https://api.${c.cliniko.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)![1]}.cliniko.com/v1`;
  }
  #now(): string { return (this.#config.clock ?? (() => new Date().toISOString()))(); }
  async #live(signal: AbortSignal): Promise<boolean> {
    const c = this.#config, scope = c.receipt.scope;
    if (signal.aborted || c.signal.aborted) return false;
    const approval = await c.policy.current(scope), policy = await c.policies.read(scope), stop = await c.ledger.readWriteStop(scope);
    const state = await c.ledger.read(c.receipt.callId, scope), now = Date.parse(this.#now());
    return approval.ok && approval.value.policyVersion === c.policyVersion && approval.value.businessId === c.cliniko.businessId &&
      approval.value.credentialFingerprint === this.#fingerprint && approval.value.timeZone === c.cliniko.timeZone && approval.value.recallTypeId === c.cliniko.recallTypeId &&
      policy.ok && sameScope(policy.value.scope, scope) && policy.value.automationEnabled && policy.value.policyVersion === c.policyVersion &&
      stop.ok && !stop.value.stopped && state.ok && state.value.lifecycle === "active" && !state.value.callerIdentityDenied &&
      sameScope(state.value.policy.scope, scope) && state.value.policy.automationEnabled && state.value.policy.policyVersion === c.policyVersion &&
      state.value.sessionLease?.sessionId === c.sessionId && Number.isFinite(now) && Date.parse(state.value.sessionLease.expiresAt) > now &&
      state.value.admission?.key.accountRef === c.inbound.key.accountRef && state.value.admission.key.providerCallRef === c.inbound.key.providerCallRef &&
      state.value.admission.dialedNumber === c.inbound.dialedNumber && !signal.aborted && !c.signal.aborted;
  }
  async #subject(signal: AbortSignal): Promise<VerifiedPatient | undefined> {
    const c = this.#config;
    if (!await this.#live(signal)) return undefined;
    const subject = await c.verification.verifiedSubject("appointments.resend", signal);
    return subject && validClinikoId(subject.patientRef) &&
      await c.permission.allows(c.receipt.scope, subject.patientRef, "appointments.resend", c.policyVersion, signal) === true && await this.#live(signal)
      ? subject : undefined;
  }
  async #get(path: string, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
    const c = this.#config;
    if (!await this.#live(signal) || await claimClinikoBudget(c.cliniko.rateBudget) || signal.aborted) return undefined;
    const response = await this.#fetch(`${this.#base}${path}`, { method: "GET", redirect: "error", signal,
      headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${c.cliniko.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${c.cliniko.contactEmail})` } });
    if (response.status === 429) await observeCliniko429(c.cliniko.rateBudget, response.headers.get("X-RateLimit-Reset"));
    if (response.status !== 200 || signal.aborted) return undefined;
    const parsed = await boundedClinikoJson(response);
    return parsed.ok && !signal.aborted ? record(parsed.value) : undefined;
  }
  #linkedId(value: unknown, family: string): string | undefined {
    const self = record(record(value)?.links)?.self;
    if (typeof self !== "string" || !self.startsWith(`${this.#base}/${family}/`)) return undefined;
    const id = self.slice(`${this.#base}/${family}/`.length);
    return validClinikoId(id) ? id : undefined;
  }
  /** appointmentId comes from trusted verified selection, never from a model tool argument. */
  async read(appointmentId: string, external: AbortSignal): Promise<ConfirmationEvidence | undefined> {
    if (!validClinikoId(appointmentId) || !(external instanceof AbortSignal) || external.aborted) return undefined;
    const signal = AbortSignal.any([external, this.#config.signal, AbortSignal.timeout(20_000)]);
    const pending = this.#read(appointmentId, signal).catch(() => undefined);
    return awaitUntilAbort(pending, signal);
  }
  async #read(appointmentId: string, signal: AbortSignal): Promise<ConfirmationEvidence | undefined> {
    const c = this.#config, before = await this.#subject(signal);
    if (!before) return undefined;
    const row = await this.#get(`/individual_appointments/${appointmentId}`, signal);
    const startsAt = instant(row?.starts_at), endsAt = instant(row?.ends_at);
    const practitionerId = this.#linkedId(row?.practitioner, "practitioners"), appointmentTypeId = this.#linkedId(row?.appointment_type, "appointment_types");
    if (!row || row.id !== appointmentId || row.cancelled_at !== null || row.archived_at !== null || row.deleted_at !== null ||
        this.#linkedId(row.patient, "patients") !== before.patientRef || this.#linkedId(row.business, "businesses") !== c.cliniko.businessId ||
        !startsAt || !endsAt || Date.parse(startsAt) <= Date.parse(this.#now()) || Date.parse(endsAt) <= Date.parse(startsAt) || !practitionerId || !appointmentTypeId) return undefined;
    const business = await this.#get(`/businesses/${c.cliniko.businessId}`, signal);
    const practitioner = await this.#get(`/practitioners/${practitionerId}`, signal);
    const type = await this.#get(`/appointment_types/${appointmentTypeId}`, signal);
    if (!business || business.id !== c.cliniko.businessId || business.archived_at !== null || business.time_zone_identifier !== c.cliniko.timeZone ||
        !practitioner || practitioner.id !== practitionerId || !type || type.id !== appointmentTypeId || type.archived_at !== null || !label(type.name) ||
        !label(business.business_name) || !label(business.address_1)) return undefined;
    const locationName = business.display_name ?? business.label ?? business.business_name;
    const practitionerName = practitioner.display_name ?? (label(practitioner.first_name) && label(practitioner.last_name) ? `${practitioner.first_name} ${practitioner.last_name}` : undefined);
    const addressParts = [business.address_1, business.address_2, business.city, business.state, business.post_code, business.country].filter(v => v !== null && v !== undefined && v !== "");
    if (!label(locationName) || !label(practitionerName) || addressParts.some(v => !label(v))) return undefined;
    const recipient = await this.#contact.read(c.receipt.scope, before.patientRef, c.inbound.presentedCallerNumber!, signal);
    if (!recipient.ok || !await this.#subject(signal)) return undefined;
    const freshTarget = await this.#get(`/individual_appointments/${appointmentId}`, signal);
    if (!freshTarget || freshTarget.id !== appointmentId || freshTarget.cancelled_at !== null || freshTarget.archived_at !== null || freshTarget.deleted_at !== null ||
        instant(freshTarget.starts_at) !== startsAt || instant(freshTarget.ends_at) !== endsAt ||
        this.#linkedId(freshTarget.patient, "patients") !== before.patientRef || this.#linkedId(freshTarget.business, "businesses") !== c.cliniko.businessId ||
        this.#linkedId(freshTarget.practitioner, "practitioners") !== practitionerId || this.#linkedId(freshTarget.appointment_type, "appointment_types") !== appointmentTypeId) return undefined;
    const after = await this.#subject(signal);
    if (!after || after.patientRef !== before.patientRef || after.verificationRef !== before.verificationRef) return undefined;
    const mail = { email: recipient.value, startsAt, endsAt, timeZone: c.cliniko.timeZone, clinicName: business.business_name,
      locationName, locationAddress: addressParts.join(", "), practitionerName, appointmentTypeName: type.name };
    return appointmentConfirmationText(mail) ? { patientId: before.patientRef, appointmentId, practitionerId, appointmentTypeId,
      verificationRef: before.verificationRef, mail } : undefined;
  }
}
