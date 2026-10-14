import type { VerificationContact } from "../cliniko/verification-contact.ts";
import { ClinikoVerificationContactReader } from "../cliniko/verification-contact.ts";
import type { PolicyStore } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { AdmissionReceipt, Result, VerifiedPatient } from "../core/model.ts";
import { callIdFor } from "../voice/admission.ts";
import type { AuthenticatedInboundCall } from "../voice/admission.ts";
import type { CallerCandidateLookup } from "../voice/caller-candidates.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { EmailPatientAuthority } from "./email-patient-authority.ts";
import type { PatientCodeDelivery, PatientVerificationBudget, PatientVerificationPermission } from "./email-patient-authority.ts";
import { TransientPatientProofHost } from "./transient-patient-proof.ts";
import type { PatientOperation, VerificationPolicyGate } from "./transient-patient-proof.ts";

type Config = Readonly<{
  receipt: AdmissionReceipt; inbound: AuthenticatedInboundCall; sessionId: string; policyVersion: string;
  operation: PatientOperation; ledger: Pick<LedgerStore, "read" | "readWriteStop">;
  policyStore: Pick<PolicyStore, "read">; policy: VerificationPolicyGate & Readonly<{ operation: PatientOperation }>; lookup: CallerCandidateLookup;
  contact: VerificationContact; permission: PatientVerificationPermission;
  budget: PatientVerificationBudget; delivery: PatientCodeDelivery; clock?: () => string; timeoutMs?: number;
}>;
type Grant = Readonly<{ verificationRef: string; expiresAt: string }>;
export const verificationPrompt = "If you receive a verification code at your registered email, enter it here. I cannot access or change personal appointments until verification succeeds.";

/** Trusted call-owner input, separate from caller turns and every model/agent command.
 * One admission/session owns one challenge, one operation and one private proof. */
export class CallerVerificationSession {
  readonly #config: Config;
  readonly #email: EmailPatientAuthority;
  readonly #proof: TransientPatientProofHost;
  #pending: Promise<void> | undefined;
  #busy = false;
  #closed = false;
  #grant: Grant | undefined;

