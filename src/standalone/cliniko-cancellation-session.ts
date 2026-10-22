import { isDeepStrictEqual } from "node:util";
import { ClinikoOutboundClinicalContext } from "./cliniko-outbound-clinical-context.ts";
import { ClinikoIncomingCallContext } from "./cliniko-incoming-call-context.ts";
import { createWorkflowCallerVerification } from "./workflow-caller-verification.ts";
import type { RepresentativeWorkflowSelection } from "./workflow-caller-verification.ts";
import { ClinikoCancellationWriter } from "../cliniko/cancellation-write.ts";
import { ClinikoRecallWriter } from "../cliniko/recall-write.ts";
import { clinikoCredentialFingerprint, isClinikoRequestBudget } from "../cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import { ClinikoVerificationContactReader } from "../cliniko/verification-contact.ts";
import type { PolicyStore } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { AdmissionReceipt, Result } from "../core/model.ts";
import type { AuthenticatedInboundCall } from "../voice/admission.ts";
import type { CallerCandidateLookup } from "../voice/caller-candidates.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import { ClinikoCancellationAuthority } from "./cliniko-cancellation-authority.ts";
import { ClinikoCancellationHost } from "./cliniko-cancellation-host.ts";
import { captureAdministrativeMemoConfig } from "./administrative-memo-retention.ts";
import type { PatientCodeDelivery, PatientVerificationBudget, PatientVerificationPermission } from "./email-patient-authority.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { OwnerFileCallerPolicy } from "./owner-file-caller-policy.ts";
import { OwnerFileCancellationPolicy } from "./owner-file-cancellation-policy.ts";

export type ClinikoCancellationSessionConfig = Readonly<{
  incomingOriginal?: ClinikoIncomingCallContext;
  memo?: import("./administrative-memo-retention.ts").ClinikoAdministrativeMemoConfig;
  receipt: AdmissionReceipt; inbound: AuthenticatedInboundCall; sessionId: string; policyVersion: string;
  ledger: LedgerStore; policies: PolicyStore; lookup: CallerCandidateLookup;
  permission: PatientVerificationPermission; verificationBudget: PatientVerificationBudget; delivery: PatientCodeDelivery;
  directory: AdminDirectory; callerApprovalPath: string; cancellationApprovalPath: string;
  cliniko: Readonly<{ apiKey: string; contactEmail: string; businessId: string; recallTypeId: string;
    timeZone: string; countryCallingCode: string; rateBudget: ClinikoRequestBudget }>;
  representative?: RepresentativeWorkflowSelection;
  signal: AbortSignal; fetchPort?: typeof fetch; clock?: () => string; timeoutMs?: number;
}>;
export type ClinikoOutboundCancellationSessionConfig = Omit<ClinikoCancellationSessionConfig, "inbound" | "representative" | "incomingOriginal"> &
  Readonly<{ outbound: ClinikoOutboundClinicalContext; inbound?: never; representative?: never; incomingOriginal?: never }>;
type SessionConfig = Omit<ClinikoCancellationSessionConfig, "inbound"> &
  Readonly<{ inbound?: AuthenticatedInboundCall; outbound?: ClinikoOutboundClinicalContext }>;
type Failure = Readonly<{ kind: "cancellationSessionUnavailable" }>;

/** Trusted post-admission wiring. One admission owns one verifier, selection map and send attempt.
 * These ports belong to the call owner, never to a model/caller or an activation endpoint. */
