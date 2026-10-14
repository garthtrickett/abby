import { isDeepStrictEqual } from "node:util";
import { ClinikoPatientCaseSessionsReader } from "../cliniko/patient-case-sessions.ts";
import { CLINIKO_CASE_ASSOCIATION_LIMIT } from "../cliniko/patient-case-sessions.ts";
import type { ClinikoCaseSessions } from "../cliniko/patient-case-sessions.ts";
import type { ClinikoAttendanceConfig } from "../cliniko/class-attendance-write.ts";
import type { ClinikoClassSession } from "../cliniko/class-attendance-read.ts";
import type { PatientProofHost } from "../core/host.ts";
import type { LocationScope, VerifiedPatient } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { approvalRef } from "./owner-file-clinic-approval.ts";
import type { ClassApproval } from "./owner-file-class-policy.ts";
import { OwnerFileClassPolicy } from "./owner-file-class-policy.ts";

export type ClassPassSelection = Readonly<{ patientCaseId: string; entitlementRef: string }>;
export type ClassPassAuthorityQuery = Readonly<{
  scope: LocationScope; callId: string; sessionId: string; policyVersion: string; patientId: string;
  classSessionId: string; serviceRef: string; businessId: string; practitionerId: string; appointmentTypeId: string;
  startsAt: string; endsAt: string; termsVersion: string; phase: "proposal" | "commit" | "inspection"; signal: AbortSignal;
}>;
/** Independent clinic-owned selection/service/location/payment authority.
 * Native case counts and channel verification cannot implement this port.
 * Inspection must remain possible for the last consumed session. A different
 * case or entitlement requires a new played proposal, never a silent switch. */
export type ClassPassAuthority = Readonly<{
  select(query: ClassPassAuthorityQuery): Promise<ClassPassSelection | undefined>;
}>;
export type ClassPassBookingBinding = Readonly<{
  selection: ClassPassSelection; usageFingerprint: string; maximum: number; used: number;
}>;
type Config = Readonly<{
  scope: LocationScope; callId: string; sessionId: string; policyVersion: string;
  cliniko: Omit<ClinikoAttendanceConfig, "scope">; policy: OwnerFileClassPolicy;
  proof: PatientProofHost; authority: ClassPassAuthority; clock: () => string; fetchPort: typeof fetch;
}>;
const validSelection = (value: unknown): value is ClassPassSelection => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "entitlementRef,patientCaseId") return false;
  const row = value as Record<string, unknown>;
  return typeof row.patientCaseId === "string" && /^[1-9][0-9]{0,18}$/.test(row.patientCaseId) && approvalRef(row.entitlementRef);
};

/** Owns the private pass binding for one class booking host. No model, public
 * menu, ledger presentation or transcript receives native case identifiers.
 * Native counters and independent authority are both rechecked; neither
 * substitutes for the other's contract. */
