import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { PatientProofHost } from "../core/host.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ClinikoReviewedSend } from "./cliniko-reviewed-send.ts";
import { ClinikoClassAttendanceReader } from "../cliniko/class-attendance-read.ts";
import type { ClinikoClassSession } from "../cliniko/class-attendance-read.ts";
import { ClinikoClassAttendanceWriter } from "../cliniko/class-attendance-write.ts";
import type { ClinikoAttendanceConfig, ClinikoAttendanceRequest } from "../cliniko/class-attendance-write.ts";
import { ClinikoRecallReader } from "../cliniko/recalls.ts";
import type { ClinikoReviewRecord } from "../cliniko/recalls.ts";
import { ClinikoRecallWriter } from "../cliniko/recall-write.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { encodeClinikoReview } from "../cliniko/review-request.ts";
import type { ClinikoReviewRequest } from "../cliniko/review-request.ts";
import type { ClassMovementPass } from "../cliniko/review-request.ts";
import { ClinikoClassPassMovement } from "./cliniko-class-pass-movement.ts";
import type { ClassPassMoveAuthority } from "./cliniko-class-pass-movement.ts";
import { withVerifiedClinikoRead } from "../cliniko/verified-read.ts";
import { ClassMoveStageControl } from "./cliniko-class-move-stages.ts";
import type { ClinikoStagedClassMove } from "./cliniko-class-move-stages.ts";
import { observedClassMoveRequests } from "../cliniko/class-move-workload.ts";

type Service = Readonly<{ practitionerId: string; appointmentTypeId: string; className: string }>;
type Occurrence = Readonly<{ sessionId: string; startsAt: string; endsAt: string }>;
export type ClinikoClassMoveRequest = Readonly<{
  scope: LocationScope; patientId: string; verificationRef: string; actionId: string; expiresAt: string;
  source: Occurrence & Readonly<{ attendeeId: string }>;
  destination: Occurrence;
  cancellationReason: 10 | 20 | 30 | 40 | 50 | 60;
  compensation: "cancelReplacementIfOriginalUnsent";
  pass?: ClassMovementPass;
}>;
export type ClinikoClassMovePhase = "review" | "bookReplacement" | "inspectReplacement" | "cancelOriginal" |
  "inspectOriginal" | "compensateReplacement" | "inspectCompensation" | "inspectStaging" | "linkReplacement" | "inspectPass" | "final";
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
  casePass?: Readonly<{ authority: ClassPassMoveAuthority; stagingContractVersion: string }>;
  /** Independent host knowledge of native requests made by each proof check.
   * Omitted means unknown (zero lower bound), never an upper-cost guarantee. */
  proofNativeRequestFloor?: 0 | 1;
  /** Separately approved staged quota contract; legacy call routes do not enable it. */
  quotaStaging?: Readonly<{ version: string }>;
}>;
export type ClinikoClassMoveFailure = Readonly<{ kind: "invalidConfig" | "invalidQuery" | "scopeMismatch" | "attemptConsumed" | "unavailable" }>;
type Failure = ClinikoClassMoveFailure;
type MutationState = "notSent" | "uncertain" | "inspectedActive" | "inspectedCancelled";
export type ClinikoClassMoveOutcome = Readonly<{
  kind: "moved" | "restored" | "notSent" | "needsReview";
  phase: ClinikoClassMovePhase;
  original: MutationState; replacement: MutationState;
  replacementAttendeeRef?: string; recallRef?: string; review?: "uncertain";
  caseAssociation?: "notSent" | "unlinked" | "uncertain" | "inspectedLinked";
}>;
const id = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const instant = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const sameScope = (a: LocationScope, b: LocationScope) => a.tenantId === b.tenantId && a.clinicId === b.clinicId && a.locationId === b.locationId;
const sameService = (a: Service, b: Service) => a.practitionerId === b.practitionerId && a.appointmentTypeId === b.appointmentTypeId;
/** Staff can derive the exact three leg markers from the root in the owned review.
 * A distinct leg never reuses another leg's native single-attempt fence. */
