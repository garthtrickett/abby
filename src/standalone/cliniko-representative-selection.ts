import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { LocationScope, Result, VerifiedPatient } from "../core/model.ts";
import { err, ok } from "../core/model.ts";
import { boundedClinikoJson } from "../cliniko/bounded-json.ts";
import { claimClinikoBudget, clinikoCredentialFingerprint, isClinikoRequestBudget, observeCliniko429 } from "../cliniko/read-budget.ts";
import { normalizeEmailAddress } from "../shared/email-address.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import { createRepresentativeSubjectVerifier } from "./representative-subject-verification.ts";
import type { AdditionalRepresentativeVerification } from "./representative-subject-verification.ts";
import type { ClinikoBookingSessionConfig } from "./cliniko-booking-session.ts";
import { OwnerFileRepresentativePolicy } from "./owner-file-representative-policy.ts";
import { sameScope, validClinikoId } from "./appointment-change-authority.ts";
import type { PatientOperation } from "./transient-patient-proof.ts";
import type { VerificationContactFailure } from "../cliniko/verification-contact.ts";
import { representativeSubjectEligible, validRepresentativeIdentity as identity } from "./representative-identity.ts";
import type { RepresentativeIdentity } from "./representative-identity.ts";

export type { RepresentativeIdentity } from "./representative-identity.ts";
export type RepresentativeAuthorization = Readonly<{ authorityRef: string; version: string; expiresAt: string;
  authorityKind: "adultRepresentative" | "guardian"; subjectKind: "adult" | "minor" }>;
type ActorQuery = Readonly<{ scope: LocationScope; callId: string; sessionId: string; caller: VerifiedPatient;
  operation: PatientOperation; policyVersion: string; signal: AbortSignal }>;
export interface ClinicRepresentativePermission {
  allowsLookup(query: ActorQuery): Promise<boolean>;
  authorize(query: ActorQuery & Readonly<{ subjectPatientId: string; relationshipId: string; relationCode: number;
    purpose: "identify" | "channel" | "operation" }>): Promise<RepresentativeAuthorization | undefined>;
}
type Config = Omit<ClinikoBookingSessionConfig, "callerApprovalPath" | "bookingApprovalPath" | "permission"> & Readonly<{
  actor: CallerVerificationSession; actorOperation: PatientOperation; policy: OwnerFileRepresentativePolicy;
  representativeCallerApprovalPath: string; permission: ClinicRepresentativePermission;
}>;
type Relation = Readonly<{ id: string; subjectId: string; code: number; updatedAt: string }>;
type Subject = RepresentativeIdentity & Readonly<{ patientId: string; email: string }>;
type Selection = Readonly<{ ref: string; operation: PatientOperation; callerId: string; caller: VerifiedPatient; relation: Relation; subject: Subject; authorization: RepresentativeAuthorization }>;
const fail = <T>(): Result<T, Readonly<{ kind: "representativeUnavailable" }>> => err({ kind: "representativeUnavailable" });
const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const label = (value: unknown): value is string => typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 255 && !/[\p{Cc}\p{Cf}]/u.test(value);
const instant = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const name = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en");

/** Private per-person selection. Related-patient records supply identity evidence;
 * current clinic authorization and separate subject channel proof supply authority. */
