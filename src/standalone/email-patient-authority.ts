import type { VerificationContact } from "../cliniko/verification-contact.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { CallerCandidateLookup } from "../voice/caller-candidates.ts";
import { validCallerCandidates } from "../voice/caller-candidates.ts";
import { normalizeEmailAddress } from "../shared/email-address.ts";
import { RegisteredEmailChallenge } from "../shared/registered-email-challenge.ts";
import type { VerificationCodeBudget, VerificationCodeDelivery } from "../shared/registered-email-challenge.ts";
import { sameScope } from "./appointment-change-authority.ts";
import type { PatientAuthority, PatientAuthorityDecision, PatientAuthorityRequest, PatientAuthorityRecheck, PatientOperation,
  VerificationPolicyGate } from "./transient-patient-proof.ts";
import { patientOperations } from "./transient-patient-proof.ts";

/** Existing patient interface; aggregate issue/answer limits are shared with guardian verification. */
export type PatientVerificationBudget = VerificationCodeBudget;
export type PatientCodeDelivery = VerificationCodeDelivery;
export interface PatientVerificationPermission {
  /** Trusted current patient/action authority policy, including self/proxy/minor restrictions.
   * Channel possession alone must not supply this decision. */
  allows(scope: LocationScope, patientId: string, operation: PatientOperation, policyVersion: string,
    signal: AbortSignal): Promise<boolean>;
}
type Config = Readonly<{
  scope: LocationScope; callId: string; sessionId: string; policyVersion: string;
  presentedNumber: string; operations: readonly PatientOperation[];
  lookup: CallerCandidateLookup; contact: VerificationContact; policy: VerificationPolicyGate;
  permission: PatientVerificationPermission;
  budget: PatientVerificationBudget; delivery: PatientCodeDelivery;
  clock?: () => number; deadlineMs?: number;
}>;
type PatientContact = Readonly<{ patientId: string; registeredEmail: string; contactRevision: number | undefined }>;
type Denied = Readonly<{ kind: "denied" }>;
const allowedOperations: readonly PatientOperation[] = patientOperations;