export function classMoveLegActionId(root: string, leg: "replacement" | "original" | "compensation" | "association"): string {
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
  readonly #passes?: ClinikoClassPassMovement;
  readonly #attempted = new Set<string>();
  private constructor(config: Config, source: ClinikoClassAttendanceReader, destination: ClinikoClassAttendanceReader,
    writer: ClinikoClassAttendanceWriter, recalls: ClinikoRecallWriter) {
    this.#config = config; this.#source = source; this.#destination = destination; this.#writer = writer; this.#recalls = recalls;
    if (config.casePass) this.#passes = new ClinikoClassPassMovement({ ...config, fetchPort: config.fetchPort ?? fetch, ...config.casePass });
  }
  static create(input: Config): Result<ClinikoClassAttendanceMove, Failure> {
    try {
      if (!input || !(input.signal instanceof AbortSignal) || input.signal.aborted || typeof input.proof?.verifyPatient !== "function" || typeof input.clock !== "function" || typeof input.timeZone !== "string" || !input.timeZone || input.timeZone.length > 128) return err({ kind: "invalidConfig" });
      if (input.proofNativeRequestFloor !== undefined && input.proofNativeRequestFloor !== 0 && input.proofNativeRequestFloor !== 1) return err({ kind: "invalidConfig" });
      if ("quotaStaging" in input && (!Object.hasOwn(input, "quotaStaging") || !input.quotaStaging || Object.keys(input.quotaStaging).join(",") !== "version" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.quotaStaging.version))) return err({ kind: "invalidConfig" });
      if (Object.hasOwn(input, "casePass") && (!input.casePass || Object.keys(input.casePass).sort().join(",") !== "authority,stagingContractVersion")) return err({ kind: "invalidConfig" });
      const config = Object.freeze({ ...input, scope: Object.freeze({ ...input.scope }), cliniko: Object.freeze({ ...input.cliniko }),
        source: Object.freeze({ ...input.source }), destination: Object.freeze({ ...input.destination }), ...(input.quotaStaging ? { quotaStaging: Object.freeze({ ...input.quotaStaging }) } : {}) });
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
      [10, 20, 30, 40, 50, 60].includes(request.cancellationReason) && request.compensation === "cancelReplacementIfOriginalUnsent" &&
      !!request.pass === !!this.#passes && (Object.hasOwn(request, "pass") ? !!request.pass : !this.#passes);
  }
  #readers(proof?: PatientProofHost) {
    if (!proof) return { source: this.#source, destination: this.#destination };
    const c = this.#config, make = (service: Service) => ClinikoClassAttendanceReader.create({ ...c.cliniko, ...service, scope: c.scope }, proof, c.fetchPort, c.clock);
    const source = make(c.source), destination = sameService(c.source, c.destination) ? source : make(c.destination);
    return source.ok && destination.ok ? { source: source.value, destination: destination.value } : undefined;
  }
  async #observe(request: ClinikoClassMoveRequest, signal: AbortSignal, proof?: PatientProofHost): Promise<Readonly<{ source: ClinikoClassSession; destination: ClinikoClassSession }> | undefined> {
    const c = this.#config, now = c.clock(), from = request.source.startsAt < request.destination.startsAt ? request.source.startsAt : request.destination.startsAt,
      to = request.source.endsAt > request.destination.endsAt ? request.source.endsAt : request.destination.endsAt;
    const readers = this.#readers(proof); if (!readers) return undefined;
    const paired = readers.source === readers.destination;
    const reads = paired ? [await readers.source.inspectPair(c.scope, request.verificationRef, [request.source.sessionId, request.destination.sessionId], from, to, now, signal)] :
      [await readers.source.inspect(c.scope, request.verificationRef, request.source.sessionId, from, to, now, signal),
        await readers.destination.inspect(c.scope, request.verificationRef, request.destination.sessionId, from, to, now, signal)];
    if (signal.aborted || reads.some(read => !read.ok || read.value.patientRef !== request.patientId || read.value.timeZone !== c.timeZone)) return undefined;
    const sessions = reads.flatMap(read => read.ok ? read.value.sessions : []);
    const source = sessions.find(row => row.sessionRef === request.source.sessionId), destination = sessions.find(row => row.sessionRef === request.destination.sessionId);
    const matches = (actual: ClinikoClassSession | undefined, expected: Occurrence) => actual?.startsAt === expected.startsAt && actual?.endsAt === expected.endsAt;
    return source && destination && matches(source, request.source) && matches(destination, request.destination) ? { source, destination } : undefined;
  }
  async #observeDestination(request: ClinikoClassMoveRequest, signal: AbortSignal, proof?: PatientProofHost): Promise<ClinikoClassSession | undefined> {
    const c = this.#config, selected = request.destination;
    const readers = this.#readers(proof); if (!readers) return undefined;
    const read = await readers.destination.inspect(c.scope, request.verificationRef, selected.sessionId, selected.startsAt, selected.endsAt, c.clock(), signal);
    if (!read.ok || read.value.patientRef !== request.patientId || read.value.timeZone !== c.timeZone || signal.aborted) return undefined;
    const found = read.value.sessions[0];
    return found?.sessionRef === selected.sessionId && found.startsAt === selected.startsAt && found.endsAt === selected.endsAt ? found : undefined;
  }
  async executeOnce(input: ClinikoClassMoveRequest, external: AbortSignal, permit: ClinikoClassMovePermit): Promise<Result<ClinikoClassMoveOutcome, Failure>> {
    return this.#execute(input, external, permit);
  }
  prepareStagesOnce(input: ClinikoClassMoveRequest): Result<ClinikoStagedClassMove, Failure> {
    try {
      const c = this.#config;
      if (!c.quotaStaging || !input.pass || typeof c.cliniko.rateBudget.withReservation !== "function" || !this.#valid(input) || c.signal.aborted) return err({ kind: "invalidQuery" });
      if (this.#attempted.has(input.actionId)) return err({ kind: "attemptConsumed" });
      const stages = new ClassMoveStageControl({ version: c.quotaStaging.version, initialExpiresAt: input.expiresAt, initialVerificationRef: input.verificationRef,
        clock: c.clock, signal: c.signal, budget: c.cliniko.rateBudget });
      void this.#execute(input, c.signal, query => stages.authorize(query), stages).then(result => stages.finish(result), () => stages.finish(err({ kind: "unavailable" })));
      return ok(stages.handle());
    } catch { return err({ kind: "invalidQuery" }); }
  }
  async #execute(input: ClinikoClassMoveRequest, external: AbortSignal, permit: ClinikoClassMovePermit, staging?: ClassMoveStageControl): Promise<Result<ClinikoClassMoveOutcome, Failure>> {
    try { if (!this.#valid(input)) return err({ kind: input?.scope && !sameScope(input.scope, this.#config.scope) ? "scopeMismatch" : "invalidQuery" }); }
    catch { return err({ kind: "invalidQuery" }); }
    if (!(external instanceof AbortSignal) || external.aborted || this.#config.signal.aborted || typeof permit !== "function") return err({ kind: "unavailable" });
    if (this.#attempted.has(input.actionId)) return err({ kind: "attemptConsumed" });
    if (this.#attempted.size >= 10000) return err({ kind: "unavailable" });
    this.#attempted.add(input.actionId);
    let request = structuredClone(input); const c = this.#config;
    Object.freeze(request.scope); Object.freeze(request.source); Object.freeze(request.destination); Object.freeze(request);
    if (request.pass) { Object.freeze(request.pass.source); Object.freeze(request.pass.destination); Object.freeze(request.pass); }
    const signal = AbortSignal.any([c.signal, external, ...(staging ? [] : [AbortSignal.timeout(30000)])]);
    let phase: ClinikoClassMovePhase = "review", original: MutationState = "notSent", replacement: MutationState = "notSent", replacementAttendeeRef: string | undefined;
    let recallRef: string | undefined;
    let caseAssociation: ClinikoClassMoveOutcome["caseAssociation"] = this.#passes ? "notSent" : undefined;
    const outcome = (kind?: ClinikoClassMoveOutcome["kind"]): ClinikoClassMoveOutcome => ({ kind: kind ?? (replacement === "notSent" && original === "notSent" ? "notSent" : "needsReview"), phase, original, replacement,
      ...(replacementAttendeeRef ? { replacementAttendeeRef } : {}), ...(recallRef ? { recallRef } : {}), ...(caseAssociation ? { caseAssociation } : {}) });
    const permission = async (stage: ClinikoClassMovePhase, stop: AbortSignal) => {
      phase = stage;
      if (stop.aborted || Date.parse(c.clock()) >= Date.parse(staging?.expiresAt ?? request.expiresAt)) return false;
      try { return await awaitUntilAbort(permit({ request: staging ? { ...request, expiresAt: staging.expiresAt } : request, phase: stage, ...(replacementAttendeeRef ? { replacementAttendeeRef } : {}), signal: stop }), stop) === true && !stop.aborted; }
      catch { return false; }
    };
    // Exact attendee inspections need their own live proof. Compound class
    // observations already verify it before and after every native snapshot;
    // their surrounding checks independently revalidate move/SAM permission.
    const allowed = async (stage: ClinikoClassMovePhase, stop: AbortSignal, readProof = c.proof) => {
      const proof = await awaitUntilAbort(readProof.verifyPatient(c.scope, request.verificationRef, c.clock(), stop), stop);
      if (!proof?.ok || !sameScope(proof.value.scope, c.scope) || proof.value.patientRef !== request.patientId || proof.value.verificationRef !== request.verificationRef ||
          !instant(proof.value.expiresAt) || Date.parse(proof.value.expiresAt) <= Date.parse(c.clock()) + 120000) return false;
      return permission(stage, stop);
    };
    const sourceActive = (value: ClinikoClassSession) => value.attendance.kind === "one" && value.attendance.attendeeRef === request.source.attendeeId;
    const replacementActive = (value: ClinikoClassSession) => value.attendance.kind === "one" && `cliniko:attendee:${value.attendance.attendeeRef}` === replacementAttendeeRef;
    const observation = async <T>(phase: "commit" | "inspection" | "compensation", stop: AbortSignal,
      read: (proof: PatientProofHost, signal: AbortSignal, passes: ClinikoClassPassMovement) => Promise<T>): Promise<T | undefined> => {
      const result = await withVerifiedClinikoRead({ proof: c.proof, scope: c.scope, verificationRef: request.verificationRef, clock: c.clock }, stop,
        (proof, signal) => read(proof, signal, this.#passes!.usingProof(proof)));
      return result !== undefined && await this.#passes!.authorized(request.pass!, request, phase, stop) ? result : undefined;
    };
    const grouped = async (phase: "commit" | "inspection" | "compensation", stop: AbortSignal,
      read: (proof: PatientProofHost, signal: AbortSignal, passes: ClinikoClassPassMovement) => Promise<boolean>) =>
      await observation(phase, stop, read) === true;
    const initial = async (stop: AbortSignal) => {
      const read = async (proof: PatientProofHost | undefined, last: AbortSignal, passes?: ClinikoClassPassMovement) => {
        const observed = await this.#observe(request, last, proof);
        if (!observed || !sourceActive(observed.source) || observed.destination.attendance.kind !== "none" || observed.destination.remainingPlaces < 1 || observed.destination.overCapacity) return false;
        if (!request.pass) return true;
        const current = await passes!.selectWithWorkload(request, "commit", last);
        const requests = current && observedClassMoveRequests(current.minimumNativeRequests, observed.source, observed.destination, sameService(c.source, c.destination));
        return !!current && isDeepStrictEqual(current.binding, request.pass) &&
          requests !== undefined && (staging !== undefined || requests + 9 * (c.proofNativeRequestFloor ?? 0) <= 180);
      };
      return request.pass ? grouped("commit", stop, (proof, last, passes) => read(proof, last, passes)) : read(undefined, stop);
    };
    const native = (kind: "book" | "cancel", leg: "replacement" | "original" | "compensation"): ClinikoAttendanceRequest => ({ scope: c.scope, patientId: request.patientId,
      sessionId: leg === "original" ? request.source.sessionId : request.destination.sessionId, actionId: classMoveLegActionId(request.actionId, leg),
      ...(kind === "book" ? { kind } : { kind, attendeeId: leg === "original" ? request.source.attendeeId : replacementAttendeeRef!.slice("cliniko:attendee:".length), cancellationReason: request.cancellationReason }) });
    const unlinked = async (stage: ClinikoClassMovePhase, stop: AbortSignal, proof = c.proof) => {
      if (!replacementAttendeeRef) return false;
      const found = await this.#writer.inspectUnlinked(native("book", "replacement") as Extract<ClinikoAttendanceRequest, { kind: "book" }>,
        replacementAttendeeRef, stop, last => allowed(stage, last, proof));
      return found.ok && found.value;
    };
    const cancelCompensation = async (stop: AbortSignal): Promise<boolean> => {
      if (original !== "notSent" || !replacementAttendeeRef || !await (request.pass ? permission("compensateReplacement", stop) : allowed("compensateReplacement", stop))) return false;
      const cancel = native("cancel", "compensation") as Extract<ClinikoAttendanceRequest, { kind: "cancel" }>;
      replacement = "uncertain";
      const sent = await this.#writer.executeOnce(cancel, stop, async last => {
        if (!await permission("compensateReplacement", last)) return false;
        if (request.pass) return grouped("compensation", last, async (proof, inner, passes) => {
          const current = await this.#observe(request, inner, proof);
          return !!current && sourceActive(current.source) && replacementActive(current.destination) &&
            await passes.unchanged(request.pass!, request, "compensation", inner) && await unlinked("compensateReplacement", inner, proof) && await permission("compensateReplacement", inner);
        });
        const current = await this.#observe(request, last);
        return !!current && sourceActive(current.source) && replacementActive(current.destination) && await permission("compensateReplacement", last);
      });
      if (!sent.ok) { replacement = "inspectedActive"; return false; }
      if (sent.value.kind !== "accepted") return false;
      return true;
    };
    const inspectCompensation = async (stop: AbortSignal): Promise<ClinikoClassMoveOutcome> => {
      if (!replacementAttendeeRef) return outcome();
      const cancel = native("cancel", "compensation") as Extract<ClinikoAttendanceRequest, { kind: "cancel" }>;
      if (request.pass) {
        const inspected = await grouped("compensation", stop, async (proof, last, passes) => {
          const exact = await this.#writer.inspect(cancel, replacementAttendeeRef!, last, next => allowed("inspectCompensation", next, proof));
          if (!exact.ok || !exact.value) return false;
          const after = await this.#observe(request, last, proof);
          if (!after || !sourceActive(after.source) || after.destination.attendance.kind !== "none" || !await permission("inspectCompensation", last)) return false;
          const nil = await this.#writer.inspectUnlinked(cancel, replacementAttendeeRef!, last, next => allowed("inspectCompensation", next, proof), classMoveLegActionId(request.actionId, "replacement"));
          return nil.ok && nil.value && await passes.unchanged(request.pass!, request, "compensation", last);
        });
        if (!inspected) return outcome();
        replacement = "inspectedCancelled"; return outcome("restored");
      }
      const exact = await this.#writer.inspect(cancel, replacementAttendeeRef, stop, last => allowed("inspectCompensation", last));
      if (!exact.ok || !exact.value || !await allowed("inspectCompensation", stop)) return outcome();
      const after = await this.#observe(request, stop);
      if (!after || !sourceActive(after.source) || after.destination.attendance.kind !== "none" || !await permission("inspectCompensation", stop)) return outcome();
      replacement = "inspectedCancelled";
      return outcome("restored");
    };
    const compensate = async (stop: AbortSignal) => await cancelCompensation(stop) ? inspectCompensation(stop) : outcome();
    const bookReplacement = async (stop: AbortSignal, inspectStaging = false): Promise<boolean> => {
      const book = native("book", "replacement") as Extract<ClinikoAttendanceRequest, { kind: "book" }>;
      replacement = "uncertain";
      if (request.pass) caseAssociation = "uncertain";
      const booked = await this.#writer.executeOnce(book, stop, async last => await permission("bookReplacement", last) && await initial(last) && await permission("bookReplacement", last));
      if (!booked.ok) { replacement = "notSent"; if (request.pass) caseAssociation = "notSent"; return false; }
      if (booked.value.kind !== "accepted") return false;
      replacementAttendeeRef = booked.value.attendeeRef;
      if (!request.pass) {
        const exact = await this.#writer.inspect(book, replacementAttendeeRef, stop, last => allowed("inspectReplacement", last));
        if (!exact.ok || !exact.value) return false;
        replacement = "inspectedActive";
      }
      if (request.pass && inspectStaging) {
        const inspected = await grouped("inspection", stop, async (proof, last) =>
          await unlinked("inspectStaging", last, proof) && await permission("inspectReplacement", last));
        if (!inspected) return false;
        replacement = "inspectedActive"; caseAssociation = "unlinked";
      }
      return true;
    };
    const cancelOriginal = async (stop: AbortSignal, inspectStaging = false): Promise<"continue" | "compensate" | "stop"> => {
      const cancel = native("cancel", "original");
      original = "uncertain";
      const cancelled = await this.#writer.executeOnce(cancel, stop, async last => {
        if (request.pass) {
          const checked = await observation("commit", last, async (proof, inner, passes) => {
            // The two exact native is-null observations also prove the
            // active record, patient, booking and creation marker. Keep
            // staging and current class/case reads in one private group,
            // after this write's budget claim and before any cancellation.
            if (!await permission("inspectReplacement", inner) || !await unlinked("inspectStaging", inner, proof)) return undefined;
            const current = await this.#observe(request, inner, proof);
            return { canCancel: !!current && sourceActive(current.source) && replacementActive(current.destination) && !current.destination.overCapacity &&
              await passes.unchanged(request.pass!, request, "commit", inner) };
          });
          if (!checked) return false;
          replacement = "inspectedActive"; caseAssociation = "unlinked";
          return checked.canCancel && await permission("cancelOriginal", last);
        }
        if (!await permission("cancelOriginal", last)) return false;
        const current = await this.#observe(request, last);
        if (!current || !sourceActive(current.source) || !replacementActive(current.destination) || current.destination.overCapacity) return false;
        return permission("cancelOriginal", last);
      });
      if (!cancelled.ok) { original = "notSent"; return replacement === "inspectedActive" ? "compensate" : "stop"; }
      if (cancelled.value.kind !== "accepted") return "stop";
      if (!request.pass) {
        const inspected = await this.#writer.inspect(cancel, `cliniko:attendee:${request.source.attendeeId}`, stop, last => allowed("inspectOriginal", last));
        if (!inspected.ok || !inspected.value) return "stop";
        original = "inspectedCancelled";
      }
      if (request.pass && inspectStaging) {
        const inspected = await this.#writer.inspect(cancel, `cliniko:attendee:${request.source.attendeeId}`, stop, last => allowed("inspectOriginal", last));
        if (!inspected.ok || !inspected.value) return "stop";
        original = "inspectedCancelled";
      }
      return "continue";
    };
    const associateAndInspect = async (stop: AbortSignal): Promise<ClinikoClassMoveOutcome> => {
      if (!replacementAttendeeRef) return outcome();
      const book = native("book", "replacement") as Extract<ClinikoAttendanceRequest, { kind: "book" }>;
      if (request.pass) {
        const link: ClinikoAttendanceRequest = { kind: "linkCase", scope: c.scope, patientId: request.patientId, sessionId: request.destination.sessionId,
          attendeeId: replacementAttendeeRef.slice("cliniko:attendee:".length), patientCaseId: request.pass.destination.patientCaseId,
          actionId: classMoveLegActionId(request.actionId, "association"), creationActionId: book.actionId };
        caseAssociation = "uncertain";
        const linked = await this.#writer.executeOnce(link, stop, async last => {
          if (!await permission("linkReplacement", last)) return false;
          // The complete source case below independently proves exact
          // original cancellation. Only destination class capacity needs
          // another full class observation before associating its pass.
          const checked = await grouped("commit", last, async (proof, inner, passes) => {
            if (!await permission("inspectOriginal", inner)) return false;
            const current = await this.#observeDestination(request, inner, proof);
            return !!current && replacementActive(current) && !current.overCapacity && await unlinked("inspectStaging", inner, proof) &&
              await passes.afterCancellation(request.pass!, request, inner) && await permission("linkReplacement", inner);
          });
          if (checked) original = "inspectedCancelled";
          return checked;
        });
        if (!linked.ok) { caseAssociation = "unlinked"; return outcome(); }
        if (linked.value.kind !== "accepted") return outcome();
      }
      if (!await permission("final", stop)) return outcome();
      if (request.pass) {
        // The complete final case inspection proves the exact original's
        // cancelled state and old booking, as well as all other source
        // associations. A second source-class roster read adds no evidence
        // for that selected record. Destination capacity is still fresh.
        const checked = await grouped("inspection", stop, async (proof, last, passes) => {
          const link: ClinikoAttendanceRequest = { kind: "linkCase", scope: c.scope, patientId: request.patientId, sessionId: request.destination.sessionId,
            attendeeId: replacementAttendeeRef!.slice("cliniko:attendee:".length), patientCaseId: request.pass!.destination.patientCaseId,
            actionId: classMoveLegActionId(request.actionId, "association"), creationActionId: book.actionId };
          const exact = await this.#writer.inspect(link, replacementAttendeeRef!, last, next => allowed("inspectPass", next, proof));
          if (!exact.ok || !exact.value) return false;
          const destination = await this.#observeDestination(request, last, proof);
          return !!destination && replacementActive(destination) && !destination.overCapacity &&
            await passes.inspectMovement(request.pass!, request, replacementAttendeeRef!.slice("cliniko:attendee:".length), last) && await permission("final", last);
        });
        if (checked) caseAssociation = "inspectedLinked";
        return checked ? outcome("moved") : outcome();
      }
      const final = await this.#observe(request, stop);
      return final && final.source.attendance.kind === "none" && replacementActive(final.destination) && !final.destination.overCapacity && await permission("final", stop) ? outcome("moved") : outcome();
    };
    const review: ClinikoReviewRequest = { scope: c.scope, patientId: request.patientId, businessId: c.cliniko.businessId,
      credentialFingerprint: clinikoCredentialFingerprint(c.cliniko.apiKey), policyVersion: c.policyVersion, termsVersion: c.termsVersion, timeZone: c.timeZone, createdAt: c.clock(),
      operation: { kind: "classMove", sessionId: request.source.sessionId, attendeeId: request.source.attendeeId, startsAt: request.source.startsAt, endsAt: request.source.endsAt,
        practitionerId: c.source.practitionerId, appointmentTypeId: c.source.appointmentTypeId, newSessionId: request.destination.sessionId, newStartsAt: request.destination.startsAt,
        newEndsAt: request.destination.endsAt, ...(c.source.practitionerId !== c.destination.practitionerId ? { newPractitionerId: c.destination.practitionerId } : {}),
        ...(c.source.appointmentTypeId !== c.destination.appointmentTypeId ? { newAppointmentTypeId: c.destination.appointmentTypeId } : {}),
        attendanceActionId: request.actionId, cancellationReason: request.cancellationReason, compensation: request.compensation, ...(request.pass ? { pass: request.pass } : {}), ...(staging ? { quotaStaging: c.quotaStaging!.version } : {}) } };
    if (!encodeClinikoReview(request.actionId, review).ok) return err({ kind: "invalidQuery" });
    const reviewed = new ClinikoReviewedSend({ scope: c.scope, businessId: c.cliniko.businessId, credentialFingerprint: review.credentialFingerprint,
      policyVersion: c.policyVersion, timeZone: c.timeZone, recallTypeId: c.recallTypeId, writer: this.#recalls, clock: () => Date.parse(c.clock()) });
    try {
      let prepared = false;
      let activeReview = review;
      const start = (stop: AbortSignal) => {
        activeReview = staging ? { ...review, createdAt: c.clock() } : review;
        return reviewed.run(activeReview, {
        authorize: async (_request, stop) => {
          // No clinical/provider read occurs in the send callback before its
          // own actual-proof group. After the private journal, recheck owned
          // review/effect permission here; the next protected operation still
          // verifies native contact before and after its complete observations.
          if (prepared) return request.pass ? await permission("review", stop) && await this.#passes!.authorized(request.pass, request, "commit", stop) : allowed("review", stop);
          if (!await permission("review", stop)) return false;
          // A pass review journals the caller-confirmed proposal, not a claim
          // of current native capacity. Its ownership/proof and independent
          // financial authority are fresh here; the complete class and case
          // state is rechecked after review and the final budget claim, before
          // any attendance write. Legacy movement keeps its existing contract.
          prepared = request.pass ? await allowed("review", stop) && await this.#passes!.authorized(request.pass, request, "commit", stop) : await initial(stop);
          return prepared && await permission("review", stop);
        },
        send: async (_request, stop) => {
          if (!await bookReplacement(stop, !!staging)) return outcome();
          if (staging) return outcome();
          const cancellation = await cancelOriginal(stop);
          if (cancellation === "compensate") return compensate(stop);
          return cancellation === "continue" ? associateAndInspect(stop) : outcome();
        },
      }, stop);
      };
      if (staging) {
        const made = ClinikoRecallReader.create({ ...c.cliniko, scope: c.scope }, c.fetchPort, c.clock);
        if (!made.ok) return err({ kind: "invalidConfig" });
        let boundReview: ClinikoReviewRecord | undefined;
        const currentReview = async (stop: AbortSignal, bind = false) => {
          if (!recallRef || !await allowed("review", stop)) return false;
          const read = await made.value.readReview(c.scope, recallRef, c.recallTypeId, stop);
          if (!read.ok || read.value.recalled || !isDeepStrictEqual(read.value.envelope.request, activeReview) ||
              !bind && (!boundReview || !isDeepStrictEqual(read.value, boundReview))) return false;
          if (bind) boundReview = structuredClone(read.value);
          return allowed("review", stop);
        };
        const refreshProof = () => { request = Object.freeze({ ...request, verificationRef: staging.verificationRef, expiresAt: staging.expiresAt }); };
        const segment = <T>(name: Parameters<typeof staging.segment>[0], task: (stop: AbortSignal) => Promise<T>) => staging.segment(name, async stop => {
          refreshProof();
          if (!await currentReview(stop)) return undefined;
          const value = await task(stop);
          return await currentReview(stop) ? value : undefined;
        }, outcome);
        const first = await staging.segment("replacement", async stop => {
          refreshProof();
          const result = await start(stop);
          if (!result.ok) return result;
          recallRef = result.value.recallRef;
          return await currentReview(stop, true) ? result : err({ kind: "mutationUncertain" as const });
        }, outcome);
        if (!first) return ok(outcome());
        if (!first.ok) return ok({ ...outcome(), ...(first.error.kind === "reviewUncertain" ? { review: "uncertain" as const } : {}) });
        recallRef = first.value.recallRef;
        if (outcome().replacement !== "inspectedActive") return ok(outcome());
        const cancelled = await segment("original", stop => cancelOriginal(stop, true));
        if (cancelled === "compensate") {
          const compensated = await segment("compensation", cancelCompensation);
          if (!compensated) return ok(outcome());
          return ok(await segment("compensationInspection", inspectCompensation) ?? outcome());
        }
        if (cancelled !== "continue") return ok(outcome());
        return ok(await segment("association", associateAndInspect) ?? outcome());
      }
      const result = await start(signal);
      return ok(result.ok ? { ...result.value.outcome, recallRef: result.value.recallRef } : { ...outcome(), ...(result.error.kind === "reviewUncertain" ? { review: "uncertain" as const } : {}) });
    } catch { return ok(outcome()); }
    finally { reviewed.close(); }
  }
}
