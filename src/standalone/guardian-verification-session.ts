import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ClinikoGuardianContactReader } from "../cliniko/guardian-contact.ts";
import type { GuardianContactSnapshot } from "../cliniko/guardian-contact.ts";
import { clinikoRequestCeiling } from "../cliniko/request-cost.ts";
import type { ClinikoCostBinding } from "../cliniko/request-cost.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { RegisteredEmailChallenge } from "../shared/registered-email-challenge.ts";
import type { VerificationCodeBudget, VerificationCodeDelivery } from "../shared/registered-email-challenge.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { callIdFor } from "../voice/admission.ts";
import type { AuthenticatedInboundCall } from "../voice/admission.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { activePrivateVerificationCall } from "./private-verification-call.ts";
import type { PrivateVerificationCall } from "./private-verification-call.ts";
import { guardianOperations, OwnerFileGuardianPolicy } from "./owner-file-guardian-policy.ts";
import type { GuardianOperation } from "./owner-file-guardian-policy.ts";

type Config = PrivateVerificationCall & Readonly<{
  inbound: AuthenticatedInboundCall; operation: GuardianOperation; signal: AbortSignal; policy: OwnerFileGuardianPolicy;
  account: Readonly<{ businessId: string; credentialFingerprint: string; budget: ClinikoRequestBudget }>;
  contact: ClinikoGuardianContactReader; budget: VerificationCodeBudget; delivery: VerificationCodeDelivery;
  clock?: () => string; timeoutMs?: number;
}>;
type Grant = Readonly<{ verificationRef: string; expiresAt: string; snapshot: GuardianContactSnapshot }>;
export type VerifiedGuardian = Readonly<{
  kind: "verifiedGuardian"; scope: Config["receipt"]["scope"]; callId: string; sessionId: string; policyVersion: string;
  operation: GuardianOperation; businessId: string; credentialFingerprint: string; contactId: string;
  recordRef: string; recordVersion: string; revision: string; verificationRef: string; expiresAt: string;
}>;
const denied = () => err({ kind: "verificationUnavailable" as const });
export const guardianVerificationPrompt = "If you receive a verification code at your registered guardian email, enter it here. I cannot access or change another person's appointments until the required checks succeed.";

/** Private incoming-call guardian proof, never a PatientAuthority or VerifiedPatient.
 * Each later subject/action still needs its independent current clinic authority. */
