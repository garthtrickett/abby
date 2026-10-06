import { randomUUID } from "node:crypto";
import { ClinikoRecallWriter } from "../cliniko/recall-write.ts";
import type { ClinikoRecallWriteRequest } from "../cliniko/recall-write.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { ClinikoVerificationContactReader } from "../cliniko/verification-contact.ts";
import type { StaffRequestQuery, StaffRequestPreparation } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { Result, StaffItem, StaffTaskReceipt, StaffTaskObservation } from "../core/model.ts";
import { validStaffLabel } from "../core/staff-outcome.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import type { ClinikoCancellationSessionConfig } from "./cliniko-cancellation-session.ts";
import { clinicDateAt } from "./clinic-clock.ts";
import { OwnerFileCallerPolicy } from "./owner-file-caller-policy.ts";
import { OwnerFileStaffPolicy } from "./owner-file-staff-policy.ts";
import { staffRequestLanguage } from "./staff-request-language.ts";
import { validStaffRequestSubject } from "../core/staff-request-subject.ts";
import type { StaffRequestSubject } from "../core/staff-request-subject.ts";

export type ClinikoStaffSessionConfig = Omit<ClinikoCancellationSessionConfig, "cancellationApprovalPath"> & Readonly<{ staffApprovalPath: string }>;
type Failure = Readonly<{ kind: "staffUnavailable" }>;
const unavailable = (): Result<never, Failure> => err({ kind: "staffUnavailable" });
type Prepared = Readonly<{ turnId: string; revision: number; requestedPerson?: string; requestSubject?: StaffRequestSubject }>;

/** One admitted call owns an independently authorized staff verification and at
 * most one request send. Only the approved Cliniko queue durably owns its detail. */
