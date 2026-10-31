import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ClinikoCostBinding } from "../cliniko/request-cost.ts";
import { clinikoRequestCeiling, inheritClinikoRequestCost } from "../cliniko/request-cost.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { err, ok } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { sameScope, validClinikoId } from "./appointment-change-authority.ts";
import { GuardianVerificationSession } from "./guardian-verification-session.ts";
import type { VerifiedGuardian } from "./guardian-verification-session.ts";
import { validAdminAccount } from "./identity/magic-link.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { approvalInstant, approvalRef, clinicApprovalKeys, decodeClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";
import { guardianOperations, OwnerFileGuardianPolicy } from "./owner-file-guardian-policy.ts";
import type { GuardianOperation } from "./owner-file-guardian-policy.ts";
import { validRepresentativeIdentity } from "./representative-identity.ts";
import type { RepresentativeIdentity } from "./representative-identity.ts";

export type GuardianAuthorityPurpose = "identify" | "channel" | "operation";
type Failure = Readonly<{ kind: "guardianAuthorityUnavailable" }>;
export type ClinicGuardianPatientAuthorityRecord = ClinicApproval & Readonly<{
  kind: "guardianPatientAuthority"; policyVersion: string; businessId: string; credentialFingerprint: string;
  authorityRef: string; authorityVersion: string; contactId: string; identityRecordRef: string;
  identityRecordVersion: string; identityRevision: string; subjectPatientId: string; operation: GuardianOperation;
  authorityKind: "guardian" | "adultRepresentative"; subjectKind: "minor" | "adult";
  purposes: readonly GuardianAuthorityPurpose[];
}>;
type Query = Readonly<{ scope: LocationScope; policyVersion: string; businessId: string; credentialFingerprint: string;
  guardian: VerifiedGuardian; identity: RepresentativeIdentity; operation: GuardianOperation; purpose: GuardianAuthorityPurpose; signal: AbortSignal }>;
export interface ClinicGuardianPatientAuthorityRecords {
  /** One complete, unique clinic-approved match for this actor, private identity
   * and action. Missing or ambiguous matches have no result. Caller claims,
   * identity records, contact notes and family labels cannot supply authority. */
  read(query: Query): Promise<Result<unknown, Failure>>;
}
export type GuardianPatientAuthorization = Readonly<{
  guardian: VerifiedGuardian; record: ClinicGuardianPatientAuthorityRecord; approvalMembershipFingerprint: string;
}>;
type Config = Readonly<{ scope: LocationScope; callId: string; sessionId: string; policyVersion: string; businessId: string;
  credentialFingerprint: string; budget: ClinikoRequestBudget; actor: GuardianVerificationSession; policy: OwnerFileGuardianPolicy;
  records: ClinicGuardianPatientAuthorityRecords; directory: Pick<AdminDirectory, "findByRef">; clock: () => string; signal: AbortSignal }>;
const purposes: readonly GuardianAuthorityPurpose[] = ["identify", "channel", "operation"];
const denied = (): Result<never, Failure> => err({ kind: "guardianAuthorityUnavailable" });
const keys = [...clinicApprovalKeys, "kind", "policyVersion", "businessId", "credentialFingerprint", "authorityRef", "authorityVersion",
  "contactId", "identityRecordRef", "identityRecordVersion", "identityRevision", "subjectPatientId", "operation", "authorityKind", "subjectKind", "purposes"];

/** Fresh identity possession and a separate current clinic subject/action approval.
 * This component never creates a patient proof or reads a patient's clinical data. */
