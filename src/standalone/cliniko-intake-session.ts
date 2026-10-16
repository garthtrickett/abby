import { clinikoIntakeAdditionalFields } from "../cliniko/patient-intake.ts";
import { randomUUID } from "node:crypto";
import { ClinikoPatientIntakeEdge } from "../cliniko/patient-intake.ts";
import type { ClinikoIntakeDraft, ClinikoIntakeRequest } from "../cliniko/patient-intake.ts";
import { clinikoCredentialFingerprint, isClinikoRequestBudget } from "../cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import { digestActionRequest } from "../core/digest.ts";
import type { HostReadFailure, IntakeEvidenceHost, IntakeEvidenceQuery, PolicyStore } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { ActionRequest, AdmissionReceipt, HostMutation, HostWriteReceipt, LocationScope, ReconcileObservation, Result, StaffItem, StaffTaskObservation, StaffTaskReceipt } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { callIdFor } from "../voice/admission.ts";
import type { AuthenticatedInboundCall } from "../voice/admission.ts";
import { sameScope } from "./appointment-change-authority.ts";
import type { PatientCodeDelivery, PatientVerificationBudget } from "./email-patient-authority.ts";
import { NoStoredKnowledge } from "./no-stored-knowledge.ts";
import { OwnerFileIntakePolicy } from "./owner-file-intake-policy.ts";
import type { IntakeDraftQuery } from "./owner-file-intake-policy.ts";
import { ProspectiveEmailCode } from "./prospective-email-code.ts";
import { TransientIntakeAuthority } from "./transient-intake-authority.ts";

type Failure = Readonly<{ kind: "intakeSessionUnavailable" }>;
type IntakeAction = Extract<ActionRequest, { kind: "intake" }>;
export type ProspectiveIntakePermission = Readonly<{
  /** Independent clinic permission; mailbox possession proves neither identity nor this permission. */
  allows(input: Readonly<{ scope: LocationScope; callId: string; sessionId: string; policyVersion: string;
    operation: "patients.intake"; draft: ClinikoIntakeDraft; signal: AbortSignal }>): Promise<boolean>;
}>;
export type ClinikoIntakeSessionConfig = Readonly<{
  receipt: AdmissionReceipt; inbound: AuthenticatedInboundCall; sessionId: string; policyVersion: string;
  ledger: Pick<LedgerStore, "read" | "readWriteStop">; policies: Pick<PolicyStore, "read">; policy: OwnerFileIntakePolicy;
  permission: ProspectiveIntakePermission; verificationBudget: PatientVerificationBudget; delivery: PatientCodeDelivery;
  /** Private transport presentation. true requires completed display/playback, not enqueue acceptance. */
  presentation: Readonly<{ play(text: string, signal: AbortSignal): Promise<boolean> }>;
  /** Optional current service authority, checked on every protected registration use. */
  workflowApproval?: (signal: AbortSignal) => Promise<boolean>;
  cliniko: Readonly<{ apiKey: string; contactEmail: string; rateBudget: ClinikoRequestBudget;
    contactRevision?: import("../cliniko/contact-revision.ts").ClinikoContactRevisionReader }>;
  signal: AbortSignal; fetchPort?: typeof fetch; clock?: () => string; timeoutMs?: number;
}>;

/** One admitted, volatile caller-mediated registration. Private collection/OTP stays outside SAM/model turns.
 * SAM alone owns the final action confirmation and dispatch. Production wiring remains separately gated. */
