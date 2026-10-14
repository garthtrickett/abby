import { isDeepStrictEqual } from "node:util";
import { ClinikoPatientCaseSessionsReader } from "../cliniko/patient-case-sessions.ts";
import type { ClinikoCaseAttendance } from "../cliniko/patient-case-sessions.ts";
import type { ClinikoAttendanceConfig } from "../cliniko/class-attendance-write.ts";
import type { ClinikoClassSession } from "../cliniko/class-attendance-read.ts";
import type { PatientProofHost } from "../core/host.ts";
import type { LocationScope, VerifiedPatient } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { approvalRef } from "./owner-file-clinic-approval.ts";
import type { ClassApproval } from "./owner-file-class-policy.ts";
import { OwnerFileClassPolicy } from "./owner-file-class-policy.ts";
import type { ClassPassAuthorityQuery, ClassPassSelection } from "./cliniko-class-pass-booking.ts";

export type ClassPassCancellationEffect = "releaseOne" | "unchanged" | "consumeOne";
export type ClassPassCancellationAuthorityQuery = ClassPassAuthorityQuery & Readonly<{
  operation: "cancel"; attendeeId: string; passTermsVersion: string; effect?: ClassPassCancellationEffect;
}>;
/** The initial effect-free proposal query grants only private case inspection.
 * The actual effect must subsequently be independently approved, with the same
 * exact case/entitlement, before caller consent or mutation. No refund implied. */
export type ClassPassCancellationAuthority = Readonly<{
  select(query: ClassPassCancellationAuthorityQuery): Promise<ClassPassSelection | undefined>;
}>;
export type ClassPassCancellationBinding = Readonly<{
  selection: ClassPassSelection; usageFingerprint: string; maximum: number; used: number; effect: ClassPassCancellationEffect;
}>;
type Config = Readonly<{
  scope: LocationScope; callId: string; sessionId: string; policyVersion: string;
  cliniko: Omit<ClinikoAttendanceConfig, "scope">; policy: OwnerFileClassPolicy;
  proof: PatientProofHost; authority: ClassPassCancellationAuthority; clock: () => string; fetchPort: typeof fetch;
}>;
const effectOf = (read: ClinikoCaseAttendance): ClassPassCancellationEffect => {
  const delta = Number(read.includeCancelled) - Number(read.attendance.countsSession);
  return delta < 0 ? "releaseOne" : delta > 0 ? "consumeOne" : "unchanged";
};
const validSelection = (v: unknown): v is ClassPassSelection => {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join(",") !== "entitlementRef,patientCaseId") return false;
  const row = v as Record<string, unknown>;
  return typeof row.patientCaseId === "string" && /^[1-9][0-9]{0,18}$/.test(row.patientCaseId) && approvalRef(row.entitlementRef);
};

/** Owns the private case binding for one exact attendance cancellation. A full,
 * expired or closed pass can still lose attendance, without restoring validity
 * or money. The entire case state must otherwise remain unchanged. */
