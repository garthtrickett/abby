import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ClinikoClassAttendanceReader } from "../cliniko/class-attendance-read.ts";
import type { ClinikoClassSession } from "../cliniko/class-attendance-read.ts";
import { ClinikoClassAttendanceWriter } from "../cliniko/class-attendance-write.ts";
import type { ClinikoAttendanceConfig, ClinikoAttendanceRequest } from "../cliniko/class-attendance-write.ts";
import { ClinikoRecallWriter } from "../cliniko/recall-write.ts";
import type { ClinikoReviewRequest } from "../cliniko/review-request.ts";
import { checkClinikoHeadroom, clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { digestActionRequest } from "../core/digest.ts";
import type { AppointmentChangeEvidenceHost, AppointmentChangeEvidenceQuery, AppointmentHost, BookingEvidenceHost, BookingMenuQuery, HostEffects, HostReadFailure, PolicyStore } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { ActionRequest, AppointmentRead, AppointmentReadFailure, CallState, HostMutation, HostWriteReceipt, LocationScope, ReconcileObservation, Result, StaffItem, StaffTaskObservation, StaffTaskReceipt } from "../core/model.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import { ClinikoReviewedSend } from "./cliniko-reviewed-send.ts";
import { OwnerFileClassPolicy } from "./owner-file-class-policy.ts";
import type { ClassApproval } from "./owner-file-class-policy.ts";
import { ClinikoClassPassCancellation } from "./cliniko-class-pass-cancellation.ts";
import type { ClassPassCancellationAuthority, ClassPassCancellationBinding } from "./cliniko-class-pass-cancellation.ts";
import { OwnerFileCancellationPolicy } from "./owner-file-cancellation-policy.ts";
import { approvalInstant, approvalRef } from "./owner-file-clinic-approval.ts";
import { NoStoredKnowledge } from "./no-stored-knowledge.ts";
import { preparationMayBeDiscarded } from "./prepared-proposal.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { administrativeMemoActionRef } from "../cliniko/administrative-memo.ts";
import type { AdministrativeMemo } from "../cliniko/administrative-memo.ts";
import { captureAdministrativeMemoConfig, retainAdministrativeMemo } from "./administrative-memo-retention.ts";
import type { ClinikoAdministrativeMemoConfig } from "./administrative-memo-retention.ts";
export type ClassCancellationPermission = Readonly<{
  allows(query: Readonly<{
    operation: "cancel";
    scope: LocationScope;
    callId: string;
    sessionId: string;
    policyVersion: string;
    patientId: string;
    classSessionId: string;
    attendeeId: string;
    phase: "proposal" | "commit" | "inspection";
    termsVersion: string;
    signal: AbortSignal;
  }>): Promise<boolean>;
}>;
export type ClinikoClassCancellationConfig = Readonly<{
  scope: LocationScope;
  callId: string;
  sessionId: string;
  policyVersion: string;
  ledger: LedgerStore;
  policies: PolicyStore;
  verification: CallerVerificationSession;
  classPolicy: OwnerFileClassPolicy;
  cancellationPolicy: OwnerFileCancellationPolicy;
  permission: ClassCancellationPermission;
  classPassCancellationAuthority?: ClassPassCancellationAuthority;
  memo?: ClinikoAdministrativeMemoConfig;
  cliniko: Omit<ClinikoAttendanceConfig, "scope">;
  clock: () => string;
  signal: AbortSignal;
  fetchPort?: typeof fetch;
}>;
type Cancellation = Extract<ActionRequest, {
  kind: "cancel";
}>;
type Target = Readonly<{
  alias: string;
  session: ClinikoClassSession;
  attendeeId: string;
  patientRef: string;
  verificationRef: string;
  from: string;
  to: string;
  expiresAt: string;
  pass?: ClassPassCancellationBinding;
}>;
type Prepared = Readonly<{
  target: Target;
  request: Cancellation;
  provider: Extract<ClinikoAttendanceRequest, {
    kind: "cancel";
  }>;
  revision: number;
}>;
const denied = <T>(): Result<T, HostReadFailure> => err({ kind: "unavailable", target: "appointment" });
const readDenied = <T>(): Result<T, AppointmentReadFailure> => err({ kind: "unavailable" });
/** One exact attendance cancellation under SAM. Native class IDs and other
 * patients stay private; neither this host nor review notes confer refund authority. */
export class ClinikoClassCancellationHost extends NoStoredKnowledge implements AppointmentHost, AppointmentChangeEvidenceHost, BookingEvidenceHost, HostEffects {
  readonly effectDeadlineMs = 30000;
  readonly #config: ClinikoClassCancellationConfig;
  readonly #reader: ClinikoClassAttendanceReader;
  readonly #writer: ClinikoClassAttendanceWriter;
  readonly #review: ClinikoReviewedSend;
  readonly #passes?: ClinikoClassPassCancellation;
  readonly #lifetime = new AbortController();
  readonly #targets = new Map<string, Target>();
  #menu: {
    snapshot: AppointmentRead;
    from: string;
    to: string;
  } | undefined;
  #prepared: Prepared | undefined;
  #attempted = false;
  #busy = false;
  #epoch = 0;
  #memoDispatch: Readonly<{ prepared: Prepared; digest: string; direction: "inbound" | "outbound" }> | undefined;
  #memoInspection: Readonly<{ prepared: Prepared; at: string }> | undefined;
  readonly #onClose = () => this.dispose();
  private constructor(config: ClinikoClassCancellationConfig, approval: ClassApproval) {
    super();
    this.#config = config;
    const port = config.fetchPort ?? fetch;
    const reader = ClinikoClassAttendanceReader.create({ ...config.cliniko, scope: config.scope, className: approval.className }, { verifyPatient: (scope, ref, now, signal) => config.verification.proof.verifyOperation(scope, ref, "appointments.cancel", now, signal) }, port, config.clock);
    const writer = ClinikoClassAttendanceWriter.create({ ...config.cliniko, scope: config.scope }, port);
    const recalls = ClinikoRecallWriter.create({ ...config.cliniko, scope: config.scope }, port);
    if (!reader.ok || !writer.ok || !recalls.ok)
      throw new TypeError("invalid class cancellation providers");
    this.#reader = reader.value;
    this.#writer = writer.value;
    if (approval.membership === "nativeCaseSessions") this.#passes = new ClinikoClassPassCancellation({ ...config, policy: config.classPolicy,
      authority: config.classPassCancellationAuthority!, fetchPort: port,
      proof: { verifyPatient: (scope, ref, now, signal) => config.verification.proof.verifyOperation(scope, ref, "appointments.cancel", now, signal) } });
    this.#review = new ClinikoReviewedSend({ scope: config.scope, businessId: config.cliniko.businessId, credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey),
      policyVersion: config.policyVersion, timeZone: approval.timeZone, recallTypeId: approval.recallTypeId, writer: recalls.value, clock: () => Date.parse(config.clock()) });
    config.signal.addEventListener("abort", this.#onClose, { once: true });
  }
  static async create(input: ClinikoClassCancellationConfig): Promise<Result<ClinikoClassCancellationHost, HostReadFailure>> {
    try {
      if (!(input.signal instanceof AbortSignal) || input.signal.aborted || !(input.verification instanceof CallerVerificationSession) ||
        !(input.classPolicy instanceof OwnerFileClassPolicy) || !(input.cancellationPolicy instanceof OwnerFileCancellationPolicy) ||
        !input.verification.proof.matchesCall(input.scope, input.callId, input.sessionId, input.policyVersion) || ![input.callId, input.sessionId, input.policyVersion].every(approvalRef) ||
        !input.verification.matchesClinikoAccount(clinikoCredentialFingerprint(input.cliniko.apiKey)) ||
        typeof input.permission?.allows !== "function" || typeof input.clock !== "function" || typeof input.ledger?.read !== "function" || typeof input.ledger?.readWriteStop !== "function" || typeof input.policies?.read !== "function")
        return denied();
      const config = Object.freeze({ ...input, scope: Object.freeze({ ...input.scope }), cliniko: Object.freeze({ ...input.cliniko }),
        ...(input.memo ? { memo: captureAdministrativeMemoConfig(input.memo, { scope: input.scope, businessId: input.cliniko.businessId,
          credentialFingerprint: clinikoCredentialFingerprint(input.cliniko.apiKey), rateBudget: input.cliniko.rateBudget, clock: input.clock }) } : {}) });
      const signal = AbortSignal.any([config.signal, AbortSignal.timeout(15000)]);
      const [classPolicy, cancel] = await Promise.all([awaitUntilAbort(config.classPolicy.current(config.scope), signal), awaitUntilAbort(config.cancellationPolicy.current(config.scope), signal)]);
      if (!classPolicy?.ok || !cancel?.ok || signal.aborted || classPolicy.value.policyVersion !== config.policyVersion || cancel.value.policyVersion !== config.policyVersion ||
        (classPolicy.value.membership === "nativeCaseSessions" ? !classPolicy.value.caseSessions?.cancellation || typeof config.classPassCancellationAuthority?.select !== "function" : config.classPassCancellationAuthority !== undefined) ||
        classPolicy.value.credentialFingerprint !== clinikoCredentialFingerprint(config.cliniko.apiKey) || cancel.value.credentialFingerprint !== classPolicy.value.credentialFingerprint ||
        cancel.value.businessId !== classPolicy.value.businessId || cancel.value.recallTypeId !== classPolicy.value.recallTypeId || cancel.value.timeZone !== classPolicy.value.timeZone ||
        (["businessId", "practitionerId", "appointmentTypeId"] as const).some(key => config.cliniko[key] !== classPolicy.value[key]))
        return denied();
      return ok(new ClinikoClassCancellationHost(config, classPolicy.value));
    }
    catch {
      return denied();
    }
  }
  #now() { return this.#config.clock(); }
  #signal(external?: AbortSignal, ms = 15000) { return AbortSignal.any([this.#lifetime.signal, this.#config.signal, AbortSignal.timeout(ms), ...(external ? [external] : [])]); }
  #time(now: string): number | undefined {
    try {
      const actual = approvalInstant(this.#now()), supplied = approvalInstant(now);
      return actual !== undefined && supplied !== undefined && Math.abs(actual - supplied) <= 30000 ? actual : undefined;
    }
    catch {
      return undefined;
    }
  }
  async #ready(now: string, signal: AbortSignal, mutation?: HostMutation): Promise<CallState | undefined> {
    const c = this.#config, at = this.#time(now);
    if (at === undefined || signal.aborted || this.#lifetime.signal.aborted)
      return undefined;
    const [found, current, stop] = await Promise.all([awaitUntilAbort(c.ledger.read(c.callId, c.scope), signal), awaitUntilAbort(c.policies.read(c.scope), signal), awaitUntilAbort(c.ledger.readWriteStop(c.scope), signal)]);
    if (!found?.ok || !current?.ok || !stop?.ok || stop.value.stopped || signal.aborted)
      return undefined;
    const state = found.value, valid = (policy: CallState["policy"]) => sameScope(policy.scope, c.scope) && policy.policyVersion === c.policyVersion && policy.automationEnabled && policy.cancellationEnabled === true && policy.capabilities.cancel === "execute" && policy.staffWorkEnabled === true;
    if (state.lifecycle !== "active" || !state.admission || state.callId !== c.callId || !valid(state.policy) || !valid(current.value) || state.sessionLease?.sessionId !== c.sessionId ||
      approvalInstant(state.sessionLease.expiresAt) === undefined || Date.parse(state.sessionLease.expiresAt) <= at)
      return undefined;
    if (mutation) {
      const action = state.actions[mutation.actionKey], effect = state.effects[`${mutation.actionKey}:write`];
      if (action?.kind !== "cancel" || action.status !== "dispatched" || action.digest !== mutation.payloadDigest || digestActionRequest(action.mutation.request) !== mutation.payloadDigest ||
        state.presentations[action.presentationId]?.status !== "played" || effect?.kind !== "hostWrite" || effect.status !== "possiblySent" || effect.mutation.actionKey !== mutation.actionKey || effect.mutation.payloadDigest !== mutation.payloadDigest)
        return undefined;
    }
    return state;
  }
  #terms(target: Target, approval: ClassApproval, raw: Readonly<{ version: string; approvedText: string }>) {
    const baseVersion = `${approval.revision}:${raw.version}`;
    const pass = target.pass ? ClinikoClassPassCancellation.terms(baseVersion, approval, target.pass.effect) : undefined;
    if ((approval.membership === "nativeCaseSessions") !== !!target.pass || !!target.pass !== !!this.#passes || target.pass && !pass) return undefined;
    return { version: pass?.version ?? baseVersion, approvedText: `This cancels only your ${approval.className} attendance with ${approval.practitionerName} at ${approval.locationName}. ${raw.approvedText}${pass ? ` ${pass.approvedText}` : ""}`, expiresAt: target.expiresAt };
  }
  async #fresh(target: Target, phase: "proposal" | "commit" | "inspection", signal: AbortSignal, readNative = true): Promise<Cancellation | undefined> {
    const c = this.#config, now = this.#now(), at = this.#time(now);
    if (at === undefined || Date.parse(target.expiresAt) <= at || !await this.#ready(now, signal))
      return undefined;
    const [classPolicy, cancel, patient] = await Promise.all([c.classPolicy.current(c.scope), c.cancellationPolicy.current(c.scope), c.verification.proof.verifyOperation(c.scope, target.verificationRef, "appointments.cancel", now, signal)]);
    if (!classPolicy.ok || !cancel.ok || !patient.ok || patient.value.patientRef !== target.patientRef || classPolicy.value.timeZone !== cancel.value.timeZone)
      return undefined;
    const raw = OwnerFileCancellationPolicy.termsFor(cancel.value, target.session.startsAt, now);
    if (!raw)
      return undefined;
    const baseVersion = `${classPolicy.value.revision}:${raw.version}`;
    const terms = this.#terms(target, classPolicy.value, raw);
    if (!terms || terms.version.length > 256 || terms.approvedText.length > 500 || Date.parse(terms.expiresAt) > Math.min(Date.parse(classPolicy.value.effectiveUntil), Date.parse(raw.expiresAt), Date.parse(patient.value.expiresAt)))
      return undefined;
    const query = { operation: "cancel" as const, scope: { ...c.scope }, callId: c.callId, sessionId: c.sessionId, policyVersion: c.policyVersion, patientId: patient.value.patientRef,
      classSessionId: target.session.sessionRef, attendeeId: target.attendeeId, phase, termsVersion: terms.version, signal };
    if (await awaitUntilAbort(Promise.resolve().then(() => c.permission.allows(query)), signal) !== true || signal.aborted)
      return undefined;
    if (readNative) {
      const found = await this.#reader.inspect(c.scope, target.verificationRef, target.session.sessionRef, new Date(Math.max(at, Date.parse(target.from))).toISOString(), target.to, now, signal);
      const selected = found.ok ? found.value.sessions[0] : undefined;
      if (!found.ok || !selected || found.value.patientRef !== target.patientRef || found.value.timeZone !== classPolicy.value.timeZone || selected.startsAt !== target.session.startsAt || selected.endsAt !== target.session.endsAt ||
        (phase === "inspection" ? selected.attendance.kind !== "none" : selected.attendance.kind !== "one" || selected.attendance.attendeeRef !== target.attendeeId))
        return undefined;
    }
    if (target.pass && this.#passes && !(phase === "inspection"
      ? await this.#passes.authorized(target.pass, patient.value, target.session, target.attendeeId, classPolicy.value, baseVersion, phase, signal)
      : await this.#passes.unchanged(target.pass, patient.value, target.session, target.attendeeId, classPolicy.value, baseVersion, phase, now, signal))) return undefined;
    const [currentClass, currentCancel, currentPatient] = await Promise.all([c.classPolicy.current(c.scope), c.cancellationPolicy.current(c.scope), c.verification.proof.verifyOperation(c.scope, target.verificationRef, "appointments.cancel", this.#now(), signal)]);
    if (!currentClass.ok || !currentCancel.ok || !currentPatient.ok || currentPatient.value.patientRef !== target.patientRef || !isDeepStrictEqual(currentClass.value, classPolicy.value) ||
      !isDeepStrictEqual(currentCancel.value, cancel.value) || !await this.#ready(this.#now(), signal) || await awaitUntilAbort(Promise.resolve().then(() => c.permission.allows(query)), signal) !== true || signal.aborted)
      return undefined;
    return { kind: "cancel", patient: currentPatient.value, target: { scope: { ...c.scope }, appointmentRef: target.alias, patientRef: target.patientRef, startsAt: target.session.startsAt, endsAt: target.session.endsAt, timeZone: classPolicy.value.timeZone }, terms };
  }
  async list(scope: LocationScope, verificationRef: string, from: string, to: string, now: string): Promise<Result<AppointmentRead, AppointmentReadFailure>> {
    if (!sameScope(scope, this.#config.scope) || this.#busy || this.#attempted)
      return readDenied();
    const epoch = ++this.#epoch;
    this.#busy = true;
    this.#menu = undefined;
    this.#targets.clear();
    const signal = this.#signal();
    try {
      if (!await this.#ready(now, signal))
        return readDenied();
      const [classPolicy, cancel] = await Promise.all([this.#config.classPolicy.current(scope), this.#config.cancellationPolicy.current(scope)]);
      if (!classPolicy.ok || !cancel.ok)
        return readDenied();
      const found = await this.#reader.list(scope, verificationRef, from, to, now, signal);
      if (!found.ok || found.value.timeZone !== classPolicy.value.timeZone || found.value.sessions.some(row => row.attendance.kind === "ambiguous"))
        return readDenied();
      const expiry = new Date(Math.min(Date.parse(now) + classPolicy.value.offerTtlSeconds * 1000, Date.parse(found.value.proofExpiresAt), Date.parse(classPolicy.value.effectiveUntil), Date.parse(cancel.value.effectiveUntil))).toISOString();
      const targets: Target[] = [];
      for (const session of found.value.sessions) {
        if (session.attendance.kind !== "one")
          continue;
        if (Date.parse(session.startsAt) <= Date.parse(from) || Date.parse(session.endsAt) - Date.parse(session.startsAt) !== classPolicy.value.durationMinutes * 60000 || !OwnerFileCancellationPolicy.termsFor(cancel.value, session.startsAt, now))
          return readDenied();
        const rawTerms = OwnerFileCancellationPolicy.termsFor(cancel.value, session.startsAt, now)!;
        const pass = this.#passes ? await this.#passes.select({ scope, patientRef: found.value.patientRef, verificationRef, expiresAt: found.value.proofExpiresAt },
          session, session.attendance.attendeeRef, classPolicy.value, `${classPolicy.value.revision}:${rawTerms.version}`, now, signal) : undefined;
        if (this.#passes && !pass) return readDenied();
        const passTerms = pass ? ClinikoClassPassCancellation.terms(`${classPolicy.value.revision}:${rawTerms.version}`, classPolicy.value, pass.effect) : undefined;
        const permit = await awaitUntilAbort(Promise.resolve().then(() => this.#config.permission.allows({ operation: "cancel", scope: { ...scope },
          callId: this.#config.callId, sessionId: this.#config.sessionId, policyVersion: this.#config.policyVersion, patientId: found.value.patientRef,
          classSessionId: session.sessionRef, attendeeId: session.attendance.kind === "one" ? session.attendance.attendeeRef : "", phase: "proposal", termsVersion: passTerms?.version ?? `${classPolicy.value.revision}:${rawTerms.version}`, signal })), signal);
        if (permit !== true || signal.aborted)
          return readDenied();
        targets.push({ alias: `class-target:${randomUUID()}`, session: structuredClone(session), attendeeId: session.attendance.attendeeRef, patientRef: found.value.patientRef, verificationRef, from, to, expiresAt: expiry,
          ...(pass ? { pass: structuredClone(pass) } : {}) });
      }
      const current = await this.#config.classPolicy.current(scope), currentCancel = await this.#config.cancellationPolicy.current(scope);
      const patient = await this.#config.verification.proof.verifyOperation(scope, verificationRef, "appointments.cancel", this.#now(), signal);
      if (!patient.ok || patient.value.patientRef !== found.value.patientRef || !current.ok || !currentCancel.ok || !isDeepStrictEqual(current.value, classPolicy.value) || !isDeepStrictEqual(currentCancel.value, cancel.value) || !await this.#ready(now, signal) || epoch !== this.#epoch)
        return readDenied();
      for (const target of targets)
        this.#targets.set(target.alias, target);
      if (targets.length === 1)
        this.#targets.set("selected", targets[0]!);
      const snapshot: AppointmentRead = { scope: { ...scope }, sourceRef: `cliniko:class-attendance:${classPolicy.value.businessId}:${classPolicy.value.appointmentTypeId}`, observedAt: found.value.observedAt, timeZone: found.value.timeZone,
        patientRef: found.value.patientRef, verificationRef, proofExpiresAt: found.value.proofExpiresAt, appointments: targets.map(target => ({ appointmentRef: target.alias, startsAt: target.session.startsAt, endsAt: target.session.endsAt })) };
      this.#menu = { snapshot: structuredClone(snapshot), from, to };
      return ok(snapshot);
    }
    catch {
      return readDenied();
    }
    finally {
      this.#busy = false;
    }
  }
  async select(scope: LocationScope, ref: string, choice: 1 | 2 | 3, now: string, external?: AbortSignal): Promise<Result<{
    snapshot: AppointmentRead;
    from: string;
    to: string;
  }, AppointmentReadFailure>> {
    const menu = this.#menu;
    this.#menu = undefined;
    const epoch = ++this.#epoch;
    if (!menu || !sameScope(scope, this.#config.scope) || menu.snapshot.verificationRef !== ref || ![1, 2, 3].includes(choice) || this.#attempted || this.#busy || this.#time(now) === undefined)
      return readDenied();
    const selected = menu.snapshot.appointments[choice - 1], target = selected ? this.#targets.get(selected.appointmentRef) : undefined;
    if (!target || !await this.#fresh(target, "proposal", this.#signal(external)) || epoch !== this.#epoch)
      return readDenied();
    this.#targets.set("selected", target);
    return ok({ snapshot: { ...menu.snapshot, observedAt: now, appointments: [selected!] }, from: menu.from, to: menu.to });
  }
  clearSelection(): void { this.#targets.clear(); this.#menu = undefined; this.#prepared = undefined; ++this.#epoch; }
  async resolveBooking(): Promise<Result<Extract<ActionRequest, {
    kind: "book";
  }>, HostReadFailure>> { return denied(); }
  async resolveAppointmentChange(query: AppointmentChangeEvidenceQuery, external?: AbortSignal): Promise<Result<Cancellation, HostReadFailure>> {
    const c = this.#config, target = this.#targets.get(query.targetRef);
    if (query.kind !== "cancel" || !target || query.verificationRef !== target.verificationRef || !sameScope(query.scope, c.scope) || query.callId !== c.callId || query.sessionId !== c.sessionId || query.policyVersion !== c.policyVersion || this.#time(query.now) === undefined || this.#busy || this.#attempted)
      return denied();
    this.#busy = true;
    const signal = this.#signal(external);
    try {
      const state = await this.#ready(query.now, signal);
      if (!state || this.#prepared && !preparationMayBeDiscarded(state, this.#prepared.request, this.#prepared.revision))
        return denied();
      this.#prepared = undefined;
      const request = await this.#fresh(target, "proposal", signal), again = await this.#ready(query.now, signal);
      if (!request || !again || again.conversationRevision !== state.conversationRevision)
        return denied();
      const cancel = await c.cancellationPolicy.current(c.scope);
      if (!cancel.ok)
        return denied();
      const provider: Extract<ClinikoAttendanceRequest, {
        kind: "cancel";
      }> = { kind: "cancel", scope: c.scope, patientId: target.patientRef, sessionId: target.session.sessionRef, attendeeId: target.attendeeId, actionId: randomUUID(), cancellationReason: cancel.value.cancellationReason };
      this.#prepared = { target: structuredClone(target), request: structuredClone(request), provider, revision: state.conversationRevision };
      return ok(request);
    }
    catch {
      return denied();
    }
    finally {
      this.#busy = false;
    }
  }
  async #authorize(prepared: Prepared, mutation: HostMutation, phase: "commit" | "inspection", signal: AbortSignal, readNative = true): Promise<boolean> {
    if (!await this.#ready(this.#now(), signal, mutation))
      return false;
    const current = await this.#fresh(prepared.target, phase, signal, readNative), cancel = await this.#config.cancellationPolicy.current(this.#config.scope);
    if (!current || !cancel.ok || cancel.value.cancellationReason !== prepared.provider.cancellationReason || digestActionRequest(current) !== mutation.payloadDigest ||
        mutation.payloadDigest !== digestActionRequest(prepared.request)) return false;
    const at = this.#now(), state = await this.#ready(at, signal, mutation); if (!state) return false;
    if (this.#config.memo) {
      try {
        if (phase === "commit") this.#memoDispatch = Object.freeze({ prepared, digest: mutation.payloadDigest,
          direction: state.admission?.direction === "outbound" ? "outbound" : "inbound" });
        else this.#memoInspection = Object.freeze({ prepared, at });
      } catch { /* Optional metadata cannot change an existing authorization. */ }
    }
    return true;
  }
  async checkConfirmationCapacity(query: BookingMenuQuery & Readonly<{ actionKey: string; digest: string }>): Promise<Result<Readonly<{ kind: "ready" }> | Readonly<{ kind: "wait"; seconds: number }>, HostReadFailure>> {
    if (!this.#passes) return ok({ kind: "ready" });
    const p = this.#prepared, c = this.#config;
    if (!p?.target.pass || this.#busy || this.#attempted || !sameScope(query.scope, c.scope) || query.callId !== c.callId || query.sessionId !== c.sessionId ||
      query.policyVersion !== c.policyVersion || this.#time(query.now) === undefined || digestActionRequest(p.request) !== query.digest) return denied();
    const signal = this.#signal(query.signal);
    // Non-disclosing guidance. All protected native checks still run at send.
    const current = async () => {
      const state = await this.#ready(this.#now(), signal), a = await c.classPolicy.current(c.scope), fee = await c.cancellationPolicy.current(c.scope);
      const grant = await c.verification.ownedGrant("appointments.cancel", signal), action = state?.actions[query.actionKey];
      const raw = fee.ok ? OwnerFileCancellationPolicy.termsFor(fee.value, p.target.session.startsAt, this.#now()) : undefined;
      if (!state || !a.ok || !grant || grant.verificationRef !== p.target.verificationRef || !raw || action?.status !== "awaitingConfirmation" || action.digest !== query.digest ||
        state.presentations[action.presentationId]?.status !== "played" || this.#prepared !== p || Date.parse(p.target.expiresAt) <= Date.parse(this.#now()) ||
        !isDeepStrictEqual(this.#terms(p.target, a.value, raw), p.request.terms) ||
        await awaitUntilAbort(c.permission.allows({ operation: "cancel", scope: c.scope, callId: c.callId, sessionId: c.sessionId, policyVersion: c.policyVersion,
          patientId: p.target.patientRef, classSessionId: p.target.session.sessionRef, attendeeId: p.target.attendeeId, phase: "commit", termsVersion: p.request.terms.version, signal }), signal) !== true ||
        !await this.#passes!.authorized(p.target.pass!, p.request.patient, p.target.session, p.target.attendeeId, a.value, `${a.value.revision}:${raw.version}`, "commit", signal)) return undefined;
      return state;
    };
    const before = await current(); if (!before) return denied();
    const capacity = await checkClinikoHeadroom(c.cliniko.rateBudget, 180), after = await current();
    if (!after || before.conversationRevision !== after.conversationRevision || signal.aborted || this.#prepared !== p) return denied();
    if (capacity === null) return ok({ kind: "ready" });
    if (capacity.kind !== "rateLimited" || !Number.isSafeInteger(capacity.retryAfterMs) || capacity.retryAfterMs! < 1 || capacity.retryAfterMs! > 60000) return denied();
    const seconds = Math.ceil(capacity.retryAfterMs! / 1000);
    if (Date.parse(p.target.expiresAt) <= Date.parse(this.#now()) + (seconds + 3) * 1000) return err({ kind: "expired", target: "offer" });
    return ok({ kind: "wait", seconds });
  }
  #captureMemo(prepared: Prepared, result: unknown): AdministrativeMemo | undefined {
    const c = this.#config, dispatch = this.#memoDispatch, inspected = this.#memoInspection;
    if (!c.memo) return;
    try {
      const reviewed = this.#review.changeSource(result), value = result as { outcome?: { ok?: unknown; value?: unknown } };
      const native = value.outcome?.ok === true ? this.#writer.cancellationAcknowledgement(value.outcome.value) : undefined;
      if (!reviewed || reviewed.request.operation.kind !== "classCancel" || !native || dispatch?.prepared !== prepared || inspected?.prepared !== prepared ||
          dispatch.digest !== digestActionRequest(prepared.request) || !isDeepStrictEqual(native.request, prepared.provider)) return;
      const r = reviewed.request, op = r.operation, p = prepared.provider, selection = native.selection;
      if (op.kind !== "classCancel" || !sameScope(r.scope, c.scope) || !sameScope(selection.scope, c.scope) || r.patientId !== p.patientId || p.patientId !== prepared.target.patientRef ||
          r.businessId !== c.cliniko.businessId || selection.businessId !== r.businessId || selection.practitionerId !== c.cliniko.practitionerId ||
          selection.appointmentTypeId !== c.cliniko.appointmentTypeId || r.credentialFingerprint !== clinikoCredentialFingerprint(c.cliniko.apiKey) ||
          selection.credentialFingerprint !== r.credentialFingerprint || r.policyVersion !== c.policyVersion || r.termsVersion !== prepared.request.terms.version ||
          op.sessionId !== p.sessionId || op.attendeeId !== p.attendeeId || op.cancellationReason !== p.cancellationReason ||
          op.practitionerId !== selection.practitionerId || op.appointmentTypeId !== selection.appointmentTypeId ||
          Date.parse(op.startsAt) !== Date.parse(prepared.target.session.startsAt) || Date.parse(op.endsAt) !== Date.parse(prepared.target.session.endsAt)) return;
      const actionRef = administrativeMemoActionRef(reviewed.marker), at = new Date(inspected.at).toISOString();
      if (!actionRef || at < new Date(r.createdAt).toISOString()) return;
      const signed = c.memo.authentication.sign({ actionRef, sourceActionRef: reviewed.marker, scope: c.scope, businessId: r.businessId,
        credentialFingerprint: r.credentialFingerprint, patientId: p.patientId, authorRef: c.memo.native.authorRef, policy: c.memo.native.policy,
        direction: dispatch.direction, outcome: { kind: "classCancellationObserved", appointmentRef: `cliniko:booking:${p.sessionId}`,
          attendeeRef: native.attendeeRef, startsAt: new Date(op.startsAt).toISOString(), endsAt: new Date(op.endsAt).toISOString(),
          verification: { basis: "acknowledgedAndObservedBestEffort", observedAt: at } }, occurredAt: at, recordedAt: c.memo.native.clock!() });
      return signed.ok ? signed.value : undefined;
    } catch { return; /* Optional metadata cannot change the inspected clinical result. */ }
  }
  #retainMemo(prepared: Prepared, result: unknown): void {
    const memo = this.#captureMemo(prepared, result); this.#memoDispatch = undefined; this.#memoInspection = undefined;
    if (this.#config.memo) void retainAdministrativeMemo(this.#config.memo, memo).catch(() => {});
  }
  async write(mutation: HostMutation, now: string, external?: AbortSignal): Promise<HostWriteReceipt> {
    const p = this.#prepared, c = this.#config, reject = (): HostWriteReceipt => ({ kind: "rejected", actionKey: mutation.actionKey, reason: "forbidden" });
    if (!p || this.#busy || this.#attempted || this.#lifetime.signal.aborted || mutation.kind !== "cancel" || mutation.request.kind !== "cancel" || mutation.notification || !sameScope(mutation.scope, c.scope) ||
      mutation.policyVersion !== c.policyVersion || mutation.payloadDigest !== digestActionRequest(p.request) || digestActionRequest(mutation.request) !== mutation.payloadDigest || !approvalRef(mutation.actionKey) || this.#time(now) === undefined)
      return reject();
    this.#attempted = true;
    const signal = this.#signal(external, 30000), uncertain = (): HostWriteReceipt => ({ kind: "uncertain", actionKey: mutation.actionKey, reconcileAfter: now, deadline: new Date(Date.parse(now) + 300000).toISOString() });
    const classPolicy = await c.classPolicy.current(c.scope);
    if (!classPolicy.ok || p.target.pass && await checkClinikoHeadroom(c.cliniko.rateBudget, 180) !== null)
      return reject();
    const review: ClinikoReviewRequest = { scope: c.scope, patientId: p.target.patientRef, businessId: classPolicy.value.businessId, credentialFingerprint: classPolicy.value.credentialFingerprint, policyVersion: c.policyVersion,
      termsVersion: p.request.terms.version, timeZone: classPolicy.value.timeZone, createdAt: now, operation: { kind: "classCancel", sessionId: p.provider.sessionId, attendeeId: p.provider.attendeeId, cancellationReason: p.provider.cancellationReason,
        practitionerId: classPolicy.value.practitionerId, appointmentTypeId: classPolicy.value.appointmentTypeId, startsAt: p.target.session.startsAt, endsAt: p.target.session.endsAt,
        ...(p.target.pass ? { pass: { ...p.target.pass.selection, usageFingerprint: p.target.pass.usageFingerprint, maximum: p.target.pass.maximum, used: p.target.pass.used, effect: p.target.pass.effect } } : {}) } };
    const result = await this.#review.run(review, { authorize: (_request, stop) => this.#authorize(p, mutation, "commit", stop), send: async (_request, stop) => {
        const sent = await this.#writer.executeOnce(p.provider, stop, final => this.#authorize(p, mutation, "commit", final));
        if (!sent.ok || sent.value.kind !== "accepted")
          return sent;
        const inspected = await this.#writer.inspect(p.provider, sent.value.attendeeRef, stop, final => this.#authorize(p, mutation, "inspection", final, false));
        if (!inspected.ok || !inspected.value || !await this.#authorize(p, mutation, "inspection", stop)) return ok({ kind: "uncertain" as const });
        if (p.target.pass && this.#passes) {
          const raw = await c.cancellationPolicy.current(c.scope), patient = p.request.patient;
          const feeTerms = raw.ok ? OwnerFileCancellationPolicy.termsFor(raw.value, p.target.session.startsAt, this.#now()) : undefined;
          if (!feeTerms || !await this.#passes.inspectCancellation(p.target.pass, patient, p.target.session, p.target.attendeeId, classPolicy.value,
            `${classPolicy.value.revision}:${feeTerms.version}`, this.#now(), stop) || !await this.#authorize(p, mutation, "inspection", stop, false)) return ok({ kind: "uncertain" as const });
        }
        return sent;
      } }, signal);
    if (!result.ok)
      return ["reviewUncertain", "mutationUncertain"].includes(result.error.kind) ? uncertain() : reject();
    if (!result.value.outcome.ok)
      return reject();
    if (result.value.outcome.value.kind === "accepted" && !signal.aborted) {
      this.#retainMemo(p, result.value);
      return { kind: "committed", actionKey: mutation.actionKey, hostRef: result.value.outcome.value.attendeeRef };
    }
    return uncertain();
  }
  async reconcile(mutation: HostMutation): Promise<ReconcileObservation> { return { kind: "stillUnknown", actionKey: mutation.actionKey }; }
  async openTask(item: StaffItem): Promise<StaffTaskReceipt> { return { kind: "rejected", taskKey: item.key }; }
  async reconcileTask(item: StaffItem): Promise<StaffTaskObservation> { return { kind: "stillUnknown", taskKey: item.key }; }
  dispose() { this.#config.signal.removeEventListener("abort", this.#onClose); this.#lifetime.abort(); this.#review.close(); this.#targets.clear(); this.#menu = undefined; this.#prepared = undefined;
    this.#memoDispatch = undefined; this.#memoInspection = undefined; ++this.#epoch; }
}
