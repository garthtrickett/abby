import { ClinikoReschedulingMenu } from "./cliniko-rescheduling-menu.ts";
import { ClinikoCancellationWriter } from "../cliniko/cancellation-write.ts";
import { OwnerFileReschedulingPolicy } from "./owner-file-rescheduling-policy.ts";
import { ClinikoRescheduleWriter } from "../cliniko/reschedule-write.ts";
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
import { ClinikoReschedulingAuthority } from "./cliniko-rescheduling-authority.ts";
import { ClinikoReschedulingHost } from "./cliniko-rescheduling-host.ts";
import type { PatientCodeDelivery, PatientVerificationBudget, PatientVerificationPermission } from "./email-patient-authority.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { OwnerFileCallerPolicy } from "./owner-file-caller-policy.ts";
import { OwnerFileBookingPolicy } from "./owner-file-booking-policy.ts";

export type ClinikoReschedulingSessionConfig = Readonly<{
  receipt: AdmissionReceipt; inbound: AuthenticatedInboundCall; sessionId: string; policyVersion: string;
  ledger: LedgerStore; policies: PolicyStore; lookup: CallerCandidateLookup;
  permission: PatientVerificationPermission; verificationBudget: PatientVerificationBudget; delivery: PatientCodeDelivery;
  directory: AdminDirectory; callerApprovalPath: string; bookingApprovalPath: string; reschedulingApprovalPath: string;
  destination?: Readonly<{ practitionerId: string; bookingApprovalPath: string }>;
  practitioners?: readonly Readonly<{ practitionerId: string; bookingApprovalPath: string }>[];
  cliniko: Readonly<{ apiKey: string; contactEmail: string; businessId: string; practitionerId: string; appointmentTypeId: string; recallTypeId: string;
    timeZone: string; countryCallingCode: string; rateBudget: ClinikoRequestBudget }>;
  signal: AbortSignal; fetchPort?: typeof fetch; clock?: () => string; timeoutMs?: number;
}>;
type Failure = Readonly<{ kind: "reschedulingSessionUnavailable" }>;

/** Trusted post-admission wiring. One admission owns one verifier, selection map and send attempt.
 * These ports belong to the call owner, never to a model/caller or an activation endpoint. */
