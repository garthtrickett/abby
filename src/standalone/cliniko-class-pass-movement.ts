import { isDeepStrictEqual } from "node:util";
import { ClinikoPatientCaseSessionsReader } from "../cliniko/patient-case-sessions.ts";
import type { ClinikoCaseSessions } from "../cliniko/patient-case-sessions.ts";
import type { ClassMovementPass } from "../cliniko/review-request.ts";
import type { ClinikoAttendanceConfig } from "../cliniko/class-attendance-write.ts";
import type { PatientProofHost } from "../core/host.ts";
import type { LocationScope } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import type { ClinikoClassMoveRequest } from "./cliniko-class-attendance-move.ts";
import type { ClassPassSelection } from "./cliniko-class-pass-booking.ts";
import { approvalRef } from "./owner-file-clinic-approval.ts";

type Phase = "proposal" | "commit" | "inspection" | "compensation";
type Service = Readonly<{ practitionerId: string; appointmentTypeId: string }>;
type Selection = Readonly<{ source: ClassPassSelection; destination: ClassPassSelection }>;
export type ClassPassMoveAuthorityQuery = Readonly<{
  scope: LocationScope; policyVersion: string; termsVersion: string; stagingContractVersion: string;
  patientId: string; source: ClinikoClassMoveRequest["source"] & Service; destination: ClinikoClassMoveRequest["destination"] & Service;
  phase: Phase; signal: AbortSignal;
}>;
/** Selection grants only scoped private inspection. Actual session effects,
 * temporary unlinked attendance and recovery require the separate allows check.
 * Neither the case balance nor the caller proof can implement this authority. */
export type ClassPassMoveAuthority = Readonly<{
  select(query: ClassPassMoveAuthorityQuery): Promise<Selection | undefined>;
  allows(query: ClassPassMoveAuthorityQuery & Readonly<{ binding: ClassMovementPass }>): Promise<boolean>;
}>;
export type ClassPassMoveConfig = Readonly<{
  scope: LocationScope; policyVersion: string; termsVersion: string; timeZone: string;
  cliniko: Omit<ClinikoAttendanceConfig, "scope" | "practitionerId" | "appointmentTypeId">;
  source: Service; destination: Service; proof: PatientProofHost; clock: () => string; fetchPort: typeof fetch;
  authority: ClassPassMoveAuthority; stagingContractVersion: string;
}>;
const selection = (value: unknown): value is ClassPassSelection => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "entitlementRef,patientCaseId") return false;
  const row = value as Record<string, unknown>;
  return typeof row.patientCaseId === "string" && /^[1-9][0-9]{0,18}$/.test(row.patientCaseId) && approvalRef(row.entitlementRef);
};
const delta = (binding: ClassMovementPass) => binding.source.effect === "releaseOne" ? -1 : binding.source.effect === "consumeOne" ? 1 : 0;
const sameCase = (binding: ClassMovementPass) => binding.source.patientCaseId === binding.destination.patientCaseId;

/** Private pass evidence for a replacement-first move, including full passes and
 * separately authorised cross-case/service transfers. The attendance coordinator
 * owns staging, native writes and no-replay recovery; this module owns complete
 * case observations, independent entitlement and exact expected session effects. */