/** One live call owns its challenge and single-use attestation token. No persistence or model port. */
export class EmailPatientAuthority implements PatientAuthority {
  readonly #config: Config;
  readonly #verification: RegisteredEmailChallenge<PatientContact, PatientOperation>;
  constructor(config: Config) {
    if (!config.scope || ![config.scope.tenantId, config.scope.clinicId, config.scope.locationId,
      config.callId, config.sessionId, config.policyVersion].every(value => typeof value === "string" &&
        !!value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)) ||
      !/^\+[1-9][0-9]{7,14}$/.test(config.presentedNumber) || !Array.isArray(config.operations) ||
      !config.operations.length || config.operations.length > 4 || new Set(config.operations).size !== config.operations.length ||
      config.operations.some(operation => !allowedOperations.includes(operation)) ||
      (config.deadlineMs !== undefined && (!Number.isSafeInteger(config.deadlineMs) || config.deadlineMs < 1 || config.deadlineMs > 20_000)) ||
      (config.clock !== undefined && typeof config.clock !== "function") ||
      typeof config.lookup?.candidates !== "function" || typeof config.contact?.read !== "function" ||
      typeof config.policy?.current !== "function" || typeof config.budget?.reserve !== "function" ||
      typeof config.permission?.allows !== "function" ||
      typeof config.delivery?.send !== "function") throw new TypeError("invalid email patient authority configuration");
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }), operations: Object.freeze([...config.operations]) });
    this.#verification = new RegisteredEmailChallenge<PatientContact, PatientOperation>({ scope: this.#config.scope, contexts: this.#config.operations,
      budget: config.budget, delivery: config.delivery,
      current: (operation, expected, signal) => this.#current(operation, expected?.patientId, expected?.registeredEmail, signal, expected?.contactRevision),
      ...(config.clock === undefined ? {} : { clock: config.clock }), ...(config.deadlineMs === undefined ? {} : { deadlineMs: config.deadlineMs }) });
  }

  async #current(operation: PatientOperation, patientId: string | undefined, email: string | undefined, signal: AbortSignal,
    expectedRevision?: number): Promise<PatientContact | undefined> {
    const config = this.#config;
    if (signal.aborted) return undefined;
    const revision = config.contact.revision ? await config.contact.revision(config.scope, signal) : ok(undefined);
    if (!revision.ok || signal.aborted || patientId !== undefined && revision.value !== expectedRevision) return undefined;
    const policy = await config.policy.current(config.scope);
    if (!policy.ok || policy.value.enabled !== true || policy.value.version !== config.policyVersion ||
        !sameScope(policy.value.scope, config.scope) || signal.aborted) return undefined;
    const candidates = await config.lookup.candidates(config.scope, config.presentedNumber, signal);
    if (!candidates.ok || !validCallerCandidates(candidates.value) || candidates.value.kind !== "one" || candidates.value.candidateIds.length !== 1 ||
        signal.aborted) return undefined;
    const selected = candidates.value.candidateIds[0]!;
    if (!/^[1-9][0-9]{0,18}$/.test(selected) || (patientId !== undefined && patientId !== selected)) return undefined;
    const contact = await config.contact.read(config.scope, selected, config.presentedNumber, signal);
    if (!contact.ok || typeof contact.value !== "string" || normalizeEmailAddress(contact.value) !== contact.value ||
        (email !== undefined && email !== contact.value) || signal.aborted) return undefined;
    if (await config.permission.allows(config.scope, selected, operation, config.policyVersion, signal) !== true || signal.aborted) return undefined;
    const finalPolicy = await config.policy.current(config.scope);
    const finalRevision = config.contact.revision ? await config.contact.revision(config.scope, signal) : ok(undefined);
    return finalPolicy.ok && finalPolicy.value.enabled === true && finalPolicy.value.version === config.policyVersion &&
      finalRevision.ok && finalRevision.value === revision.value && sameScope(finalPolicy.value.scope, config.scope) && !signal.aborted
      ? { patientId: selected, registeredEmail: contact.value, contactRevision: revision.value } : undefined;
  }

  /** Fixed result: never disclose whether a patient/address exists, nor promise mailbox delivery. */
  start(operation: PatientOperation): Promise<void> { return this.#verification.start(operation); }

  /** Called by the trusted text/keypad owner, outside model context. All failures share one denial. */
  answer(code: string): Promise<Result<string, Denied>> { return this.#verification.answer(code); }

  async attest(request: PatientAuthorityRequest): Promise<Result<PatientAuthorityDecision, Denied>> {
    if (!sameScope(request.scope, this.#config.scope) || request.callId !== this.#config.callId ||
        request.sessionId !== this.#config.sessionId || request.policyVersion !== this.#config.policyVersion ||
        request.signal.aborted) return err({ kind: "denied" });
    const consumed = await this.#verification.consume({ token: request.token, context: request.operation, signal: request.signal,
      accepts: snapshot => request.candidateIds.length === 1 && request.candidateIds[0] === snapshot.patientId });
    return consumed.ok ? ok({ scope: this.#config.scope, callId: this.#config.callId, sessionId: this.#config.sessionId,
      policyVersion: this.#config.policyVersion, patientId: consumed.value.snapshot.patientId, operations: [consumed.value.context] }) : consumed;
  }

  async revalidate(request: PatientAuthorityRecheck): Promise<boolean> {
    const config = this.#config;
    if (!sameScope(request.scope, config.scope) || request.callId !== config.callId || request.sessionId !== config.sessionId ||
        request.policyVersion !== config.policyVersion || request.signal.aborted) return false;
    return this.#verification.revalidate(request.operation, snapshot => request.patientId === snapshot.patientId, request.signal);
  }

  close(): void { this.#verification.close(); }
}
