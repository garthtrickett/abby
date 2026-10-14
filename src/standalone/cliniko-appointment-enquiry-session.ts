import { createWorkflowCallerVerification } from "./workflow-caller-verification.ts";
import { clinikoCredentialFingerprint, isClinikoRequestBudget } from "../cliniko/read-budget.ts";
import { ClinikoVerificationContactReader } from "../cliniko/verification-contact.ts";
import type { AppointmentHost } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { AppointmentRead, AppointmentReadFailure, LocationScope, Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import type { ClinikoCancellationSessionConfig } from "./cliniko-cancellation-session.ts";
import { OwnerFileCallerPolicy } from "./owner-file-caller-policy.ts";
import { OwnerFileAppointmentReadPolicy } from "./owner-file-appointment-read-policy.ts";
import { VerifiedAppointmentReadSession } from "./verified-appointment-read-session.ts";

type Config = Omit<ClinikoCancellationSessionConfig, "cancellationApprovalPath"> & Readonly<{ readApprovalPath: string }>;
const denied = <T>(): Result<T, AppointmentReadFailure> => err({ kind: "invalidProof" });

/** Independent admitted read owner. No writer, cancellation terms or shared clinical proof exists here. */
export class ClinikoAppointmentEnquirySession {
  readonly #config: Config;
  readonly #verification: CallerVerificationSession;
  readonly #policy: OwnerFileAppointmentReadPolicy;
  readonly #reads: VerifiedAppointmentReadSession;
  readonly #lifetime = new AbortController();
  readonly #onClose = () => this.dispose();
  #busy = false;
  private constructor(config: Config, verification: CallerVerificationSession, policy: OwnerFileAppointmentReadPolicy, reads: VerifiedAppointmentReadSession) {
    this.#config = config; this.#verification = verification; this.#policy = policy; this.#reads = reads;
    config.signal.addEventListener("abort", this.#onClose, { once: true });
    if (config.signal.aborted) this.dispose();
  }
  static async create(incoming: Config): Promise<Result<ClinikoAppointmentEnquirySession, Readonly<{ kind: "enquiryUnavailable" }>>> {
    const unavailable = () => err({ kind: "enquiryUnavailable" as const });
    let verification: CallerVerificationSession | undefined, reads: VerifiedAppointmentReadSession | undefined;
    let completed: ClinikoAppointmentEnquirySession | undefined;
    try {
      if (!(incoming.signal instanceof AbortSignal) || incoming.signal.aborted || !isClinikoRequestBudget(incoming.cliniko.rateBudget)) return unavailable();
      const config = Object.freeze({ ...incoming, ...(incoming.representative ? { representative: Object.freeze({ ...incoming.representative }) } : {}), receipt: structuredClone(incoming.receipt), inbound: structuredClone(incoming.inbound),
        cliniko: Object.freeze({ ...incoming.cliniko }), clock: incoming.clock ?? (() => new Date().toISOString()) });
      const signal = AbortSignal.any([config.signal, AbortSignal.timeout(15_000)]), scope = config.receipt.scope;
      const building = (async () => {
        const caller = await OwnerFileCallerPolicy.capture({ path: config.callerApprovalPath, scope, policyVersion: config.policyVersion,
          operation: "appointments.read", directory: config.directory, clock: config.clock });
        const terms = await OwnerFileAppointmentReadPolicy.capture({ path: config.readApprovalPath, scope, policyVersion: config.policyVersion,
          ...config.cliniko, credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey), directory: config.directory, clock: config.clock });
        if (!caller.ok || !terms.ok || signal.aborted) return undefined;
        const policy = { operation: "appointments.read" as const, current: async (bound: LocationScope) => {
          const method = await caller.value.current(bound);
          if (!method.ok) return method;
          const current = await terms.value.current(bound);
          return ok({ ...method.value, enabled: method.value.enabled && current.ok });
        } };
        const session = await createWorkflowCallerVerification({ ...config, operation: "appointments.read", policyStore: config.policies,
          policy, budget: config.verificationBudget, contact: new ClinikoVerificationContactReader({ ...config.cliniko, scope }, config.fetchPort), clock: config.clock }, { credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey), businessId: config.cliniko.businessId, timeZone: config.cliniko.timeZone }, signal, caller.value, config.representative);
        if (!session.ok) return undefined;
        verification = session.value;
        if (signal.aborted) { verification.dispose(); return undefined; }
        const approved = await terms.value.current(scope);
        if (!approved.ok || signal.aborted) return undefined;
        const reader = VerifiedAppointmentReadSession.fromVerification({ verification, scope, cliniko: { ...config.cliniko, maxStartAdvanceDays: approved.value.searchDays },
          ...(config.fetchPort ? { fetchPort: config.fetchPort } : {}), clock: config.clock });
        if (!reader.ok) return undefined;
        reads = reader.value;
        if (signal.aborted) { reads.dispose(); verification.dispose(); return undefined; }
        return new ClinikoAppointmentEnquirySession(config, verification, terms.value, reads);
      })();
      const built = await awaitUntilAbort(building, signal);
      if (!built || signal.aborted) {
        void building.then(late => late?.dispose(), () => undefined);
        return unavailable();
      }
      completed = built; return ok(built);
    } catch { return unavailable(); }
    finally { if (!completed) { reads?.dispose(); verification?.dispose(); } }
  }
  beginVerification() { return this.#verification.begin(); }
  submitCode(code: string) { return this.#verification.submitCode(code); }
  verified(signal?: AbortSignal) { return this.#verification.verified(signal); }
  async searchRange(now: string) {
    const terms = await this.#policy.current(this.#config.receipt.scope);
    const at = Date.parse(now);
    if (this.#lifetime.signal.aborted || !terms.ok || !Number.isFinite(at)) return undefined;
    return { from: now, to: new Date(at + terms.value.searchDays * 86_400_000).toISOString() };
  }
  async read(from: string, to: string, now: string, external: AbortSignal): Promise<Result<AppointmentRead, AppointmentReadFailure>> {
    return this.#withProof(now, external, async proof => {
      const range = await this.searchRange((this.#config.clock ?? (() => new Date().toISOString()))());
      // The public intent is resolved before the media turn is committed. Match
      // the protected reader's 30-second clock tolerance, using the owner clock.
      if (!range || Date.parse(from) < Date.parse(range.from) - 30_000 || Date.parse(to) > Date.parse(range.to)) return err({ kind: "invalidRange" });
      const result = await this.#reads.appointments.list(this.#config.receipt.scope, proof, from, to, now);
      return result.ok && result.value.timeZone !== this.#config.cliniko.timeZone ? err({ kind: "malformed" }) : result;
    });
  }
  async select(choice: 1 | 2 | 3, now: string, external: AbortSignal): ReturnType<NonNullable<AppointmentHost["select"]>> {
    return this.#withProof(now, external, async proof => {
      const result = await this.#reads.appointments.select!(this.#config.receipt.scope, proof, choice, now);
      return result.ok && result.value.snapshot.timeZone !== this.#config.cliniko.timeZone ? err({ kind: "malformed" }) : result;
    });
  }
  async #withProof<T>(now: string, external: AbortSignal, run: (proof: string) => Promise<Result<T, AppointmentReadFailure>>): Promise<Result<T, AppointmentReadFailure>> {
    const suppliedAt = Date.parse(now), observedAt = Date.parse((this.#config.clock ?? (() => new Date().toISOString()))());
    if (this.#busy || this.#lifetime.signal.aborted || external.aborted || !Number.isFinite(suppliedAt) || !Number.isFinite(observedAt) || Math.abs(suppliedAt - observedAt) > 30_000) return denied();
    this.#busy = true;
    const signal = AbortSignal.any([external, this.#lifetime.signal, AbortSignal.timeout(20_000)]);
    try {
      const proof = await awaitUntilAbort(this.#verification.verified(signal), signal);
      if (!proof || signal.aborted) return denied();
      const result = await awaitUntilAbort(run(proof.verificationRef), signal);
      if (!result || signal.aborted || !await this.#verification.verified(signal) || signal.aborted) return denied();
      return result;
    } catch { return err({ kind: "unavailable" }); }
    finally { this.#busy = false; }
  }
  dispose(): void { this.#lifetime.abort(); this.#config.signal.removeEventListener("abort", this.#onClose); this.#reads.dispose(); this.#verification.dispose(); }
}