export class ClinikoIntakeSession extends NoStoredKnowledge implements IntakeEvidenceHost {
  readonly effectDeadlineMs = 30_000;
  readonly #config: ClinikoIntakeSessionConfig;
  readonly #lifetime = new AbortController();
  readonly #authority: TransientIntakeAuthority;
  readonly #edge: ClinikoPatientIntakeEdge;
  readonly #onClose = () => this.dispose();
  #mail: ProspectiveEmailCode | undefined;
  #recoveryRef: string | undefined;
  #recoveryAccepted = false;
  #draft: Readonly<{ ref: string; query: IntakeDraftQuery }> | undefined;
  #providerRequest: ClinikoIntakeRequest | undefined;
  #action: IntakeAction | undefined;
  #dispatch: HostMutation | undefined;
  #created: Readonly<{ actionKey: string; patientRef: string }> | undefined;
  #draftCount = 0;
  #busy = false;
  #attempted = false;
  private constructor(config: ClinikoIntakeSessionConfig) {
    super(); this.#config = Object.freeze({ ...config, receipt: structuredClone(config.receipt), inbound: structuredClone(config.inbound),
      cliniko: Object.freeze({ ...config.cliniko }) });
    const scope = config.receipt.scope;
    this.#authority = new TransientIntakeAuthority({ scope, callId: config.receipt.callId, sessionId: config.sessionId,
      policyVersion: config.policyVersion, clock: () => this.#now(), timeoutMs: config.timeoutMs ?? 15_000,
      source: { resolve: async query => {
        const draft = this.#draft;
        if (!draft || query.draftRef !== draft.ref || query.consentRef !== this.#recoveryRef || query.authorityRef !== draft.ref ||
            !await this.#currentDraft(query.signal)) return err({ kind: "denied" });
        return ok({ scope, callId: config.receipt.callId, sessionId: config.sessionId, policyVersion: config.policyVersion,
          draftRef: draft.ref, consentRef: query.consentRef, authorityRef: draft.ref, draft: structuredClone(draft.query.draft),
          caller: "patient", privacyAccepted: true, proxyAuthorized: false, expiresAt: this.#mail!.expiresAt()! });
      } } });
    const binding = config.policy.binding();
    const edge = ClinikoPatientIntakeEdge.create({ ...config.cliniko, scope, countryCallingCode: binding.countryCallingCode },
      this.#authority, config.fetchPort ?? fetch, () => this.#now());
    if (!edge.ok) throw new TypeError("invalid intake provider configuration");
    this.#edge = edge.value;
    config.signal.addEventListener("abort", this.#onClose, { once: true });
    if (config.signal.aborted) this.dispose();
  }
  static async create(config: ClinikoIntakeSessionConfig): Promise<Result<ClinikoIntakeSession, Failure>> {
    let session: ClinikoIntakeSession | undefined;
    try {
      if (!config || !(config.signal instanceof AbortSignal) || config.signal.aborted || !(config.policy instanceof OwnerFileIntakePolicy) ||
          !isClinikoRequestBudget(config.cliniko?.rateBudget) || typeof config.presentation?.play !== "function" ||
          (config.workflowApproval !== undefined && typeof config.workflowApproval !== "function") || typeof config.permission?.allows !== "function" || typeof config.verificationBudget?.reserve !== "function" ||
          typeof config.delivery?.send !== "function" || !/^[A-Za-z0-9:_-]{1,128}$/.test(config.sessionId) ||
          !/^[A-Za-z0-9:_-]{1,128}$/.test(config.policyVersion) ||
          (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 30_000))) return err({ kind: "intakeSessionUnavailable" });
      const binding = config.policy.binding();
      if (!sameScope(binding.scope, config.receipt.scope) || binding.policyVersion !== config.policyVersion ||
          binding.credentialFingerprint !== clinikoCredentialFingerprint(config.cliniko.apiKey) ||
          config.receipt.callId !== callIdFor(config.inbound.key) ||
          config.receipt.admission.key.accountRef !== config.inbound.key.accountRef ||
          config.receipt.admission.key.providerCallRef !== config.inbound.key.providerCallRef ||
          config.receipt.admission.dialedNumber !== config.inbound.dialedNumber ||
          !/^\+[1-9][0-9]{7,14}$/.test(config.inbound.presentedCallerNumber ?? "")) return err({ kind: "intakeSessionUnavailable" });
      session = new ClinikoIntakeSession(config);
      const ready = await session.#bounded(signal => session!.#ready(signal));
      if (!ready || config.signal.aborted) { session.dispose(); return err({ kind: "intakeSessionUnavailable" }); }
      return ok(session);
    } catch { session?.dispose(); return err({ kind: "intakeSessionUnavailable" }); }
  }
  #now(): string { return (this.#config.clock ?? (() => new Date().toISOString()))(); }
  async #bounded<T>(run: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T | undefined> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.#config.timeoutMs ?? 15_000);
    const signal = AbortSignal.any([controller.signal, this.#lifetime.signal, ...(external ? [external] : [])]);
    try { return await awaitUntilAbort(Promise.resolve().then(() => signal.aborted ? undefined : run(signal)), signal); }
    catch { return undefined; }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async #ready(signal: AbortSignal): Promise<boolean> {
    const config = this.#config, scope = config.receipt.scope;
    if (signal.aborted || this.#lifetime.signal.aborted) return false;
    const current = await config.policies.read(scope), stop = await config.ledger.readWriteStop(scope);
    const approval = await config.policy.current(scope, signal);
    const state = await config.ledger.read(config.receipt.callId, scope), now = Date.parse(this.#now());
    if (!current.ok || !stop.ok || stop.value.stopped || !approval.ok || !state.ok || !Number.isFinite(now) || signal.aborted || this.#lifetime.signal.aborted ||
        !sameScope(current.value.scope, scope) || !current.value.automationEnabled || current.value.policyVersion !== config.policyVersion ||
        state.value.callId !== config.receipt.callId || state.value.lifecycle !== "active" ||
        !sameScope(state.value.policy.scope, scope) || state.value.policy.policyVersion !== config.policyVersion ||
        !state.value.policy.automationEnabled || state.value.policy.firstTimeIntakeEnabled !== true || state.value.policy.capabilities.intake !== "execute" ||
        state.value.policy.firstTimeIntakeVersion !== config.policy.binding().intakeVersion ||
        state.value.sessionLease?.sessionId !== config.sessionId || !Number.isFinite(Date.parse(state.value.sessionLease.expiresAt)) ||
        Date.parse(state.value.sessionLease.expiresAt) <= now ||
        state.value.admission?.key.accountRef !== config.inbound.key.accountRef ||
        state.value.admission.key.providerCallRef !== config.inbound.key.providerCallRef || state.value.admission.dialedNumber !== config.inbound.dialedNumber) return false;
    if (Object.values(state.value.actions).some(action => action.kind === "intake" &&
        (action.mutation.request.kind !== "intake" || action.mutation.request.approvedDraftRef !== this.#draft?.ref))) return false;
    const mutation = this.#dispatch;
    if (mutation) {
      const action = state.value.actions[mutation.actionKey], effect = state.value.effects[`${mutation.actionKey}:write`];
      if (action?.kind !== "intake" || action.digest !== mutation.payloadDigest ||
          !((action.status === "dispatched" && effect?.status === "possiblySent") ||
            (action.status === "committed" && effect?.status === "completed" && this.#created?.actionKey === action.key && action.hostRef === this.#created.patientRef)) ||
          state.value.presentations[action.presentationId]?.status !== "played" || effect?.kind !== "hostWrite" ||
          digestActionRequest(action.mutation.request) !== mutation.payloadDigest || digestActionRequest(effect.mutation.request) !== mutation.payloadDigest) return false;
    }
    if (config.workflowApproval && await config.workflowApproval(signal) !== true) return false;
    return !signal.aborted && !this.#lifetime.signal.aborted && Date.parse(state.value.sessionLease!.expiresAt) > Date.parse(this.#now());
  }
  async #currentDraft(signal: AbortSignal): Promise<boolean> {
    const draft = this.#draft, config = this.#config;
    if (!draft || !this.#recoveryAccepted || !this.#mail?.verified(draft.query.draft.email) || !await this.#ready(signal)) return false;
    const checked = await config.policy.checkDraft(draft.query, signal);
    if (!checked.ok || signal.aborted) return false;
    const permitted = await config.permission.allows({ scope: { ...config.receipt.scope }, callId: config.receipt.callId,
      sessionId: config.sessionId, policyVersion: config.policyVersion, operation: "patients.intake", draft: structuredClone(draft.query.draft), signal });
    if (permitted !== true || !await this.#ready(signal)) return false;
    return !signal.aborted && !this.#lifetime.signal.aborted && this.#draft === draft && this.#recoveryAccepted && this.#mail?.verified(draft.query.draft.email) === true;
  }
  /** Private presentation of approved public terms, before any patient draft is accepted. */
  async begin(): Promise<Result<Readonly<{ recoveryRef: string; requiredFields: readonly (typeof import("./owner-file-intake-policy.ts").intakeAllowedFields)[number][] }>, Failure>> {
    if (this.#busy || this.#recoveryRef || this.#attempted) return err({ kind: "intakeSessionUnavailable" });
    this.#busy = true;
    try {
      const result = await this.#bounded(async signal => {
        if (!await this.#ready(signal)) return undefined;
        const approval = await this.#config.policy.current(this.#config.receipt.scope, signal);
        if (!approval.ok || signal.aborted) return undefined;
        if (await this.#config.presentation.play(`${approval.value.privacyTerms.approvedText} ${approval.value.intakeTerms.approvedText} ${approval.value.recoveryTerms.approvedText}`, signal) !== true ||
            !await this.#ready(signal)) return undefined;
        return { recoveryRef: randomUUID(), requiredFields: [...approval.value.requiredFields] };
      });
      if (!result || this.#lifetime.signal.aborted) return err({ kind: "intakeSessionUnavailable" });
      this.#recoveryRef = result.recoveryRef; return ok(result);
    } finally { this.#busy = false; }
  }
  /** A separate observed acknowledgment, never combined with final SAM affirmation or mailbox possession. */
  async acknowledgeRecovery(ref: string, acknowledged: boolean): Promise<boolean> {
    if (this.#recoveryRef && ref === this.#recoveryRef && acknowledged === false) { this.dispose(); return false; }
    if (this.#busy || !this.#recoveryRef || ref !== this.#recoveryRef || acknowledged !== true || this.#draft || this.#attempted) return false;
    const current = await this.#bounded(signal => this.#ready(signal));
    if (current === true && !this.#lifetime.signal.aborted && ref === this.#recoveryRef) { this.#recoveryAccepted = true; return true; }
    return false;
  }
  /** Trusted private collection/correction, never a model tool. A correction destroys old proof and draft references. */
  async collect(draft: ClinikoIntakeDraft, consent: Readonly<{ privacyAccepted: boolean; intakeAccepted: boolean }>): Promise<Result<Readonly<{ draftRef: string }>, Failure>> {
    if (this.#providerRequest && !this.#attempted) { this.dispose(); return err({ kind: "intakeSessionUnavailable" }); }
    if (this.#busy || !this.#recoveryAccepted || this.#attempted) return err({ kind: "intakeSessionUnavailable" });
    this.#busy = true; this.#mail?.close(); this.#mail = undefined; this.#draft = undefined;
    try {
      draft = structuredClone(draft); consent = structuredClone(consent);
      if (++this.#draftCount > 3) return err({ kind: "intakeSessionUnavailable" });
      const result = await this.#bounded(async signal => {
        if (!await this.#ready(signal)) return undefined;
        const approval = await this.#config.policy.current(this.#config.receipt.scope, signal);
        if (!approval.ok || signal.aborted) return undefined;
        const query: IntakeDraftQuery = { scope: this.#config.receipt.scope, draft, admittedCallerPhone: this.#config.inbound.presentedCallerNumber!, caller: "patient",
          privacyAccepted: consent.privacyAccepted, intakeAccepted: consent.intakeAccepted, recoveryAccepted: this.#recoveryAccepted,
          privacyTermsVersion: approval.value.privacyTerms.version, intakeTermsVersion: approval.value.intakeTerms.version, recoveryTermsVersion: approval.value.recoveryTerms.version };
        if (!(await this.#config.policy.checkDraft(query, signal)).ok || signal.aborted) return undefined;
        const fields = [`first name ${draft.firstName}`, `last name ${draft.lastName}`, `date of birth ${draft.dateOfBirth}`,
          `email ${draft.email}`, `phone ${draft.patientPhone}`, `phone type ${draft.phoneType}`,
          ...clinikoIntakeAdditionalFields.filter(field => Object.hasOwn(draft, field)).map(field =>
            `${field.replace(/([A-Z])/g, " $1").replace(/([1-3])$/, " line $1").toLowerCase()}: ${draft[field]}`)];
        const chunks: string[] = []; let chunk = "";
        for (const field of fields) {
          if (chunk && chunk.length + field.length + 2 > 1800) { chunks.push(chunk); chunk = ""; }
          chunk += `${chunk ? "; " : ""}${field}`;
        }
        if (chunk) chunks.push(chunk);
        for (const details of chunks) {
          if (await this.#config.presentation.play(`Registration details: ${details}. Saving these does not book an appointment.`, signal) !== true ||
              !await this.#ready(signal)) return undefined;
        }
        return { ref: randomUUID(), query: structuredClone(query) };
      });
      if (!result || this.#lifetime.signal.aborted) return err({ kind: "intakeSessionUnavailable" });
      this.#draft = result;
      this.#mail = new ProspectiveEmailCode({ scope: this.#config.receipt.scope, budget: this.#config.verificationBudget,
        delivery: this.#config.delivery, current: signal => this.#ready(signal), clock: () => Date.parse(this.#now()), timeoutMs: this.#config.timeoutMs ?? 15_000 });
      await this.#mail.start(result.query.draft.email, this.#lifetime.signal);
      if (this.#lifetime.signal.aborted) return err({ kind: "intakeSessionUnavailable" });
      return ok({ draftRef: result.ref });
    } catch { return err({ kind: "intakeSessionUnavailable" }); }
    finally { this.#busy = false; }
  }
  async submitCode(code: string): Promise<Readonly<{ verified: boolean }>> {
    if (this.#busy || !this.#mail || !this.#draft || this.#attempted) return { verified: false };
    this.#busy = true;
    try {
      if (!await this.#mail.answer(code, this.#lifetime.signal)) return { verified: false };
      return { verified: await this.#bounded(signal => this.#currentDraft(signal)) === true };
    } finally { this.#busy = false; }
  }
  async resolveIntake(query: IntakeEvidenceQuery): Promise<Result<IntakeAction, HostReadFailure>> {
    if (this.#busy || this.#attempted || !this.#draft || !sameScope(query.scope, this.#config.receipt.scope) ||
        query.callId !== this.#config.receipt.callId || query.sessionId !== this.#config.sessionId || query.policyVersion !== this.#config.policyVersion ||
        query.draftRef !== this.#draft.ref || Math.abs(Date.parse(query.now) - Date.parse(this.#now())) > 30_000 || !Number.isFinite(Date.parse(query.now))) return err({ kind: "unavailable", target: "patient" });
    this.#busy = true;
    try {
      const result = await this.#bounded(async signal => {
        if (!await this.#currentDraft(signal)) return undefined;
        if (!this.#providerRequest) {
          const prepared = await this.#authority.prepare(this.#draft!.ref, this.#recoveryRef!, this.#draft!.ref, signal);
          if (!prepared.ok || signal.aborted) return undefined;
          this.#providerRequest = prepared.value;
          this.#action = { kind: "intake", scope: this.#config.receipt.scope, approvedDraftRef: this.#draft!.ref,
            consentRef: this.#recoveryRef!, duplicateCheckRef: randomUUID(), recoveryContract: "callerMediated" };
        }
        return this.#action;
      });
      return result && !this.#lifetime.signal.aborted ? ok(structuredClone(result)) : err({ kind: "unavailable", target: "patient" });
    } finally { this.#busy = false; }
  }
  async resolveBooking(): Promise<Result<Extract<ActionRequest, { kind: "book" }>, HostReadFailure>> { return err({ kind: "unavailable", target: "offer" }); }
  async write(mutation: HostMutation, now: string, external?: AbortSignal): Promise<HostWriteReceipt> {
    const reject = (): HostWriteReceipt => ({ kind: "rejected", actionKey: mutation.actionKey, reason: "forbidden" });
    if (this.#busy || this.#attempted || !this.#action || !this.#providerRequest || mutation.kind !== "intake" || mutation.request.kind !== "intake" ||
        mutation.notification || !sameScope(mutation.scope, this.#config.receipt.scope) || mutation.policyVersion !== this.#config.policyVersion ||
        mutation.payloadDigest !== digestActionRequest(this.#action) || digestActionRequest(mutation.request) !== mutation.payloadDigest ||
        !Number.isFinite(Date.parse(now))) return reject();
    this.#attempted = true; this.#dispatch = structuredClone(mutation);
    const uncertain = (): HostWriteReceipt => ({ kind: "uncertain", actionKey: mutation.actionKey, reconcileAfter: now, deadline: new Date(Date.parse(now) + 300_000).toISOString() });
    try {
      const result = await this.#bounded(async signal => {
        if (!await this.#currentDraft(signal)) return reject();
        const outcome = await this.#edge.createOnce(this.#providerRequest!, { signal, timeoutMs: this.#config.timeoutMs ?? 15_000 });
        if (!outcome.ok) return reject();
        if (outcome.value.kind === "uncertain") return uncertain();
        if (outcome.value.kind !== "created") return reject();
        if (!await this.#currentDraft(signal)) return uncertain();
        return { kind: "committed" as const, actionKey: mutation.actionKey, hostRef: outcome.value.patientRef };
      }, external);
      // Abandoning the composition cannot prove the provider send never occurred.
      if (result?.kind === "committed" && !this.#lifetime.signal.aborted && !external?.aborted) {
        this.#created = { actionKey: mutation.actionKey, patientRef: result.hostRef };
        return result;
      }
      return result?.kind === "committed" ? uncertain() : result ?? uncertain();
    } catch { return uncertain(); }
  }
  /** Trusted owner only: a private exact provider receipt AND committed SAM action are required.
   * This supplies a candidate for independent booking permission, never appointment authority. */
  async createdPatient(external?: AbortSignal): Promise<Readonly<{ patientId: string; email: string; phone: string; expiresAt: string }> | undefined> {
    return this.#bounded(async signal => {
      const created = this.#created, draft = this.#draft;
      if (!created || !draft || !await this.#currentDraft(signal)) return undefined;
      const state = await this.#config.ledger.read(this.#config.receipt.callId, this.#config.receipt.scope);
      const action = state.ok ? state.value.actions[created.actionKey] : undefined;
      const patientId = created.patientRef.match(/^cliniko:patient:([1-9][0-9]{0,18})$/)?.[1];
      if (!patientId || action?.status !== "committed" || action.hostRef !== created.patientRef ||
          !await this.#currentDraft(signal) || signal.aborted || this.#created !== created || this.#draft !== draft) return undefined;
      return { patientId, email: draft.query.draft.email, phone: draft.query.draft.patientPhone, expiresAt: this.#mail!.expiresAt()! };
    }, external);
  }
  matchesCall(scope: LocationScope, callId: string, sessionId: string, policyVersion: string): boolean {
    const config = this.#config;
    return !this.#lifetime.signal.aborted && sameScope(scope, config.receipt.scope) && callId === config.receipt.callId &&
      sessionId === config.sessionId && policyVersion === config.policyVersion;
  }
  async reconcile(mutation: HostMutation): Promise<ReconcileObservation> { return { kind: "stillUnknown", actionKey: mutation.actionKey }; }
  async openTask(item: StaffItem): Promise<StaffTaskReceipt> { return { kind: "rejected", taskKey: item.key }; }
  async reconcileTask(item: StaffItem): Promise<StaffTaskObservation> { return { kind: "stillUnknown", taskKey: item.key }; }
  dispose(): void {
    this.#lifetime.abort(); this.#config.signal.removeEventListener("abort", this.#onClose); this.#mail?.close(); this.#authority.dispose();
    this.#mail = undefined; this.#draft = undefined; this.#providerRequest = undefined; this.#action = undefined; this.#dispatch = undefined; this.#created = undefined;
    this.#recoveryRef = undefined; this.#recoveryAccepted = false;
  }
}
