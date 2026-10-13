import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { patientDetailChangesDigest, patientDetailsDigest, validPatientDetailChanges } from "../cliniko/patient-details.ts";
import type { PatientDetailChanges, PatientDetailsSnapshot } from "../cliniko/patient-details.ts";
import { ClinikoPatientUpdateEdge } from "../cliniko/patient-update.ts";
import type { PatientUpdateAttestation, PatientUpdateQuery, PatientUpdateRequest } from "../cliniko/patient-update.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import { digestActionRequest } from "../core/digest.ts";
import type { HostReadFailure, PatientCorrectionEvidenceHost, PatientCorrectionEvidenceQuery, PolicyStore } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { AdmissionReceipt, HostMutation, HostWriteReceipt, ReconcileObservation, Result, StaffItem, StaffTaskObservation, StaffTaskReceipt, VerifiedPatient } from "../core/model.ts";
import type { PatientCorrectionAction } from "../core/patient-correction.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { callIdFor } from "../voice/admission.ts";
import type { AuthenticatedInboundCall } from "../voice/admission.ts";
import { sameScope, validClinikoId } from "./appointment-change-authority.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import { ClinikoReviewedSend } from "./cliniko-reviewed-send.ts";
import type { PatientCodeDelivery, PatientVerificationBudget, PatientVerificationPermission } from "./email-patient-authority.ts";
import { NoStoredKnowledge } from "./no-stored-knowledge.ts";
import { OwnerFilePatientUpdatePolicy } from "./owner-file-patient-update-policy.ts";
import type { PatientCorrectionPolicyQuery } from "./owner-file-patient-update-policy.ts";
import { ProspectiveEmailCode } from "./prospective-email-code.ts";
import type { ClinikoContactRevisionOwner } from "../cliniko/contact-revision.ts";

type Failure = Readonly<{ kind: "patientCorrectionUnavailable" }>;
type Pending = Readonly<{ ref: string; before: PatientDetailsSnapshot; query: PatientCorrectionPolicyQuery; request: PatientUpdateRequest }>;
export type PatientCorrectionSessionConfig = Readonly<{
  receipt: AdmissionReceipt; inbound: AuthenticatedInboundCall; sessionId: string; policyVersion: string;
  ledger: Pick<LedgerStore, "read" | "readWriteStop">; policies: Pick<PolicyStore, "read">;
  policy: OwnerFilePatientUpdatePolicy; verification: CallerVerificationSession; permission: PatientVerificationPermission;
  verificationBudget: PatientVerificationBudget; delivery: PatientCodeDelivery;
  /** Completion of private playback/display, never enqueue acknowledgment. */
  presentation: Readonly<{ play(text: string, signal: AbortSignal): Promise<boolean> }>;
  reviewedSend: ClinikoReviewedSend;
  /** Same durable account owner used by registered-channel verification and phone scans. */
  contactRevision: ClinikoContactRevisionOwner;
  cliniko: Readonly<{ apiKey: string; contactEmail: string; rateBudget: ClinikoRequestBudget }>;
  signal: AbortSignal; fetchPort?: typeof fetch; clock?: () => string; timeoutMs?: number;
}>;

/** Private correction evidence owner. SAM alone confirms and dispatches writes.
 * Native values, before/change digests and email codes never enter SAM or model turns. */
