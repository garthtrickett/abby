import type { VerificationContact } from "../cliniko/verification-contact.ts";
import { ClinikoVerificationContactReader } from "../cliniko/verification-contact.ts";
import type { PolicyStore } from "../core/host.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { AdmissionReceipt, Result, VerifiedPatient } from "../core/model.ts";
import { callIdFor } from "../voice/admission.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import type { AuthenticatedInboundCall } from "../voice/admission.ts";
import type { CallerCandidateLookup } from "../voice/caller-candidates.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { EmailPatientAuthority } from "./email-patient-authority.ts";
import type { PatientCodeDelivery, PatientVerificationBudget, PatientVerificationPermission } from "./email-patient-authority.ts";
import { TransientPatientProofHost } from "./transient-patient-proof.ts";
import { clinikoRequestCeiling, inheritClinikoRequestCost } from "../cliniko/request-cost.ts";
import type { ClinikoCostBinding } from "../cliniko/request-cost.ts";
import type { PatientOperation, VerificationPolicyGate } from "./transient-patient-proof.ts";
import { ClinikoOutboundClinicalContext } from "./cliniko-outbound-clinical-context.ts";
import { activePrivateVerificationCall } from "./private-verification-call.ts";

type Config = Readonly<{
  receipt: AdmissionReceipt; inbound: AuthenticatedInboundCall; sessionId: string; policyVersion: string;
  operation: PatientOperation; ledger: Pick<LedgerStore, "read" | "readWriteStop">;
  policyStore: Pick<PolicyStore, "read">; policy: VerificationPolicyGate & Readonly<{ operation: PatientOperation }>; lookup: CallerCandidateLookup;
  contact: VerificationContact; permission: PatientVerificationPermission;
  budget: PatientVerificationBudget; delivery: PatientCodeDelivery; clock?: () => string; timeoutMs?: number;
}>;
type CapturedConfig = Omit<Config, "inbound"> & Readonly<{
  candidateNumber: string;
  outbound?: ClinikoOutboundClinicalContext;
}>;
export type OutboundCallerVerificationConfig = Omit<Config, "inbound"> & Readonly<{ outbound: ClinikoOutboundClinicalContext }>;
type Grant = Readonly<{ verificationRef: string; expiresAt: string }>;
export const verificationPrompt = "If you receive a verification code at your registered email, enter it here. I cannot access or change personal appointments until verification succeeds.";

/** Trusted call-owner input, separate from caller turns and every model/agent command.
 * One admission/session owns one challenge, one operation and one private proof. */
export class CallerVerificationSession {
  readonly #config: CapturedConfig;
  readonly #email: EmailPatientAuthority;
  readonly #proof: TransientPatientProofHost;
  #pending: Promise<void> | undefined;
  #busy = false;
  #closed = false;
  #grant: Grant | undefined;
  #subject: string | undefined;

