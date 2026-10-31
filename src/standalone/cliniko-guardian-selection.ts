import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { boundedClinikoJson } from "../cliniko/bounded-json.ts";
import { claimClinikoBudget, clinikoCredentialFingerprint, isClinikoRequestBudget, observeCliniko429 } from "../cliniko/read-budget.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { normalizeEmailAddress } from "../shared/email-address.ts";
import { sameScope, validClinikoId } from "./appointment-change-authority.ts";
import type { CallerVerificationSession } from "./caller-verification-session.ts";
import type { ClinikoBookingSessionConfig } from "./cliniko-booking-session.ts";
import { GuardianPatientAuthority } from "./guardian-patient-authority.ts";
import type { GuardianAuthorityPurpose, GuardianPatientAuthorization } from "./guardian-patient-authority.ts";
import { GuardianVerificationSession } from "./guardian-verification-session.ts";
import { guardianOperations, OwnerFileGuardianPolicy } from "./owner-file-guardian-policy.ts";
import type { GuardianOperation } from "./owner-file-guardian-policy.ts";
import { representativeSubjectEligible, sameRepresentativeIdentity, validRepresentativeIdentity } from "./representative-identity.ts";
import type { RepresentativeIdentity } from "./representative-identity.ts";
import { createRepresentativeSubjectVerifier } from "./representative-subject-verification.ts";
import type { AdditionalRepresentativeVerification } from "./representative-subject-verification.ts";
import type { PatientOperation } from "./transient-patient-proof.ts";

type Config = Omit<ClinikoBookingSessionConfig, "callerApprovalPath" | "bookingApprovalPath" | "permission" | "representative"> & Readonly<{
  actor: GuardianVerificationSession; policy: OwnerFileGuardianPolicy; authority: GuardianPatientAuthority; representativeCallerApprovalPath: string;
}>;
type Subject = RepresentativeIdentity & Readonly<{ patientId: string; email: string }>;
type Selection = Readonly<{ ref: string; identity: RepresentativeIdentity; operation: GuardianOperation; authorization: GuardianPatientAuthorization; subject: Subject }>;
const fail = <T>(): Result<T, Readonly<{ kind: "representativeUnavailable" }>> => err({ kind: "representativeUnavailable" });
const row = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Private non-patient actor selection. Clinic authority identifies the subject;
 * native exact identity/age and the patient's own registered channel follow. */
