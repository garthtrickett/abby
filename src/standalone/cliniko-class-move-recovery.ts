import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { PatientProofHost } from "../core/host.ts";
import type { ClassMovementProgress } from "../core/class-movement-progress.ts";
import { ClinikoRecallReader } from "../cliniko/recalls.ts";
import type { ClinikoReviewRecord } from "../cliniko/recalls.ts";
import { ClinikoClassAttendanceReader } from "../cliniko/class-attendance-read.ts";
import { ClinikoClassAttendanceWriter } from "../cliniko/class-attendance-write.ts";
import type { ClinikoAttendanceConfig } from "../cliniko/class-attendance-write.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { withVerifiedClinikoRead } from "../cliniko/verified-read.ts";
import type { HostActor } from "../reference/command-gateway.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { classMoveContract } from "./class-move-contract.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { classMoveLegActionId } from "./cliniko-class-attendance-move.ts";
import type { ClinikoClassMoveRequest } from "./cliniko-class-attendance-move.ts";
import { ClinikoClassPassMovement } from "./cliniko-class-pass-movement.ts";
import type { ClassPassMoveAuthority } from "./cliniko-class-pass-movement.ts";
import { OwnerFileClassPolicy } from "./owner-file-class-policy.ts";
import { OwnerFileClassMovePolicy } from "./owner-file-class-move-policy.ts";
import type { AdminAccount, AdminDirectory } from "./identity/magic-link.ts";
import { validAdminAccount } from "./identity/magic-link.ts";

export interface ClassMoveRecoveryAuthority {
  /** A live authenticated host session, never an actor supplied in JSON. */
  currentActor(signal: AbortSignal): Promise<HostActor | null>;
  /** Independent current clinical/financial permission, human investigation and
   * sender/provider quiescence for this exact review. Notes, a released claim
   * and recalled=true cannot supply these facts. Called before/after reads. */
  permitsReviewedResolution(actor: HostActor, review: ClinikoReviewRecord, signal: AbortSignal): Promise<boolean>;
}
type Config = Readonly<{ scope: LocationScope;
  cliniko: Omit<ClinikoAttendanceConfig, "scope" | "practitionerId" | "appointmentTypeId">;
  sourcePolicy: OwnerFileClassPolicy; destinationPolicy: OwnerFileClassPolicy; movePolicy: OwnerFileClassMovePolicy;
  directory: AdminDirectory; authority: ClassMoveRecoveryAuthority;
  classPassMoveAuthority?: ClassPassMoveAuthority; clock: () => string; fetchPort?: typeof fetch }>;
export type ClassMoveRecoveryRequest = Readonly<{ recallRef: string; replacementAttendeeRef?: string }>;
export type ClassMoveRecoveryStatus = Readonly<{ kind: "reviewedMoved" | "reviewedRestored" | "needsReview";
  reviewAcknowledged: boolean; progress: ClassMovementProgress; observedAt: string }>;
type Failure = Readonly<{ kind: "classMoveRecoveryUnavailable" }>;
const denied = () => err({ kind: "classMoveRecoveryUnavailable" as const });

/** Cold staff observation only. No stage owner, caller proof, sender, local
 * journal or provider mutation is constructed. A result never commits a call. */