export class ClinikoClassPassMovement {
  readonly #config: ClassPassMoveConfig;
  constructor(input: ClassPassMoveConfig) {
    if (!approvalRef(input.stagingContractVersion) || typeof input.authority?.select !== "function" || typeof input.authority?.allows !== "function" ||
      !ClinikoPatientCaseSessionsReader.create({ ...input.cliniko, scope: input.scope, timeZone: input.timeZone, attendanceStatus: "arrivedFalseIsDna" },
        input.proof, { allows: async () => false }, input.fetchPort, input.clock).ok) throw new TypeError("invalid pass movement configuration");
    this.#config = Object.freeze({ ...input, scope: Object.freeze({ ...input.scope }), cliniko: Object.freeze({ ...input.cliniko }),
      source: Object.freeze({ ...input.source }), destination: Object.freeze({ ...input.destination }) });
  }
  #query(request: ClinikoClassMoveRequest, phase: Phase, signal: AbortSignal): ClassPassMoveAuthorityQuery {
    const c = this.#config;
    return { scope: { ...c.scope }, policyVersion: c.policyVersion, termsVersion: c.termsVersion, stagingContractVersion: c.stagingContractVersion,
      patientId: request.patientId, source: { ...request.source, ...c.source }, destination: { ...request.destination, ...c.destination }, phase, signal };
  }
  async #selection(request: ClinikoClassMoveRequest, phase: Phase, signal: AbortSignal): Promise<Selection | undefined> {
    const scope = request?.scope, expected = this.#config.scope;
    if (!scope || scope.tenantId !== expected.tenantId || scope.clinicId !== expected.clinicId || scope.locationId !== expected.locationId || signal.aborted) return undefined;
    try {
      const found = await awaitUntilAbort(Promise.resolve().then(() => this.#config.authority.select(this.#query(request, phase, signal))), signal);
      return found && !Array.isArray(found) && Object.keys(found).sort().join(",") === "destination,source" && selection(found.source) && selection(found.destination) && !signal.aborted ? structuredClone(found) : undefined;
    } catch { return undefined; }
  }
  async authorized(binding: ClassMovementPass, request: ClinikoClassMoveRequest, phase: Phase, signal: AbortSignal): Promise<boolean> {
    const selected = await this.#selection(request, phase, signal);
    if (!selected || binding.stagingContractVersion !== this.#config.stagingContractVersion || !isDeepStrictEqual(selected,
      { source: { patientCaseId: binding.source.patientCaseId, entitlementRef: binding.source.entitlementRef },
        destination: { patientCaseId: binding.destination.patientCaseId, entitlementRef: binding.destination.entitlementRef } })) return false;
    try { return await awaitUntilAbort(Promise.resolve().then(() => this.#config.authority.allows({ ...this.#query(request, phase, signal), binding: structuredClone(binding) })), signal) === true && !signal.aborted; }
    catch { return false; }
  }
  #reader(request: ClinikoClassMoveRequest, selected: Selection, side: "source" | "destination", phase: Phase, binding?: ClassMovementPass) {
    const c = this.#config, expected = request[side];
    return ClinikoPatientCaseSessionsReader.create({ ...c.cliniko, scope: c.scope, timeZone: c.timeZone, attendanceStatus: "arrivedFalseIsDna" }, c.proof,
      { allows: async query => {
        if (query.patientId !== request.patientId || query.patientCaseId !== selected[side].patientCaseId || query.classSessionId !== expected.sessionId || query.startsAt !== expected.startsAt) return false;
        if (binding) return this.authorized(binding, request, phase, query.signal);
        const current = await this.#selection(request, phase, query.signal); return !!current && isDeepStrictEqual(current, selected);
      } }, c.fetchPort, c.clock);
  }
  #nativeQuery(request: ClinikoClassMoveRequest, selected: Selection, side: "source" | "destination") {
    return { scope: { ...this.#config.scope }, verificationRef: request.verificationRef, patientCaseId: selected[side].patientCaseId,
      classSessionId: request[side].sessionId, startsAt: request[side].startsAt, now: this.#config.clock() };
  }
  #selected(binding: ClassMovementPass): Selection {
    return { source: { patientCaseId: binding.source.patientCaseId, entitlementRef: binding.source.entitlementRef },
      destination: { patientCaseId: binding.destination.patientCaseId, entitlementRef: binding.destination.entitlementRef } };
  }
  async select(request: ClinikoClassMoveRequest, phase: "proposal" | "commit" | "compensation", signal: AbortSignal): Promise<ClassMovementPass | undefined> {
    const selected = await this.#selection(request, phase, signal); if (!selected) return undefined;
    const source = this.#reader(request, selected, "source", phase), destination = this.#reader(request, selected, "destination", phase);
    if (!source.ok || !destination.ok) return undefined;
    const a = await source.value.inspectAttendance(this.#nativeQuery(request, selected, "source"), request.source.attendeeId, signal);
    const b = await destination.value.read(this.#nativeQuery(request, selected, "destination"), signal);
    if (!a.ok || !b.ok || !b.value.eligibleOnSessionDate) return undefined;
    const change = Number(a.value.includeCancelled) - Number(a.value.attendance.countsSession);
    const bind = (side: "source" | "destination", value: ClinikoCaseSessions) => ({ ...selected[side], usageFingerprint: value.usageFingerprint, maximum: value.maximum, used: value.used });
    const binding: ClassMovementPass = { source: { ...bind("source", a.value), effect: change < 0 ? "releaseOne" : change > 0 ? "consumeOne" : "unchanged" },
      destination: bind("destination", b.value), stagingContractVersion: this.#config.stagingContractVersion };
    if (sameCase(binding) ? a.value.usageFingerprint !== b.value.usageFingerprint || b.value.used + change + 1 > b.value.maximum :
      b.value.remaining < 1 || b.value.overdrawn || change > 0 && a.value.used + change > a.value.maximum) return undefined;
    return await this.authorized(binding, request, phase, signal) ? binding : undefined;
  }
  async unchanged(binding: ClassMovementPass, request: ClinikoClassMoveRequest, phase: "commit" | "compensation", signal: AbortSignal): Promise<boolean> {
    const current = await this.select(request, phase, signal); return !!current && isDeepStrictEqual(binding, current) && !signal.aborted;
  }
  async afterCancellation(binding: ClassMovementPass, request: ClinikoClassMoveRequest, signal: AbortSignal): Promise<boolean> {
    const selected = this.#selected(binding), source = this.#reader(request, selected, "source", "commit", binding), destination = this.#reader(request, selected, "destination", "commit", binding);
    if (!source.ok || !destination.ok) return false;
    const a = await source.value.inspectCancellation(this.#nativeQuery(request, selected, "source"), binding.source.usageFingerprint, request.source.attendeeId, signal);
    const b = await destination.value.read(this.#nativeQuery(request, selected, "destination"), signal);
    return a.ok && b.ok && a.value.maximum === binding.source.maximum && a.value.used === binding.source.used + delta(binding) &&
      b.value.eligibleOnSessionDate && !b.value.overdrawn && b.value.remaining >= 1 && b.value.maximum === binding.destination.maximum &&
      b.value.usageFingerprint === (sameCase(binding) ? a.value.usageFingerprint : binding.destination.usageFingerprint) && !signal.aborted;
  }
  async inspectMovement(binding: ClassMovementPass, request: ClinikoClassMoveRequest, replacementAttendeeId: string, signal: AbortSignal): Promise<boolean> {
    const selected = this.#selected(binding), source = this.#reader(request, selected, "source", "inspection", binding), destination = this.#reader(request, selected, "destination", "inspection", binding);
    if (!source.ok || !destination.ok) return false;
    const b = sameCase(binding) ? await destination.value.inspectMovement(this.#nativeQuery(request, selected, "destination"), {
      usageFingerprint: binding.source.usageFingerprint, originalAttendeeId: request.source.attendeeId, originalClassSessionId: request.source.sessionId, replacementAttendeeId }, signal) :
      await destination.value.inspectAddition(this.#nativeQuery(request, selected, "destination"), binding.destination.usageFingerprint, replacementAttendeeId, signal);
    if (!b.ok || !b.value.eligibleOnSessionDate || b.value.overdrawn || b.value.maximum !== binding.destination.maximum ||
      b.value.used !== binding.destination.used + 1 + (sameCase(binding) ? delta(binding) : 0)) return false;
    if (sameCase(binding)) return this.authorized(binding, request, "inspection", signal);
    const a = await source.value.inspectCancellation(this.#nativeQuery(request, selected, "source"), binding.source.usageFingerprint, request.source.attendeeId, signal);
    return a.ok && a.value.maximum === binding.source.maximum && a.value.used === binding.source.used + delta(binding) &&
      await this.authorized(binding, request, "inspection", signal);
  }
}