export class ClinikoReschedulingSession {
  readonly #verification: CallerVerificationSession;
  readonly #authority: ClinikoReschedulingAuthority;
  readonly #host: ClinikoReschedulingHost;
  readonly #signal: AbortSignal;
  readonly #menu: ClinikoReschedulingMenu;
  readonly #onClose = () => this.dispose();
  #closed = false;
  private constructor(verification: CallerVerificationSession, authority: ClinikoReschedulingAuthority,
    host: ClinikoReschedulingHost, menu: ClinikoReschedulingMenu, signal: AbortSignal) {
    this.#verification = verification; this.#authority = authority; this.#host = host; this.#signal = signal; this.#menu = menu;
    signal.addEventListener("abort", this.#onClose, { once: true });
    if (signal.aborted) this.dispose();
  }

  static async create(incoming: ClinikoReschedulingSessionConfig): Promise<Result<ClinikoReschedulingSession, Failure>> {
    const unavailable = (): Result<ClinikoReschedulingSession, Failure> => err({ kind: "reschedulingSessionUnavailable" });
    let timeout: ReturnType<typeof setTimeout> | undefined, removeAbort: () => void = () => undefined;
    let verification: CallerVerificationSession | undefined, authority: ClinikoReschedulingAuthority | undefined;
    let host: ClinikoReschedulingHost | undefined, completed: ClinikoReschedulingSession | undefined;
    let menu: ClinikoReschedulingMenu | undefined;
    let settled = false;
    const dispose = () => { host?.dispose(); menu?.dispose(); authority?.dispose(); verification?.dispose(); };
    try {
      if (!incoming || !(incoming.signal instanceof AbortSignal) || incoming.signal.aborted ||
          incoming.destination && incoming.practitioners !== undefined ||
          incoming.practitioners !== undefined && (!Array.isArray(incoming.practitioners) || incoming.practitioners.length > 23) ||
          !isClinikoRequestBudget(incoming.cliniko?.rateBudget) ||
          (incoming.timeoutMs !== undefined && (!Number.isSafeInteger(incoming.timeoutMs) || incoming.timeoutMs < 1 || incoming.timeoutMs > 20_000))) return unavailable();
      // Freeze caller/provider bindings before the first async approval read.
      const config = Object.freeze({ ...incoming, receipt: structuredClone(incoming.receipt), inbound: structuredClone(incoming.inbound),
        ...(incoming.destination ? { destination: Object.freeze({ ...incoming.destination }) } : {}),
        ...(incoming.practitioners ? { practitioners: Object.freeze(incoming.practitioners.map(member => Object.freeze({ ...member }))) } : {}),
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
          state.value.admission?.key.accountRef === config.receipt.admission.key.accountRef &&
          state.value.admission?.key.providerCallRef === config.receipt.admission.key.providerCallRef &&
          state.value.sessionLease?.sessionId === config.sessionId && Date.parse(state.value.sessionLease.expiresAt) > at &&
          state.value.policy.policyVersion === config.policyVersion;
      };
      const build = (async () => {
        if (!await active() || settled) return undefined;
        const caller = await OwnerFileCallerPolicy.capture({ path: config.callerApprovalPath, scope, policyVersion: config.policyVersion,
          operation: "appointments.reschedule", directory: config.directory, clock: config.clock });
        if (!caller.ok || settled) return undefined;
        const destinationId = config.destination?.practitionerId ?? config.cliniko.practitionerId;
        const policy = await OwnerFileBookingPolicy.capture({ path: config.destination?.bookingApprovalPath ?? config.bookingApprovalPath, scope,
          policyVersion: config.policyVersion, businessId: config.cliniko.businessId, practitionerId: destinationId, appointmentTypeId: config.cliniko.appointmentTypeId, recallTypeId: config.cliniko.recallTypeId,
          credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey), timeZone: config.cliniko.timeZone,
          directory: config.directory, clock: config.clock });
        if (!policy.ok || settled) return undefined;
        const fees = await OwnerFileReschedulingPolicy.capture({ path: config.reschedulingApprovalPath, scope,
          policyVersion: config.policyVersion, businessId: config.cliniko.businessId, recallTypeId: config.cliniko.recallTypeId,
          credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey), timeZone: config.cliniko.timeZone,
          directory: config.directory, clock: config.clock });
        if (!fees.ok || settled) return undefined;
        const practitionerPolicies: OwnerFileBookingPolicy[] = [];
        for (const member of config.practitioners ?? []) {
          const captured = await OwnerFileBookingPolicy.capture({ path: member.bookingApprovalPath, scope,
            policyVersion: config.policyVersion, businessId: config.cliniko.businessId, practitionerId: member.practitionerId,
            appointmentTypeId: config.cliniko.appointmentTypeId, recallTypeId: config.cliniko.recallTypeId,
            credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey), timeZone: config.cliniko.timeZone,
            directory: config.directory, clock: config.clock });
          if (!captured.ok || settled) return undefined;
          practitionerPolicies.push(captured.value);
        }
        if (destinationId !== config.cliniko.practitionerId) {
          const destination = await policy.value.current(scope), current = await fees.value.current(scope);
          if (!destination.ok || !current.ok || !current.value.practitionerMoves?.some(move => move.fromPractitionerId === config.cliniko.practitionerId &&
              move.toPractitionerId === destinationId && move.appointmentTypeId === config.cliniko.appointmentTypeId && move.durationMinutes === destination.value.durationMinutes)) return undefined;
        }
        const verificationPolicy = { operation: "appointments.reschedule" as const, current: async (bound: typeof scope) => {
          const method = await caller.value.current(bound);
          if (!method.ok) return method;
          const terms = await policy.value.current(bound);
          const fee = await fees.value.current(bound);
          const current = await config.policies.read(bound);
          const admitted = await config.ledger.read(config.receipt.callId, bound);
          return ok({ ...method.value, enabled: method.value.enabled && terms.ok && fee.ok && current.ok &&
            current.value.policyVersion === config.policyVersion && current.value.reschedulingEnabled === true &&
            current.value.capabilities.reschedule === "execute" && current.value.staffWorkEnabled === true && admitted.ok &&
            admitted.value.policy.capabilities.reschedule === "execute" && admitted.value.policy.staffWorkEnabled === true });
        } };
        const session = CallerVerificationSession.create({ receipt: config.receipt, inbound: config.inbound, sessionId: config.sessionId,
          policyVersion: config.policyVersion, operation: "appointments.reschedule", ledger: config.ledger, policyStore: config.policies,
          policy: verificationPolicy, lookup: config.lookup, contact: new ClinikoVerificationContactReader({ ...config.cliniko, scope }, fetchPort),
          permission: config.permission, budget: config.verificationBudget, delivery: config.delivery, clock: config.clock, ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) });
        if (!session.ok || settled) return undefined;
        verification = session.value;
        const source = ClinikoReschedulingAuthority.create({ ...config.cliniko, practitionerId: destinationId, scope, callId: config.receipt.callId,
          sessionId: config.sessionId, policyVersion: config.policyVersion, proof: verification.proof,
          policy: policy.value, feePolicy: fees.value, ...(config.practitioners !== undefined ? { practitionerPolicies } : {}), clock: config.clock, ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) }, fetchPort);
        const cancellation = ClinikoCancellationWriter.create({ ...config.cliniko, scope }, fetchPort, config.clock);
        const rescheduling = ClinikoRescheduleWriter.create({ ...config.cliniko, scope }, fetchPort, config.clock);
        const recalls = ClinikoRecallWriter.create({ ...config.cliniko, scope }, fetchPort);
        if (!source.ok || !rescheduling.ok || !cancellation.ok || !recalls.ok || settled) return undefined;
        authority = source.value;
        menu = new ClinikoReschedulingMenu({ verification, authority, scope, callId: config.receipt.callId, sessionId: config.sessionId, policyVersion: config.policyVersion });
        host = new ClinikoReschedulingHost({ scope, callId: config.receipt.callId, sessionId: config.sessionId,
          policyVersion: config.policyVersion, ledger: config.ledger, policy: config.policies, proof: verification.proof, authority,
          menu,
          timeZone: config.cliniko.timeZone, recallTypeId: config.cliniko.recallTypeId, rescheduling: rescheduling.value, cancellation: cancellation.value,
          businessId: config.cliniko.businessId, credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey),
          recallWriter: recalls.value, clock: config.clock });
        if (settled || config.signal.aborted || !await active() || settled) return undefined;
        completed = new ClinikoReschedulingSession(verification, authority, host, menu, config.signal);
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
  verified(): ReturnType<CallerVerificationSession["verified"]> { return this.#verification.verified(); }
  get selections(): ClinikoReschedulingAuthority { return this.#authority; }
  get effects(): ClinikoReschedulingHost { return this.#host; }
  dispose(): void {
    this.#closed = true; this.#signal.removeEventListener("abort", this.#onClose);
    this.#host.dispose(); this.#menu.dispose(); this.#authority.dispose(); this.#verification.dispose();
  }
}