export class ClinikoClassMoveRecovery {
  readonly #config: Config;
  constructor(config: Config) {
    if (!(config.sourcePolicy instanceof OwnerFileClassPolicy) || !(config.destinationPolicy instanceof OwnerFileClassPolicy) ||
        !(config.movePolicy instanceof OwnerFileClassMovePolicy) || typeof config.directory?.findByRef !== "function" ||
        typeof config.authority?.currentActor !== "function" || typeof config.authority?.permitsReviewedResolution !== "function" ||
        typeof config.clock !== "function" || !ClinikoRecallReader.create({ ...config.cliniko, scope: config.scope }, config.fetchPort).ok)
      throw new TypeError("invalid class movement recovery configuration");
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }), cliniko: Object.freeze({ ...config.cliniko }) });
  }
  async #actor(signal: AbortSignal, expected?: AdminAccount, authenticatedActor?: HostActor): Promise<AdminAccount | undefined> {
    const c = this.#config, actor = await c.authority.currentActor(signal);
    if (signal.aborted || !actor || actor.role !== "clinicAdmin" || !sameScope(actor.scope, c.scope) ||
        authenticatedActor && !isDeepStrictEqual(actor, authenticatedActor)) return undefined;
    const account = await c.directory.findByRef(actor.actorRef);
    return account.ok && validAdminAccount(account.value) && isDeepStrictEqual(account.value.actor, actor) &&
      (!expected || isDeepStrictEqual(expected, account.value)) && !signal.aborted ? structuredClone(account.value) : undefined;
  }
  async #context(review: ClinikoReviewRecord, signal: AbortSignal) {
    const c = this.#config, r = review.envelope.request, o = r.operation;
    if (o.kind !== "classMove" || !o.quotaStaging || !sameScope(r.scope, c.scope) ||
        r.businessId !== c.cliniko.businessId || r.credentialFingerprint !== clinikoCredentialFingerprint(c.cliniko.apiKey)) return undefined;
    const [a, b, m] = await Promise.all([c.sourcePolicy.current(c.scope), c.destinationPolicy.current(c.scope), c.movePolicy.current(c.scope)]);
    if (signal.aborted || !a.ok || !b.ok || !m.ok) return undefined;
    const source = a.value, destination = b.value, move = m.value;
    if (!move.quotaStaging || move.quotaStaging.version !== o.quotaStaging ||
        move.sourceServiceRef !== source.serviceRef || move.destinationServiceRef !== destination.serviceRef ||
        o.practitionerId !== source.practitionerId || o.appointmentTypeId !== source.appointmentTypeId ||
        (o.newPractitionerId ?? o.practitionerId) !== destination.practitionerId ||
        (o.newAppointmentTypeId ?? o.appointmentTypeId) !== destination.appointmentTypeId ||
        o.cancellationReason !== move.cancellationReason || o.compensation !== move.compensation ||
        [source, destination, move].some(p => !sameScope(p.scope, c.scope) || p.policyVersion !== r.policyVersion ||
          p.businessId !== r.businessId || p.credentialFingerprint !== r.credentialFingerprint || p.timeZone !== r.timeZone ||
          p.recallTypeId !== move.recallTypeId || p.membership !== move.membership) ||
        !!o.pass !== (move.membership === "nativeCaseSessions") || o.pass && !c.classPassMoveAuthority) return undefined;
    const contract = classMoveContract(source, destination, move, o.startsAt, r.createdAt, o.pass);
    return contract?.version === r.termsVersion ? { source, destination, move } : undefined;
  }
  async inspect(request: ClassMoveRecoveryRequest, external?: AbortSignal, authenticatedActor?: HostActor): Promise<Result<ClassMoveRecoveryStatus, Failure>> {
    const lifetime = new AbortController(), timer = setTimeout(() => lifetime.abort(), 20000);
    const signal = AbortSignal.any([lifetime.signal, ...(external ? [external] : [])]);
    try {
      if (!request || !["recallRef", "recallRef,replacementAttendeeRef"].includes(Object.keys(request).sort().join(",")) ||
          !/^cliniko:recall:[1-9][0-9]{0,18}$/.test(request.recallRef) || request.replacementAttendeeRef !== undefined &&
          !/^cliniko:attendee:[1-9][0-9]{0,18}$/.test(request.replacementAttendeeRef)) return denied();
      request = structuredClone(request);
      return await awaitUntilAbort(this.#inspect(request, signal, authenticatedActor), signal) ?? denied();
    } catch { return denied(); }
    finally { clearTimeout(timer); lifetime.abort(); }
  }
  async #inspect(input: ClassMoveRecoveryRequest, signal: AbortSignal, authenticatedActor?: HostActor): Promise<Result<ClassMoveRecoveryStatus, Failure>> {
    const c = this.#config, actor = await this.#actor(signal, undefined, authenticatedActor);
    if (!actor) return denied();
    const approval = await c.movePolicy.current(c.scope);
    if (!approval.ok) return denied();
    const made = ClinikoRecallReader.create({ ...c.cliniko, scope: c.scope }, c.fetchPort);
    if (!made.ok) return denied();
    const found = await made.value.readReview(c.scope, input.recallRef, approval.value.recallTypeId, signal);
    if (!found.ok) return denied();
    const review = found.value, context = await this.#context(review, signal), r = review.envelope.request, o = r.operation;
    if (!context || o.kind !== "classMove") return denied();
    const current = async (stop: AbortSignal) => !stop.aborted && !!await this.#actor(stop, actor, authenticatedActor) &&
      isDeepStrictEqual(await this.#context(review, stop), context) &&
      await c.authority.permitsReviewedResolution(actor.actor, structuredClone(review), stop) === true && !stop.aborted;
    if (!await current(signal)) return denied();
    const at = c.clock(), time = Date.parse(at);
    if (!Number.isFinite(time)) return denied();
    const reference = "staff-class-review:" + randomUUID(), expiresAt = new Date(time + 180000).toISOString();
    const proof: PatientProofHost = { verifyPatient: async (scope, ref, now, stop) => {
      const last = AbortSignal.any([signal, ...(stop ? [stop] : [])]), actual = Date.parse(c.clock());
      return sameScope(scope, c.scope) && ref === reference && Number.isFinite(actual) && actual >= time &&
        actual < time + 20000 && Math.abs(Date.parse(now) - actual) <= 30000 && await current(last)
        ? ok({ scope: { ...c.scope }, patientRef: r.patientId, verificationRef: reference, expiresAt })
        : err({ kind: "unavailable", target: "patient" });
    } };
    // This expired request is input to read-only inspections, never prepare or execute.
    const request: ClinikoClassMoveRequest = { scope: c.scope, patientId: r.patientId, verificationRef: reference,
      actionId: o.attendanceActionId, expiresAt: r.createdAt,
      source: { sessionId: o.sessionId, attendeeId: o.attendeeId, startsAt: o.startsAt, endsAt: o.endsAt },
      destination: { sessionId: o.newSessionId, startsAt: o.newStartsAt, endsAt: o.newEndsAt },
      cancellationReason: o.cancellationReason, compensation: o.compensation, ...(o.pass ? { pass: o.pass } : {}) };
    const inspect = await withVerifiedClinikoRead({ proof, scope: c.scope, verificationRef: reference, clock: c.clock }, signal,
      async (scoped, stop) => {
        const nativeConfig = (service: typeof context.source) => ({ ...c.cliniko, scope: c.scope,
          practitionerId: service.practitionerId, appointmentTypeId: service.appointmentTypeId, className: service.className });
        const source = ClinikoClassAttendanceReader.create(nativeConfig(context.source), scoped, c.fetchPort, c.clock);
        const destination = ClinikoClassAttendanceReader.create(nativeConfig(context.destination), scoped, c.fetchPort, c.clock);
        const writer = ClinikoClassAttendanceWriter.create(nativeConfig(context.destination), c.fetchPort);
        if (!source.ok || !destination.ok || !writer.ok) return undefined;
        const from = o.startsAt < o.newStartsAt ? o.startsAt : o.newStartsAt, to = o.endsAt > o.newEndsAt ? o.endsAt : o.newEndsAt;
        const a = await source.value.inspect(c.scope, reference, o.sessionId, from, to, c.clock(), stop);
        const b = await destination.value.inspect(c.scope, reference, o.newSessionId, from, to, c.clock(), stop);
        if (!a.ok || !b.ok || a.value.patientRef !== r.patientId || b.value.patientRef !== r.patientId) return undefined;
        const original = a.value.sessions.find(s => s.sessionRef === o.sessionId), replacement = b.value.sessions.find(s => s.sessionRef === o.newSessionId);
        if (!original || !replacement || original.startsAt !== o.startsAt || original.endsAt !== o.endsAt ||
            replacement.startsAt !== o.newStartsAt || replacement.endsAt !== o.newEndsAt) return undefined;
        const passes = o.pass ? new ClinikoClassPassMovement({ scope: c.scope, cliniko: c.cliniko, source: context.source,
          destination: context.destination, proof: scoped, clock: c.clock, fetchPort: c.fetchPort ?? fetch, policyVersion: r.policyVersion,
          termsVersion: r.termsVersion, timeZone: r.timeZone, authority: c.classPassMoveAuthority!, stagingContractVersion: o.pass.stagingContractVersion }) : undefined;
        const permit = (last: AbortSignal) => current(last);
        const book = { kind: "book" as const, scope: c.scope, patientId: r.patientId, sessionId: o.newSessionId,
          actionId: classMoveLegActionId(o.attendanceActionId, "replacement"), ...(o.pass ? { patientCaseId: o.pass.destination.patientCaseId } : {}) };
        let progress: ClassMovementProgress = { original: original.attendance.kind === "one" && original.attendance.attendeeRef === o.attendeeId
          ? "inspectedActive" : "uncertain", replacement: "uncertain", caseAssociation: o.pass ? "uncertain" : "notApplicable" };
        let outcome: ClassMoveRecoveryStatus["kind"] = "needsReview";
        const ref = replacement.attendance.kind === "one" ? "cliniko:attendee:" + replacement.attendance.attendeeRef : input.replacementAttendeeRef;
        if (ref && (!input.replacementAttendeeRef || input.replacementAttendeeRef === ref)) {
          const active = o.pass ? await writer.value.inspect(book, ref, stop, permit)
            : await writer.value.inspectUnlinked(book, ref, stop, permit);
          if (active.ok && active.value) {
            progress = { ...progress, replacement: "inspectedActive" };
            const cancelled = await writer.value.inspect({ kind: "cancel", scope: c.scope, patientId: r.patientId, sessionId: o.sessionId,
              attendeeId: o.attendeeId, cancellationReason: o.cancellationReason, actionId: classMoveLegActionId(o.attendanceActionId, "original") },
            "cliniko:attendee:" + o.attendeeId, stop, permit);
            if (cancelled.ok && cancelled.value && original.attendance.kind === "none" && !replacement.overCapacity &&
                (!passes || await passes.inspectMovement(o.pass!, request, ref.slice("cliniko:attendee:".length), stop))) {
              progress = { original: "inspectedCancelled", replacement: "inspectedActive", caseAssociation: o.pass ? "inspectedLinked" : "notApplicable" };
              outcome = "reviewedMoved";
            }
          } else if (progress.original === "inspectedActive" && replacement.attendance.kind === "none") {
            const { patientCaseId: unused, ...unlinkedBook } = book;
            const cancelled = await writer.value.inspectUnlinked({ ...unlinkedBook, kind: "cancel", attendeeId: ref.slice("cliniko:attendee:".length),
              cancellationReason: o.cancellationReason, actionId: classMoveLegActionId(o.attendanceActionId, "compensation") }, ref, stop, permit, book.actionId);
            if (cancelled.ok && cancelled.value && (!passes || await passes.unchanged(o.pass!, request, "compensation", stop))) {
              progress = { original: "inspectedActive", replacement: "inspectedCancelled", caseAssociation: o.pass ? "unlinked" : "notApplicable" };
              outcome = "reviewedRestored";
            }
          }
        }
        // Re-observe the joint class state after exact record/case checks.
        // A changed roster/capacity/attendance cannot be resolved from an early snapshot.
        const finalA = await source.value.inspect(c.scope, reference, o.sessionId, from, to, c.clock(), stop);
        const finalB = await destination.value.inspect(c.scope, reference, o.newSessionId, from, to, c.clock(), stop);
        if (!finalA.ok || !finalB.ok || !isDeepStrictEqual(finalA.value.sessions, a.value.sessions) ||
            !isDeepStrictEqual(finalB.value.sessions, b.value.sessions)) return undefined;
        return { outcome, progress };
      });
    const again = await made.value.readReview(c.scope, input.recallRef, context.move.recallTypeId, signal);
    if (!inspect || !again.ok || !isDeepStrictEqual(again.value, review) || !await current(signal)) return denied();
    const observedAt = c.clock(), lastTime = Date.parse(observedAt);
    if (!Number.isFinite(lastTime) || lastTime < time || lastTime >= time + 20000) return denied();
    return ok({ kind: review.recalled ? inspect.outcome : "needsReview", reviewAcknowledged: review.recalled,
      progress: inspect.progress, observedAt });
  }
}