export class ClinikoClassPassBooking {
  readonly #config: Config;
  constructor(config: Config) { this.#config = config; }
  #query(patient: VerifiedPatient, session: ClinikoClassSession, approval: ClassApproval,
    phase: ClassPassAuthorityQuery["phase"], signal: AbortSignal): ClassPassAuthorityQuery {
    const c = this.#config;
    return { scope: { ...c.scope }, callId: c.callId, sessionId: c.sessionId, policyVersion: c.policyVersion,
      patientId: patient.patientRef, classSessionId: session.sessionRef, serviceRef: approval.serviceRef, businessId: approval.businessId,
      practitionerId: approval.practitionerId, appointmentTypeId: approval.appointmentTypeId, startsAt: session.startsAt, endsAt: session.endsAt,
      termsVersion: approval.bookingTerms.version, phase, signal };
  }
  async #selection(patient: VerifiedPatient, session: ClinikoClassSession, approval: ClassApproval,
    phase: ClassPassAuthorityQuery["phase"], signal: AbortSignal): Promise<ClassPassSelection | undefined> {
    const current = await awaitUntilAbort(this.#config.policy.current(this.#config.scope), signal);
    if (!current?.ok || current.value.membership !== "nativeCaseSessions" || !isDeepStrictEqual(current.value, approval) || signal.aborted) return undefined;
    const selection = await awaitUntilAbort(Promise.resolve().then(() => this.#config.authority.select(this.#query(patient, session, approval, phase, signal))), signal);
    return validSelection(selection) && !signal.aborted ? structuredClone(selection) : undefined;
  }
  async authorized(binding: ClassPassBookingBinding, patient: VerifiedPatient, session: ClinikoClassSession, approval: ClassApproval,
    phase: ClassPassAuthorityQuery["phase"], signal: AbortSignal): Promise<boolean> {
    const selected = await this.#selection(patient, session, approval, phase, signal);
    return !!selected && isDeepStrictEqual(selected, binding.selection) && !signal.aborted;
  }
  #reader(selection: ClassPassSelection, patient: VerifiedPatient, session: ClinikoClassSession, approval: ClassApproval,
    phase: ClassPassAuthorityQuery["phase"]) {
    const c = this.#config;
    return ClinikoPatientCaseSessionsReader.create({ ...c.cliniko, scope: c.scope, timeZone: approval.timeZone,
      attendanceStatus: approval.caseSessions!.attendanceStatus }, c.proof, { allows: async query => {
        if (query.patientId !== patient.patientRef || query.patientCaseId !== selection.patientCaseId || query.classSessionId !== session.sessionRef || query.startsAt !== session.startsAt) return false;
        const current = await this.#selection(patient, session, approval, phase, query.signal);
        return !!current && isDeepStrictEqual(current, selection);
      } }, c.fetchPort, c.clock);
  }
  #caseQuery(selection: ClassPassSelection, patient: VerifiedPatient, session: ClinikoClassSession, now: string) {
    return { scope: { ...this.#config.scope }, verificationRef: patient.verificationRef, patientCaseId: selection.patientCaseId,
      classSessionId: session.sessionRef, startsAt: session.startsAt, now };
  }
  async select(patient: VerifiedPatient, session: ClinikoClassSession, approval: ClassApproval, now: string, signal: AbortSignal): Promise<ClassPassBookingBinding | undefined> {
    const selection = await this.#selection(patient, session, approval, "proposal", signal);
    if (!selection) return undefined;
    const reader = this.#reader(selection, patient, session, approval, "proposal"); if (!reader.ok) return undefined;
    const read = await reader.value.read(this.#caseQuery(selection, patient, session, now), signal);
    if (!read.ok || !read.value.eligibleOnSessionDate || read.value.overdrawn || read.value.remaining < 1 || read.value.associationCount >= CLINIKO_CASE_ASSOCIATION_LIMIT || signal.aborted) return undefined;
    return { selection, usageFingerprint: read.value.usageFingerprint, maximum: read.value.maximum, used: read.value.used };
  }
  async unchanged(binding: ClassPassBookingBinding, patient: VerifiedPatient, session: ClinikoClassSession, approval: ClassApproval,
    phase: "proposal" | "commit", now: string, signal: AbortSignal): Promise<boolean> {
    const reader = this.#reader(binding.selection, patient, session, approval, phase); if (!reader.ok) return false;
    const read = await reader.value.read(this.#caseQuery(binding.selection, patient, session, now), signal);
    return read.ok && read.value.eligibleOnSessionDate && !read.value.overdrawn && read.value.remaining > 0 && read.value.associationCount < CLINIKO_CASE_ASSOCIATION_LIMIT &&
      read.value.usageFingerprint === binding.usageFingerprint && !signal.aborted;
  }
  async inspectAddition(binding: ClassPassBookingBinding, patient: VerifiedPatient, session: ClinikoClassSession,
    approval: ClassApproval, now: string, attendeeId: string, signal: AbortSignal): Promise<boolean> {
    const reader = this.#reader(binding.selection, patient, session, approval, "inspection"); if (!reader.ok) return false;
    const read = await reader.value.inspectAddition(this.#caseQuery(binding.selection, patient, session, now), binding.usageFingerprint, attendeeId, signal);
    return read.ok && this.#oneConsumed(binding, read.value) && !signal.aborted;
  }
  #oneConsumed(binding: ClassPassBookingBinding, read: ClinikoCaseSessions): boolean {
    return read.eligibleOnSessionDate && !read.overdrawn && read.maximum === binding.maximum && read.used === binding.used + 1;
  }
}
