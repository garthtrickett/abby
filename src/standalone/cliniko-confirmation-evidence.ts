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
import { appointmentConfirmationText, validPatientJoinUrl } from "./smtp-appointment-confirmation-delivery.ts";
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
  async #patientJoin(appointmentId: string, patientId: string, origin: string, signal: AbortSignal): Promise<string | undefined> {
    const seen = new Set<string>(); let total: number | undefined, selected: string | undefined;
    for (let page = 1; page <= 5; page++) {
      const query = new URLSearchParams({ page: String(page), per_page: "100" });
      query.append("q[]", `booking_id:=${appointmentId}`); query.append("q[]", `patient_id:=${patientId}`);
      const body = await this.#get(`/attendees?${query}`, signal);
      if (!body || !Number.isSafeInteger(body.total_entries) || Number(body.total_entries) < 0 || Number(body.total_entries) > 500 ||
          (total !== undefined && total !== body.total_entries) || !Array.isArray(body.attendees) || body.attendees.length > 100) return undefined;
      total = Number(body.total_entries);
      for (const value of body.attendees) {
        const row = record(value);
        if (!row || !validClinikoId(row.id) || seen.has(row.id) || this.#linkedId(row.booking, "bookings") !== appointmentId ||
            this.#linkedId(row.patient, "patients") !== patientId || row.archived_at !== null || row.deleted_at !== null || row.cancelled_at !== null ||
            !validPatientJoinUrl(row.telehealth_url) || new URL(row.telehealth_url).origin !== origin || selected !== undefined) return undefined;
        seen.add(row.id); selected = row.telehealth_url;
      }
      if (seen.size > total || body.attendees.length === 0 && seen.size < total) return undefined;
      if (seen.size === total) return seen.size === 1 ? selected : undefined;
    }
    return undefined;
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
    const cancelledAt = row?.cancelled_at === null ? undefined : instant(row?.cancelled_at);
    const approval = await c.policy.current(c.receipt.scope);
    if (!approval.ok || row?.cancelled_at !== null && !cancelledAt) return undefined;
    const practitionerId = this.#linkedId(row?.practitioner, "practitioners"), appointmentTypeId = this.#linkedId(row?.appointment_type, "appointment_types");
    if (!row || row.id !== appointmentId || row.archived_at !== null || row.deleted_at !== null ||
        this.#linkedId(row.patient, "patients") !== before.patientRef || this.#linkedId(row.business, "businesses") !== c.cliniko.businessId ||
        !startsAt || !endsAt || (cancelledAt ? Date.parse(cancelledAt) > Date.parse(this.#now()) || Math.abs(Date.parse(startsAt) - Date.parse(this.#now())) > 90 * 86_400_000 : Date.parse(startsAt) <= Date.parse(this.#now())) || Date.parse(endsAt) <= Date.parse(startsAt) || !practitionerId || !appointmentTypeId) return undefined;
    // These exact metadata GETs depend only on the validated target above.
    // Each keeps its own live authority/quota gate. Overlap their independent
    // reads; exact target/type and subject checks still bracket disclosure.
    const [business, practitioner, type] = await Promise.all([
      this.#get(`/businesses/${c.cliniko.businessId}`, signal),
      this.#get(`/practitioners/${practitionerId}`, signal),
      this.#get(`/appointment_types/${appointmentTypeId}`, signal),
    ]);
    if (!business || business.id !== c.cliniko.businessId || business.archived_at !== null || business.time_zone_identifier !== c.cliniko.timeZone ||
        !practitioner || practitioner.id !== practitionerId || !type || type.id !== appointmentTypeId || type.archived_at !== null || !label(type.name) ||
        !label(business.business_name) || ![true, false, null].includes(type.telehealth_enabled as boolean | null)) return undefined;
    const locationName = business.display_name ?? business.label ?? business.business_name;
    const practitionerName = practitioner.display_name ?? (label(practitioner.first_name) && label(practitioner.last_name) ? `${practitioner.first_name} ${practitioner.last_name}` : undefined);
    const addressParts = [business.address_1, business.address_2, business.city, business.state, business.post_code, business.country].filter(v => v !== null && v !== undefined && v !== "");
    const contentKind = cancelledAt ? "cancelled" : type.telehealth_enabled === true ? "activeTelehealth" : "activeInPerson";
    if (approval.value.template === "appointmentDetails.v1" ? contentKind !== "activeInPerson" : !approval.value.contentKinds?.includes(contentKind)) return undefined;
    if (contentKind === "activeInPerson" && (!label(business.address_1) || addressParts.some(v => !label(v)))) return undefined;
    if (!label(locationName) || !label(practitionerName)) return undefined;
    const staffUrl = row.telehealth_url;
    const virtualOrigin = typeof staffUrl === "string" && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cliniko\.com\/appointments\/[1-9][0-9]*\/connect$/.test(staffUrl) &&
      new URL(staffUrl).pathname === `/appointments/${appointmentId}/connect` ? new URL(staffUrl).origin : undefined;
    if (contentKind === "activeTelehealth" && !virtualOrigin) return undefined;
    const patientJoinUrl = contentKind === "activeTelehealth" ? await this.#patientJoin(appointmentId, before.patientRef, virtualOrigin!, signal) : undefined;
    if (contentKind === "activeTelehealth" && !patientJoinUrl) return undefined;
    const recipient = await this.#contact.read(c.receipt.scope, before.patientRef, c.inbound.presentedCallerNumber!, signal);
    if (!recipient.ok || !await this.#subject(signal)) return undefined;
    const freshTarget = await this.#get(`/individual_appointments/${appointmentId}`, signal);
    if (!freshTarget || freshTarget.id !== appointmentId || (cancelledAt ? instant(freshTarget.cancelled_at) !== cancelledAt : freshTarget.cancelled_at !== null) || freshTarget.archived_at !== null || freshTarget.deleted_at !== null ||
        instant(freshTarget.starts_at) !== startsAt || instant(freshTarget.ends_at) !== endsAt ||
        this.#linkedId(freshTarget.patient, "patients") !== before.patientRef || this.#linkedId(freshTarget.business, "businesses") !== c.cliniko.businessId ||
        this.#linkedId(freshTarget.practitioner, "practitioners") !== practitionerId || this.#linkedId(freshTarget.appointment_type, "appointment_types") !== appointmentTypeId) return undefined;
    const freshType = await this.#get(`/appointment_types/${appointmentTypeId}`, signal);
    if (!freshType || freshType.id !== appointmentTypeId || freshType.archived_at !== null || freshType.name !== type.name ||
        freshType.telehealth_enabled !== type.telehealth_enabled || contentKind === "activeTelehealth" && freshTarget.telehealth_url !== staffUrl || contentKind === "activeTelehealth" && await this.#patientJoin(appointmentId, before.patientRef, virtualOrigin!, signal) !== patientJoinUrl) return undefined;
    const after = await this.#subject(signal);
    if (!after || after.patientRef !== before.patientRef || after.verificationRef !== before.verificationRef) return undefined;
    const base = { email: recipient.value, startsAt, endsAt, timeZone: c.cliniko.timeZone, clinicName: business.business_name,
      locationName, practitionerName, appointmentTypeName: type.name };
    const mail: AppointmentConfirmationMail = contentKind === "cancelled" ? { ...base, contentKind, cancelledAt: cancelledAt! } :
      contentKind === "activeTelehealth" ? { ...base, contentKind, patientJoinUrl: patientJoinUrl! } : approval.value.template === "appointmentDetails.v1" ?
      { ...base, locationAddress: addressParts.join(", ") } : { ...base, contentKind, locationAddress: addressParts.join(", ") };
    return appointmentConfirmationText(mail) ? { patientId: before.patientRef, appointmentId, practitionerId, appointmentTypeId,
      verificationRef: before.verificationRef, mail } : undefined;
  }
}
