import { clinikoCredentialFingerprint, isClinikoRequestBudget } from "../cliniko/read-budget.ts";
import { ClinikoVerificationContactReader } from "../cliniko/verification-contact.ts";
import { err, ok } from "../core/model.ts";
import type { CallPolicy, Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import { declareClinikoRequestCost } from "../cliniko/request-cost.ts";
import type { ClinikoBookingSessionConfig } from "./cliniko-booking-session.ts";
import { ClinikoClassBookingHost } from "./cliniko-class-booking-host.ts";
import type { ClassAttendancePermission } from "./cliniko-class-booking-host.ts";
import type { ClassPassAuthority } from "./cliniko-class-pass-booking.ts";
import type { ClassPassCancellationAuthority } from "./cliniko-class-pass-cancellation.ts";
import type { ClassPassMoveAuthority } from "./cliniko-class-pass-movement.ts";
import { ClinikoClassCancellationHost } from "./cliniko-class-cancellation-host.ts";
import type { ClassCancellationPermission } from "./cliniko-class-cancellation-host.ts";
import { OwnerFileCallerPolicy } from "./owner-file-caller-policy.ts";
import { OwnerFileCancellationPolicy } from "./owner-file-cancellation-policy.ts";
import { OwnerFileClassPolicy } from "./owner-file-class-policy.ts";
import { OwnerFileClassMovePolicy } from "./owner-file-class-move-policy.ts";
import { ClinikoClassMoveHost } from "./cliniko-class-move-host.ts";
import type { ClassMovePermission } from "./cliniko-class-move-host.ts";

type Common = Omit<ClinikoBookingSessionConfig, "bookingApprovalPath" | "catalogue" | "representative"> & Readonly<{ classApprovalPath: string }>;
export type ClinikoClassSessionConfig = Common & (
  Readonly<{ operation: "book"; classPermission: ClassAttendancePermission; classPassAuthority?: ClassPassAuthority }> |
  Readonly<{ operation: "cancel"; classPermission: ClassCancellationPermission; cancellationApprovalPath: string; classPassCancellationAuthority?: ClassPassCancellationAuthority }> |
  Readonly<{ operation: "reschedule"; classPermission: ClassMovePermission; moveApprovalPath: string; classPassMoveAuthority?: ClassPassMoveAuthority;
    destination: Readonly<{ classApprovalPath: string; practitionerId: string; appointmentTypeId: string }> }>
);
type Failure = Readonly<{ kind: "classSessionUnavailable" }>;
type ClassHost = ClinikoClassBookingHost | ClinikoClassCancellationHost | ClinikoClassMoveHost;

/** An admitted call owns its verifier and exactly one class operation. A class
 * service approval, operation approval and patient permission remain separate. */
export class ClinikoClassSession {
  readonly #verification: CallerVerificationSession;
  readonly #host: ClassHost;
  readonly #lifetime: AbortController;
  readonly #signal: AbortSignal;
  readonly #policy: OwnerFileClassPolicy;
  readonly operation: "book" | "cancel" | "reschedule";
  readonly #onClose = () => this.dispose();
  private constructor(operation: "book" | "cancel" | "reschedule", verification: CallerVerificationSession,
    host: ClassHost, lifetime: AbortController, signal: AbortSignal, policy: OwnerFileClassPolicy) {
    this.operation = operation; this.#verification = verification; this.#host = host;
    this.#lifetime = lifetime; this.#signal = signal; this.#policy = policy;
    signal.addEventListener("abort", this.#onClose, { once: true });
    if (signal.aborted) this.dispose();
  }

  static async create(incoming: ClinikoClassSessionConfig): Promise<Result<ClinikoClassSession, Failure>> {
    const unavailable = (): Result<ClinikoClassSession, Failure> => err({ kind: "classSessionUnavailable" });
    const lifetime = new AbortController();
    let verification: CallerVerificationSession | undefined;
    let host: ClassHost | undefined;
    let published = false;
    const dispose = () => { lifetime.abort(); host?.dispose(); verification?.dispose(); };
    try {
      if (!incoming || !(incoming.signal instanceof AbortSignal) || incoming.signal.aborted ||
          Object.hasOwn(incoming, "representative") || !["book", "cancel", "reschedule"].includes(incoming.operation) ||
          incoming.operation === "reschedule" && (!incoming.destination || typeof incoming.destination !== "object") ||
          !isClinikoRequestBudget(incoming.cliniko?.rateBudget) ||
          typeof incoming.classPermission?.allows !== "function" ||
          incoming.timeoutMs !== undefined && (!Number.isSafeInteger(incoming.timeoutMs) || incoming.timeoutMs < 1 || incoming.timeoutMs > 20_000)) return unavailable();
      const config = Object.freeze({ ...incoming, receipt: structuredClone(incoming.receipt), inbound: structuredClone(incoming.inbound),
        ...(incoming.operation === "reschedule" ? { destination: Object.freeze({ ...incoming.destination }) } : {}),
        cliniko: Object.freeze({ ...incoming.cliniko }), clock: incoming.clock ?? (() => new Date().toISOString()) });
      const callSignal = AbortSignal.any([config.signal, lifetime.signal]);
      const signal = AbortSignal.any([callSignal, AbortSignal.timeout(config.timeoutMs ?? 15_000)]);
      const scope = config.receipt.scope;
      const operation = config.operation === "book" ? "appointments.book" : config.operation === "cancel" ? "appointments.cancel" : "appointments.reschedule";
      const binding = { scope, policyVersion: config.policyVersion, businessId: config.cliniko.businessId,
        practitionerId: config.cliniko.practitionerId, appointmentTypeId: config.cliniko.appointmentTypeId,
        credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey), recallTypeId: config.cliniko.recallTypeId,
        timeZone: config.cliniko.timeZone, directory: config.directory, clock: config.clock };
      const active = async () => {
        const [state, policy, stop] = await Promise.all([config.ledger.read(config.receipt.callId, scope), config.policies.read(scope), config.ledger.readWriteStop(scope)]);
        const at = Date.parse(config.clock());
        const allowed = (p: CallPolicy) => sameScope(p.scope, scope) && p.policyVersion === config.policyVersion && p.automationEnabled && p.staffWorkEnabled === true &&
          p.capabilities[config.operation] === "execute" && (config.operation === "book" ? p.bookingEnabled === true : config.operation === "cancel" ? p.cancellationEnabled === true : p.reschedulingEnabled === true);
        // This predicate also belongs to the published verifier's current
        // policy. Preparation has its own deadline; only the live call and
        // session disposal may end ongoing verification after publication.
        return !callSignal.aborted && state.ok && policy.ok && stop.ok && !stop.value.stopped && Number.isFinite(at) &&
          state.value.lifecycle === "active" && !state.value.callerIdentityDenied &&
          state.value.admission?.key.accountRef === config.receipt.admission.key.accountRef &&
          state.value.admission?.key.providerCallRef === config.receipt.admission.key.providerCallRef &&
          state.value.sessionLease?.sessionId === config.sessionId && Date.parse(state.value.sessionLease.expiresAt) > at &&
          allowed(state.value.policy) && allowed(policy.value);
      };
      const build = (async () => {
        if (!await active()) return undefined;
        const caller = await OwnerFileCallerPolicy.capture({ path: config.callerApprovalPath, scope, policyVersion: config.policyVersion, operation,
          directory: config.directory, clock: config.clock });
        const classes = await OwnerFileClassPolicy.capture({ ...binding, path: config.classApprovalPath });
        const cancellation = config.operation === "cancel" ? await OwnerFileCancellationPolicy.capture({ ...binding, path: config.cancellationApprovalPath }) : undefined;
        const destination = config.operation === "reschedule" ? await OwnerFileClassPolicy.capture({ ...binding, path: config.destination.classApprovalPath,
          practitionerId: config.destination.practitionerId, appointmentTypeId: config.destination.appointmentTypeId }) : undefined;
        const sourceApproval = classes.ok ? await classes.value.current(scope) : undefined;
        const destinationApproval = destination?.ok ? await destination.value.current(scope) : undefined;
        const movement = config.operation === "reschedule" && sourceApproval?.ok && destinationApproval?.ok
          ? await OwnerFileClassMovePolicy.capture({ ...binding, path: config.moveApprovalPath,
            sourceServiceRef: sourceApproval.value.serviceRef, destinationServiceRef: destinationApproval.value.serviceRef }) : undefined;
        if (!caller.ok || !classes.ok || config.operation === "cancel" && !cancellation?.ok || signal.aborted) return undefined;
        if (config.operation === "cancel" && sourceApproval?.ok && sourceApproval.value.membership === "nativeCaseSessions" &&
          (!sourceApproval.value.caseSessions?.cancellation || typeof config.classPassCancellationAuthority?.select !== "function")) return undefined;
        if (config.operation === "reschedule") {
          const move = movement?.ok ? await movement.value.current(scope) : undefined;
          if (!sourceApproval?.ok || !destination?.ok || !destinationApproval?.ok || !move?.ok ||
            sourceApproval.value.membership !== destinationApproval.value.membership || sourceApproval.value.membership !== move.value.membership ||
            (move.value.membership === "nativeCaseSessions" ? !move.value.passMovement || typeof config.classPassMoveAuthority?.select !== "function" || typeof config.classPassMoveAuthority?.allows !== "function" : config.classPassMoveAuthority !== undefined)) return undefined;
        }
        const method: Parameters<typeof CallerVerificationSession.create>[0]["policy"] = { operation, current: declareClinikoRequestCost(async (bound: typeof scope) => {
          const [identity, service, fees, replacement, move] = await Promise.all([caller.value.current(bound), classes.value.current(bound), cancellation?.ok ? cancellation.value.current(bound) : undefined,
            destination?.ok ? destination.value.current(bound) : undefined, movement?.ok ? movement.value.current(bound) : undefined]);
          return identity.ok ? ok({ ...identity.value, enabled: identity.value.enabled && service.ok && (!cancellation || fees?.ok === true) &&
            (!destination || replacement?.ok === true) && (!movement || move?.ok === true) && await active() }) : identity;
        }, { scope, credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey), budget: config.cliniko.rateBudget }, 0) };
        const currentMethod = await method.current(scope);
        if (!currentMethod.ok || !currentMethod.value.enabled || signal.aborted) return undefined;
        const verified = CallerVerificationSession.create({ receipt: config.receipt, inbound: config.inbound, sessionId: config.sessionId,
          policyVersion: config.policyVersion, operation, ledger: config.ledger, policyStore: config.policies, policy: method,
          lookup: config.lookup, contact: new ClinikoVerificationContactReader({ ...config.cliniko, scope }, config.fetchPort ?? fetch),
          permission: config.permission, budget: config.verificationBudget, delivery: config.delivery, clock: config.clock,
          ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) });
        if (!verified.ok) return undefined;
        verification = verified.value;
        if (signal.aborted) { dispose(); return undefined; }
        const common = { scope, callId: config.receipt.callId, sessionId: config.sessionId, policyVersion: config.policyVersion,
          ledger: config.ledger, policies: config.policies, verification, classPolicy: classes.value, cliniko: config.cliniko,
          clock: config.clock, signal: callSignal, ...(config.fetchPort ? { fetchPort: config.fetchPort } : {}) };
        const created = config.operation === "book" ? await ClinikoClassBookingHost.create({ ...common, permission: config.classPermission,
          ...(config.classPassAuthority ? { classPassAuthority: config.classPassAuthority } : {}) }) :
          config.operation === "cancel" && cancellation?.ok ? await ClinikoClassCancellationHost.create({ ...common, cancellationPolicy: cancellation.value, permission: config.classPermission,
            ...(config.classPassCancellationAuthority ? { classPassCancellationAuthority: config.classPassCancellationAuthority } : {}) }) :
          config.operation === "reschedule" && destination?.ok && movement?.ok ? await ClinikoClassMoveHost.create({ ...common,
            sourcePolicy: classes.value, destinationPolicy: destination.value, movePolicy: movement.value, permission: config.classPermission,
            ...(config.classPassMoveAuthority ? { classPassMoveAuthority: config.classPassMoveAuthority } : {}) }) : undefined;
        if (!created?.ok) return undefined;
        host = created.value;
        const finalMethod = await method.current(scope);
        if (!finalMethod.ok || !finalMethod.value.enabled || !await active() || signal.aborted) { dispose(); return undefined; }
        return new ClinikoClassSession(config.operation, verification, host, lifetime, config.signal, classes.value);
      })();
      const completed = await awaitUntilAbort(build, signal);
      if (!completed || signal.aborted) return unavailable();
      published = true;
      return ok(completed);
    } catch { return unavailable(); }
    finally { if (!published) dispose(); }
  }
  beginVerification() { return this.#verification.begin(); }
  submitCode(code: string) { return this.#verification.submitCode(code); }
  verified(signal?: AbortSignal) { return this.#verification.verified(signal); }
  get effects() { return this.#host; }
  get booking() { return this.#host instanceof ClinikoClassBookingHost ? this.#host : undefined; }
  get appointments() { return this.#host instanceof ClinikoClassCancellationHost ? this.#host : undefined; }
  get rescheduling() { return this.#host instanceof ClinikoClassMoveHost ? this.#host : undefined; }
  async maxBookingSearchDays() {
    if (this.#lifetime.signal.aborted) return undefined;
    const current = await this.#policy.current(this.#policy.binding().scope);
    return current.ok && !this.#lifetime.signal.aborted ? current.value.maxAdvanceDays : undefined;
  }
  dispose() { this.#signal.removeEventListener("abort", this.#onClose); this.#lifetime.abort(); this.#host.dispose(); this.#verification.dispose(); }
}
