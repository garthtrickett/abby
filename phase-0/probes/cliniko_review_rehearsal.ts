import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { boundedClinikoJson } from "../../src/cliniko/bounded-json.ts";
import { ClinikoReadBudget, claimClinikoBudget, clinikoCredentialFingerprint, observeCliniko429 } from "../../src/cliniko/read-budget.ts";
import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { ClinikoRecallWriter } from "../../src/cliniko/recall-write.ts";
import { decodeClinikoReview, encodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { err, ok } from "../../src/core/model.ts";
import type { Result } from "../../src/core/model.ts";
import { normalizeEmailAddress } from "../../src/shared/email-address.ts";
import { clinicDateAt } from "../../src/standalone/clinic-clock.ts";

export const reviewRehearsalType = "Abby supervised review rehearsal";
const scope = { tenantId: "abby-review-rehearsal", clinicId: "demo", locationId: "supervised" };
const patientTag = "abby-review-rehearsal:";
const policyVersion = "demo.reviewOnly.noAppointmentSend";
const id = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value);
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export type RehearsalFailure = Readonly<{ kind: "invalidConfig" | "unavailable" | "ambiguousFixture" | "uncertainSetup" | "unsafeCleanup" }>;
export type RehearsalStatus = Readonly<{ kind: "clinikoReviewRehearsal"; types: number; patients: number;
  pending: number; providerMarkedRecalled: number; invalid: number; ambiguous: number; clinicalWrites: 0 }>;
type Fixture = Readonly<{ type: Record<string, unknown> | undefined; patients: Record<string, unknown>[];
  recalls: Record<string, unknown>[]; status: RehearsalStatus }>;

class ProbeFailure extends Error {
  readonly kind: RehearsalFailure["kind"];
  constructor(kind: RehearsalFailure["kind"]) { super(kind); this.kind = kind; }
}