  private constructor(incoming: CapturedConfig) {
    const config = Object.freeze({ ...incoming, receipt: structuredClone(incoming.receipt) });
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
      policyVersion: config.policyVersion, presentedNumber: config.candidateNumber, operations: [config.operation],
      lookup: config.lookup, contact: config.contact, policy, permission: config.permission, budget: config.budget,
      delivery: config.delivery, clock: () => Date.parse(clock()), ...(config.timeoutMs === undefined ? {} : { deadlineMs: config.timeoutMs }) });
    this.#proof = new TransientPatientProofHost({ scope, callId: config.receipt.callId, sessionId: config.sessionId,
      policyVersion: config.policyVersion, presentedCallerNumber: config.candidateNumber,
      maxAttempts: 1, lookup: config.lookup, authority: this.#email, policy, clock,
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) });
  }

  static create(config: Config): Result<CallerVerificationSession, Readonly<{ kind: "verificationUnavailable" }>> {
    try {
      const { receipt, inbound } = config;
      if (!receipt || !inbound || Object.hasOwn(config, "outbound") || receipt.admission.direction === "outbound" || receipt.lifecycle === "ended" || receipt.callId !== callIdFor(inbound.key) ||
          receipt.admission.key.accountRef !== inbound.key.accountRef ||
          receipt.admission.key.providerCallRef !== inbound.key.providerCallRef || receipt.admission.dialedNumber !== inbound.dialedNumber ||
          typeof config.ledger?.read !== "function" || typeof config.ledger?.readWriteStop !== "function" ||
          typeof config.policyStore?.read !== "function" || config.policy?.operation !== config.operation) return err({ kind: "verificationUnavailable" });
      const { inbound: _, ...rest } = config;
      return ok(new CallerVerificationSession({ ...rest, candidateNumber: inbound.presentedCallerNumber! }));
    } catch { return err({ kind: "verificationUnavailable" }); }
  }

  /** Explicit outgoing path. Native original context constrains the candidate;
   * it cannot issue proof or replace registered-channel and patient authority.
   * Incoming events are never manufactured from the called number. */
  static createOutbound(config: OutboundCallerVerificationConfig): Result<CallerVerificationSession, Readonly<{ kind: "verificationUnavailable" }>> {
    try {
      const { outbound, receipt, contact } = config;
      if (!(outbound instanceof ClinikoOutboundClinicalContext) || !outbound.matchesAdmission(receipt) || !outbound.current(config.operation) ||
          Object.hasOwn(config, "inbound") || !(contact instanceof ClinikoVerificationContactReader) ||
          Object.getPrototypeOf(contact) !== ClinikoVerificationContactReader.prototype || contact.read !== ClinikoVerificationContactReader.prototype.read ||
          contact.revision !== ClinikoVerificationContactReader.prototype.revision ||
          !outbound.matchesContact(contact) ||
          typeof config.ledger?.read !== "function" || typeof config.ledger?.readWriteStop !== "function" ||
          typeof config.policyStore?.read !== "function" || config.policy?.operation !== config.operation) return err({ kind: "verificationUnavailable" });
      const binding = outbound.verificationBinding(), selection = ClinikoVerificationContactReader.prototype.selection.call(contact);
      if (selection.credentialFingerprint !== binding.credentialFingerprint || selection.scope.tenantId !== binding.scope.tenantId ||
          selection.scope.clinicId !== binding.scope.clinicId) return err({ kind: "verificationUnavailable" });
      return ok(new CallerVerificationSession({ ...config, candidateNumber: binding.number, lookup: outbound.constrainLookup(config.lookup, config.operation) }));
    } catch { return err({ kind: "verificationUnavailable" }); }
  }

  #now(): string {
    const now = (this.#config.clock ?? (() => new Date().toISOString()))();
    if (!Number.isFinite(Date.parse(now))) throw new Error("verification unavailable");
    return now;
  }

  async #active(): Promise<boolean> {
    const { outbound, operation } = this.#config;
    if (this.#closed || outbound && !outbound.current(operation)) return false;
    const active = await activePrivateVerificationCall(this.#config, operation !== "appointments.read", () => this.#now());
    return !!active && !this.#closed && (!outbound || outbound.matchesAdmission(this.#config.receipt) && outbound.current(operation)) &&
      Date.parse(active.expiresAt) > Date.parse(this.#now());
  }

  /** Trusted transport binding only; no patient, contact, code or proof. */
  binding(): Readonly<{ callId: string; sessionId: string }> {
    return { callId: this.#config.receipt.callId, sessionId: this.#config.sessionId };
  }

  /** Private native composition only. Scope/call matching cannot substitute for
   * the Cliniko account that supplied the registered verification channel. */
  matchesClinikoAccount(credentialFingerprint: string, budget?: ClinikoCostBinding["budget"]): boolean {
    const contact = this.#config.contact;
    if (this.#closed || !(contact instanceof ClinikoVerificationContactReader)) return false;
    const selection = contact.selection(), scope = this.#config.receipt.scope;
    return selection.credentialFingerprint === credentialFingerprint && selection.scope.tenantId === scope.tenantId && selection.scope.clinicId === scope.clinicId &&
      (budget === undefined || ClinikoVerificationContactReader.prototype.usesBudget.call(contact, budget));
  }
  /** Cost of the actual composed proof recheck and non-disclosing ownership
   * check. Native contact, lookup, patient permission and all four underlying
   * policy reads are included. This supplies no caller or send authority. */
  nativeRequestCostCeilings(binding: ClinikoCostBinding): Readonly<{ proof: number; ownership: number }> | undefined {
    const c = this.#config, contact = c.contact;
    if (this.#closed || !(contact instanceof ClinikoVerificationContactReader)) return undefined;
    const channel = ClinikoVerificationContactReader.prototype.nativeRequestCostCeiling.call(contact, binding);
    const policy = clinikoRequestCeiling(c.policy.current, binding), lookup = clinikoRequestCeiling(c.lookup.candidates, binding),
      permission = clinikoRequestCeiling(c.permission.allows, binding);
    if (channel === undefined || policy === undefined || lookup === undefined || permission === undefined) return undefined;
    return Object.freeze({ proof: channel + 4 * policy + lookup + permission, ownership: policy });
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
      const subject = await this.verifiedSubject(this.#config.operation);
      if (!subject || this.#closed || this.#grant !== issued.value) return { verified: false };
      this.#subject = subject.patientRef;
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

  /** Private live-workflow handoff, never a caller/model resend command. Retire
   * this owner before looking up a fresh challenge. The successor must verify
   * the original patient again under the same admitted call and operation.
   * Expiry is not extended, and a failed handoff cannot restore the old proof. */
  async renewOnce(verificationRef: string, external: AbortSignal): Promise<Result<CallerVerificationSession, Readonly<{ kind: "verificationUnavailable" }>>> {
    const unavailable = () => err({ kind: "verificationUnavailable" as const });
    const grant = this.#grant, patientId = this.#subject, config = this.#config;
    if (this.#closed || this.#busy || !grant || !patientId || verificationRef !== grant.verificationRef ||
        !(external instanceof AbortSignal) || external.aborted) return unavailable();
    this.#busy = true;
    // No old reader, captured proof object or concurrent answer keeps access
    // while current admission/policy and the successor are being checked.
    this.#grant = undefined; this.#subject = undefined;
    this.#email.close(); this.#proof.dispose();
    const signal = AbortSignal.any([external, AbortSignal.timeout(config.timeoutMs ?? 5000)]);
    let successor: CallerVerificationSession | undefined;
    try {
      const active = await awaitUntilAbort(this.#active(), signal);
      if (active !== true || signal.aborted || this.#closed) return unavailable();
      const lookup: CallerCandidateLookup = { candidates: inheritClinikoRequestCost(async (scope: Parameters<CallerCandidateLookup["candidates"]>[0], number: string, stop?: AbortSignal) => {
        const found = await config.lookup.candidates(scope, number, stop);
        return found.ok && found.value.kind === "one" && found.value.candidateIds.length === 1 && found.value.candidateIds[0] === patientId
          ? found : ok({ kind: "none" as const, candidateIds: [] });
      }, config.lookup.candidates) };
      successor = new CallerVerificationSession({ ...config, lookup });
      const current = await awaitUntilAbort(successor.#active(), signal);
      if (current !== true || signal.aborted || this.#closed) { successor.dispose(); return unavailable(); }
      return ok(successor);
    } catch { successor?.dispose(); return unavailable(); }
    finally { this.dispose(); this.#busy = false; }
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

  dispose(): void { this.#closed = true; this.#email.close(); this.#proof.dispose(); this.#grant = undefined; this.#subject = undefined; }
}
