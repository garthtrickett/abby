import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { ClinikoVerificationContactReader } from "../cliniko/verification-contact.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import { ClinikoCallFlow } from "./cliniko-call-flow.ts";
import { ClinikoRepresentativeSelection } from "./cliniko-representative-selection.ts";
import type { ClinicRepresentativePermission, RepresentativeIdentity } from "./cliniko-representative-selection.ts";
import type { ClinikoBookingSessionConfig } from "./cliniko-booking-session.ts";
import type { PatientVerificationPermission } from "./email-patient-authority.ts";
import { OwnerFileCallerPolicy } from "./owner-file-caller-policy.ts";
import { OwnerFileRepresentativePolicy } from "./owner-file-representative-policy.ts";

type Operation = "book" | "cancel" | "reschedule" | "appointments.read";
type Context = Pick<ClinikoBookingSessionConfig, "receipt" | "inbound" | "sessionId" | "policyVersion" | "ledger" | "policies" |
  "lookup" | "verificationBudget" | "delivery" | "directory" | "cliniko" | "signal" | "fetchPort" | "clock">;
type Config = Readonly<{ context: Context; flow: ClinikoCallFlow; operation: Operation;
  serviceChoice?: import("../core/booking-service-choice.ts").BookingServiceChoice;
  callerApprovalPath: string; callerPermission: PatientVerificationPermission;
  representativeApprovalPath: string; representativeCallerApprovalPath: string; permission: ClinicRepresentativePermission }>;
type Failure = Readonly<{ kind: "representativeUnavailable" }>;
const denied = <T>(): Result<T, Failure> => err({ kind: "representativeUnavailable" });
const patientOperation = { book: "appointments.book", cancel: "appointments.cancel", reschedule: "appointments.reschedule", "appointments.read": "appointments.read" } as const;

/** Call-owned private verification. The caller has a native self channel and
 * separate permission; their proof never becomes the selected patient's proof.
 * This owner retains the caller throughout the delegated workflow lifetime. */