export class ClinikoGuardianSelection {
  readonly #config: Config;
  readonly #base: string;
  readonly #fingerprint: string;
  readonly #lifetime = new AbortController();
  readonly #onClose = () => this.dispose();
  #selection: Selection | undefined;
  #verification: CallerVerificationSession | undefined;
  #busy = false;
  #subjectAttempted = false;
  constructor(config: Config) {
    const fingerprint = clinikoCredentialFingerprint(config.cliniko.apiKey), binding = config.actor?.binding();
    if (!(config.actor instanceof GuardianVerificationSession) || !(config.policy instanceof OwnerFileGuardianPolicy) ||
        !(config.authority instanceof GuardianPatientAuthority) || Object.getPrototypeOf(config.authority) !== GuardianPatientAuthority.prototype ||
        config.authority.read !== GuardianPatientAuthority.prototype.read || config.authority.ownsCurrentAuthorization !== GuardianPatientAuthority.prototype.ownsCurrentAuthorization ||
        !config.actor.usesProcessPolicy(config.policy) || !config.actor.matchesClinikoAccount(fingerprint, config.cliniko.rateBudget) ||
        !isClinikoRequestBudget(config.cliniko.rateBudget) || !validClinikoId(config.cliniko.businessId) ||
        binding?.callId !== config.receipt.callId || binding.sessionId !== config.sessionId ||
        !config.actor.matchesPrivateContext({ ...config, policyStore: config.policies }) ||
        !config.authority.matchesContext({ scope: config.receipt.scope, callId: config.receipt.callId, sessionId: config.sessionId, policyVersion: config.policyVersion,
          businessId: config.cliniko.businessId, credentialFingerprint: fingerprint, budget: config.cliniko.rateBudget, actor: config.actor, policy: config.policy, signal: config.signal }))
      throw new TypeError("invalid guardian selection owner");
    this.#config = Object.freeze({ ...config, receipt: structuredClone(config.receipt), inbound: structuredClone(config.inbound), cliniko: Object.freeze({ ...config.cliniko }) });
    this.#fingerprint = fingerprint; this.#base = `https://api.${config.cliniko.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)![1]}.cliniko.com/v1`;
    config.signal.addEventListener("abort", this.#onClose, { once: true });
    if (config.signal.aborted) this.dispose();
  }
  #now() { return (this.#config.clock ?? (() => new Date().toISOString()))(); }
  async #bounded<T>(signal: AbortSignal, run: (bound: AbortSignal) => Promise<T>): Promise<T | undefined> {
    const bound = AbortSignal.any([signal, this.#config.signal, this.#lifetime.signal, AbortSignal.timeout(20_000)]);
    try { return await awaitUntilAbort(run(bound), bound); } catch { return undefined; }
  }
  async #subject(patientId: string, signal: AbortSignal): Promise<Subject | undefined> {
    const c = this.#config;
    if (signal.aborted || await claimClinikoBudget(c.cliniko.rateBudget) || signal.aborted) return undefined;
    const response = await (c.fetchPort ?? fetch)(`${this.#base}/patients/${patientId}`, { method: "GET", redirect: "error", signal,
      headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${c.cliniko.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${c.cliniko.contactEmail})` } });
    if (response.status === 429) await observeCliniko429(c.cliniko.rateBudget, response.headers.get("X-RateLimit-Reset"));
    if (response.status !== 200 || signal.aborted) return undefined;
    const body = await boundedClinikoJson(response), record = body.ok && row(body.value), email = record && normalizeEmailAddress(record.email);
    const identity = { firstName: record && record.first_name, lastName: record && record.last_name, dateOfBirth: record && record.date_of_birth };
    if (!record || record.id !== patientId || record.archived_at !== null || !email || !validRepresentativeIdentity(identity) ||
        record.links !== undefined && row(record.links)?.self !== `${this.#base}/patients/${patientId}`) return undefined;
    return { ...identity, patientId, email };
  }
  async #eligible(subject: Subject, authority: GuardianPatientAuthorization, signal: AbortSignal) {
    const approval = await this.#process(authority.record.operation, signal);
    return !!approval && approval.allowedAuthorities.includes(authority.record.authorityKind) &&
      !signal.aborted && representativeSubjectEligible(subject.dateOfBirth, authority.record, approval, this.#now());
  }
  async #process(operation: GuardianOperation, signal: AbortSignal) {
    const c = this.#config, approval = await c.policy.current(c.receipt.scope);
    return approval.ok && approval.value.policyVersion === c.policyVersion && approval.value.businessId === c.cliniko.businessId &&
      approval.value.credentialFingerprint === this.#fingerprint && approval.value.timeZone === c.cliniko.timeZone &&
      approval.value.operations.includes(operation) && !signal.aborted ? approval.value : undefined;
  }
  async #authorized(selected: Selection, purpose: GuardianAuthorityPurpose, signal: AbortSignal) {
    return this.#selection === selected && !signal.aborted &&
      await this.#config.authority.ownsCurrentAuthorization(selected.authorization, selected.identity, purpose, signal) &&
      !signal.aborted && this.#selection === selected;
  }
  async #current(selected: Selection, purpose: GuardianAuthorityPurpose, signal: AbortSignal) {
    if (this.#selection !== selected || signal.aborted || !await this.#process(selected.operation, signal)) return undefined;
    const authority = await this.#config.authority.read(selected.identity, selected.operation, purpose, signal);
    if (!authority.ok || !isDeepStrictEqual(authority.value, selected.authorization) || signal.aborted) return undefined;
    const subject = await this.#subject(selected.subject.patientId, signal);
    if (!subject || !isDeepStrictEqual(subject, selected.subject) || !await this.#eligible(subject, authority.value, signal)) return undefined;
    return await this.#authorized(selected, purpose, signal) ? subject : undefined;
  }
  async select(incoming: RepresentativeIdentity, operation: PatientOperation, signal: AbortSignal) {
    if (this.#busy || this.#subjectAttempted || !validRepresentativeIdentity(incoming) || !guardianOperations.includes(operation as GuardianOperation)) return fail<{ selectionRef: string }>();
    const wanted = structuredClone(incoming), selectedOperation = operation as GuardianOperation;
    this.#busy = true; this.#selection = undefined;
    try {
      const selected = await this.#bounded(signal, async bound => {
        if (!await this.#process(selectedOperation, bound)) return undefined;
        const authorization = await this.#config.authority.read(wanted, selectedOperation, "identify", bound);
        if (!authorization.ok || bound.aborted) return undefined;
        const subject = await this.#subject(authorization.value.record.subjectPatientId, bound);
        if (!subject || !sameRepresentativeIdentity(subject, wanted) ||
            !await this.#eligible(subject, authorization.value, bound)) return undefined;
        const selection = { ref: randomUUID(), identity: wanted, operation: selectedOperation, authorization: authorization.value, subject };
        this.#selection = selection;
        return await this.#authorized(selection, "identify", bound) ? selection : undefined;
      });
      if (!selected || signal.aborted || this.#lifetime.signal.aborted) { this.#selection = undefined; return fail<{ selectionRef: string }>(); }
      return ok({ selectionRef: selected.ref });
    } finally { this.#busy = false; }
  }
  matchesWorkflow(query: Readonly<{ scope: LocationScope; callId: string; sessionId: string; policyVersion: string; credentialFingerprint: string;
    businessId: string; timeZone: string; operation: PatientOperation; selectionRef: string; inbound: Config["inbound"] }>): boolean {
    const c = this.#config, selected = this.#selection;
    return !c.signal.aborted && !this.#lifetime.signal.aborted && !!selected && query.selectionRef === selected.ref && query.operation === selected.operation &&
      sameScope(query.scope, c.receipt.scope) && query.callId === c.receipt.callId && query.sessionId === c.sessionId && query.policyVersion === c.policyVersion &&
      query.credentialFingerprint === this.#fingerprint && query.businessId === c.cliniko.businessId && query.timeZone === c.cliniko.timeZone &&
      query.inbound.key.accountRef === c.inbound.key.accountRef && query.inbound.key.providerCallRef === c.inbound.key.providerCallRef &&
      query.inbound.dialedNumber === c.inbound.dialedNumber && query.inbound.presentedCallerNumber === c.inbound.presentedCallerNumber;
  }
  async verifier(selectionRef: string, signal: AbortSignal, additional?: AdditionalRepresentativeVerification) {
    const selected = this.#selection, c = this.#config;
    if (this.#busy || this.#subjectAttempted || !selected || selected.ref !== selectionRef || additional && (additional.policy?.operation !== selected.operation ||
        typeof additional.policy?.current !== "function" || typeof additional.permission?.allows !== "function")) return fail<CallerVerificationSession>();
    this.#subjectAttempted = true;
    const verifier = await this.#bounded(signal, async bound => {
      if (!await this.#current(selected, "channel", bound)) return undefined;
      const made = await createRepresentativeSubjectVerifier({ ...c, patientId: selected.subject.patientId, operation: selected.operation,
        subjectApprovalPath: c.representativeCallerApprovalPath, ...(additional ? { additional } : {}), authority: {
          authorized: async request => await this.#bounded(request, live => this.#authorized(selected, "channel", live)) === true,
          current: async (purpose, request) => (await this.#bounded(request, live => this.#current(selected, purpose, live)))?.email,
          operation: async request => await this.#bounded(request, live => this.#authorized(selected, "operation", live)) === true,
        } }, bound);
      return made.ok && !bound.aborted ? made.value : undefined;
    });
    if (!verifier || signal.aborted || this.#lifetime.signal.aborted) { verifier?.dispose(); return fail<CallerVerificationSession>(); }
    this.#verification = verifier; return ok(verifier);
  }
  dispose(): void { this.#config.signal.removeEventListener("abort", this.#onClose); this.#lifetime.abort(); this.#verification?.dispose(); this.#verification = undefined; this.#selection = undefined; }
}