export class ClinikoClassPassCancellation {
  readonly #config: Config;
  constructor(config: Config) { this.#config = config; }
  static terms(baseVersion: string, approval: ClassApproval, effect: ClassPassCancellationEffect) {
    const contract = approval.caseSessions?.cancellation;
    return contract ? { version: `${baseVersion}:pass:${contract.version}:${effect}`, approvedText: contract[effect] } : undefined;
  }
  async #selection(patient: VerifiedPatient, session: ClinikoClassSession, attendeeId: string, approval: ClassApproval,
    baseVersion: string, phase: ClassPassAuthorityQuery["phase"], signal: AbortSignal, effect?: ClassPassCancellationEffect): Promise<ClassPassSelection | undefined> {
    const c = this.#config, current = await awaitUntilAbort(c.policy.current(c.scope), signal), contract = approval.caseSessions?.cancellation;
    if (!current?.ok || current.value.membership !== "nativeCaseSessions" || !contract || !isDeepStrictEqual(current.value, approval) || signal.aborted) return undefined;
    const selected = await awaitUntilAbort(Promise.resolve().then(() => c.authority.select({ scope: { ...c.scope }, callId: c.callId, sessionId: c.sessionId,
      policyVersion: c.policyVersion, patientId: patient.patientRef, operation: "cancel", classSessionId: session.sessionRef, attendeeId,
      serviceRef: approval.serviceRef, businessId: approval.businessId, practitionerId: approval.practitionerId, appointmentTypeId: approval.appointmentTypeId,
      startsAt: session.startsAt, endsAt: session.endsAt, termsVersion: effect ? ClinikoClassPassCancellation.terms(baseVersion, approval, effect)!.version : baseVersion,
      passTermsVersion: contract.version, ...(effect ? { effect } : {}), phase, signal })), signal);
    return validSelection(selected) && !signal.aborted ? structuredClone(selected) : undefined;
  }
  async authorized(binding: ClassPassCancellationBinding, patient: VerifiedPatient, session: ClinikoClassSession, attendeeId: string,
    approval: ClassApproval, baseVersion: string, phase: ClassPassAuthorityQuery["phase"], signal: AbortSignal): Promise<boolean> {
    const selected = await this.#selection(patient, session, attendeeId, approval, baseVersion, phase, signal, binding.effect);
    return !!selected && isDeepStrictEqual(selected, binding.selection) && !signal.aborted;
  }
  #reader(selection: ClassPassSelection, patient: VerifiedPatient, session: ClinikoClassSession, attendeeId: string,
    approval: ClassApproval, baseVersion: string, phase: ClassPassAuthorityQuery["phase"], effect?: ClassPassCancellationEffect) {
    const c = this.#config;
    return ClinikoPatientCaseSessionsReader.create({ ...c.cliniko, scope: c.scope, timeZone: approval.timeZone,
      attendanceStatus: approval.caseSessions!.attendanceStatus }, c.proof, { allows: async query => {
        if (query.patientId !== patient.patientRef || query.patientCaseId !== selection.patientCaseId || query.classSessionId !== session.sessionRef || query.startsAt !== session.startsAt) return false;
        const selected = await this.#selection(patient, session, attendeeId, approval, baseVersion, phase, query.signal, effect);
        return !!selected && isDeepStrictEqual(selected, selection);
      } }, c.fetchPort, c.clock);
  }
  #query(selection: ClassPassSelection, patient: VerifiedPatient, session: ClinikoClassSession, now: string) {
    return { scope: { ...this.#config.scope }, verificationRef: patient.verificationRef, patientCaseId: selection.patientCaseId,
      classSessionId: session.sessionRef, startsAt: session.startsAt, now };
  }
  async select(patient: VerifiedPatient, session: ClinikoClassSession, attendeeId: string, approval: ClassApproval,
    baseVersion: string, now: string, signal: AbortSignal): Promise<ClassPassCancellationBinding | undefined> {
    const selected = await this.#selection(patient, session, attendeeId, approval, baseVersion, "proposal", signal);
    if (!selected) return undefined;
    const reader = this.#reader(selected, patient, session, attendeeId, approval, baseVersion, "proposal"); if (!reader.ok) return undefined;
    const read = await reader.value.inspectAttendance(this.#query(selected, patient, session, now), attendeeId, signal);
    if (!read.ok) return undefined;
    const binding = { selection: selected, usageFingerprint: read.value.usageFingerprint, maximum: read.value.maximum, used: read.value.used, effect: effectOf(read.value) };
    return await this.authorized(binding, patient, session, attendeeId, approval, baseVersion, "proposal", signal) ? binding : undefined;
  }
  async unchanged(binding: ClassPassCancellationBinding, patient: VerifiedPatient, session: ClinikoClassSession, attendeeId: string,
    approval: ClassApproval, baseVersion: string, phase: "proposal" | "commit", now: string, signal: AbortSignal): Promise<boolean> {
    const reader = this.#reader(binding.selection, patient, session, attendeeId, approval, baseVersion, phase, binding.effect); if (!reader.ok) return false;
    const read = await reader.value.inspectAttendance(this.#query(binding.selection, patient, session, now), attendeeId, signal);
    return read.ok && read.value.usageFingerprint === binding.usageFingerprint && effectOf(read.value) === binding.effect && !signal.aborted;
  }
  async inspectCancellation(binding: ClassPassCancellationBinding, patient: VerifiedPatient, session: ClinikoClassSession, attendeeId: string,
    approval: ClassApproval, baseVersion: string, now: string, signal: AbortSignal): Promise<boolean> {
    const reader = this.#reader(binding.selection, patient, session, attendeeId, approval, baseVersion, "inspection", binding.effect); if (!reader.ok) return false;
    const read = await reader.value.inspectCancellation(this.#query(binding.selection, patient, session, now), binding.usageFingerprint, attendeeId, signal);
    const delta = binding.effect === "releaseOne" ? -1 : binding.effect === "consumeOne" ? 1 : 0;
    return read.ok && read.value.maximum === binding.maximum && read.value.used === binding.used + delta && !signal.aborted;
  }
}
