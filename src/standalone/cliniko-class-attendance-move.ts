import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { PatientProofHost } from "../core/host.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ClinikoReviewedSend } from "./cliniko-reviewed-send.ts";
import { ClinikoClassAttendanceReader } from "../cliniko/class-attendance-read.ts";
import type { ClinikoClassSession } from "../cliniko/class-attendance-read.ts";
import { ClinikoClassAttendanceWriter } from "../cliniko/class-attendance-write.ts";
import type { ClinikoAttendanceConfig, ClinikoAttendanceRequest } from "../cliniko/class-attendance-write.ts";
import { ClinikoRecallWriter } from "../cliniko/recall-write.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { encodeClinikoReview } from "../cliniko/review-request.ts";
import type { ClinikoReviewRequest } from "../cliniko/review-request.ts";

type Service = Readonly<{ practitionerId: string; appointmentTypeId: string; className: string }>;
type Occurrence = Readonly<{ sessionId: string; startsAt: string; endsAt: string }>;
export type ClinikoClassMoveRequest = Readonly<{
  scope: LocationScope; patientId: string; verificationRef: string; actionId: string; expiresAt: string;
  source: Occurrence & Readonly<{ attendeeId: string }>;
  destination: Occurrence;
  cancellationReason: 10 | 20 | 30 | 40 | 50 | 60;
  compensation: "cancelReplacementIfOriginalUnsent";
}>;
export type ClinikoClassMovePhase = "review" | "bookReplacement" | "inspectReplacement" | "cancelOriginal" |
  "inspectOriginal" | "compensateReplacement" | "inspectCompensation" | "final";
/** Trusted host authority: exact dispatched SAM, played move/fee/recovery consent,
 * current source/destination policies, independent membership permission and
 * write stop. Channel proof and native observations cannot establish these. */
export type ClinikoClassMovePermit = (query: Readonly<{ request: ClinikoClassMoveRequest; phase: ClinikoClassMovePhase;
  replacementAttendeeRef?: string; signal: AbortSignal }>) => Promise<boolean>;
type Config = Readonly<{
  scope: LocationScope; cliniko: Omit<ClinikoAttendanceConfig, "scope" | "practitionerId" | "appointmentTypeId">;
  source: Service; destination: Service; proof: PatientProofHost;
  policyVersion: string; termsVersion: string; timeZone: string; recallTypeId: string;
  clock: () => string; signal: AbortSignal; fetchPort?: typeof fetch;
}>;
type Failure = Readonly<{ kind: "invalidConfig" | "invalidQuery" | "scopeMismatch" | "attemptConsumed" | "unavailable" }>;
type MutationState = "notSent" | "uncertain" | "inspectedActive" | "inspectedCancelled";
export type ClinikoClassMoveOutcome = Readonly<{
  kind: "moved" | "restored" | "notSent" | "needsReview";
  phase: ClinikoClassMovePhase;
  original: MutationState; replacement: MutationState;
  replacementAttendeeRef?: string; recallRef?: string; review?: "uncertain";
}>;
const id = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const instant = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const sameScope = (a: LocationScope, b: LocationScope) => a.tenantId === b.tenantId && a.clinicId === b.clinicId && a.locationId === b.locationId;
const sameService = (a: Service, b: Service) => a.practitionerId === b.practitionerId && a.appointmentTypeId === b.appointmentTypeId;
/** Staff can derive the exact three leg markers from the root in the owned review.
 * A distinct leg never reuses another leg's native single-attempt fence. */