export class ClinikoRepresentativeSelection {
  readonly #config: Config;
  readonly #base: string;
  readonly #fingerprint: string;
  readonly #lifetime = new AbortController();
  #selection: Selection | undefined;
  #verification: CallerVerificationSession | undefined;
  #busy = false;
  #subjectAttempted = false;
  readonly #onClose = () => this.dispose();
  constructor(config: Config) {
    const fp = clinikoCredentialFingerprint(config.cliniko.apiKey), binding = config.actor?.binding();
    if (!(config.actor instanceof CallerVerificationSession) || !(config.policy instanceof OwnerFileRepresentativePolicy) ||
        !config.actor.usesSelfRegisteredContact() || !config.actor.matchesClinikoAccount(fp) || binding?.callId !== config.receipt.callId || binding.sessionId !== config.sessionId ||
        !isClinikoRequestBudget(config.cliniko.rateBudget) || !validClinikoId(config.cliniko.businessId) ||
        typeof config.permission?.allowsLookup !== "function" || typeof config.permission?.authorize !== "function") throw new TypeError("invalid representative owner");
    this.#config = Object.freeze({ ...config, receipt: structuredClone(config.receipt), inbound: structuredClone(config.inbound), cliniko: Object.freeze({ ...config.cliniko }) });
    this.#fingerprint = fp; this.#base = `https://api.${config.cliniko.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)![1]}.cliniko.com/v1`;
    config.signal.addEventListener("abort", this.#onClose, { once: true });
    if (config.signal.aborted) this.dispose();
  }
  #now() { return (this.#config.clock ?? (() => new Date().toISOString()))(); }
  async #actor(operation: PatientOperation, signal: AbortSignal): Promise<ActorQuery | undefined> {
    const c = this.#config;
    if (signal.aborted || c.signal.aborted || this.#lifetime.signal.aborted) return undefined;
    const approval = await c.policy.current(c.receipt.scope), caller = await c.actor.verifiedSubject(c.actorOperation, signal);
    if (!approval.ok || !caller || !sameScope(caller.scope, c.receipt.scope) || !approval.value.operations.includes(operation) ||
        approval.value.policyVersion !== c.policyVersion || approval.value.businessId !== c.cliniko.businessId || approval.value.credentialFingerprint !== this.#fingerprint ||
        approval.value.timeZone !== c.cliniko.timeZone || !validClinikoId(caller.patientRef)) return undefined;
    const query = { scope: c.receipt.scope, callId: c.receipt.callId, sessionId: c.sessionId, caller, operation, policyVersion: c.policyVersion, signal };
    return await c.permission.allowsLookup(query) === true && !signal.aborted ? query : undefined;
  }
  async #get(path: string, signal: AbortSignal) {
    const c = this.#config;
    if (signal.aborted || c.signal.aborted || this.#lifetime.signal.aborted || await claimClinikoBudget(c.cliniko.rateBudget)) return undefined;
    if (signal.aborted || c.signal.aborted || this.#lifetime.signal.aborted) return undefined;
    const response = await (c.fetchPort ?? fetch)(`${this.#base}${path}`, { method: "GET", redirect: "error", signal,
      headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${c.cliniko.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${c.cliniko.contactEmail})` } });
    if (response.status === 429) await observeCliniko429(c.cliniko.rateBudget, response.headers.get("X-RateLimit-Reset"));
    if (response.status !== 200 || signal.aborted) return undefined;
    const body = await boundedClinikoJson(response); return body.ok && !signal.aborted ? record(body.value) : undefined;
  }
  #id(value: unknown, family: string) {
    const self = record(record(value)?.links)?.self;
    if (typeof self !== "string" || !self.startsWith(`${this.#base}/${family}/`)) return undefined;
    const id = self.slice(`${this.#base}/${family}/`.length); return validClinikoId(id) ? id : undefined;
  }
  #relation(value: unknown, callerId: string): Relation | undefined {
    const row = record(value), subjectId = this.#id(row?.related_patient, "patients");
    return row && validClinikoId(row.id) && row.archived_at === null && this.#id(row.patient, "patients") === callerId && subjectId && subjectId !== callerId &&
      [10, 20, 30, 40, 50, 60, 70].includes(Number(row.relation)) && typeof row.relation === "number" && instant(row.updated_at)
      ? { id: row.id, subjectId, code: row.relation, updatedAt: row.updated_at } : undefined;
  }
  async #relations(callerId: string, signal: AbortSignal): Promise<Relation[] | undefined> {
    let total: number | undefined; const rows: Relation[] = [], seen = new Set<string>();
    for (let page = 1; page <= 5; page++) {
      const query = new URLSearchParams({ page: String(page), per_page: "100" }); query.append("q[]", `patient_id:=${callerId}`);
      const body = await this.#get(`/relationships?${query}`, signal);
      if (!body || !Number.isSafeInteger(body.total_entries) || Number(body.total_entries) < 0 || Number(body.total_entries) > 500 ||
          total !== undefined && total !== body.total_entries || !Array.isArray(body.relationships) || body.relationships.length > 100) return undefined;
      total = Number(body.total_entries);
      for (const value of body.relationships) {
        const relation = this.#relation(value, callerId); if (!relation || seen.has(relation.id)) return undefined;
        seen.add(relation.id); rows.push(relation);
      }
      if (seen.size > total || body.relationships.length === 0 && seen.size < total) return undefined;
      if (seen.size === total) return rows;
    }
    return undefined;
  }
  #subject(value: unknown, patientId: string): Subject | undefined {
    const row = record(value), email = normalizeEmailAddress(row?.email);
    const values = { firstName: row?.first_name, lastName: row?.last_name, dateOfBirth: row?.date_of_birth };
    return row?.id === patientId && row.archived_at === null && email && identity(values) ? { ...values, patientId, email } : undefined;
  }
  async #authorize(actor: ActorQuery, relation: Relation, purpose: "identify" | "channel" | "operation") {
    const value = await this.#config.permission.authorize({ ...actor, subjectPatientId: relation.subjectId, relationshipId: relation.id, relationCode: relation.code, purpose });
    const captured = structuredClone(value), row = record(captured), approval = await this.#config.policy.current(actor.scope), now = Date.parse(this.#now());
    return row && Object.keys(row).sort().join(",") === "authorityKind,authorityRef,expiresAt,subjectKind,version" && label(row.authorityRef) && label(row.version) && instant(row.expiresAt) &&
      Date.parse(row.expiresAt) > now && Date.parse(row.expiresAt) <= Date.parse(actor.caller.expiresAt) &&
      (row.subjectKind === "adult" && row.authorityKind === "adultRepresentative" || row.subjectKind === "minor" && row.authorityKind === "guardian") &&
      approval.ok && approval.value.allowedAuthorities.includes(row.authorityKind as "adultRepresentative" | "guardian") && !actor.signal.aborted ? captured : undefined;
  }
  async #eligible(subject: Subject, authorization: RepresentativeAuthorization, signal: AbortSignal): Promise<boolean> {
    const approval = await this.#config.policy.current(this.#config.receipt.scope);
    if (!approval.ok || signal.aborted) return false;
    return representativeSubjectEligible(subject.dateOfBirth, authorization, approval.value, this.#now());
  }
  async #bounded<T>(signal: AbortSignal, run: (bound: AbortSignal) => Promise<T>): Promise<T | undefined> {
    const bound = AbortSignal.any([signal, this.#config.signal, this.#lifetime.signal, AbortSignal.timeout(20_000)]);
    try { return await awaitUntilAbort(run(bound), bound); } catch { return undefined; }
  }
  async select(incoming: RepresentativeIdentity, operation: PatientOperation, signal: AbortSignal) {
    if (this.#busy || this.#subjectAttempted || !identity(incoming)) return fail<{ selectionRef: string }>();
    this.#busy = true; this.#selection = undefined; const wanted = structuredClone(incoming);
    try {
      const selection = await this.#bounded(signal, async bound => {
        const actor = await this.#actor(operation, bound); if (!actor) return undefined;
        const relations = await this.#relations(actor.caller.patientRef, bound); if (!relations) return undefined;
        const matches: Selection[] = [];
        for (const relation of relations) {
          const authorization = await this.#authorize(actor, relation, "identify"); if (!authorization) continue;
          const subject = this.#subject(await this.#get(`/patients/${relation.subjectId}`, bound), relation.subjectId); if (!subject || !await this.#eligible(subject, authorization, bound)) return undefined;
          if (name(subject.firstName) === name(wanted.firstName) && name(subject.lastName) === name(wanted.lastName) && subject.dateOfBirth === wanted.dateOfBirth)
            matches.push({ ref: randomUUID(), operation, callerId: actor.caller.patientRef, caller: structuredClone(actor.caller), relation, subject, authorization });
        }
        if (matches.length !== 1) return undefined;
        this.#selection = matches[0]; return await this.#current(matches[0]!, "identify", bound) ? matches[0] : undefined;
      });
      if (!selection || signal.aborted) { this.#selection = undefined; return fail<{ selectionRef: string }>(); }
      return ok({ selectionRef: selection.ref });
    } finally { this.#busy = false; }
  }
  /** Method policy and candidate lookup expose no patient fields. They check
   * current actor/process permission; contact and operation permission below
   * independently require fresh native relationship and subject evidence. */
  async #authorized(selection: Selection, signal: AbortSignal) {
    const c = this.#config, approval = await c.policy.current(c.receipt.scope);
    if (!approval.ok || !approval.value.operations.includes(selection.operation) || this.#selection !== selection ||
        !await c.actor.ownsCurrentProof(c.actorOperation, selection.caller.verificationRef, signal)) return false;
    const query: ActorQuery = { scope: c.receipt.scope, callId: c.receipt.callId, sessionId: c.sessionId, caller: structuredClone(selection.caller),
      operation: selection.operation, policyVersion: c.policyVersion, signal };
    if (await c.permission.allowsLookup(query) !== true || signal.aborted) return false;
    const authorization = await this.#authorize(query, selection.relation, "channel");
    return !!authorization && isDeepStrictEqual(authorization, selection.authorization) && !signal.aborted;
  }
  async #current(selection: Selection, purpose: "identify" | "channel" | "operation", signal: AbortSignal) {
    const actor = await this.#actor(selection.operation, signal); if (!actor || actor.caller.patientRef !== selection.callerId || this.#selection !== selection) return undefined;
    const relation = this.#relation(await this.#get(`/relationships/${selection.relation.id}`, signal), actor.caller.patientRef);
    if (!relation || !isDeepStrictEqual(relation, selection.relation)) return undefined;
    const authorization = await this.#authorize(actor, relation, purpose); if (!authorization || !isDeepStrictEqual(authorization, selection.authorization)) return undefined;
    const subject = this.#subject(await this.#get(`/patients/${relation.subjectId}`, signal), relation.subjectId);
    if (!subject || !isDeepStrictEqual(subject, selection.subject) || !await this.#eligible(subject, authorization, signal)) return undefined;
    // Recheck authority after native reads; withdrawal during the read must win.
    // The native caller was freshly verified before protected native reads.
    // Recheck ownership, process and independent permission after those reads;
    // every later logical validation re-verifies the native caller again.
    if (!await this.#authorized(selection, signal) || this.#selection !== selection) return undefined;
    const finalAuthorization = await this.#authorize(actor, relation, purpose);
    return finalAuthorization && isDeepStrictEqual(finalAuthorization, selection.authorization) && !signal.aborted ? subject : undefined;
  }
  matchesWorkflow(query: Readonly<{ scope: LocationScope; callId: string; sessionId: string; policyVersion: string;
    credentialFingerprint: string; businessId: string; timeZone: string; operation: PatientOperation; selectionRef: string;
    inbound: Config["inbound"] }>): boolean {
    const c = this.#config, selected = this.#selection;
    return !c.signal.aborted && !this.#lifetime.signal.aborted && !!selected && selected.ref === query.selectionRef && selected.operation === query.operation &&
      sameScope(query.scope, c.receipt.scope) && query.callId === c.receipt.callId && query.sessionId === c.sessionId && query.policyVersion === c.policyVersion &&
      query.inbound.key.accountRef === c.inbound.key.accountRef && query.inbound.key.providerCallRef === c.inbound.key.providerCallRef &&
      query.inbound.dialedNumber === c.inbound.dialedNumber && query.inbound.presentedCallerNumber === c.inbound.presentedCallerNumber &&
      query.credentialFingerprint === this.#fingerprint && query.businessId === c.cliniko.businessId && query.timeZone === c.cliniko.timeZone;
  }
  async verifier(selectionRef: string, signal: AbortSignal, additional?: AdditionalRepresentativeVerification) {
    const selected = this.#selection, c = this.#config;
    if (this.#busy || this.#subjectAttempted || !selected || selected.ref !== selectionRef || additional && (additional.policy?.operation !== selected.operation ||
        typeof additional.policy?.current !== "function" || typeof additional.permission?.allows !== "function")) return fail<CallerVerificationSession>();
    this.#subjectAttempted = true;
    const verifier = await this.#bounded(signal, async bound => {
      if (!await this.#current(selected, "channel", bound)) return undefined;
      const created = await createRepresentativeSubjectVerifier({ ...c, patientId: selected.subject.patientId, operation: selected.operation,
        subjectApprovalPath: c.representativeCallerApprovalPath, contactAuthority: this, ...(additional ? { additional } : {}), authority: {
          authorized: async request => await this.#bounded(request, live => this.#authorized(selected, live)) === true,
          current: async (purpose, request) => (await this.#bounded(request, live => this.#current(selected, purpose, live)))?.email,
          operation: async request => await this.#bounded(request, async live => {
            const actor: ActorQuery = { scope: c.receipt.scope, callId: c.receipt.callId, sessionId: c.sessionId, caller: structuredClone(selected.caller),
              operation: selected.operation, policyVersion: c.policyVersion, signal: live };
            const authority = await this.#authorize(actor, selected.relation, "operation");
            return !!authority && isDeepStrictEqual(authority, selected.authorization) && this.#selection === selected && !live.aborted;
          }) === true,
        } }, bound);
      return created.ok && !bound.aborted ? created.value : undefined;
    });
    if (!verifier || signal.aborted) { verifier?.dispose(); return fail<CallerVerificationSession>(); }
    this.#verification = verifier; return ok(verifier);
  }
  matchesContact(scope: Pick<LocationScope, "tenantId" | "clinicId">, fingerprint: string): boolean {
    const c = this.#config; return !c.signal.aborted && !this.#lifetime.signal.aborted && scope.tenantId === c.receipt.scope.tenantId &&
      scope.clinicId === c.receipt.scope.clinicId && fingerprint === this.#fingerprint;
  }
  async registeredRecipient(scope: LocationScope, patientId: string, phone: string, signal: AbortSignal): Promise<Result<string, VerificationContactFailure>> {
    const selected = this.#selection, c = this.#config;
    if (!selected || !sameScope(scope, c.receipt.scope) || patientId !== selected.subject.patientId || phone !== c.inbound.presentedCallerNumber) return err({ kind: "denied" });
    const subject = await this.#bounded(signal, bound => this.#current(selected, "channel", bound));
    return subject && !signal.aborted && this.#selection === selected ? ok(subject.email) : err({ kind: "denied" });
  }
  dispose(): void { this.#config.signal.removeEventListener("abort", this.#onClose); this.#lifetime.abort(); this.#verification?.dispose(); this.#verification = undefined; this.#selection = undefined; }
}
