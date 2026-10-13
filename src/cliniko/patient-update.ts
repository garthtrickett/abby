import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { normalizeEmailAddress } from "../shared/email-address.ts";
import { sameScope, validClinikoId } from "../standalone/appointment-change-authority.ts";
import { boundedClinikoJson } from "./bounded-json.ts";
import { claimClinikoBudget, clinikoCredentialFingerprint, isClinikoRequestBudget, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";
import { patientDetailFields, patientDetailsSnapshot, patientDetailsDigest, patientDetailChangesDigest, validPatientDetailChanges } from "./patient-details.ts";
import type { PatientDetailChanges, PatientDetailField, PatientDetailsSnapshot } from "./patient-details.ts";

export type PatientUpdateQuery = Readonly<{ scope: LocationScope; callId: string; sessionId: string;
  patientId: string; policyVersion: string; verificationRef: string }>;
export type PatientUpdateRequest = PatientUpdateQuery & Readonly<{ attemptRef: string; consentRef: string;
  expectedDigest: string; changes: PatientDetailChanges; prospectiveEmailRef?: string }>;
export type PatientUpdateAttestation = PatientUpdateQuery & Readonly<{ operation: "patients.update";
  recordScope: "clinikoAccount"; credentialFingerprint: string; allowedFields: readonly PatientDetailField[];
  expiresAt: string; independentPermission: true; selfAuthorized: true;
  /** Send attestation binds the privately played complete correction, not spoken/model assertions. */
  attemptRef?: string; consentRef?: string; expectedDigest?: string; changesDigest?: string;
  confirmationPlayed?: true; prospectiveEmailRef?: string; prospectiveEmailDigest?: string }>;
export type PatientUpdateAuthority = Readonly<{
  attest(query: PatientUpdateQuery | PatientUpdateRequest, phase: "read" | "send" | "inspect", signal: AbortSignal): Promise<PatientUpdateAttestation | null>;
  /** An explicit owner dependency: revoke old contact grants and synchronize
   * affected lookup state after known native readback. Failure needs review. */
  contactChanged(request: PatientUpdateRequest, snapshot: PatientDetailsSnapshot, signal: AbortSignal): Promise<boolean>;
}>;
type Config = Readonly<{ scope: LocationScope; apiKey: string; contactEmail: string; rateBudget: ClinikoRequestBudget }>;
type Failure = Readonly<{ kind: "invalidConfig" | "invalidQuery" | "forbidden" | "unavailable" | "changed" }>;
export type PatientUpdateOutcome = Readonly<{ kind: "updated" | "unchanged"; patientId: string }> | Readonly<{ kind: "uncertain" | "needsContactReview" }>;
const ref = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const emailDigest = (email: string | null) => createHash("sha256").update(JSON.stringify(email)).digest("hex");

/** Native provider edge only. It cannot approve a correction, verify a caller,
 * play confirmation, update lookup state or activate a patient-facing workflow. */
export class ClinikoPatientUpdateEdge {
  readonly #config: Config;
  readonly #authority: PatientUpdateAuthority;
  readonly #fetch: typeof fetch;
  readonly #clock: () => string;
  readonly #base: string;
  readonly #lifetime = new AbortController();
  readonly #attempted = new Set<string>();
  readonly #busy = new Set<string>();
  private constructor(config: Config, authority: PatientUpdateAuthority, fetchPort: typeof fetch, clock: () => string) {
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) });
    this.#authority = authority; this.#fetch = fetchPort; this.#clock = clock;
    this.#base = `https://api.${config.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)![1]}.cliniko.com/v1`;
  }
  static create(config: Config, authority: PatientUpdateAuthority, fetchPort: typeof fetch = fetch, clock = () => new Date().toISOString()): Result<ClinikoPatientUpdateEdge, Failure> {
    if (!config || !config.scope || ![config.scope.tenantId, config.scope.clinicId, config.scope.locationId].every(ref) ||
        typeof config.apiKey !== "string" || !/^.+-[a-z]{2}[0-9]{1,2}$/.test(config.apiKey) || /[\p{Cc}\p{Cf}]/u.test(config.apiKey) ||
        !normalizeEmailAddress(config.contactEmail) || !isClinikoRequestBudget(config.rateBudget) ||
        typeof authority?.attest !== "function" || typeof authority.contactChanged !== "function" || typeof fetchPort !== "function" || typeof clock !== "function") return err({ kind: "invalidConfig" });
    return ok(new ClinikoPatientUpdateEdge(config, authority, fetchPort, clock));
  }
  #query(query: PatientUpdateQuery, update = false): boolean {
    if (!query || !query.scope || Object.keys(query.scope).sort().join(",") !== "clinicId,locationId,tenantId") return false;
    const keys = ["scope", "callId", "sessionId", "patientId", "policyVersion", "verificationRef",
      ...(update ? ["attemptRef", "consentRef", "expectedDigest", "changes", ...(Object.hasOwn(query, "prospectiveEmailRef") ? ["prospectiveEmailRef"] : [])] : [])];
    return Object.keys(query).sort().join(",") === keys.sort().join(",") && sameScope(query.scope, this.#config.scope) &&
      [query.callId, query.sessionId, query.policyVersion, query.verificationRef].every(ref) && validClinikoId(query.patientId);
  }
  #key(query: PatientUpdateQuery): string { return JSON.stringify([query.callId, query.sessionId, query.patientId]); }
  async #bounded<T>(run: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T | undefined> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
    const signal = AbortSignal.any([controller.signal, this.#lifetime.signal, ...(external ? [external] : [])]);
    try { return await awaitUntilAbort(Promise.resolve().then(() => signal.aborted ? undefined : run(signal)), signal); }
    catch { return undefined; } finally { clearTimeout(timer); controller.abort(); }
  }
  async #authorized(query: PatientUpdateQuery | PatientUpdateRequest, phase: "read" | "send" | "inspect", signal: AbortSignal): Promise<boolean> {
    const proof = await awaitUntilAbort(this.#authority.attest(structuredClone(query), phase, signal), signal);
    const now = Date.parse(this.#clock());
    if (!proof || signal.aborted || !Number.isFinite(now) || !sameScope(proof.scope, query.scope) ||
        ["callId", "sessionId", "patientId", "policyVersion", "verificationRef"].some(key => proof[key as keyof PatientUpdateQuery] !== query[key as keyof PatientUpdateQuery]) ||
        proof.operation !== "patients.update" || proof.recordScope !== "clinikoAccount" || proof.credentialFingerprint !== clinikoCredentialFingerprint(this.#config.apiKey) ||
        proof.independentPermission !== true || proof.selfAuthorized !== true || !Number.isFinite(Date.parse(proof.expiresAt)) ||
        Date.parse(proof.expiresAt) <= now || Date.parse(proof.expiresAt) - now > 300_000 ||
        !Array.isArray(proof.allowedFields) || proof.allowedFields.length < 1 || new Set(proof.allowedFields).size !== proof.allowedFields.length ||
        proof.allowedFields.some(field => !patientDetailFields.includes(field))) return false;
    if (phase === "read") return true;
    if (!("changes" in query) || proof.attemptRef !== query.attemptRef || proof.consentRef !== query.consentRef || proof.confirmationPlayed !== true ||
        proof.expectedDigest !== query.expectedDigest || proof.changesDigest !== patientDetailChangesDigest(query.changes) ||
        Object.keys(query.changes).some(key => !proof.allowedFields.includes(key as PatientDetailField))) return false;
    return !Object.hasOwn(query.changes, "email") || ref(query.prospectiveEmailRef) && proof.prospectiveEmailRef === query.prospectiveEmailRef &&
      proof.prospectiveEmailDigest === emailDigest(query.changes.email ?? null);
  }
  async #get(query: PatientUpdateQuery, signal: AbortSignal): Promise<PatientDetailsSnapshot | undefined> {
    const limited = await awaitUntilAbort(claimClinikoBudget(this.#config.rateBudget), signal);
    if (limited !== null || signal.aborted) return undefined;
    const response = await awaitUntilAbort(this.#fetch(`${this.#base}/patients/${query.patientId}`, { method: "GET", redirect: "error", signal,
      headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${this.#config.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${this.#config.contactEmail})` } }), signal);
    if (!response || signal.aborted) return undefined;
    if (response.status === 429) await observeCliniko429(this.#config.rateBudget, response.headers.get("X-RateLimit-Reset"));
    if (response.status !== 200) return undefined;
    const parsed = await awaitUntilAbort(boundedClinikoJson(response), signal);
    return parsed?.ok && !signal.aborted ? patientDetailsSnapshot(parsed.value, query.patientId, this.#base) : undefined;
  }
  async readTarget(incoming: PatientUpdateQuery, external?: AbortSignal): Promise<Result<PatientDetailsSnapshot, Failure>> {
    try {
      const query = structuredClone(incoming); if (!this.#query(query)) return err({ kind: "invalidQuery" });
      return await this.#bounded(async signal => {
        if (!await this.#authorized(query, "read", signal)) return err({ kind: "forbidden" as const });
        const snapshot = await this.#get(query, signal);
        return snapshot && await this.#authorized(query, "read", signal) && !signal.aborted ? ok(snapshot) : err({ kind: "unavailable" as const });
      }, external) ?? err({ kind: "unavailable" });
    } catch { return err({ kind: "invalidQuery" }); }
  }
  async updateOnce(incoming: PatientUpdateRequest, external?: AbortSignal): Promise<Result<PatientUpdateOutcome, Failure>> {
    let sent = false, acquired = false, key: string | undefined;
    try {
      const request = structuredClone(incoming);
      if (!this.#query(request, true) || !ref(request.attemptRef) || !ref(request.consentRef) || !digest(request.expectedDigest) || !validPatientDetailChanges(request.changes) ||
          request.prospectiveEmailRef !== undefined && !ref(request.prospectiveEmailRef)) return err({ kind: "invalidQuery" });
      key = this.#key(request);
      if (this.#busy.has(key) || this.#attempted.has(key) || this.#attempted.size >= 10_000) return err({ kind: "forbidden" });
      this.#busy.add(key);
      acquired = true;
      const result = await this.#bounded(async signal => {
        if (!await this.#authorized(request, "send", signal)) return err({ kind: "forbidden" as const });
        const before = await this.#get(request, signal);
        if (!before || patientDetailsDigest(before) !== request.expectedDigest) return err({ kind: "changed" as const });
        if (request.changes.date_of_birth && Date.parse(request.changes.date_of_birth) > Date.parse(this.#clock()) ||
            request.changes.patient_phone_numbers?.some(phone => !before.details.patient_phone_numbers.some(original =>
              original.number === phone.number && original.phone_type === phone.phone_type) && !/^\+[1-9][0-9]{7,14}$/.test(phone.number))) return err({ kind: "invalidQuery" as const });
        const expected = { ...before.details, ...request.changes };
        if (!await this.#authorized(request, "send", signal) || signal.aborted) return err({ kind: "forbidden" as const });
        if (JSON.stringify(expected) === JSON.stringify(before.details)) return ok({ kind: "unchanged" as const, patientId: request.patientId });
        const limited = await awaitUntilAbort(claimClinikoBudget(this.#config.rateBudget), signal);
        if (limited !== null || signal.aborted) return err({ kind: "unavailable" as const });
        if (!await this.#authorized(request, "send", signal) || signal.aborted) return err({ kind: "forbidden" as const });
        this.#attempted.add(key!); sent = true;
        const response = await awaitUntilAbort(this.#fetch(`${this.#base}/patients/${request.patientId}`, { method: "PATCH", redirect: "error", signal,
          headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${this.#config.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${this.#config.contactEmail})` },
          body: JSON.stringify(request.changes) }), signal);
        const uncertain = () => ok({ kind: "uncertain" as const });
        if (!response || signal.aborted) return uncertain();
        if (response.status === 429) await observeCliniko429(this.#config.rateBudget, response.headers.get("X-RateLimit-Reset"));
        if (response.status !== 200 || !await this.#authorized(request, "inspect", signal)) return uncertain();
        const returned = await awaitUntilAbort(boundedClinikoJson(response), signal);
        const resultRow = returned?.ok ? patientDetailsSnapshot(returned.value, request.patientId, this.#base) : undefined;
        const observed = await this.#get(request, signal);
        if (!resultRow || !observed || JSON.stringify(resultRow.details) !== JSON.stringify(expected) || JSON.stringify(observed.details) !== JSON.stringify(expected) ||
            !await this.#authorized(request, "inspect", signal) || signal.aborted) return uncertain();
        let contact: boolean | undefined;
        try { contact = await awaitUntilAbort(this.#authority.contactChanged(structuredClone(request), structuredClone(observed), signal), signal); }
        catch { return ok({ kind: "needsContactReview" as const }); }
        return contact === true && !signal.aborted ? ok({ kind: "updated" as const, patientId: request.patientId }) : ok({ kind: "needsContactReview" as const });
      }, external);
      return result ?? (sent ? ok({ kind: "uncertain" }) : err({ kind: "unavailable" }));
    } catch { return sent ? ok({ kind: "uncertain" }) : err({ kind: "unavailable" }); }
    finally { if (acquired && key) this.#busy.delete(key); }
  }
  dispose(): void { this.#lifetime.abort(); }
}
