import { clinikoCredentialFingerprint, isClinikoRequestBudget } from "../cliniko/read-budget.ts";
import { ClinikoVerificationContactReader } from "../cliniko/verification-contact.ts";
import { ClinikoPreviousPractitionerReader } from "../cliniko/previous-practitioner.ts";
import { err, ok } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import { OwnerFileCallerPolicy } from "./owner-file-caller-policy.ts";
import { OwnerFileAppointmentHistoryPolicy } from "./owner-file-appointment-history-policy.ts";
import type { ClinikoCancellationSessionConfig } from "./cliniko-cancellation-session.ts";

type Config = Omit<ClinikoCancellationSessionConfig, "cancellationApprovalPath" | "representative"> & Readonly<{ historyApprovalPath: string }>;
const denied = () => err({ kind: "historyUnavailable" as const });
/** A separate history approval and read verifier. No booking writer or grant
 * reuse is available in this owner. Clinical history remains volatile. */
export class ClinikoPractitionerHistorySession {
  readonly #config: Config;
  readonly #verification: CallerVerificationSession;
  readonly #policy: OwnerFileAppointmentHistoryPolicy;
  readonly #reader: ClinikoPreviousPractitionerReader;
  readonly #lifetime = new AbortController();
  readonly #onClose = () => this.dispose();
  #busy = false;
  private constructor(config: Config, verification: CallerVerificationSession, policy: OwnerFileAppointmentHistoryPolicy, reader: ClinikoPreviousPractitionerReader) {
    this.#config = config; this.#verification = verification; this.#policy = policy; this.#reader = reader;
    config.signal.addEventListener("abort", this.#onClose, { once: true }); if (config.signal.aborted) this.dispose();
  }
  static async create(incoming: Config) {
    let verification: CallerVerificationSession | undefined, completed = false;
    try {
      if (incoming.signal.aborted || !isClinikoRequestBudget(incoming.cliniko.rateBudget)) return denied();
      const config = Object.freeze({ ...incoming, receipt: structuredClone(incoming.receipt), inbound: structuredClone(incoming.inbound),
        cliniko: Object.freeze({ ...incoming.cliniko }), clock: incoming.clock ?? (() => new Date().toISOString()) });
      const signal = AbortSignal.any([config.signal, AbortSignal.timeout(15000)]), scope = config.receipt.scope;
      const caller = await awaitUntilAbort(OwnerFileCallerPolicy.capture({ path: config.callerApprovalPath, scope, policyVersion: config.policyVersion,
        operation: "appointments.read", directory: config.directory, clock: config.clock }), signal);
      const terms = await awaitUntilAbort(OwnerFileAppointmentHistoryPolicy.capture({ path: config.historyApprovalPath, scope, policyVersion: config.policyVersion,
        ...config.cliniko, credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey), directory: config.directory, clock: config.clock }), signal);
      if (!caller?.ok || !terms?.ok || signal.aborted) return denied();
      const policy = { operation: "appointments.read" as const, current: async (bound: typeof scope) => {
        const method = await caller.value.current(bound); if (!method.ok) return method;
        const current = await terms.value.current(bound); return ok({ ...method.value, enabled: method.value.enabled && current.ok });
      } };
      const created = CallerVerificationSession.create({ ...config, operation: "appointments.read", policyStore: config.policies, policy,
        budget: config.verificationBudget, contact: new ClinikoVerificationContactReader({ ...config.cliniko, scope }, config.fetchPort) });
      if (!created.ok || signal.aborted) { if (created.ok) created.value.dispose(); return denied(); }
      verification = created.value;
      const current = await terms.value.current(scope); if (!current.ok || signal.aborted) return denied();
      const reader = new ClinikoPreviousPractitionerReader({ ...config.cliniko, scope, lookBackDays: current.value.lookBackDays }, verification.proof, config.fetchPort);
      const session = new ClinikoPractitionerHistorySession(config, verification, terms.value, reader); completed = true; return ok(session);
    } catch { return denied(); }
    finally { if (!completed) verification?.dispose(); }
  }
  beginVerification() { return this.#verification.begin(); }
  submitCode(code: string) { return this.#verification.submitCode(code); }
  verified(signal?: AbortSignal) { return this.#verification.verified(signal); }
  async read(now: string, external: AbortSignal) {
    if (this.#busy || this.#lifetime.signal.aborted || external.aborted || !Number.isFinite(Date.parse(now)) ||
        Math.abs(Date.parse(now) - Date.parse((this.#config.clock ?? (() => new Date().toISOString()))())) > 30000) return denied();
    this.#busy = true;
    const signal = AbortSignal.any([this.#lifetime.signal, external, AbortSignal.timeout(20000)]);
    try {
      const terms = await awaitUntilAbort(this.#policy.current(this.#config.receipt.scope), signal);
      const proof = await awaitUntilAbort(this.#verification.verified(signal), signal);
      if (!terms?.ok || !proof || signal.aborted) return denied();
      const read = await awaitUntilAbort(this.#reader.read(proof.verificationRef, now, signal), signal);
      const after = await awaitUntilAbort(this.#policy.current(this.#config.receipt.scope), signal);
      if (!read?.ok || !after?.ok || signal.aborted || !await this.#verification.verified(signal)) return denied();
      return ok({ ...read.value, lookBackDays: terms.value.lookBackDays });
    } catch { return denied(); }
    finally { this.#busy = false; }
  }
  dispose() { this.#lifetime.abort(); this.#config.signal.removeEventListener("abort", this.#onClose); this.#verification.dispose(); }
}