export class ClinikoRepresentativeCallOwner {
  readonly #config: Config;
  readonly #actor: CallerVerificationSession;
  readonly #selection: ClinikoRepresentativeSelection;
  readonly #lifetime: AbortController;
  readonly #onClose = () => this.dispose();
  #busy = false;
  #attempted = false;
  #routed = false;
  private constructor(config: Config, actor: CallerVerificationSession, selection: ClinikoRepresentativeSelection, lifetime: AbortController) {
    this.#config = config; this.#actor = actor; this.#selection = selection; this.#lifetime = lifetime;
    config.context.signal.addEventListener("abort", this.#onClose, { once: true });
    if (config.context.signal.aborted) this.dispose();
  }
  static async create(incoming: Config): Promise<Result<ClinikoRepresentativeCallOwner, Failure>> {
    const lifetime = new AbortController();
    let actor: CallerVerificationSession | undefined, selection: ClinikoRepresentativeSelection | undefined;
    let completed: ClinikoRepresentativeCallOwner | undefined;
    try {
      if (!incoming || !(incoming.flow instanceof ClinikoCallFlow) || !(incoming.context?.signal instanceof AbortSignal) ||
          incoming.context.signal.aborted || !Object.hasOwn(patientOperation, incoming.operation) ||
          !incoming.flow.matchesPrivateVerificationContext(incoming.context)) return denied();
      const context = Object.freeze({ ...incoming.context, receipt: structuredClone(incoming.context.receipt), inbound: structuredClone(incoming.context.inbound),
        cliniko: Object.freeze({ ...incoming.context.cliniko }), clock: incoming.context.clock ?? (() => new Date().toISOString()),
        signal: AbortSignal.any([incoming.context.signal, lifetime.signal]) });
      const config = Object.freeze({ ...incoming, context, ...(incoming.serviceChoice ? { serviceChoice: structuredClone(incoming.serviceChoice) } : {}) });
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]), scope = context.receipt.scope;
      const building = (async () => {
        const [caller, process] = await Promise.all([
          OwnerFileCallerPolicy.capture({ path: config.callerApprovalPath, scope, policyVersion: context.policyVersion,
            operation: "appointments.read", directory: context.directory, clock: context.clock }),
          OwnerFileRepresentativePolicy.capture({ path: config.representativeApprovalPath, scope, policyVersion: context.policyVersion,
            businessId: context.cliniko.businessId, credentialFingerprint: clinikoCredentialFingerprint(context.cliniko.apiKey),
            timeZone: context.cliniko.timeZone, directory: context.directory, clock: context.clock }),
        ]);
        if (!caller.ok || !process.ok || signal.aborted || !config.flow.matchesPrivateVerificationContext(context)) return undefined;
        const policy = { operation: "appointments.read" as const, current: async (bound: typeof scope) => {
          const method = await caller.value.current(bound), current = await process.value.current(bound);
          return method.ok ? ok({ ...method.value, enabled: method.value.enabled && current.ok &&
            current.value.operations.includes(patientOperation[config.operation]) && config.flow.matchesPrivateVerificationContext(context) }) : method;
        } };
        const made = CallerVerificationSession.create({ ...context, operation: "appointments.read", policyStore: context.policies,
          policy, contact: new ClinikoVerificationContactReader({ ...context.cliniko, scope }, context.fetchPort),
          permission: config.callerPermission, budget: context.verificationBudget });
        if (!made.ok) return undefined;
        actor = made.value;
        if (signal.aborted) { actor.dispose(); return undefined; }
        selection = new ClinikoRepresentativeSelection({ ...context, actor, actorOperation: "appointments.read", policy: process.value,
          representativeCallerApprovalPath: config.representativeCallerApprovalPath, permission: config.permission });
        if (signal.aborted || !config.flow.matchesPrivateVerificationContext(context)) { selection.dispose(); actor.dispose(); return undefined; }
        return new ClinikoRepresentativeCallOwner(config, actor, selection, lifetime);
      })();
      const built = await awaitUntilAbort(building, signal);
      if (!built || signal.aborted) { void building.then(late => late?.dispose(), () => undefined); return denied(); }
      completed = built; return ok(built);
    } catch { return denied(); }
    finally { if (!completed) { lifetime.abort(); selection?.dispose(); actor?.dispose(); } }
  }
  get closed(): boolean { return this.#lifetime.signal.aborted; }
  get operation(): Operation { return this.#config.operation; }
  binding() { return { callId: this.#config.context.receipt.callId, sessionId: this.#config.context.sessionId }; }
  async privateStartupReady(): Promise<boolean> {
    const c = this.#config.context, state = await c.ledger.read(c.receipt.callId, c.receipt.scope);
    return !this.closed && this.#config.flow.matchesPrivateVerificationContext(c) && state.ok && !state.value.callerIdentityDenied &&
      !state.value.pendingPresentationId && Object.values(state.value.presentations).every(item => item.status !== "started" && item.status !== "possiblySent");
  }
  beginCallerVerification(): boolean {
    if (this.closed || !this.#config.flow.matchesPrivateVerificationContext(this.#config.context)) return false;
    this.#actor.begin(); return true;
  }
  async submitCallerCode(code: string): Promise<Readonly<{ verified: boolean }>> {
    if (this.closed || !this.#config.flow.matchesPrivateVerificationContext(this.#config.context)) return { verified: false };
    const result = await this.#actor.submitCode(code);
    return !this.closed && this.#config.flow.matchesPrivateVerificationContext(this.#config.context) ? result : { verified: false };
  }
  beginPatientVerification(): boolean {
    return !this.closed && this.#routed && this.#config.flow.matchesPrivateVerificationContext(this.#config.context) && this.#config.flow.beginVerification();
  }
  async selectPatient(identity: RepresentativeIdentity, expectedRevision?: number, external?: AbortSignal): Promise<Result<Readonly<{ codeRequired: true }>, Failure>> {
    if (this.closed || this.#busy || this.#attempted || external?.aborted || !this.#config.flow.matchesPrivateVerificationContext(this.#config.context)) return denied();
    this.#busy = true; this.#attempted = true;
    const signal = AbortSignal.any([this.#config.context.signal, this.#lifetime.signal, AbortSignal.timeout(20_000), ...(external ? [external] : [])]);
    try {
      const selected = await this.#selection.select(structuredClone(identity), patientOperation[this.#config.operation], signal);
      if (!selected.ok || signal.aborted || !this.#config.flow.matchesPrivateVerificationContext(this.#config.context)) return denied();
      const routed = await this.#config.flow.chooseRepresentative(this.#config.operation, { owner: this.#selection, selectionRef: selected.value.selectionRef }, signal, expectedRevision, this.#config.serviceChoice);
      this.#routed = routed.ok && !signal.aborted && !this.closed;
      return this.#routed ? ok({ codeRequired: true as const }) : denied();
    } catch { return denied(); }
    finally { this.#busy = false; }
  }
  dispose(): void {
    this.#config.context.signal.removeEventListener("abort", this.#onClose); this.#lifetime.abort(); this.#selection.dispose(); this.#actor.dispose();
  }
}