export class GuardianVerificationSession {
  readonly #config: Config;
  readonly #verification: RegisteredEmailChallenge<GuardianContactSnapshot, "guardian.identity">;
  readonly #lifetime = new AbortController();
  readonly #onClose = () => this.dispose();
  #closed = false;
  #busy = false;
  #pending: Promise<void> | undefined;
  #grant: Grant | undefined;
  private constructor(incoming: Config) {
    const config = Object.freeze({ ...incoming, receipt: structuredClone(incoming.receipt), inbound: structuredClone(incoming.inbound),
      account: Object.freeze({ ...incoming.account }) });
    this.#config = config;
    this.#verification = new RegisteredEmailChallenge<GuardianContactSnapshot, "guardian.identity">({ scope: config.receipt.scope, contexts: ["guardian.identity"],
      budget: config.budget, delivery: config.delivery, clock: () => Date.parse(this.#now()),
      expiryCeiling: snapshot => Date.parse(snapshot.effectiveUntil), current: (_context, _expected, signal) => this.#current(signal),
      ...(config.timeoutMs === undefined ? {} : { deadlineMs: config.timeoutMs }) });
    config.signal.addEventListener("abort", this.#onClose, { once: true });
    if (config.signal.aborted) this.dispose();
  }
  static create(config: Config): Result<GuardianVerificationSession, Readonly<{ kind: "verificationUnavailable" }>> {
    try {
      const { receipt, inbound, contact, account } = config;
      if (!receipt || !inbound || receipt.lifecycle === "ended" || receipt.admission.direction === "outbound" ||
          Object.hasOwn(config, "outbound") || receipt.callId !== callIdFor(inbound.key) || receipt.admission.key.accountRef !== inbound.key.accountRef ||
          receipt.admission.key.providerCallRef !== inbound.key.providerCallRef || receipt.admission.dialedNumber !== inbound.dialedNumber ||
          typeof inbound.presentedCallerNumber !== "string" || !/^\+[1-9][0-9]{7,14}$/.test(inbound.presentedCallerNumber) ||
          !(config.signal instanceof AbortSignal) || config.signal.aborted || !guardianOperations.includes(config.operation) ||
          !(config.policy instanceof OwnerFileGuardianPolicy) || !(contact instanceof ClinikoGuardianContactReader) ||
          Object.getPrototypeOf(contact) !== ClinikoGuardianContactReader.prototype || contact.read !== ClinikoGuardianContactReader.prototype.read ||
          typeof config.ledger?.read !== "function" || typeof config.ledger?.readWriteStop !== "function" || typeof config.policyStore?.read !== "function") return denied();
      const binding = ClinikoGuardianContactReader.prototype.selection.call(contact);
      if (!sameScope(binding.scope, receipt.scope) || binding.policyVersion !== config.policyVersion || binding.businessId !== account?.businessId ||
          binding.credentialFingerprint !== account.credentialFingerprint || !ClinikoGuardianContactReader.prototype.usesBudget.call(contact, account.budget)) return denied();
      return ok(new GuardianVerificationSession(config));
    } catch { return denied(); }
  }
  #now(): string {
    const now = (this.#config.clock ?? (() => new Date().toISOString()))();
    if (!Number.isFinite(Date.parse(now))) throw new Error("verification unavailable");
    return now;
  }
  async #active(): Promise<boolean> {
    if (this.#closed || this.#config.signal.aborted) return false;
    const current = await activePrivateVerificationCall(this.#config, false, () => this.#now());
    return !!current && !this.#closed && !this.#config.signal.aborted && Date.parse(current.expiresAt) > Date.parse(this.#now());
  }
  async #policy() {
    const c = this.#config, current = await c.policy.current(c.receipt.scope);
    return current.ok && current.value.policyVersion === c.policyVersion && current.value.businessId === c.account.businessId &&
      current.value.credentialFingerprint === c.account.credentialFingerprint && current.value.operations.includes(c.operation) ? current.value : undefined;
  }
  async #current(signal: AbortSignal): Promise<GuardianContactSnapshot | undefined> {
    if (signal.aborted || !await this.#active()) return undefined;
    const approval = await this.#policy(); if (!approval || signal.aborted) return undefined;
    const found = await this.#config.contact.read(this.#config.receipt.scope, this.#config.inbound.presentedCallerNumber!, signal);
    if (!found.ok || signal.aborted) return undefined;
    const current = await this.#policy();
    return current && isDeepStrictEqual(current, approval) && !signal.aborted && await this.#active() && !signal.aborted ? found.value : undefined;
  }
  #live(grant: Grant): boolean {
    try { return !this.#closed && !this.#config.signal.aborted && this.#grant === grant && Date.parse(grant.expiresAt) > Date.parse(this.#now()) + 120_000; }
    catch { return false; }
  }
  binding(): Readonly<{ callId: string; sessionId: string }> { return { callId: this.#config.receipt.callId, sessionId: this.#config.sessionId }; }
  matchesPrivateContext(query: Pick<Config, "receipt" | "inbound" | "sessionId" | "policyVersion" | "ledger" | "policyStore">): boolean {
    const c = this.#config;
    return !this.#closed && sameScope(query.receipt.scope, c.receipt.scope) && query.receipt.callId === c.receipt.callId &&
      query.sessionId === c.sessionId && query.policyVersion === c.policyVersion && query.ledger === c.ledger && query.policyStore === c.policyStore &&
      isDeepStrictEqual(query.receipt.admission, c.receipt.admission) && isDeepStrictEqual(query.inbound, c.inbound);
  }
  usesProcessPolicy(policy: OwnerFileGuardianPolicy): boolean { return !this.#closed && this.#config.policy === policy; }
  matchesClinikoAccount(fingerprint: string, budget?: ClinikoRequestBudget): boolean {
    return !this.#closed && fingerprint === this.#config.account.credentialFingerprint && (budget === undefined || budget === this.#config.account.budget);
  }
  nativeRequestCostCeilings(binding: ClinikoCostBinding): Readonly<{ proof: number; ownership: number }> | undefined {
    if (!this.matchesClinikoAccount(binding.credentialFingerprint, binding.budget) || !sameScope({ ...binding.scope, locationId: this.#config.receipt.scope.locationId }, this.#config.receipt.scope)) return undefined;
    const channel = ClinikoGuardianContactReader.prototype.nativeRequestCostCeiling.call(this.#config.contact, binding),
      policy = clinikoRequestCeiling(this.#config.policy.current, binding);
    return channel === undefined || policy === undefined || channel + 2 * policy > 200 ? undefined : { proof: channel + 2 * policy, ownership: policy };
  }
  begin(): Readonly<{ prompt: string }> {
    if (!this.#closed && !this.#pending) this.#pending = this.#verification.start("guardian.identity").catch(() => undefined);
    return { prompt: guardianVerificationPrompt };
  }
  async submitCode(code: string): Promise<Readonly<{ verified: boolean }>> {
    if (this.#closed || this.#busy || this.#grant || !this.#pending) return { verified: false };
    this.#busy = true;
    try {
      await this.#pending; if (this.#closed) return { verified: false };
      const answer = await this.#verification.answer(typeof code === "string" && code.length === 6 ? code : "");
      if (!answer.ok || this.#closed) return { verified: false };
      const consumed = await this.#verification.consume({ token: answer.value, context: "guardian.identity", accepts: () => true, signal: this.#config.signal });
      if (!consumed.ok || this.#closed || consumed.value.expiresAt <= Date.parse(this.#now()) + 120_000) { this.dispose(); return { verified: false }; }
      const grant = { verificationRef: `guardian:${randomBytes(32).toString("base64url")}`, expiresAt: new Date(consumed.value.expiresAt).toISOString(), snapshot: consumed.value.snapshot };
      this.#grant = grant;
      return { verified: !!await this.verifiedGuardian(this.#config.operation) && this.#grant === grant && !this.#closed };
    } catch { this.dispose(); return { verified: false }; }
    finally { this.#busy = false; }
  }
  /** Private clinic owner only. No email/code/patient identity is returned. */
  async verifiedGuardian(operation: GuardianOperation, signal = this.#config.signal): Promise<VerifiedGuardian | undefined> {
    const grant = this.#grant;
    if (operation !== this.#config.operation || signal.aborted || !grant || !this.#live(grant)) return undefined;
    try {
      const checked = await this.#verification.revalidate("guardian.identity", value => isDeepStrictEqual(value, grant.snapshot), signal);
      if (!checked || signal.aborted || !this.#live(grant)) { this.dispose(); return undefined; }
      const c = this.#config, source = grant.snapshot;
      return { kind: "verifiedGuardian", scope: { ...c.receipt.scope }, callId: c.receipt.callId, sessionId: c.sessionId, policyVersion: c.policyVersion,
        operation, businessId: source.businessId, credentialFingerprint: source.credentialFingerprint, contactId: source.contactId,
        recordRef: source.recordRef, recordVersion: source.recordVersion, revision: source.revision, verificationRef: grant.verificationRef, expiresAt: grant.expiresAt };
    } catch { this.dispose(); return undefined; }
  }
  /** Non-disclosing routing check only. Protected patient work must revalidate the guardian above. */
  async ownsCurrentProof(operation: GuardianOperation, verificationRef: string, signal: AbortSignal): Promise<boolean> {
    const grant = this.#grant;
    if (operation !== this.#config.operation || !grant || grant.verificationRef !== verificationRef || signal.aborted || !this.#live(grant)) return false;
    const controller = new AbortController(), bound = AbortSignal.any([signal, this.#config.signal, this.#lifetime.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs ?? 5_000);
    try {
      return await awaitUntilAbort((async () => !!await this.#policy() && !bound.aborted && await this.#active() && !bound.aborted && this.#live(grant))(), bound) === true;
    } catch { return false; }
    finally { clearTimeout(timer); controller.abort(); }
  }
  dispose(): void {
    this.#closed = true; this.#lifetime.abort(); this.#config.signal.removeEventListener("abort", this.#onClose); this.#verification.close(); this.#grant = undefined;
  }
}