export class ClinikoCancellationSession {
  readonly #verification: CallerVerificationSession;
  readonly #authority: ClinikoCancellationAuthority;
  readonly #host: ClinikoCancellationHost;
  readonly #signal: AbortSignal;
  readonly #onClose = () => this.dispose();
  #closed = false;
  private constructor(verification: CallerVerificationSession, authority: ClinikoCancellationAuthority,
    host: ClinikoCancellationHost, signal: AbortSignal) {
    this.#verification = verification; this.#authority = authority; this.#host = host; this.#signal = signal;
    signal.addEventListener("abort", this.#onClose, { once: true });
    if (signal.aborted) this.dispose();
  }

  static async create(incoming: ClinikoCancellationSessionConfig): Promise<Result<ClinikoCancellationSession, Failure>> {
    if (!incoming || Object.hasOwn(incoming, "outbound") || incoming.receipt?.admission?.direction === "outbound")
      return err({ kind: "cancellationSessionUnavailable" });
    if (incoming.incomingOriginal && (!(incoming.incomingOriginal instanceof ClinikoIncomingCallContext) ||
        !incoming.incomingOriginal.hasOriginalAppointment() || !incoming.incomingOriginal.current() || !incoming.incomingOriginal.matchesCall(incoming.receipt, incoming.sessionId, incoming.policyVersion) ||
        !incoming.incomingOriginal.usesBudget(incoming.cliniko.rateBudget))) return err({ kind: "cancellationSessionUnavailable" });
    return this.#create(incoming);
  }
  /** The original native sick-day target constrains an independently verified
   * cancellation; routing never becomes incoming identity or patient proof. */
  static async createOutbound(incoming: ClinikoOutboundCancellationSessionConfig): Promise<Result<ClinikoCancellationSession, Failure>> {
    try {
      if (!incoming || Object.hasOwn(incoming, "inbound") || Object.hasOwn(incoming, "representative") || Object.hasOwn(incoming, "incomingOriginal") ||
          !(incoming.outbound instanceof ClinikoOutboundClinicalContext) || !incoming.outbound.matchesAdmission(incoming.receipt) ||
          !incoming.outbound.usesBudget(incoming.cliniko.rateBudget) || !incoming.outbound.current("appointments.cancel") ||
          !incoming.outbound.matchesWorkflow({ scope: incoming.receipt.scope, callId: incoming.receipt.callId,
            credentialFingerprint: clinikoCredentialFingerprint(incoming.cliniko.apiKey), businessId: incoming.cliniko.businessId }))
        return err({ kind: "cancellationSessionUnavailable" });
      return this.#create(incoming);
    } catch { return err({ kind: "cancellationSessionUnavailable" }); }
  }
  static async #create(incoming: SessionConfig): Promise<Result<ClinikoCancellationSession, Failure>> {
    const unavailable = (): Result<ClinikoCancellationSession, Failure> => err({ kind: "cancellationSessionUnavailable" });
    let timeout: ReturnType<typeof setTimeout> | undefined, removeAbort: () => void = () => undefined;
    let verification: CallerVerificationSession | undefined, authority: ClinikoCancellationAuthority | undefined;
    let host: ClinikoCancellationHost | undefined, completed: ClinikoCancellationSession | undefined;
    let settled = false;
    const dispose = () => { host?.dispose(); authority?.dispose(); verification?.dispose(); };
    try {
      if (!incoming || !(incoming.signal instanceof AbortSignal) || incoming.signal.aborted ||
          !isClinikoRequestBudget(incoming.cliniko?.rateBudget) ||
          (incoming.timeoutMs !== undefined && (!Number.isSafeInteger(incoming.timeoutMs) || incoming.timeoutMs < 1 || incoming.timeoutMs > 20_000))) return unavailable();
      // Freeze caller/provider bindings before the first async approval read.
      const config = Object.freeze({ ...incoming, ...(incoming.representative ? { representative: Object.freeze({ ...incoming.representative }) } : {}), receipt: structuredClone(incoming.receipt), ...(incoming.inbound ? { inbound: structuredClone(incoming.inbound) } : {}),
        ...(incoming.memo ? { memo: captureAdministrativeMemoConfig(incoming.memo, { scope: incoming.receipt.scope, ...incoming.cliniko,
          credentialFingerprint: clinikoCredentialFingerprint(incoming.cliniko.apiKey), ...(incoming.clock ? { clock: incoming.clock } : {}) }) } : {}),
        cliniko: Object.freeze({ ...incoming.cliniko }), clock: incoming.clock ?? (() => new Date().toISOString()) });
      const scope = config.receipt.scope, fetchPort = config.fetchPort ?? fetch;
      const stopped = new Promise<undefined>(resolve => {
        const abort = () => { settled = true; dispose(); completed?.dispose(); resolve(undefined); };
        config.signal.addEventListener("abort", abort, { once: true });
        removeAbort = () => config.signal.removeEventListener("abort", abort);
        timeout = setTimeout(abort, config.timeoutMs ?? 15_000);
        if (config.signal.aborted) abort();
      });
      const active = async () => {
        const state = await config.ledger.read(config.receipt.callId, scope), at = Date.parse(config.clock());
        return state.ok && Number.isFinite(at) && state.value.lifecycle === "active" &&
          isDeepStrictEqual(state.value.admission, config.receipt.admission) && state.value.sessionLease?.sessionId === config.sessionId &&
          Date.parse(state.value.sessionLease.expiresAt) > at && state.value.policy.policyVersion === config.policyVersion &&
          (!config.outbound || config.outbound.current("appointments.cancel"));
      };
      const build = (async () => {
        if (!await active() || settled) return undefined;
        const caller = await OwnerFileCallerPolicy.capture({ path: config.callerApprovalPath, scope, policyVersion: config.policyVersion,
          operation: "appointments.cancel", directory: config.directory, clock: config.clock });
        if (!caller.ok || settled) return undefined;
        const policy = await OwnerFileCancellationPolicy.capture({ path: config.cancellationApprovalPath, scope,
          policyVersion: config.policyVersion, businessId: config.cliniko.businessId, recallTypeId: config.cliniko.recallTypeId,
          credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey), timeZone: config.cliniko.timeZone,
          directory: config.directory, clock: config.clock });
        if (!policy.ok || settled) return undefined;
        const verificationPolicy = { operation: "appointments.cancel" as const, current: async (bound: typeof scope) => {
          const method = await caller.value.current(bound);
          if (!method.ok) return method;
          const terms = await policy.value.current(bound);
          const current = await config.policies.read(bound);
          const admitted = await config.ledger.read(config.receipt.callId, bound);
          return ok({ ...method.value, enabled: method.value.enabled && terms.ok && current.ok &&
            current.value.policyVersion === config.policyVersion && current.value.cancellationEnabled === true &&
            current.value.capabilities.cancel === "execute" && current.value.staffWorkEnabled === true && admitted.ok &&
            admitted.value.policy.capabilities.cancel === "execute" && admitted.value.policy.staffWorkEnabled === true && await active() });
        } };
        const verificationConfig = { receipt: config.receipt, sessionId: config.sessionId,
          policyVersion: config.policyVersion, operation: "appointments.cancel" as const, ledger: config.ledger, policyStore: config.policies,
          policy: verificationPolicy, lookup: config.lookup, contact: new ClinikoVerificationContactReader({ ...config.cliniko, scope }, fetchPort),
          permission: config.permission, budget: config.verificationBudget, delivery: config.delivery, clock: config.clock, ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) };
        const session = config.outbound ? CallerVerificationSession.createOutbound({ ...verificationConfig, outbound: config.outbound }) :
          await createWorkflowCallerVerification({ ...verificationConfig, inbound: config.inbound! }, { credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey), businessId: config.cliniko.businessId, timeZone: config.cliniko.timeZone }, config.signal, caller.value, config.representative);
        if (!session.ok) return undefined;
        verification = session.value;
        if (settled || config.signal.aborted) { verification.dispose(); return undefined; }
        const source = ClinikoCancellationAuthority.create({ ...config.cliniko, scope, callId: config.receipt.callId,
          sessionId: config.sessionId, policyVersion: config.policyVersion, proof: verification.proof,
          policy: policy.value, ...(config.outbound ? { outbound: config.outbound } : {}),
          ...(config.incomingOriginal ? { incomingOriginal: { context: config.incomingOriginal, verification } } : {}), clock: config.clock, ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) }, fetchPort);
        const cancellation = ClinikoCancellationWriter.create({ ...config.cliniko, scope }, fetchPort, config.clock);
        const recalls = ClinikoRecallWriter.create({ ...config.cliniko, scope }, fetchPort);
        if (!source.ok || !cancellation.ok || !recalls.ok || settled) return undefined;
        authority = source.value;
        host = new ClinikoCancellationHost({ scope, callId: config.receipt.callId, sessionId: config.sessionId,
          policyVersion: config.policyVersion, ledger: config.ledger, policy: config.policies, proof: verification.proof, authority,
          ...(config.outbound ? { outboundCancellation: config.outbound } : {}),
          businessId: config.cliniko.businessId, credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey),
          timeZone: config.cliniko.timeZone, recallTypeId: config.cliniko.recallTypeId, cancellation: cancellation.value,
          recallWriter: recalls.value, ...(config.memo ? { memo: config.memo } : {}), clock: config.clock });
        if (settled || config.signal.aborted) return undefined;
        completed = new ClinikoCancellationSession(verification, authority, host, config.signal);
        return completed;
      })().catch(() => undefined);
      const result = await Promise.race([build, stopped]);
      if (!result || settled || config.signal.aborted) return unavailable();
      return ok(result);
    } catch { return unavailable(); }
    finally {
      settled = true; if (timeout !== undefined) clearTimeout(timeout); removeAbort();
      if (!completed || completed.#closed) { completed?.dispose(); dispose(); }
    }
  }

  beginVerification(): ReturnType<CallerVerificationSession["begin"]> { return this.#verification.begin(); }
  submitCode(code: string): ReturnType<CallerVerificationSession["submitCode"]> { return this.#verification.submitCode(code); }
  /** Private owner wiring for existing SAM/gateway commands; never send this grant to a model. */
  verified(signal?: AbortSignal): ReturnType<CallerVerificationSession["verified"]> { return this.#verification.verified(signal); }
  get appointments(): ClinikoCancellationAuthority { return this.#authority; }
  get effects(): ClinikoCancellationHost { return this.#host; }
  dispose(): void {
    this.#closed = true; this.#signal.removeEventListener("abort", this.#onClose);
    this.#host.dispose(); this.#authority.dispose(); this.#verification.dispose();
  }
}
