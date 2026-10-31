import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { normalizeEmailAddress } from "../shared/email-address.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { sameScope, validClinikoId } from "../standalone/appointment-change-authority.ts";
import { approvalInstant, approvalRef, clinicApprovalKeys, decodeClinicApproval } from "../standalone/owner-file-clinic-approval.ts";
import type { ClinicApproval } from "../standalone/owner-file-clinic-approval.ts";
import { validAdminAccount } from "../standalone/identity/magic-link.ts";
import type { AdminDirectory } from "../standalone/identity/magic-link.ts";
import { boundedClinikoJson } from "./bounded-json.ts";
import { normalizePatientPhone } from "./phone-number.ts";
import { claimClinikoBudget, clinikoCredentialFingerprint, isClinikoRequestBudget, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";
import { clinikoRequestCeiling, inheritClinikoRequestCost } from "./request-cost.ts";
import type { ClinikoCostBinding } from "./request-cost.ts";

export type GuardianContactFailure = Readonly<{ kind: "denied" | "unavailable" }>;
/** Clinic-owned identity approval only. It grants neither patient authority nor channel possession. */
export type ClinicGuardianIdentityRecord = ClinicApproval & Readonly<{
  kind: "guardianIdentity"; policyVersion: string; businessId: string; credentialFingerprint: string;
  recordRef: string; recordVersion: string; contactId: string;
}>;
type RecordQuery = Readonly<{ scope: LocationScope; policyVersion: string; businessId: string;
  credentialFingerprint: string; normalizedPhone: string; signal: AbortSignal }>;
export interface ClinicGuardianIdentityRecords {
  /** Trusted clinic-owned source: one complete approved record, or no result for
   * absent/ambiguous lookup. No caller/model assertion or contact note supplies it. */
  read(query: RecordQuery): Promise<Result<unknown, GuardianContactFailure>>;
}
export type GuardianContactSnapshot = Readonly<{
  kind: "guardianContact"; scope: LocationScope; policyVersion: string; businessId: string; credentialFingerprint: string;
  recordRef: string; recordVersion: string; revision: string; effectiveUntil: string;
  contactId: string; contactUpdatedAt: string; registeredEmail: string;
}>;
type Config = Readonly<{
  scope: LocationScope; policyVersion: string; businessId: string; apiKey: string; contactEmail: string;
  countryCallingCode: string; rateBudget: ClinikoRequestBudget; records: ClinicGuardianIdentityRecords;
  directory: Pick<AdminDirectory, "findByRef">; clock?: () => string;
}>;
const row = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const denied = (): Result<never, GuardianContactFailure> => err({ kind: "denied" });
const unavailable = (): Result<never, GuardianContactFailure> => err({ kind: "unavailable" });
const keys = [...clinicApprovalKeys, "kind", "policyVersion", "businessId", "credentialFingerprint", "recordRef", "recordVersion", "contactId"];

/** Reads one explicitly approved non-patient contact. The returned transient
 * snapshot is input to private verification, never a VerifiedPatient or guardian proof. */
export class ClinikoGuardianContactReader {
  readonly #config: Config;
  readonly #base: string;
  readonly #fingerprint: string;
  readonly #fetch: typeof fetch;
  readonly #records: ClinicGuardianIdentityRecords["read"];
  readonly #member: AdminDirectory["findByRef"];
  constructor(incoming: Config, fetchPort: typeof fetch = fetch) {
    const shard = typeof incoming?.apiKey === "string" ? incoming.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1] : undefined;
    if (!shard || !incoming.apiKey.slice(0, -(shard.length + 1)) || incoming.apiKey !== incoming.apiKey.trim() ||
        /[\p{Cc}\p{Cf}]/u.test(incoming.apiKey) || !incoming.scope ||
        ![incoming.scope.tenantId, incoming.scope.clinicId, incoming.scope.locationId, incoming.policyVersion].every(approvalRef) ||
        !validClinikoId(incoming.businessId) || !normalizeEmailAddress(incoming.contactEmail) ||
        !/^[1-9][0-9]{0,2}$/.test(incoming.countryCallingCode) || !isClinikoRequestBudget(incoming.rateBudget) ||
        typeof incoming.records?.read !== "function" || typeof incoming.directory?.findByRef !== "function" ||
        typeof fetchPort !== "function" || incoming.clock !== undefined && typeof incoming.clock !== "function") throw new TypeError("invalid guardian contact configuration");
    this.#config = Object.freeze({ ...incoming, scope: Object.freeze({ tenantId: incoming.scope.tenantId, clinicId: incoming.scope.clinicId, locationId: incoming.scope.locationId }) });
    this.#fingerprint = clinikoCredentialFingerprint(incoming.apiKey); this.#base = `https://api.${shard}.cliniko.com/v1`; this.#fetch = fetchPort;
    const records = incoming.records, directory = incoming.directory, read = records.read, member = directory.findByRef;
    this.#records = inheritClinikoRequestCost((query: RecordQuery) => read.call(records, query), read);
    this.#member = inheritClinikoRequestCost((ref: string) => member.call(directory, ref), member);
  }
  /** Private composition identity only, with no credential or contact value. */
  selection(): Readonly<{ scope: LocationScope; policyVersion: string; businessId: string; credentialFingerprint: string }> {
    const c = this.#config;
    return { scope: { ...c.scope }, policyVersion: c.policyVersion, businessId: c.businessId, credentialFingerprint: this.#fingerprint };
  }
  usesBudget(budget: ClinikoRequestBudget): boolean { return budget === this.#config.rateBudget; }
  /** Cost only, never an identity/authority grant. Unknown injected work stays unknown. */
  nativeRequestCostCeiling(binding: ClinikoCostBinding): number | undefined {
    const c = this.#config;
    if (!binding?.scope || Object.getPrototypeOf(this) !== ClinikoGuardianContactReader.prototype || this.read !== ClinikoGuardianContactReader.prototype.read ||
        binding.budget !== c.rateBudget || binding.credentialFingerprint !== this.#fingerprint ||
        binding.scope.tenantId !== c.scope.tenantId || binding.scope.clinicId !== c.scope.clinicId) return undefined;
    const records = clinikoRequestCeiling(this.#records, binding), member = clinikoRequestCeiling(this.#member, binding);
    if (records === undefined || member === undefined) return undefined;
    const maximum = 1 + 3 * records + 2 * member;
    return maximum <= 200 ? maximum : undefined;
  }
  #decode(value: unknown): ClinicGuardianIdentityRecord | undefined {
    const c = this.#config, now = approvalInstant((c.clock ?? (() => new Date().toISOString()))());
    if (!decodeClinicApproval(value, c.scope, keys)) return undefined;
    const record = value as ClinicGuardianIdentityRecord;
    return record.kind === "guardianIdentity" && record.policyVersion === c.policyVersion && record.businessId === c.businessId &&
      record.credentialFingerprint === this.#fingerprint && approvalRef(record.recordRef) && approvalRef(record.recordVersion) && validClinikoId(record.contactId) &&
      record.approved && record.enabled && now !== undefined && now >= Date.parse(record.effectiveFrom) && now < Date.parse(record.effectiveUntil) ? record : undefined;
  }
  async #record(phone: string, signal: AbortSignal) {
    const c = this.#config;
    if (signal.aborted) return undefined;
    const found = await this.#records({ scope: Object.freeze({ ...c.scope }), policyVersion: c.policyVersion, businessId: c.businessId,
      credentialFingerprint: this.#fingerprint, normalizedPhone: phone, signal });
    return found.ok && !signal.aborted ? this.#decode(structuredClone(found.value)) : undefined;
  }
  async #membership(record: ClinicGuardianIdentityRecord, signal: AbortSignal) {
    if (signal.aborted) return undefined;
    const found = await this.#member(record.approverRef);
    return found.ok && found.value && validAdminAccount(found.value) && found.value.actor.role === "clinicAdmin" &&
      found.value.actor.actorRef === record.approverRef && sameScope(found.value.actor.scope, this.#config.scope) && !signal.aborted
      ? structuredClone(found.value) : undefined;
  }
  #contact(value: unknown, id: string, phone: string) {
    const contact = row(value), email = normalizeEmailAddress(contact?.email), phones = contact?.phone_numbers;
    if (!contact || contact.id !== id || contact.archived_at !== null || contact.deleted_at !== null || contact.type_code !== 2 || contact.type !== "Standard" ||
        row(contact.links)?.self !== `${this.#base}/contacts/${id}` || !email || typeof contact.updated_at !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(contact.updated_at) || !Number.isFinite(Date.parse(contact.updated_at)) ||
        new Date(contact.updated_at).toISOString().slice(0, 19) !== contact.updated_at.slice(0, 19) ||
        !Array.isArray(phones) || phones.length > 20) return undefined;
    let matches = false;
    for (const value of phones) {
      const item = row(value);
      if (!item || item.number !== null && typeof item.number !== "string" || item.phone_type !== null && item.phone_type !== undefined && typeof item.phone_type !== "string") return undefined;
      if (String(item.phone_type).toLowerCase() !== "fax" && typeof item.number === "string" && normalizePatientPhone(item.number, this.#config.countryCallingCode) === phone) matches = true;
    }
    return matches ? { registeredEmail: email, contactUpdatedAt: contact.updated_at } : undefined;
  }
  async #read(phone: string, signal: AbortSignal): Promise<Result<GuardianContactSnapshot, GuardianContactFailure>> {
    const record = await this.#record(phone, signal); if (!record || signal.aborted) return denied();
    const member = await this.#membership(record, signal); if (!member || signal.aborted) return denied();
    if (await claimClinikoBudget(this.#config.rateBudget) || signal.aborted) return unavailable();
    const response = await this.#fetch(`${this.#base}/contacts/${record.contactId}`, { method: "GET", redirect: "error", signal,
      headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${this.#config.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${this.#config.contactEmail})` } });
    if (response.status === 429) await observeCliniko429(this.#config.rateBudget, response.headers.get("X-RateLimit-Reset"));
    if (response.status !== 200 || signal.aborted) return unavailable();
    const parsed = await boundedClinikoJson(response); if (!parsed.ok || signal.aborted) return unavailable();
    const contact = this.#contact(parsed.value, record.contactId, phone); if (!contact) return denied();
    const again = await this.#record(phone, signal); if (!again || !isDeepStrictEqual(again, record) || signal.aborted) return denied();
    const membership = await this.#membership(record, signal); if (!membership || !isDeepStrictEqual(membership, member) || signal.aborted) return denied();
    // Withdrawal during the last membership read must also defeat a late result.
    const final = await this.#record(phone, signal); if (!final || !isDeepStrictEqual(final, record) || signal.aborted) return denied();
    return ok(Object.freeze({ kind: "guardianContact", scope: Object.freeze({ ...this.#config.scope }), policyVersion: record.policyVersion,
      businessId: record.businessId, credentialFingerprint: record.credentialFingerprint, recordRef: record.recordRef, recordVersion: record.recordVersion,
      revision: record.revision, effectiveUntil: record.effectiveUntil, contactId: record.contactId, ...contact }));
  }
  async read(scope: LocationScope, normalizedPhone: string, signal: AbortSignal): Promise<Result<GuardianContactSnapshot, GuardianContactFailure>> {
    if (!scope || !sameScope(scope, this.#config.scope) || typeof normalizedPhone !== "string" || !/^\+[1-9][0-9]{7,14}$/.test(normalizedPhone) || !(signal instanceof AbortSignal) || signal.aborted) return denied();
    const bound = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    try { return await awaitUntilAbort(this.#read(normalizedPhone, bound), bound) ?? unavailable(); }
    catch { return unavailable(); }
  }
}