  private constructor(incoming: Config) {
    const config = Object.freeze({ ...incoming, receipt: structuredClone(incoming.receipt), inbound: structuredClone(incoming.inbound) });
    this.#config = config;
    const scope = this.#config.receipt.scope;
    const policy: VerificationPolicyGate = { current: async bound => {
      if (!sameScope(bound, scope) || !await this.#active()) return ok({ scope, enabled: false, version: config.policyVersion });
      const current = await config.policy.current(scope);
      if (!current.ok) return current;
      // Recheck after an asynchronous approval read; it may have raced a close or policy change.
      return ok({ scope, version: config.policyVersion, enabled: current.value.enabled === true &&
        sameScope(current.value.scope, scope) && current.value.version === config.policyVersion && await this.#active() });
    } };
    const clock = () => this.#now();
    this.#email = new EmailPatientAuthority({ scope, callId: config.receipt.callId, sessionId: config.sessionId,
      policyVersion: config.policyVersion, presentedNumber: config.inbound.presentedCallerNumber!, operations: [config.operation],
      lookup: config.lookup, contact: config.contact, policy, permission: config.permission, budget: config.budget,
      delivery: config.delivery, clock: () => Date.parse(clock()), ...(config.timeoutMs === undefined ? {} : { deadlineMs: config.timeoutMs }) });
    this.#proof = new TransientPatientProofHost({ scope, callId: config.receipt.callId, sessionId: config.sessionId,
      policyVersion: config.policyVersion, presentedCallerNumber: config.inbound.presentedCallerNumber,
      maxAttempts: 1, lookup: config.lookup, authority: this.#email, policy, clock,
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) });
  }

  static create(config: Config): Result<CallerVerificationSession, Readonly<{ kind: "verificationUnavailable" }>> {
    try {
      const { receipt, inbound } = config;
      if (!receipt || !inbound || receipt.lifecycle === "ended" || receipt.callId !== callIdFor(inbound.key) ||
          receipt.admission.key.accountRef !== inbound.key.accountRef ||
          receipt.admission.key.providerCallRef !== inbound.key.providerCallRef || receipt.admission.dialedNumber !== inbound.dialedNumber ||
          typeof config.ledger?.read !== "function" || typeof config.ledger?.readWriteStop !== "function" ||
          typeof config.policyStore?.read !== "function" || config.policy?.operation !== config.operation) return err({ kind: "verificationUnavailable" });
      return ok(new CallerVerificationSession(config));
    } catch { return err({ kind: "verificationUnavailable" }); }
  }

  #now(): string {
    const now = (this.#config.clock ?? (() => new Date().toISOString()))();
    if (!Number.isFinite(Date.parse(now))) throw new Error("verification unavailable");
    return now;
  }

  async #active(): Promise<boolean> {
    const { receipt, inbound, sessionId, policyVersion, operation, ledger, policyStore } = this.#config;
    if (this.#closed) return false;
    const current = await policyStore.read(receipt.scope);
    if (!current.ok || !sameScope(current.value.scope, receipt.scope) || current.value.automationEnabled !== true ||
        current.value.policyVersion !== policyVersion) return false;
    if (operation !== "appointments.read") {
      const stop = await ledger.readWriteStop(receipt.scope);
      if (!stop.ok || stop.value.stopped) return false;
    }
    // Read call ownership last, after any asynchronous policy/stop reads.
    const state = await ledger.read(receipt.callId, receipt.scope);
    if (!state.ok || state.value.callId !== receipt.callId || state.value.lifecycle !== "active" || state.value.callerIdentityDenied !== undefined ||
        !sameScope(state.value.policy.scope, receipt.scope) || state.value.policy.automationEnabled !== true ||
        state.value.policy.policyVersion !== policyVersion || !state.value.sessionLease ||
        state.value.sessionLease.sessionId !== sessionId ||
        Date.parse(state.value.sessionLease.expiresAt) <= Date.parse(this.#now()) ||
        !state.value.admission || state.value.admission.key.accountRef !== inbound.key.accountRef ||
        state.value.admission.key.providerCallRef !== inbound.key.providerCallRef || state.value.admission.dialedNumber !== inbound.dialedNumber) return false;
    return !this.#closed && Date.parse(state.value.sessionLease.expiresAt) > Date.parse(this.#now());
  }

  /** Trusted transport binding only; no patient, contact, code or proof. */
  binding(): Readonly<{ callId: string; sessionId: string }> {
    return { callId: this.#config.receipt.callId, sessionId: this.#config.sessionId };
  }

  /** Private native composition only. Scope/call matching cannot substitute for
   * the Cliniko account that supplied the registered verification channel. */
  matchesClinikoAccount(credentialFingerprint: string): boolean {
    const contact = this.#config.contact;
    if (this.#closed || !(contact instanceof ClinikoVerificationContactReader)) return false;
    const selection = contact.selection(), scope = this.#config.receipt.scope;
    return selection.credentialFingerprint === credentialFingerprint && selection.scope.tenantId === scope.tenantId && selection.scope.clinicId === scope.clinicId;
  }

  /** Representative roots must possess their own native registered channel.
   * A delegated subject verifier cannot become a new delegating caller. */
  usesSelfRegisteredContact(): boolean {
    return !this.#closed && this.#config.contact.constructor === ClinikoVerificationContactReader;
  }

  usesContactRevision(owner: import("../cliniko/contact-revision.ts").ClinikoContactRevisionReader): boolean {
    return !this.#closed && this.#config.contact instanceof ClinikoVerificationContactReader && this.#config.contact.usesContactRevision(owner);
  }

  /** Immediate, identical wording even if lookup, approval or mail is unavailable. No resend. */
  begin(): Readonly<{ prompt: string }> {
    if (!this.#closed && !this.#pending) {
      this.#pending = this.#email.start(this.#config.operation).catch(() => undefined);
    }
    return { prompt: this.#config.operation === "patients.update"
      ? "If you receive a verification code at your registered email, enter it here. I cannot access or change your patient details until verification succeeds."
      : verificationPrompt };
  }

  /** Only the trusted secret-entry owner calls this. Do not create a FinalCallerTurn from its input. */
  async submitCode(code: string): Promise<Readonly<{ verified: boolean }>> {
    if (this.#closed || this.#busy || this.#grant || !this.#pending) return { verified: false };
    this.#busy = true;
    try {
      await this.#pending;
      if (this.#closed) return { verified: false };
      const answered = await this.#email.answer(typeof code === "string" && code.length === 6 ? code : "");
      if (!answered.ok || this.#closed) return { verified: false };
      const issued = await this.#proof.issue(answered.value, this.#config.operation);
      if (!issued.ok || this.#closed) return { verified: false };
      this.#grant = issued.value;
      if (!await this.verified()) return { verified: false };
      return { verified: true };
    } catch { this.dispose(); return { verified: false }; }
    finally { this.#busy = false; }
  }

  /** Private host wiring only: no token, email or patient ID is returned to caller/model progress. */
  async verified(signal?: AbortSignal): Promise<Grant | undefined> {
    const grant = this.#grant;
    if (signal?.aborted || this.#closed || !grant) return undefined;
    try {
      const checked = await this.#proof.verifyOperation(this.#config.receipt.scope, grant.verificationRef, this.#config.operation, this.#now(), signal);
      if (!checked.ok || signal?.aborted || this.#closed || this.#grant !== grant) { this.dispose(); return undefined; }
      return { ...grant };
    } catch { this.dispose(); return undefined; }
  }

  /** Private ownership check for non-disclosing policy/candidate gates only.
   * It does not revalidate native contact or patient permission. Protected
   * contact and operation boundaries must still call verifiedSubject. */
  async ownsCurrentProof(operation: PatientOperation, verificationRef: string, signal: AbortSignal): Promise<boolean> {
    const grant = this.#grant;
    if (this.#closed || signal.aborted || operation !== this.#config.operation || !grant || grant.verificationRef !== verificationRef ||
        !this.#proof.ownsLiveReference(verificationRef, operation, this.#now())) return false;
    const policy = await this.#config.policy.current(this.#config.receipt.scope);
    return policy.ok && policy.value.enabled && sameScope(policy.value.scope, this.#config.receipt.scope) && policy.value.version === this.#config.policyVersion &&
      await this.#active() && !signal.aborted && this.#grant === grant && this.#proof.ownsLiveReference(verificationRef, operation, this.#now());
  }

  /** Private routing metadata only. Native readers still validate the grant. */
  async ownedGrant(operation: PatientOperation, signal: AbortSignal): Promise<Grant | undefined> {
    const grant = this.#grant;
    return grant && await this.ownsCurrentProof(operation, grant.verificationRef, signal) ? { ...grant } : undefined;
  }

  /** Trusted native owner only. Never return this patient-bearing value through a model/caller command. */
  async verifiedSubject(operation: PatientOperation, signal?: AbortSignal): Promise<VerifiedPatient | undefined> {
    const grant = this.#grant;
    if (operation !== this.#config.operation || signal?.aborted || this.#closed || !grant) return undefined;
    try {
      const checked = await this.#proof.verifyOperation(this.#config.receipt.scope, grant.verificationRef, operation, this.#now(), signal);
      if (!checked.ok || signal?.aborted || this.#closed || this.#grant !== grant) { this.dispose(); return undefined; }
      return structuredClone(checked.value);
    } catch { this.dispose(); return undefined; }
  }

  /** Supplied to a trusted protected reader/writer; not an agent command or proof-issuance endpoint. */
  get proof(): TransientPatientProofHost { return this.#proof; }

  dispose(): void { this.#closed = true; this.#email.close(); this.#proof.dispose(); this.#grant = undefined; }
}