export class ClinikoStaffSession {
  readonly #config: ClinikoStaffSessionConfig;
  readonly #policy: OwnerFileStaffPolicy;
  readonly #verification: CallerVerificationSession;
  readonly #writer: ClinikoRecallWriter;
  readonly #lifetime = new AbortController();
  readonly #onClose = () => this.dispose();
  #pendingPerson: string | undefined;
  #pendingSubject: Readonly<{ subject: StaffRequestSubject; turnId: string; revision: number }> | undefined;
  #prepared: Prepared | undefined;
  #attempt: Readonly<{ item: StaffItem; request: ClinikoRecallWriteRequest; revision: number }> | undefined;
  #receipt: StaffTaskReceipt | undefined;
  #verifiedOnce = false;
  #definitiveNoSend = false;
  private constructor(config: ClinikoStaffSessionConfig, policy: OwnerFileStaffPolicy, verification: CallerVerificationSession, writer: ClinikoRecallWriter) {
    this.#config = config; this.#policy = policy; this.#verification = verification; this.#writer = writer;
    config.signal.addEventListener("abort", this.#onClose, { once: true });
    if (config.signal.aborted) this.dispose();
  }
  static async create(incoming: ClinikoStaffSessionConfig): Promise<Result<ClinikoStaffSession, Failure>> {
    let verification: CallerVerificationSession | undefined;
    try {
      const config = Object.freeze({ ...incoming, receipt: structuredClone(incoming.receipt), inbound: structuredClone(incoming.inbound),
        cliniko: Object.freeze({ ...incoming.cliniko }) });
      if (config.signal.aborted) return unavailable();
      const scope = config.receipt.scope, clock = config.clock ?? (() => new Date().toISOString());
      const policy = await OwnerFileStaffPolicy.capture({ path: config.staffApprovalPath, scope, directory: config.directory, clock,
        policyVersion: config.policyVersion, ...config.cliniko, credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey) });
      const caller = await OwnerFileCallerPolicy.capture({ path: config.callerApprovalPath, scope, directory: config.directory, clock,
        policyVersion: config.policyVersion, operation: "staff.request" });
      if (!policy.ok || !caller.ok || config.signal.aborted) return unavailable();
      const method = { operation: "staff.request" as const, current: async (bound: typeof scope) => {
        const call = await caller.value.current(bound), queue = await policy.value.current(bound);
        return call.ok ? ok({ ...call.value, enabled: call.value.enabled && queue.ok }) : call;
      } };
      const verified = CallerVerificationSession.create({ ...config, operation: "staff.request", policyStore: config.policies, policy: method,
        budget: config.verificationBudget,
        contact: new ClinikoVerificationContactReader({ ...config.cliniko, scope }, config.fetchPort ?? fetch) });
      if (!verified.ok) return unavailable();
      verification = verified.value;
      let owner: ClinikoStaffSession | undefined;
      const provider = config.fetchPort ?? fetch;
      const guarded: typeof fetch = async (url, init) => {
        if (init?.method === "POST" && (!owner || !await owner.#permitSend(init.signal ?? undefined))) {
          if (owner) owner.#definitiveNoSend = true;
          throw new Error("staff send denied");
        }
        return provider(url, init);
      };
      const writer = ClinikoRecallWriter.create({ ...config.cliniko, scope }, guarded);
      if (!writer.ok || config.signal.aborted) { verification.dispose(); return unavailable(); }
      owner = new ClinikoStaffSession(config, policy.value, verification, writer.value);
      return ok(owner);
    } catch { verification?.dispose(); return unavailable(); }
  }
  beginVerification() { return this.#verification.begin(); }
  async submitCode(code: string) { const result = await this.#verification.submitCode(code); if (result.verified) this.#verifiedOnce = true; return result; }
  async #active(signal: AbortSignal) {
    const c = this.#config, scope = c.receipt.scope;
    if (signal.aborted || this.#lifetime.signal.aborted) return undefined;
    const checks = await awaitUntilAbort(Promise.all([c.ledger.read(c.receipt.callId, scope), c.policies.read(scope),
      c.ledger.readWriteStop(scope), this.#policy.current(scope)]), signal);
    if (!checks || signal.aborted || this.#lifetime.signal.aborted) return undefined;
    const [call, policy, stop, queue] = checks, now = Date.parse((c.clock ?? (() => new Date().toISOString()))());
    if (!call.ok || !policy.ok || !stop.ok || !queue.ok || stop.value.stopped || !Number.isFinite(now) ||
        call.value.lifecycle !== "active" || !sameScope(call.value.policy.scope, scope) || !sameScope(policy.value.scope, scope) ||
        call.value.policy.policyVersion !== c.policyVersion || policy.value.policyVersion !== c.policyVersion ||
        !call.value.policy.automationEnabled || !policy.value.automationEnabled ||
        call.value.policy.staffWorkEnabled !== true || policy.value.staffWorkEnabled !== true ||
        call.value.sessionLease?.sessionId !== c.sessionId || Date.parse(call.value.sessionLease.expiresAt) <= now ||
        call.value.admission?.key.accountRef !== c.inbound.key.accountRef || call.value.admission.key.providerCallRef !== c.inbound.key.providerCallRef ||
        call.value.admission.dialedNumber !== c.inbound.dialedNumber) return undefined;
    return { state: call.value, approval: queue.value };
  }
  async prepare(query: StaffRequestQuery): Promise<Result<StaffRequestPreparation, Failure>> {
    const c = this.#config, signal = AbortSignal.any([query.signal, this.#lifetime.signal, AbortSignal.timeout(15_000)]);
    if (!sameScope(query.scope, c.receipt.scope) || query.callId !== c.receipt.callId || query.sessionId !== c.sessionId ||
        query.policyVersion !== c.policyVersion || !query.turnId || typeof query.callerText !== "string" || query.callerText.length > 4000) return unavailable();
    const explicit = staffRequestLanguage(query.callerText);
    if (query.requestedPerson !== undefined && (explicit?.kind !== "staffRequest" || explicit.requestedPerson?.toLowerCase() !== query.requestedPerson.toLowerCase())) return unavailable();
    if (query.requestSubject !== undefined && (!validStaffRequestSubject(query.requestSubject) ||
        explicit?.kind === "staffRequest" && explicit.requestSubject !== undefined && explicit.requestSubject !== query.requestSubject)) return unavailable();
    const askedSubject = query.requestSubject ?? (explicit?.kind === "staffRequest" ? explicit.requestSubject : undefined);
    const active = await this.#active(signal);
    if (!active || active.state.conversationRevision !== query.expectedConversationRevision) return unavailable();
    const existing = Object.values(active.state.staffItems).find(item => item.reason === "callerRequested");
    if (existing) return (query.requestedPerson === undefined || query.requestedPerson.toLowerCase() === existing.requestedPerson?.toLowerCase()) &&
      (askedSubject === undefined || askedSubject === existing.requestSubject)
      ? ok({ kind: "existing" }) : unavailable();
    const person = query.requestedPerson ?? this.#pendingPerson;
    if (person !== undefined && (!validStaffLabel(person) || !active.approval.staffLabels.some(label => label.toLowerCase() === person.toLowerCase()))) return unavailable();
    this.#pendingPerson = person === undefined ? undefined : active.approval.staffLabels.find(label => label.toLowerCase() === person.toLowerCase());
    const grant = await this.#verification.verified(signal);
    if (!grant) {
      if (signal.aborted || this.#verifiedOnce) return unavailable();
      if (askedSubject !== undefined) this.#pendingSubject = { subject: askedSubject, turnId: query.turnId, revision: query.expectedConversationRevision + 1 };
      return ok({ kind: "codeRequired", ...(askedSubject === undefined ? {} : { requestSubject: askedSubject }) });
    }
    // A model classification can offer verification but never authorize the
    // send. After verification require a bounded actual caller request.
    if (explicit?.kind !== "staffRequest") return unavailable();
    if (askedSubject !== undefined && explicit.requestSubject !== askedSubject) return unavailable();
    const pending = this.#pendingSubject;
    if (pending && (!active.state.processedTurnIds.includes(pending.turnId) || active.state.conversationRevision < pending.revision)) return unavailable();
    const subject = askedSubject ?? pending?.subject;
    const after = await this.#active(signal);
    if (!after || after.state.conversationRevision !== query.expectedConversationRevision) return unavailable();
    this.#prepared = { turnId: query.turnId, revision: query.expectedConversationRevision + 1,
      ...(this.#pendingPerson ? { requestedPerson: this.#pendingPerson } : {}), ...(subject ? { requestSubject: subject } : {}) };
    return ok({ kind: "ready", ...(this.#pendingPerson ? { requestedPerson: this.#pendingPerson } : {}), ...(subject ? { requestSubject: subject } : {}) });
  }
  async openTask(item: StaffItem, external?: AbortSignal): Promise<StaffTaskReceipt> {
    const rejected = { kind: "rejected", taskKey: item.key } as const;
    if (this.#attempt) return this.#attempt.item.key === item.key ? this.#receipt ?? { kind: "uncertain", taskKey: item.key } : rejected;
    const prepared = this.#prepared;
    // Claim before any async proof/policy/provider work. A concurrent second
    // invocation cannot reinterpret the same call as a new send attempt.
    this.#prepared = undefined;
    if (!prepared || item.reason !== "callerRequested" || item.linkedActionKey || item.request || item.requestedPerson !== prepared.requestedPerson || item.requestSubject !== prepared.requestSubject ||
        !sameScope(item.scope, this.#config.receipt.scope)) return rejected;
    const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(20_000), ...(external ? [external] : [])]);
    const active = await this.#active(signal), grant = await this.#verification.verified(signal);
    if (!active || !grant || active.state.conversationRevision !== prepared.revision || !active.state.processedTurnIds.includes(prepared.turnId) ||
        JSON.stringify(active.state.staffItems[item.key]) !== JSON.stringify(item)) return rejected;
    const now = (this.#config.clock ?? (() => new Date().toISOString()))();
    const patient = await this.#verification.proof.verifyOperation(item.scope, grant.verificationRef, "staff.request", now, signal);
    const final = await this.#active(signal);
    if (!patient.ok || !final || final.state.conversationRevision !== prepared.revision ||
        JSON.stringify(final.state.staffItems[item.key]) !== JSON.stringify(item)) return rejected;
    const a = final.approval;
    const request: ClinikoRecallWriteRequest = { scope: item.scope, patientId: patient.value.patientRef,
      recallTypeId: a.recallTypeId, recallAt: clinicDateAt(a.timeZone, new Date(now)), marker: randomUUID(),
      summary: JSON.stringify({ schema: "abby.staff-request.v1", locationId: item.scope.locationId, businessId: a.businessId,
        policyVersion: a.policyVersion, approvalRevision: a.revision, reason: "callerRequested", requestedPerson: item.requestedPerson ?? null,
        ...(item.requestSubject === undefined ? {} : { requestSubject: item.requestSubject }),
        reviewOwnerRef: a.reviewOwnerRef, reviewBackupRef: a.reviewBackupRef, reviewCadenceMinutes: a.reviewCadenceMinutes }) };
    this.#attempt = { item: structuredClone(item), request, revision: prepared.revision };
    let result;
    try { result = await awaitUntilAbort(this.#writer.openOnce(request, signal), signal); } catch { result = undefined; }
    if (this.#lifetime.signal.aborted) return { kind: "uncertain", taskKey: item.key };
    this.#receipt = result?.ok && result.value.kind === "accepted"
      ? { kind: "opened", taskKey: item.key, hostTaskRef: result.value.recallRef, destination: item.destination }
      : this.#definitiveNoSend || result && !result.ok ? rejected : { kind: "uncertain", taskKey: item.key };
    return this.#receipt;
  }
  async #permitSend(external?: AbortSignal): Promise<boolean> {
    const attempt = this.#attempt;
    if (!attempt) return false;
    const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(15_000), ...(external ? [external] : [])]);
    const grant = await this.#verification.verified(signal);
    if (!grant) return false;
    const now = (this.#config.clock ?? (() => new Date().toISOString()))();
    const patient = await this.#verification.proof.verifyOperation(attempt.item.scope, grant.verificationRef, "staff.request", now, signal);
    const active = await this.#active(signal);
    return !!active && patient.ok && patient.value.patientRef === attempt.request.patientId &&
      active.state.conversationRevision === attempt.revision && JSON.stringify(active.state.staffItems[attempt.item.key]) === JSON.stringify(attempt.item) &&
      !signal.aborted && this.#attempt === attempt;
  }
  async reconcileTask(item: StaffItem, external?: AbortSignal): Promise<StaffTaskObservation> {
    const unknown = { kind: "stillUnknown", taskKey: item.key } as const, attempt = this.#attempt;
    if (!attempt || JSON.stringify(item) !== JSON.stringify(attempt.item)) return unknown;
    const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(15_000), ...(external ? [external] : [])]);
    if (!await this.#active(signal) || !await this.#verification.verified(signal)) return unknown;
    const result = await awaitUntilAbort(this.#writer.observe(attempt.request), signal);
    // An empty/partial scan or manually recalled item never authorizes a retry
    // and never claims that a person read or resolved this request.
    return result?.ok && result.value.kind === "one" && !result.value.archived && !result.value.recalled && !signal.aborted
      ? { kind: "exactOpen", taskKey: item.key, hostTaskRef: result.value.recallRef, destination: item.destination } : unknown;
  }
  dispose() { this.#lifetime.abort(); this.#config.signal.removeEventListener("abort", this.#onClose); this.#verification.dispose();
    this.#prepared = undefined; this.#pendingPerson = undefined; this.#pendingSubject = undefined; this.#attempt = undefined; this.#receipt = undefined; }
}