export class ClinikoPatientCorrectionSession extends NoStoredKnowledge implements PatientCorrectionEvidenceHost {
  readonly effectDeadlineMs = 30_000;
  readonly #config: PatientCorrectionSessionConfig;
  readonly #lifetime = new AbortController();
  readonly #edge: ClinikoPatientUpdateEdge;
  readonly #onClose = () => this.dispose();
  #subject: VerifiedPatient | undefined;
  #terms: Readonly<{ consentRef: string; privacyVersion: string; correctionVersion: string }> | undefined;
  #accepted = false;
  #pending: Pending | undefined;
  #mail: ProspectiveEmailCode | undefined;
  #action: PatientCorrectionAction | undefined;
  #dispatch: HostMutation | undefined;
  #busy = false;
  #collections = 0;
  #attempted = false;
  #claimed = false;
  #contactChange: string | undefined;
  private constructor(incoming: PatientCorrectionSessionConfig) {
    super();
    const config = this.#config = Object.freeze({ ...incoming, receipt: structuredClone(incoming.receipt), inbound: structuredClone(incoming.inbound), cliniko: Object.freeze({ ...incoming.cliniko }) });
    const edge = ClinikoPatientUpdateEdge.create({ ...config.cliniko, scope: config.receipt.scope }, {
      attest: (query, phase, signal) => this.#attest(query, phase, signal),
      claim: async (request, signal) => {
        if (this.#claimed || !this.#matchesRequest(request) || !await this.#currentPending(signal, true) || signal.aborted || this.#claimed) return false;
        const begun = await config.contactRevision.begin();
        if (!begun.ok) return false;
        this.#contactChange = begun.value;
        this.#claimed = true;
        // Consume the old channel grant before a possible contact mutation. It
        // cannot authorize another action or be reused for post-write inspection.
        config.verification.dispose(); return !signal.aborted;
      },
      contactChanged: async (request, _observed, signal) => {
        if (!this.#claimed || !this.#contactChange || !this.#matchesRequest(request) || !await this.#currentPending(signal, true) || signal.aborted) return false;
        const completed = await config.contactRevision.complete(this.#contactChange);
        return completed.ok && !signal.aborted;
      },
    }, config.fetchPort ?? fetch, () => this.#now());
    if (!edge.ok) throw new TypeError("invalid correction provider");
    this.#edge = edge.value;
    config.signal.addEventListener("abort", this.#onClose, { once: true }); if (config.signal.aborted) this.dispose();
  }
  static async create(config: PatientCorrectionSessionConfig): Promise<Result<ClinikoPatientCorrectionSession, Failure>> {
    let session: ClinikoPatientCorrectionSession | undefined;
    try {
      const binding = config.policy.binding();
      if (!(config.policy instanceof OwnerFilePatientUpdatePolicy) || !(config.verification instanceof CallerVerificationSession) ||
          !(config.reviewedSend instanceof ClinikoReviewedSend) || !(config.signal instanceof AbortSignal) || config.signal.aborted ||
          typeof config.contactRevision?.begin !== "function" || typeof config.contactRevision?.complete !== "function" ||
          !config.verification.usesContactRevision(config.contactRevision) ||
          typeof config.presentation?.play !== "function" || typeof config.permission?.allows !== "function" ||
          typeof config.delivery?.send !== "function" || typeof config.verificationBudget?.reserve !== "function" ||
          !sameScope(binding.scope, config.receipt.scope) || binding.policyVersion !== config.policyVersion ||
          binding.credentialFingerprint !== clinikoCredentialFingerprint(config.cliniko.apiKey) ||
          !config.verification.matchesClinikoAccount(binding.credentialFingerprint) ||
          !config.verification.proof.matchesCall(config.receipt.scope, config.receipt.callId, config.sessionId, config.policyVersion) ||
          config.receipt.callId !== callIdFor(config.inbound.key) || config.receipt.admission.key.accountRef !== config.inbound.key.accountRef ||
          config.receipt.admission.key.providerCallRef !== config.inbound.key.providerCallRef || config.receipt.admission.dialedNumber !== config.inbound.dialedNumber ||
          (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 30_000))) return err({ kind: "patientCorrectionUnavailable" });
      session = new ClinikoPatientCorrectionSession(config);
      if (await session.#bounded(signal => session!.#ready(signal)) !== true) { session.dispose(); return err({ kind: "patientCorrectionUnavailable" }); }
      return ok(session);
    } catch { session?.dispose(); return err({ kind: "patientCorrectionUnavailable" }); }
  }
  #now(): string { return (this.#config.clock ?? (() => new Date().toISOString()))(); }
  async #bounded<T>(run: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T | undefined> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.#config.timeoutMs ?? 15_000);
    const signal = AbortSignal.any([controller.signal, this.#lifetime.signal, ...(external ? [external] : [])]);
    try { return await awaitUntilAbort(Promise.resolve().then(() => signal.aborted ? undefined : run(signal)), signal); }
    catch { return undefined; } finally { clearTimeout(timer); controller.abort(); }
  }
  async #ready(signal: AbortSignal): Promise<boolean> {
    const c = this.#config, scope = c.receipt.scope;
    if (signal.aborted || this.#lifetime.signal.aborted) return false;
    const policy = await c.policies.read(scope), stop = await c.ledger.readWriteStop(scope), approval = await c.policy.current(scope, signal);
    const state = await c.ledger.read(c.receipt.callId, scope), now = Date.parse(this.#now());
    if (!policy.ok || !stop.ok || stop.value.stopped || !approval.ok || !state.ok || !Number.isFinite(now) || signal.aborted || this.#lifetime.signal.aborted ||
        !sameScope(policy.value.scope, scope) || !policy.value.automationEnabled || policy.value.policyVersion !== c.policyVersion || policy.value.capabilities.patientUpdate !== "execute" ||
        policy.value.patientCorrectionsEnabled !== true || policy.value.patientCorrectionsVersion !== c.policy.binding().correctionVersion ||
        state.value.lifecycle !== "active" || !sameScope(state.value.policy.scope, scope) || !state.value.policy.automationEnabled || state.value.policy.policyVersion !== c.policyVersion ||
        state.value.policy.capabilities.patientUpdate !== "execute" || state.value.policy.patientCorrectionsEnabled !== true ||
        state.value.policy.patientCorrectionsVersion !== c.policy.binding().correctionVersion || state.value.callerIdentityDenied || state.value.sessionLease?.sessionId !== c.sessionId ||
        !Number.isFinite(Date.parse(state.value.sessionLease.expiresAt)) || Date.parse(state.value.sessionLease.expiresAt) <= now ||
        state.value.admission?.key.accountRef !== c.inbound.key.accountRef || state.value.admission.key.providerCallRef !== c.inbound.key.providerCallRef ||
        state.value.admission.dialedNumber !== c.inbound.dialedNumber) return false;
    if (this.#dispatch) {
      const action = state.value.actions[this.#dispatch.actionKey], effect = state.value.effects[`${this.#dispatch.actionKey}:write`];
      if (action?.kind !== "patientUpdate" || action.status !== "dispatched" || effect?.kind !== "hostWrite" || effect.status !== "possiblySent" ||
          state.value.presentations[action.presentationId]?.status !== "played" || action.digest !== this.#dispatch.payloadDigest ||
          digestActionRequest(action.mutation.request) !== this.#dispatch.payloadDigest || digestActionRequest(effect.mutation.request) !== this.#dispatch.payloadDigest) return false;
    }
    return !signal.aborted && !this.#lifetime.signal.aborted && Date.parse(state.value.sessionLease.expiresAt) > Date.parse(this.#now());
  }
  async #currentSubject(signal: AbortSignal): Promise<VerifiedPatient | undefined> {
    const c = this.#config;
    if (!await this.#ready(signal)) return undefined;
    const grant = await c.verification.verified(signal);
    if (!grant) return undefined;
    const proof = await c.verification.proof.verifyOperation(c.receipt.scope, grant.verificationRef, "patients.update", this.#now(), signal);
    if (!proof.ok || !validClinikoId(proof.value.patientRef) || this.#subject && !isDeepStrictEqual(this.#subject, proof.value) ||
        await c.permission.allows(c.receipt.scope, proof.value.patientRef, "patients.update", c.policyVersion, signal) !== true || !await this.#ready(signal)) return undefined;
    return structuredClone(proof.value);
  }
  #providerQuery(): PatientUpdateQuery {
    const c = this.#config, subject = this.#subject!;
    return { scope: { ...c.receipt.scope }, callId: c.receipt.callId, sessionId: c.sessionId, patientId: subject.patientRef,
      policyVersion: c.policyVersion, verificationRef: subject.verificationRef };
  }
  async begin(): Promise<Result<Readonly<{ consentRef: string; allowedFields: readonly import("../cliniko/patient-details.ts").PatientDetailField[] }>, Failure>> {
    if (this.#busy || this.#terms || this.#attempted) return err({ kind: "patientCorrectionUnavailable" });
    this.#busy = true;
    try {
      const terms = await this.#bounded(async signal => {
        const subject = await this.#currentSubject(signal); if (!subject) return undefined;
        this.#subject = subject;
        const approval = await this.#config.policy.current(subject.scope, signal); if (!approval.ok) return undefined;
        if (await this.#config.presentation.play(`${approval.value.privacyTerms.approvedText} ${approval.value.correctionTerms.approvedText}`, signal) !== true || !await this.#currentSubject(signal)) return undefined;
        return { consentRef: randomUUID(), privacyVersion: approval.value.privacyTerms.version, correctionVersion: approval.value.correctionTerms.version,
          allowedFields: [...approval.value.allowedFields] };
      });
      if (!terms || this.#lifetime.signal.aborted) return err({ kind: "patientCorrectionUnavailable" });
      this.#terms = terms; return ok({ consentRef: terms.consentRef, allowedFields: [...terms.allowedFields] });
    } finally { this.#busy = false; }
  }
  async acknowledge(ref: string, accepted: boolean): Promise<boolean> {
    if (ref === this.#terms?.consentRef && accepted === false) { this.dispose(); return false; }
    if (this.#busy || this.#attempted || this.#pending || !this.#terms || ref !== this.#terms.consentRef || accepted !== true) return false;
    this.#busy = true;
    try { return this.#accepted = await this.#bounded(signal => this.#currentSubject(signal)) !== undefined; }
    finally { this.#busy = false; }
  }
  /** Trusted private field input only. Recollection destroys the previous draft, code and action references. */
  async collect(changes: PatientDetailChanges): Promise<Result<Readonly<{ correctionRef: string; codeRequired: boolean }>, Failure>> {
    if (this.#busy || this.#attempted || !this.#accepted || !this.#terms || this.#collections >= 3) return err({ kind: "patientCorrectionUnavailable" });
    try { changes = structuredClone(changes); } catch { return err({ kind: "patientCorrectionUnavailable" }); }
    if (!validPatientDetailChanges(changes)) return err({ kind: "patientCorrectionUnavailable" });
    this.#busy = true; this.#collections++; this.#mail?.close(); this.#mail = undefined; this.#pending = undefined; this.#action = undefined;
    try {
      const result = await this.#bounded(async signal => {
        if (!await this.#currentSubject(signal)) return undefined;
        const read = await this.#edge.readTarget(this.#providerQuery(), signal); if (!read.ok || !read.value.details.date_of_birth) return undefined;
        const query: PatientCorrectionPolicyQuery = { scope: this.#config.receipt.scope, caller: "patient", existingBirthDate: read.value.details.date_of_birth,
          changes, privacyAccepted: true, privacyTermsVersion: this.#terms!.privacyVersion, correctionAccepted: true, correctionTermsVersion: this.#terms!.correctionVersion };
        if (!(await this.#config.policy.checkCorrection(query, signal)).ok) return undefined;
        const ref = randomUUID(), request: PatientUpdateRequest = { ...this.#providerQuery(), attemptRef: randomUUID(), consentRef: this.#terms!.consentRef,
          expectedDigest: patientDetailsDigest(read.value), changes, ...(Object.hasOwn(changes, "email") ? { prospectiveEmailRef: randomUUID() } : {}) };
        const readback = Object.entries(changes).map(([field, value]) => `${field.replaceAll("_", " ")}: ${value === null ? "remove this value" : Array.isArray(value) ? value.map(phone => `${phone.number}, ${phone.phone_type}`).join("; ") : value}`).join(". ");
        if (await this.#config.presentation.play(`Please check this correction: ${readback}.`, signal) !== true || !await this.#currentSubject(signal)) return undefined;
        const pending = this.#pending = { ref, before: structuredClone(read.value), query: structuredClone(query), request: structuredClone(request) };
        if (request.prospectiveEmailRef) {
          const c = this.#config;
          this.#mail = new ProspectiveEmailCode({ scope: c.receipt.scope, budget: c.verificationBudget, delivery: c.delivery,
            current: async stop => this.#pending === pending && await this.#currentPending(stop, false), clock: () => Date.parse(this.#now()), timeoutMs: c.timeoutMs ?? 15_000 });
          await this.#mail.start(changes.email!, signal);
        }
        return { correctionRef: ref, codeRequired: !!request.prospectiveEmailRef };
      });
      return result && !this.#lifetime.signal.aborted ? ok(result) : err({ kind: "patientCorrectionUnavailable" });
    } finally { this.#busy = false; }
  }
  async answer(code: string): Promise<Readonly<{ verified: boolean }>> {
    if (this.#busy || this.#attempted || !this.#mail) return { verified: false };
    this.#busy = true;
    try { return { verified: await this.#mail.answer(code, this.#lifetime.signal) && await this.#bounded(signal => this.#currentPending(signal, false)) === true }; }
    finally { this.#busy = false; }
  }
  async #currentPending(signal: AbortSignal, requireEmail: boolean): Promise<boolean> {
    const pending = this.#pending, c = this.#config;
    if (!pending || !this.#accepted || !this.#subject || Date.parse(this.#subject.expiresAt) <= Date.parse(this.#now()) || !await this.#ready(signal) ||
        !(await c.policy.checkCorrection(pending.query, signal)).ok) return false;
    if (this.#claimed) {
      if (!this.#dispatch || await c.permission.allows(c.receipt.scope, this.#subject.patientRef, "patients.update", c.policyVersion, signal) !== true) return false;
    } else if (!await this.#currentSubject(signal)) return false;
    return this.#pending === pending && !signal.aborted && !this.#lifetime.signal.aborted && (!requireEmail || !pending.request.prospectiveEmailRef || this.#mail?.verified(pending.request.changes.email!) === true);
  }
  #matchesRequest(request: PatientUpdateRequest): boolean { return !!this.#pending && isDeepStrictEqual(request, this.#pending.request); }
  async #attest(query: PatientUpdateQuery | PatientUpdateRequest, phase: "read" | "send" | "inspect", signal: AbortSignal): Promise<PatientUpdateAttestation | null> {
    if (!this.#subject || !isDeepStrictEqual(Object.fromEntries(Object.entries(query).filter(([key]) => ["scope", "callId", "sessionId", "patientId", "policyVersion", "verificationRef"].includes(key))), this.#providerQuery())) return null;
    if (phase === "read") { if (this.#claimed || !await this.#currentSubject(signal)) return null; }
    else if (!("changes" in query) || !this.#matchesRequest(query) || !this.#dispatch || phase === "send" && this.#claimed || phase === "inspect" && !this.#claimed || !await this.#currentPending(signal, true)) return null;
    const approval = await this.#config.policy.current(this.#config.receipt.scope, signal); if (!approval.ok || signal.aborted) return null;
    const expiry = Math.min(Date.parse(this.#subject.expiresAt), Date.parse(approval.value.effectiveUntil), Date.parse(this.#mail?.expiresAt() ?? this.#subject.expiresAt));
    return { ...this.#providerQuery(), operation: "patients.update", recordScope: "clinikoAccount", credentialFingerprint: approval.value.credentialFingerprint,
      allowedFields: [...approval.value.allowedFields], expiresAt: new Date(expiry).toISOString(), independentPermission: true, selfAuthorized: true,
      ...(phase !== "read" && "changes" in query ? { attemptRef: query.attemptRef, consentRef: query.consentRef, expectedDigest: query.expectedDigest,
        changesDigest: patientDetailChangesDigest(query.changes), confirmationPlayed: true,
        ...(query.prospectiveEmailRef ? { prospectiveEmailRef: query.prospectiveEmailRef, prospectiveEmailDigest: createHash("sha256").update(JSON.stringify(query.changes.email)).digest("hex") } : {}) } : {}) };
  }
  async resolvePatientCorrection(query: PatientCorrectionEvidenceQuery): Promise<Result<PatientCorrectionAction, HostReadFailure>> {
    if (this.#busy || this.#attempted || !this.#pending || query.correctionRef !== this.#pending.ref || !sameScope(query.scope, this.#config.receipt.scope) ||
        query.callId !== this.#config.receipt.callId || query.sessionId !== this.#config.sessionId || query.policyVersion !== this.#config.policyVersion ||
        !Number.isFinite(Date.parse(query.now)) || Math.abs(Date.parse(query.now) - Date.parse(this.#now())) > 30_000) return err({ kind: "unavailable", target: "patient" });
    this.#busy = true;
    try {
      const result = await this.#bounded(async signal => {
        if (!await this.#currentPending(signal, true)) return undefined;
        const approval = await this.#config.policy.current(this.#config.receipt.scope, signal); if (!approval.ok) return undefined;
        const expiry = Math.min(Date.parse(this.#subject!.expiresAt), Date.parse(this.#mail?.expiresAt() ?? this.#subject!.expiresAt), Date.parse(approval.value.effectiveUntil));
        return this.#action ??= { kind: "patientUpdate", patient: structuredClone(this.#subject!), correctionRef: this.#pending!.ref,
          consentRef: this.#terms!.consentRef, correctionVersion: this.#config.policy.binding().correctionVersion, expiresAt: new Date(expiry).toISOString() };
      });
      return result ? ok(structuredClone(result)) : err({ kind: "unavailable", target: "patient" });
    } finally { this.#busy = false; }
  }
  async write(mutation: HostMutation, now: string, external?: AbortSignal): Promise<HostWriteReceipt> {
    const rejected = (): HostWriteReceipt => ({ kind: "rejected", actionKey: mutation.actionKey, reason: "forbidden" });
    const uncertain = (): HostWriteReceipt => ({ kind: "uncertain", actionKey: mutation.actionKey, reconcileAfter: this.#now(), deadline: new Date(Date.parse(this.#now()) + 300_000).toISOString() });
    if (this.#busy || this.#attempted || !this.#action || !this.#pending || mutation.kind !== "patientUpdate" || mutation.notification ||
        !sameScope(mutation.scope, this.#config.receipt.scope) || mutation.policyVersion !== this.#config.policyVersion || mutation.payloadDigest !== digestActionRequest(this.#action) ||
        !isDeepStrictEqual(mutation.request, this.#action) || !Number.isFinite(Date.parse(now)) || Math.abs(Date.parse(now) - Date.parse(this.#now())) > 30_000) return rejected();
    this.#busy = true; this.#dispatch = structuredClone(mutation);
    try {
      const result = await this.#bounded(async signal => {
        if (!await this.#currentPending(signal, true)) return rejected();
        this.#attempted = true;
        const c = this.#config, binding = c.policy.binding();
        const review = await c.reviewedSend.run({ scope: c.receipt.scope, patientId: this.#subject!.patientRef, businessId: binding.businessId,
          credentialFingerprint: binding.credentialFingerprint, policyVersion: c.policyVersion, termsVersion: binding.correctionVersion, timeZone: binding.timeZone,
          createdAt: this.#now(), operation: { kind: "patientUpdate", correctionRef: this.#pending!.ref } }, {
          authorize: (_request, stop) => this.#currentPending(stop, true), send: (_request, stop) => this.#edge.updateOnce(this.#pending!.request, stop),
        }, signal);
        if (!review.ok) return review.error.kind === "reviewUncertain" || review.error.kind === "mutationUncertain" ? uncertain() : rejected();
        if (!review.value.outcome.ok) return this.#claimed ? uncertain() : rejected();
        return ["updated", "unchanged"].includes(review.value.outcome.value.kind)
          ? { kind: "committed" as const, actionKey: mutation.actionKey, hostRef: `cliniko:patient:${this.#subject!.patientRef}` } : uncertain();
      }, external);
      return result && !external?.aborted && !this.#lifetime.signal.aborted ? result : uncertain();
    } catch { return uncertain(); }
    finally { this.#busy = false; if (!this.#attempted) this.#dispatch = undefined; }
  }
  async reconcile(mutation: HostMutation): Promise<ReconcileObservation> { return { kind: "stillUnknown", actionKey: mutation.actionKey }; }
  async resolveBooking(): Promise<Result<Extract<import("../core/model.ts").ActionRequest, { kind: "book" }>, HostReadFailure>> { return err({ kind: "unavailable", target: "offer" }); }
  async openTask(item: StaffItem): Promise<StaffTaskReceipt> { return { kind: "rejected", taskKey: item.key }; }
  async reconcileTask(item: StaffItem): Promise<StaffTaskObservation> { return { kind: "stillUnknown", taskKey: item.key }; }
  dispose(): void {
    this.#lifetime.abort(); this.#config.signal.removeEventListener("abort", this.#onClose); this.#edge.dispose(); this.#mail?.close(); this.#config.verification.dispose();
    this.#subject = undefined; this.#terms = undefined; this.#pending = undefined; this.#mail = undefined; this.#action = undefined; this.#dispatch = undefined; this.#accepted = false;
  }
}