/** Owner-run demo fixture. Not a staff approval source, production queue or caller action adapter. */
export class ClinikoReviewRehearsal {
  readonly #base: string;
  readonly #key: string;
  readonly #contact: string;
  readonly #fetch: typeof fetch;
  readonly #budget = new ClinikoReadBudget(180);
  readonly #clock: () => Date;
  constructor(config: Readonly<{ apiKey: string; contactEmail: string; clock?: () => Date }>, fetchPort: typeof fetch = fetch) {
    const shard = typeof config?.apiKey === "string" ? config.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1] : undefined;
    if (!shard || !config.apiKey.slice(0, -(shard.length + 1)) || /[\u0000-\u001f\u007f]/.test(config.apiKey) ||
        !normalizeEmailAddress(config.contactEmail) || typeof fetchPort !== "function" ||
        (config.clock !== undefined && typeof config.clock !== "function")) throw new ProbeFailure("invalidConfig");
    this.#base = `https://api.${shard}.cliniko.com/v1`; this.#key = config.apiKey;
    this.#contact = config.contactEmail; this.#fetch = fetchPort; this.#clock = config.clock ?? (() => new Date());
  }

  async #request(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<unknown> {
    if (await claimClinikoBudget(this.#budget)) throw new ProbeFailure("unavailable");
    let response: Response;
    try {
      response = await this.#fetch(this.#base+path, { method, redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Accept: "application/json", "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${this.#key}:`).toString("base64")}`,
          "User-Agent": `Abby demo review rehearsal (${this.#contact})` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new ProbeFailure(method === "POST" ? "uncertainSetup" : "unavailable"); }
    if (response.status === 429) await observeCliniko429(this.#budget, response.headers.get("X-RateLimit-Reset"));
    if (method === "POST" && path.endsWith("/archive")) {
      if (response.status !== 204) throw new ProbeFailure("unsafeCleanup"); return undefined;
    }
    if (response.status !== (method === "POST" ? 201 : 200)) throw new ProbeFailure(method === "POST" ? "uncertainSetup" : "unavailable");
    const parsed = await boundedClinikoJson(response);
    if (!parsed.ok) throw new ProbeFailure(method === "POST" ? "uncertainSetup" : "unavailable");
    return parsed.value;
  }

  async #rows(resource: "recall_types" | "patients" | "businesses" | "practitioners" | "appointment_types" | "recalls" | "individual_appointments", query = ""): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = []; let expected: number | undefined, previous = 0n;
    for (let page = 1; page <= 5; page++) {
      const body = object(await this.#request("GET", `/${resource}?per_page=100&page=${page}&sort=id:asc${query}`));
      const entries = body?.[resource], total = body?.total_entries;
      if (!Array.isArray(entries) || !Number.isSafeInteger(total) || Number(total) < 0 || Number(total) > 500 ||
          (expected !== undefined && total !== expected) || entries.length !== Math.min(100, Math.max(0, Number(total) - (page-1)*100))) {
        throw new ProbeFailure("unavailable");
      }
      expected = Number(total);
      for (const value of entries) {
        const row = object(value);
        if (!row || !id(row.id) || BigInt(row.id) <= previous || row.archived_at !== null) throw new ProbeFailure("unavailable");
        previous = BigInt(row.id); rows.push(row);
      }
      if (rows.length === expected) return rows;
    }
    throw new ProbeFailure("unavailable");
  }

  #reader(): ClinikoRecallReader {
    const reader = ClinikoRecallReader.create({ scope, apiKey: this.#key, contactEmail: this.#contact, rateBudget: this.#budget }, this.#fetch);
    if (!reader.ok) throw new ProbeFailure("unavailable"); return reader.value;
  }

  async #fixture(): Promise<Fixture> {
    const types = (await this.#rows("recall_types")).filter(row => row.name === reviewRehearsalType);
    const patients = (await this.#rows("patients")).filter(row => typeof row.old_reference_id === "string" && row.old_reference_id.startsWith(patientTag));
    if (types.length > 1 || patients.length > 1) throw new ProbeFailure("ambiguousFixture");
    if (patients.some(row => row.first_name !== "Abby" || row.last_name !== "ReviewRehearsal" ||
        !/^abby-review-rehearsal:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(row.old_reference_id)))) {
      throw new ProbeFailure("ambiguousFixture");
    }
    if (types[0] && (types[0].default_duration !== 1 || types[0].default_duration_type !== 10)) {
      throw new ProbeFailure("ambiguousFixture");
    }
    const status = { kind: "clinikoReviewRehearsal" as const, types: types.length, patients: patients.length,
      pending: 0, providerMarkedRecalled: 0, invalid: 0, ambiguous: 0, clinicalWrites: 0 as const };
    const type = types[0], allRecalls = type ? await this.#rows("recalls") : [];
    const recalls = allRecalls.filter(row => this.#link(row, "recall_type") === `${this.#base}/recall_types/${type?.id}`);
    const markers = new Set<string>();
    for (const row of recalls) {
      if (row.recalled === false) status.pending++;
      else if (row.recalled === true) status.providerMarkedRecalled++;
      else throw new ProbeFailure("unavailable");
      const decoded = decodeClinikoReview(row.notes);
      if (!decoded.ok || !this.#ownedRecall(row, patients[0])) status.invalid++;
      if (decoded.ok) {
        if (markers.has(decoded.value.marker)) status.ambiguous++;
        markers.add(decoded.value.marker);
      }
    }
    if (type) {
      // Also exercise the production recovery edge, with account/type configuration only.
      const found = await this.#reader().discoverPendingReviews(scope, String(type.id));
      if (!found.ok || found.value.pending.length !== status.pending) throw new ProbeFailure("unavailable");
      if (found.value.pending.some(row => row.kind !== "review")) status.invalid++;
    }
    return { type, patients, recalls, status };
  }

  #link(row: Record<string, unknown>, field: string): unknown { return object(object(row[field])?.links)?.self; }

  #ownedRecall(row: Record<string, unknown>, patient: Record<string, unknown> | undefined): boolean {
    const decoded = decodeClinikoReview(row.notes);
    if (!decoded.ok || !patient) return false;
    const request = decoded.value.request;
    return request.patientId === patient.id && this.#link(row, "patient") === `${this.#base}/patients/${patient.id}` &&
      request.scope.tenantId === scope.tenantId && request.scope.clinicId === scope.clinicId &&
      request.scope.locationId === scope.locationId && request.credentialFingerprint === clinikoCredentialFingerprint(this.#key) &&
      request.policyVersion === policyVersion && request.termsVersion === "demo.reviewOnly.noFees" &&
      request.operation.kind === "book" && row.recall_at === clinicDateAt(request.timeZone, new Date(request.createdAt));
  }

  async #archive(resource: "recalls" | "patients" | "recall_types", row: Record<string, unknown>): Promise<void> {
    const current = object(await this.#request("GET", `/${resource}/${row.id}`));
    const fields = resource === "recalls" ? ["id", "updated_at", "notes", "recall_at", "recalled", "recalled_at", "patient", "recall_type", "archived_at"] :
      resource === "patients" ? ["id", "updated_at", "first_name", "last_name", "old_reference_id", "email", "date_of_birth", "patient_phone_numbers", "archived_at"] :
      ["id", "updated_at", "name", "default_duration", "default_duration_type", "archived_at"];
    if (!current || fields.some(field => !isDeepStrictEqual(current[field], row[field]))) throw new ProbeFailure("unsafeCleanup");
    await this.#request("POST", `/${resource}/${row.id}/archive`);
    const after = object(await this.#request("GET", `/${resource}/${row.id}?q%5B%5D=archived_at%3A*`));
    if (!after || after.id !== row.id || typeof after.archived_at !== "string" || !Number.isFinite(Date.parse(after.archived_at))) {
      throw new ProbeFailure("unsafeCleanup");
    }
  }

  async #cleanup(fixture: Fixture): Promise<RehearsalStatus> {
    if (fixture.status.invalid || fixture.status.ambiguous) throw new ProbeFailure("unsafeCleanup");
    const patient = fixture.patients[0];
    if (patient) {
      if (patient.email || patient.date_of_birth || (Array.isArray(patient.patient_phone_numbers) && patient.patient_phone_numbers.length)) {
        throw new ProbeFailure("unsafeCleanup");
      }
      const appointments = await this.#rows("individual_appointments", `&q%5B%5D=patient_id%3A%3D${patient.id}`);
      const allRecalls = await this.#rows("recalls");
      const patientRecalls = allRecalls.filter(row => this.#link(row, "patient") === `${this.#base}/patients/${patient.id}`);
      if (appointments.length || patientRecalls.length !== fixture.recalls.length) throw new ProbeFailure("unsafeCleanup");
      for (const row of fixture.recalls) await this.#archive("recalls", row);
      await this.#archive("patients", patient);
    } else if (fixture.recalls.length) throw new ProbeFailure("unsafeCleanup");
    if (fixture.type) await this.#archive("recall_types", fixture.type);
    const after = (await this.#fixture()).status;
    if (after.types || after.patients || after.pending || after.providerMarkedRecalled) throw new ProbeFailure("unsafeCleanup");
    return after;
  }

  async run(mode: "prepare" | "status" | "cleanup"): Promise<Result<RehearsalStatus, RehearsalFailure>> {
    try {
      const fixture = await this.#fixture();
      if (mode === "status") return ok(fixture.status);
      if (mode === "cleanup") return ok(await this.#cleanup(fixture));
      if (mode !== "prepare") return err({ kind: "invalidConfig" });
      // An existing patient/request is unresolved setup or review work, never permission to POST again.
      if (fixture.patients.length || fixture.status.pending || fixture.status.providerMarkedRecalled) return ok(fixture.status);
      const listedBusiness = (await this.#rows("businesses"))[0];
      const business = listedBusiness ? object(await this.#request("GET", `/businesses/${listedBusiness.id}`)) : undefined;
      const practitioner = (await this.#rows("practitioners"))[0];
      const appointmentType = (await this.#rows("appointment_types"))[0];
      if (!business || business.id !== listedBusiness?.id || business.archived_at !== null || !practitioner || !appointmentType || typeof business.time_zone_identifier !== "string") throw new ProbeFailure("unavailable");
      new Intl.DateTimeFormat("en", { timeZone: business.time_zone_identifier });
      let type = fixture.type;
      if (!type) {
        type = object(await this.#request("POST", "/recall_types", { name: reviewRehearsalType, default_duration: 1, default_duration_type: 10 }));
        if (!type || !id(type.id) || type.name !== reviewRehearsalType || type.archived_at !== null) throw new ProbeFailure("uncertainSetup");
      }
      const tag = patientTag+randomUUID();
      const patient = object(await this.#request("POST", "/patients", { first_name: "Abby", last_name: "ReviewRehearsal", old_reference_id: tag }));
      if (!patient || !id(patient.id) || patient.first_name !== "Abby" || patient.last_name !== "ReviewRehearsal" ||
          patient.old_reference_id !== tag || patient.archived_at !== null) throw new ProbeFailure("uncertainSetup");
      const now = this.#clock(), marker = randomUUID();
      const startsAt = new Date(now.getTime()+3*86_400_000).toISOString(), endsAt = new Date(now.getTime()+3*86_400_000+30*60_000).toISOString();
      const encoded = encodeClinikoReview(marker, { scope, patientId: patient.id, businessId: String(business.id),
        credentialFingerprint: clinikoCredentialFingerprint(this.#key), policyVersion, termsVersion: "demo.reviewOnly.noFees",
        timeZone: business.time_zone_identifier, createdAt: now.toISOString(), operation: { kind: "book",
          practitionerId: String(practitioner.id), appointmentTypeId: String(appointmentType.id), startsAt, endsAt } });
      const writer = ClinikoRecallWriter.create({ scope, apiKey: this.#key, contactEmail: this.#contact, rateBudget: this.#budget }, this.#fetch);
      if (!encoded.ok || !writer.ok) throw new ProbeFailure("uncertainSetup");
      const sent = await writer.value.openOnce({ scope, patientId: patient.id, recallTypeId: String(type.id),
        recallAt: clinicDateAt(business.time_zone_identifier, now), marker, summary: encoded.value.split("\n").slice(1).join("\n") });
      if (!sent.ok || sent.value.kind !== "accepted") throw new ProbeFailure("uncertainSetup");
      return ok((await this.#fixture()).status);
    } catch (error) { return err({ kind: error instanceof ProbeFailure ? error.kind : "unavailable" }); }
  }
}