export class GuardianPatientAuthority {
  readonly #config: Config;
  readonly #read: ClinicGuardianPatientAuthorityRecords["read"];
  readonly #member: AdminDirectory["findByRef"];
  #issued = new WeakSet<GuardianPatientAuthorization>();
  #ownedGuardian: VerifiedGuardian | undefined;
  readonly #lifetime = new AbortController();
  readonly #onClose = () => this.dispose();
  constructor(incoming: Config) {
    if (!(incoming.actor instanceof GuardianVerificationSession) || !(incoming.policy instanceof OwnerFileGuardianPolicy) ||
        !incoming.actor.usesProcessPolicy(incoming.policy) || !incoming.actor.matchesClinikoAccount(incoming.credentialFingerprint, incoming.budget) ||
        incoming.actor.binding().callId !== incoming.callId || incoming.actor.binding().sessionId !== incoming.sessionId ||
        ![incoming.scope?.tenantId, incoming.scope?.clinicId, incoming.scope?.locationId, incoming.policyVersion, incoming.callId, incoming.sessionId].every(approvalRef) ||
        !validClinikoId(incoming.businessId) || typeof incoming.records?.read !== "function" || typeof incoming.directory?.findByRef !== "function" ||
        typeof incoming.clock !== "function" || !(incoming.signal instanceof AbortSignal) || incoming.signal.aborted) throw new TypeError("invalid guardian patient authority");
    this.#config = Object.freeze({ ...incoming, scope: Object.freeze({ ...incoming.scope }) });
    const records = incoming.records, directory = incoming.directory, read = records.read, member = directory.findByRef;
    this.#read = inheritClinikoRequestCost(query => read.call(records, query), read);
    this.#member = inheritClinikoRequestCost(ref => member.call(directory, ref), member);
    incoming.signal.addEventListener("abort", this.#onClose, { once: true });
  }
  nativeRequestCostCeiling(binding: ClinikoCostBinding): number | undefined {
    return this.#cost(binding, false);
  }
  ownershipNativeRequestCostCeiling(binding: ClinikoCostBinding): number | undefined {
    return this.#cost(binding, true);
  }
  #cost(binding: ClinikoCostBinding, ownership: boolean): number | undefined {
    const c = this.#config;
    if (this.#lifetime.signal.aborted || Object.getPrototypeOf(this) !== GuardianPatientAuthority.prototype || this.read !== GuardianPatientAuthority.prototype.read ||
        !binding?.scope || binding.budget !== c.budget || binding.credentialFingerprint !== c.credentialFingerprint ||
        binding.scope.tenantId !== c.scope.tenantId || binding.scope.clinicId !== c.scope.clinicId) return undefined;
    const actor = c.actor.nativeRequestCostCeilings(binding), policy = clinikoRequestCeiling(c.policy.current, binding),
      read = clinikoRequestCeiling(this.#read, binding), member = clinikoRequestCeiling(this.#member, binding);
    if (!actor || policy === undefined || read === undefined || member === undefined) return undefined;
    const maximum = 2 * (ownership ? actor.ownership : actor.proof) + actor.ownership + 2 * policy + 3 * read + 2 * member;
    return maximum <= 200 ? maximum : undefined;
  }
  matchesContext(query: Readonly<{ scope: LocationScope; callId: string; sessionId: string; policyVersion: string; businessId: string;
    credentialFingerprint: string; budget: ClinikoRequestBudget; actor: GuardianVerificationSession; policy: OwnerFileGuardianPolicy; signal: AbortSignal }>): boolean {
    const c = this.#config;
    return !this.#lifetime.signal.aborted && query.signal === c.signal && sameScope(query.scope, c.scope) && query.callId === c.callId && query.sessionId === c.sessionId && query.policyVersion === c.policyVersion &&
      query.businessId === c.businessId && query.credentialFingerprint === c.credentialFingerprint && query.budget === c.budget && query.actor === c.actor && query.policy === c.policy;
  }
  #decode(value: unknown, guardian: VerifiedGuardian, operation: GuardianOperation, purpose: GuardianAuthorityPurpose) {
    const c = this.#config, now = approvalInstant(c.clock());
    if (!decodeClinicApproval(value, c.scope, keys)) return undefined;
    const row = value as ClinicGuardianPatientAuthorityRecord;
    return row.kind === "guardianPatientAuthority" && row.policyVersion === c.policyVersion && row.businessId === c.businessId &&
      row.credentialFingerprint === c.credentialFingerprint && row.contactId === guardian.contactId && row.identityRecordRef === guardian.recordRef &&
      row.identityRecordVersion === guardian.recordVersion && row.identityRevision === guardian.revision && row.operation === operation &&
      approvalRef(row.authorityRef) && approvalRef(row.authorityVersion) && validClinikoId(row.subjectPatientId) &&
      (row.authorityKind === "guardian" && row.subjectKind === "minor" || row.authorityKind === "adultRepresentative" && row.subjectKind === "adult") &&
      Array.isArray(row.purposes) && row.purposes.length > 0 && row.purposes.length <= 3 && new Set(row.purposes).size === row.purposes.length &&
      row.purposes.every(item => purposes.includes(item)) && row.purposes.includes(purpose) && row.approved && row.enabled &&
      now !== undefined && now >= Date.parse(row.effectiveFrom) && now < Date.parse(row.effectiveUntil) ? row : undefined;
  }
  async #record(query: Query) {
    if (query.signal.aborted) return undefined;
    // Give the source its own copy: a callback cannot mutate our bound actor,
    // private identity or expected snapshot while its promise is pending.
    const { signal, ...values } = query;
    const found = await this.#read({ ...structuredClone(values), signal });
    return found.ok && !query.signal.aborted ? this.#decode(structuredClone(found.value), query.guardian, query.operation, query.purpose) : undefined;
  }
  async #membership(record: ClinicGuardianPatientAuthorityRecord, signal: AbortSignal) {
    if (signal.aborted) return undefined;
    const found = await this.#member(record.approverRef);
    return found.ok && found.value && validAdminAccount(found.value) && found.value.actor.role === "clinicAdmin" &&
      found.value.actor.actorRef === record.approverRef && sameScope(found.value.actor.scope, this.#config.scope) && !signal.aborted
      ? structuredClone(found.value) : undefined;
  }
  async #actor(operation: GuardianOperation, signal: AbortSignal) {
    const c = this.#config, guardian = await c.actor.verifiedGuardian(operation, signal);
    return guardian && sameScope(guardian.scope, c.scope) && guardian.callId === c.callId && guardian.sessionId === c.sessionId &&
      guardian.policyVersion === c.policyVersion && guardian.businessId === c.businessId && guardian.credentialFingerprint === c.credentialFingerprint &&
      !signal.aborted ? structuredClone(guardian) : undefined;
  }
  async #policy(operation: GuardianOperation, signal: AbortSignal) {
    const c = this.#config, approval = await c.policy.current(c.scope);
    return approval.ok && approval.value.policyVersion === c.policyVersion && approval.value.businessId === c.businessId &&
      approval.value.credentialFingerprint === c.credentialFingerprint && approval.value.operations.includes(operation) && !signal.aborted ? approval.value : undefined;
  }
  async #proof(operation: GuardianOperation, signal: AbortSignal, expected?: GuardianPatientAuthorization) {
    const owned = expected?.guardian ?? this.#ownedGuardian;
    if (!owned) return expected ? undefined : this.#actor(operation, signal);
    // This gate only permits non-disclosing clinic approval lookup. A normal
    // read MUST freshly revalidate the native guardian channel below before
    // returning an approval for any protected patient read. Reusing an issued
    // possession snapshot here avoids a duplicate native GET, not revocation.
    return owned.operation === operation && await this.#config.actor.ownsCurrentProof(operation, owned.verificationRef, signal) && !signal.aborted ? owned : undefined;
  }
  async #lookup(identity: RepresentativeIdentity, operation: GuardianOperation, purpose: GuardianAuthorityPurpose, signal: AbortSignal,
    expected?: GuardianPatientAuthorization): Promise<Result<GuardianPatientAuthorization, Failure>> {
    const c = this.#config, guardian = await this.#proof(operation, signal, expected), policy = guardian && await this.#policy(operation, signal);
    if (!guardian || !policy || signal.aborted) return denied();
    const query = { scope: c.scope, policyVersion: c.policyVersion, businessId: c.businessId, credentialFingerprint: c.credentialFingerprint,
      guardian, identity, operation, purpose, signal };
    const record = await this.#record(query);
    if (!record || !policy.allowedAuthorities.includes(record.authorityKind) || signal.aborted) return denied();
    const member = await this.#membership(record, signal); if (!member || signal.aborted) return denied();
    const again = await this.#record(query); if (!again || !isDeepStrictEqual(again, record) || signal.aborted) return denied();
    const actor = expected ? await this.#proof(operation, signal, expected) : await this.#actor(operation, signal);
    const currentPolicy = actor && await this.#policy(operation, signal);
    if (!isDeepStrictEqual(actor, guardian) || !isDeepStrictEqual(currentPolicy, policy) || signal.aborted) { this.#ownedGuardian = undefined; return denied(); }
    const currentMember = await this.#membership(record, signal);
    if (!currentMember || !isDeepStrictEqual(currentMember, member) || signal.aborted) return denied();
    const final = await this.#record(query); if (!final || !isDeepStrictEqual(final, record) || signal.aborted) return denied();
    if (!await c.actor.ownsCurrentProof(operation, guardian.verificationRef, signal) || signal.aborted) return denied();
    const now = approvalInstant(c.clock());
    if (now === undefined || Date.parse(guardian.expiresAt) <= now + 120_000 || Date.parse(record.effectiveUntil) <= now || Date.parse(policy.effectiveUntil) <= now) return denied();
    const snapshot = Object.freeze({ guardian: Object.freeze({ ...guardian, scope: Object.freeze({ ...guardian.scope }) }),
      record: Object.freeze({ ...record, scope: Object.freeze({ ...record.scope }), purposes: Object.freeze([...record.purposes]) }),
      approvalMembershipFingerprint: createHash("sha256").update(JSON.stringify(member)).digest("hex") });
    if (expected && !isDeepStrictEqual(snapshot, expected)) return denied();
    this.#issued.add(snapshot);
    if (!expected) this.#ownedGuardian = snapshot.guardian;
    return ok(snapshot);
  }
  async read(identity: RepresentativeIdentity, operation: GuardianOperation, purpose: GuardianAuthorityPurpose, signal: AbortSignal): Promise<Result<GuardianPatientAuthorization, Failure>> {
    if (this.#lifetime.signal.aborted || !validRepresentativeIdentity(identity) || !guardianOperations.includes(operation) || !purposes.includes(purpose) || !(signal instanceof AbortSignal) || signal.aborted) return denied();
    const bound = AbortSignal.any([signal, this.#lifetime.signal, AbortSignal.timeout(20_000)]);
    try { return await awaitUntilAbort(this.#lookup(structuredClone(identity), operation, purpose, bound), bound) ?? denied(); }
    catch { return denied(); }
  }
  /** Non-disclosing source/permission routing check for an issued selection.
   * Protected native subject/channel reads must use read() for fresh guardian
   * channel evidence first; this method cannot create or renew possession. */
  async ownsCurrentAuthorization(expected: GuardianPatientAuthorization, identity: RepresentativeIdentity,
    purpose: GuardianAuthorityPurpose, signal: AbortSignal): Promise<boolean> {
    if (this.#lifetime.signal.aborted || !expected || !this.#issued.has(expected) || !validRepresentativeIdentity(identity) || !purposes.includes(purpose) ||
        !(signal instanceof AbortSignal) || signal.aborted) return false;
    const bound = AbortSignal.any([signal, this.#lifetime.signal, AbortSignal.timeout(20_000)]);
    try { return (await awaitUntilAbort(this.#lookup(structuredClone(identity), expected.record.operation, purpose, bound, expected), bound))?.ok === true; }
    catch { return false; }
  }
  dispose(): void {
    this.#config.signal.removeEventListener("abort", this.#onClose); this.#lifetime.abort();
    this.#ownedGuardian = undefined; this.#issued = new WeakSet();
  }
}