export function classMoveLegActionId(root: string, leg: "replacement" | "original" | "compensation"): string {
  const hex = createHash("sha256").update(`abby-class-move:${root}:${leg}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4"; hex[16] = ((parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  const value = hex.join(""); return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** Explicit non-atomic native move. Create and inspect the replacement before
 * cancelling the original. Compensation is allowed only when original
 * cancellation was never sent; an unknown reply never triggers replay/rollback.
 * This provider module is not yet an admitted conversational move host. */
export class ClinikoClassAttendanceMove {
  readonly #config: Config;
  readonly #source: ClinikoClassAttendanceReader;
  readonly #destination: ClinikoClassAttendanceReader;
  readonly #writer: ClinikoClassAttendanceWriter;
  readonly #recalls: ClinikoRecallWriter;
  readonly #attempted = new Set<string>();
  private constructor(config: Config, source: ClinikoClassAttendanceReader, destination: ClinikoClassAttendanceReader,
    writer: ClinikoClassAttendanceWriter, recalls: ClinikoRecallWriter) {
    this.#config = config; this.#source = source; this.#destination = destination; this.#writer = writer; this.#recalls = recalls;
  }
  static create(input: Config): Result<ClinikoClassAttendanceMove, Failure> {
    try {
      if (!input || !(input.signal instanceof AbortSignal) || input.signal.aborted || typeof input.proof?.verifyPatient !== "function" || typeof input.clock !== "function" || typeof input.timeZone !== "string" || !input.timeZone || input.timeZone.length > 128) return err({ kind: "invalidConfig" });
      const config = Object.freeze({ ...input, scope: Object.freeze({ ...input.scope }), cliniko: Object.freeze({ ...input.cliniko }),
        source: Object.freeze({ ...input.source }), destination: Object.freeze({ ...input.destination }) });
      const port = config.fetchPort ?? fetch;
      const source = ClinikoClassAttendanceReader.create({ ...config.cliniko, ...config.source, scope: config.scope }, config.proof, port, config.clock);
      const destination = ClinikoClassAttendanceReader.create({ ...config.cliniko, ...config.destination, scope: config.scope }, config.proof, port, config.clock);
      const writer = ClinikoClassAttendanceWriter.create({ ...config.cliniko, ...config.destination, scope: config.scope }, port);
      const recalls = ClinikoRecallWriter.create({ ...config.cliniko, scope: config.scope }, port);
      if (!source.ok || !destination.ok || !writer.ok || !recalls.ok || !id(config.recallTypeId) ||
          ![config.policyVersion, config.termsVersion].every(value => typeof value === "string" && !!value.trim() && value.length <= 256)) return err({ kind: "invalidConfig" });
      new Intl.DateTimeFormat("en", { timeZone: config.timeZone });
      return ok(new ClinikoClassAttendanceMove(config, source.value, sameService(config.source, config.destination) ? source.value : destination.value, writer.value, recalls.value));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  #valid(request: ClinikoClassMoveRequest): boolean {
    const at = Date.parse(this.#config.clock());
    const occurrence = (value: Occurrence) => !!value && id(value.sessionId) && instant(value.startsAt) && instant(value.endsAt) &&
      Date.parse(value.startsAt) >= at && Date.parse(value.endsAt) > Date.parse(value.startsAt) && Date.parse(value.endsAt) <= at + 90 * 86400000;
    return !!request && !!request.scope && sameScope(request.scope, this.#config.scope) && id(request.patientId) && uuid(request.actionId) &&
      typeof request.verificationRef === "string" && !!request.verificationRef.trim() && request.verificationRef.length <= 256 &&
      Number.isFinite(at) && instant(request.expiresAt) && Date.parse(request.expiresAt) > at && Date.parse(request.expiresAt) <= at + 120000 &&
      occurrence(request.source) && id(request.source.attendeeId) && occurrence(request.destination) && request.source.sessionId !== request.destination.sessionId &&
      [10, 20, 30, 40, 50, 60].includes(request.cancellationReason) && request.compensation === "cancelReplacementIfOriginalUnsent";
  }
  async #observe(request: ClinikoClassMoveRequest, signal: AbortSignal): Promise<Readonly<{ source: ClinikoClassSession; destination: ClinikoClassSession }> | undefined> {
    const c = this.#config, now = c.clock(), from = request.source.startsAt < request.destination.startsAt ? request.source.startsAt : request.destination.startsAt,
      to = request.source.endsAt > request.destination.endsAt ? request.source.endsAt : request.destination.endsAt;
    const paired = this.#source === this.#destination;
    const reads = paired ? [await this.#source.inspectPair(c.scope, request.verificationRef, [request.source.sessionId, request.destination.sessionId], from, to, now, signal)] :
      [await this.#source.inspect(c.scope, request.verificationRef, request.source.sessionId, from, to, now, signal),
        await this.#destination.inspect(c.scope, request.verificationRef, request.destination.sessionId, from, to, now, signal)];
    if (signal.aborted || reads.some(read => !read.ok || read.value.patientRef !== request.patientId || read.value.timeZone !== c.timeZone)) return undefined;
    const sessions = reads.flatMap(read => read.ok ? read.value.sessions : []);
    const source = sessions.find(row => row.sessionRef === request.source.sessionId), destination = sessions.find(row => row.sessionRef === request.destination.sessionId);
    const matches = (actual: ClinikoClassSession | undefined, expected: Occurrence) => actual?.startsAt === expected.startsAt && actual?.endsAt === expected.endsAt;
    return source && destination && matches(source, request.source) && matches(destination, request.destination) ? { source, destination } : undefined;
  }
  async executeOnce(input: ClinikoClassMoveRequest, external: AbortSignal, permit: ClinikoClassMovePermit): Promise<Result<ClinikoClassMoveOutcome, Failure>> {
    try { if (!this.#valid(input)) return err({ kind: input?.scope && !sameScope(input.scope, this.#config.scope) ? "scopeMismatch" : "invalidQuery" }); }
    catch { return err({ kind: "invalidQuery" }); }
    if (!(external instanceof AbortSignal) || external.aborted || this.#config.signal.aborted || typeof permit !== "function") return err({ kind: "unavailable" });
    if (this.#attempted.has(input.actionId)) return err({ kind: "attemptConsumed" });
    if (this.#attempted.size >= 10000) return err({ kind: "unavailable" });
    this.#attempted.add(input.actionId);
    const request = structuredClone(input), c = this.#config;
    Object.freeze(request.scope); Object.freeze(request.source); Object.freeze(request.destination); Object.freeze(request);
    const signal = AbortSignal.any([c.signal, external, AbortSignal.timeout(30000)]);
    let phase: ClinikoClassMovePhase = "review", original: MutationState = "notSent", replacement: MutationState = "notSent", replacementAttendeeRef: string | undefined;
    const outcome = (kind?: ClinikoClassMoveOutcome["kind"]): ClinikoClassMoveOutcome => ({ kind: kind ?? (replacement === "notSent" && original === "notSent" ? "notSent" : "needsReview"), phase, original, replacement,
      ...(replacementAttendeeRef ? { replacementAttendeeRef } : {}) });
    const permission = async (stage: ClinikoClassMovePhase, stop: AbortSignal) => {
      phase = stage;
      if (stop.aborted || Date.parse(c.clock()) >= Date.parse(request.expiresAt)) return false;
      try { return await awaitUntilAbort(permit({ request, phase: stage, ...(replacementAttendeeRef ? { replacementAttendeeRef } : {}), signal: stop }), stop) === true && !stop.aborted; }
      catch { return false; }
    };
    // Exact attendee inspections need their own live proof. Compound class
    // observations already verify it before and after every native snapshot;
    // their surrounding checks independently revalidate move/SAM permission.
    const allowed = async (stage: ClinikoClassMovePhase, stop: AbortSignal) => {
      const proof = await awaitUntilAbort(c.proof.verifyPatient(c.scope, request.verificationRef, c.clock(), stop), stop);
      if (!proof?.ok || !sameScope(proof.value.scope, c.scope) || proof.value.patientRef !== request.patientId || proof.value.verificationRef !== request.verificationRef ||
          !instant(proof.value.expiresAt) || Date.parse(proof.value.expiresAt) <= Date.parse(c.clock()) + 120000) return false;
      return permission(stage, stop);
    };
    const sourceActive = (value: ClinikoClassSession) => value.attendance.kind === "one" && value.attendance.attendeeRef === request.source.attendeeId;
    const replacementActive = (value: ClinikoClassSession) => value.attendance.kind === "one" && `cliniko:attendee:${value.attendance.attendeeRef}` === replacementAttendeeRef;
    const initial = async (stop: AbortSignal) => {
      const observed = await this.#observe(request, stop);
      return !!observed && sourceActive(observed.source) && observed.destination.attendance.kind === "none" && observed.destination.remainingPlaces > 0 && !observed.destination.overCapacity;
    };
    const native = (kind: "book" | "cancel", leg: "replacement" | "original" | "compensation"): ClinikoAttendanceRequest => ({ scope: c.scope, patientId: request.patientId,
      sessionId: leg === "original" ? request.source.sessionId : request.destination.sessionId, actionId: classMoveLegActionId(request.actionId, leg),
      ...(kind === "book" ? { kind } : { kind, attendeeId: leg === "original" ? request.source.attendeeId : replacementAttendeeRef!.slice("cliniko:attendee:".length), cancellationReason: request.cancellationReason }) });
    const compensate = async (stop: AbortSignal): Promise<ClinikoClassMoveOutcome> => {
      if (original !== "notSent" || !replacementAttendeeRef || !await allowed("compensateReplacement", stop)) return outcome();
      const cancel = native("cancel", "compensation");
      replacement = "uncertain";
      const sent = await this.#writer.executeOnce(cancel, stop, async last => {
        if (!await permission("compensateReplacement", last)) return false;
        const current = await this.#observe(request, last);
        return !!current && sourceActive(current.source) && replacementActive(current.destination) && await permission("compensateReplacement", last);
      });
      if (!sent.ok) { replacement = "inspectedActive"; return outcome(); }
      if (sent.value.kind !== "accepted") return outcome();
      const exact = await this.#writer.inspect(cancel, replacementAttendeeRef, stop, last => allowed("inspectCompensation", last));
      if (!exact.ok || !exact.value || !await allowed("inspectCompensation", stop)) return outcome();
      const after = await this.#observe(request, stop);
      if (!after || !sourceActive(after.source) || after.destination.attendance.kind !== "none" || !await permission("inspectCompensation", stop)) return outcome();
      replacement = "inspectedCancelled";
      return outcome("restored");
    };
    const review: ClinikoReviewRequest = { scope: c.scope, patientId: request.patientId, businessId: c.cliniko.businessId,
      credentialFingerprint: clinikoCredentialFingerprint(c.cliniko.apiKey), policyVersion: c.policyVersion, termsVersion: c.termsVersion, timeZone: c.timeZone, createdAt: c.clock(),
      operation: { kind: "classMove", sessionId: request.source.sessionId, attendeeId: request.source.attendeeId, startsAt: request.source.startsAt, endsAt: request.source.endsAt,
        practitionerId: c.source.practitionerId, appointmentTypeId: c.source.appointmentTypeId, newSessionId: request.destination.sessionId, newStartsAt: request.destination.startsAt,
        newEndsAt: request.destination.endsAt, ...(c.source.practitionerId !== c.destination.practitionerId ? { newPractitionerId: c.destination.practitionerId } : {}),
        ...(c.source.appointmentTypeId !== c.destination.appointmentTypeId ? { newAppointmentTypeId: c.destination.appointmentTypeId } : {}),
        attendanceActionId: request.actionId, cancellationReason: request.cancellationReason, compensation: request.compensation } };
    if (!encodeClinikoReview(request.actionId, review).ok) return err({ kind: "invalidQuery" });
    const reviewed = new ClinikoReviewedSend({ scope: c.scope, businessId: c.cliniko.businessId, credentialFingerprint: review.credentialFingerprint,
      policyVersion: c.policyVersion, timeZone: c.timeZone, recallTypeId: c.recallTypeId, writer: this.#recalls, clock: () => Date.parse(c.clock()) });
    try {
      let prepared = false;
      const result = await reviewed.run(review, {
        authorize: async (_request, stop) => {
          if (prepared) return allowed("review", stop);
          if (!await permission("review", stop)) return false;
          prepared = await initial(stop); return prepared && await permission("review", stop);
        },
        send: async (_request, stop) => {
          const book = native("book", "replacement");
          replacement = "uncertain";
          const booked = await this.#writer.executeOnce(book, stop, async last => await permission("bookReplacement", last) && await initial(last) && await permission("bookReplacement", last));
          if (!booked.ok) { replacement = "notSent"; return outcome(); }
          if (booked.value.kind !== "accepted") return outcome();
          replacementAttendeeRef = booked.value.attendeeRef;
          const exact = await this.#writer.inspect(book, replacementAttendeeRef, stop, last => allowed("inspectReplacement", last));
          if (!exact.ok || !exact.value) return outcome();
          replacement = "inspectedActive";
          const cancel = native("cancel", "original");
          original = "uncertain";
          const cancelled = await this.#writer.executeOnce(cancel, stop, async last => {
            if (!await permission("cancelOriginal", last)) return false;
            const current = await this.#observe(request, last);
            return !!current && sourceActive(current.source) && replacementActive(current.destination) && !current.destination.overCapacity && await permission("cancelOriginal", last);
          });
          if (!cancelled.ok) { original = "notSent"; return compensate(stop); }
          if (cancelled.value.kind !== "accepted") return outcome();
          const inspected = await this.#writer.inspect(cancel, `cliniko:attendee:${request.source.attendeeId}`, stop, last => allowed("inspectOriginal", last));
          if (!inspected.ok || !inspected.value) return outcome();
          original = "inspectedCancelled";
          if (!await permission("final", stop)) return outcome();
          const final = await this.#observe(request, stop);
          return final && final.source.attendance.kind === "none" && replacementActive(final.destination) && !final.destination.overCapacity && await permission("final", stop) ? outcome("moved") : outcome();
        },
      }, signal);
      return ok(result.ok ? { ...result.value.outcome, recallRef: result.value.recallRef } : { ...outcome(), ...(result.error.kind === "reviewUncertain" ? { review: "uncertain" as const } : {}) });
    } catch { return ok(outcome()); }
    finally { reviewed.close(); }
  }
}
