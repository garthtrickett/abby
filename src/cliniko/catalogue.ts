import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { claimClinikoBudget, ClinikoReadBudget, clinikoCredentialFingerprint,
  isClinikoRequestBudget, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";

export type ClinikoCatalogueFailure = Readonly<{ kind: "invalidConfig" | "invalidSelection" | "scopeMismatch" |
  "forbidden" | "notFound" | "rateLimited" | "unavailable" | "malformed" | "tooManyResults";
  resetAt?: string }>;

export type ClinikoCatalogueConfig = Readonly<{
  scope: LocationScope;
  apiKey: string;
  contactEmail: string;
  rateBudget?: ClinikoRequestBudget;
}>;

export type ClinikoBusinessOption = Readonly<{
  businessId: string;
  name: string;
  timeZone: string | null;
  onlineBooking: boolean;
  archived: boolean;
}>;

export type ClinikoBusinessCatalogue = Readonly<{
  scope: LocationScope;
  observedAt: string;
  credentialFingerprint: string;
  status: "complete";
  businesses: readonly ClinikoBusinessOption[];
}>;

export type ClinikoSelection = Readonly<{
  businessId: string;
  practitionerId: string;
  appointmentTypeId: string;
  policyVersion: string;
}>;

export type ClinikoSelectionReason = "businessArchived" | "businessOnlineBookingDisabled" |
  "businessNameUnknown" | "businessTimeZoneUnknown" | "businessTypeUnconfirmed" | "businessTypeNotSelected" |
  "practitionerNameUnknown" | "appointmentTypeNameUnknown" |
  "practitionerInactive" | "practitionerOnlineBookingDisabled" | "practitionerNotAtBusiness" |
  "appointmentTypeArchived" | "appointmentTypeOnlineBookingDisabled" | "appointmentTypeNotForPractitioner";

/** Metadata evidence for clinic setup; candidate never means approved for live calls or writes. */
export type ClinikoSelectionSnapshot = Readonly<{
  scope: LocationScope;
  selection: ClinikoSelection;
  observedAt: string;
  credentialFingerprint: string;
  businessName: string;
  practitionerName: string;
  appointmentTypeName: string;
  timeZone: string | null;
  status: "candidate" | "unavailable";
  reasons: readonly ClinikoSelectionReason[];
  patientActionMode: "unavailable";
  patientRequestMode: "unavailable";
}>;

const perPage = 100;
const maxPages = 10;
const maxBodyBytes = 1_000_000;
const maxCatalogueAgeMs = 5 * 60_000;
const validId = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
const validScopeId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const validInstant = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const validScope = (value: unknown): value is LocationScope => {
  const row = record(value);
  return !!row && validScopeId(row.tenantId) && validScopeId(row.clinicId) && validScopeId(row.locationId);
};
const sameScope = (left: LocationScope, right: LocationScope): boolean =>
  left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;

function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try { new Intl.DateTimeFormat("en-AU", { timeZone: value }); return true; }
  catch { return false; }
}

function display(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 255) : "Unnamed";
}
const hasDisplay = (value: unknown): value is string => typeof value === "string" && !!value.trim();

async function boundedJson(response: Response): Promise<Result<unknown, ClinikoCatalogueFailure>> {
  if (!response.body) return err({ kind: "malformed" });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBodyBytes) {
        await reader.cancel();
        return err({ kind: "tooManyResults" });
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return ok(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
  } catch { return err({ kind: "malformed" }); }
  finally { reader.releaseLock(); }
}

export class ClinikoCatalogueReader {
  private readonly scope: LocationScope;
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly userAgent: string;
  private readonly budget: ClinikoRequestBudget;
  private readonly credentialHash: string;
  private readonly fetchPort: typeof fetch;
  private readonly clock: () => string;

  private constructor(config: ClinikoCatalogueConfig, shard: string, fetchPort: typeof fetch, clock: () => string) {
    this.scope = structuredClone(config.scope);
    this.baseUrl = `https://api.${shard}.cliniko.com/v1`;
    this.authorization = `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`;
    this.userAgent = `Abby (${config.contactEmail})`;
    this.budget = config.rateBudget ?? new ClinikoReadBudget();
    this.credentialHash = clinikoCredentialFingerprint(config.apiKey);
    this.fetchPort = fetchPort;
    this.clock = clock;
  }

  static create(config: ClinikoCatalogueConfig, fetchPort: typeof fetch = fetch,
                clock: () => string = () => new Date().toISOString()):
    Result<ClinikoCatalogueReader, ClinikoCatalogueFailure> {
    if (!config || typeof config.apiKey !== "string" || !validScope(config.scope)) {
      return err({ kind: "invalidConfig" });
    }
    const shard = config.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1];
    if (!shard || !config.apiKey.slice(0, -(shard.length + 1)) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.contactEmail) ||
        (config.rateBudget !== undefined && !isClinikoRequestBudget(config.rateBudget))) {
      return err({ kind: "invalidConfig" });
    }
    return ok(new ClinikoCatalogueReader(config, shard, fetchPort, clock));
  }

  credentialFingerprint(): string { return this.credentialHash; }

  private async get(path: string): Promise<Result<unknown, ClinikoCatalogueFailure>> {
    const denied = await claimClinikoBudget(this.budget);
    if (denied) return err(denied);
    let response: Response;
    try {
      response = await this.fetchPort(`${this.baseUrl}${path}`, { method: "GET",
        headers: { Accept: "application/json", Authorization: this.authorization, "User-Agent": this.userAgent },
        redirect: "error", signal: AbortSignal.timeout(15_000) });
    } catch { return err({ kind: "unavailable" }); }
    if (response.status === 401 || response.status === 403) return err({ kind: "forbidden" });
    if (response.status === 404) return err({ kind: "notFound" });
    if (response.status === 429) return err(await observeCliniko429(this.budget, response.headers.get("X-RateLimit-Reset")));
    if (response.status >= 500) return err({ kind: "unavailable" });
    if (response.status !== 200) return err({ kind: "malformed" });
    return boundedJson(response);
  }

  private async list(path: string, collection: "businesses" | "practitioners" | "appointment_types"):
    Promise<Result<readonly Record<string, unknown>[], ClinikoCatalogueFailure>> {
    const rows: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let total: number | undefined;
    for (let page = 1; page <= maxPages; page += 1) {
      const query = new URLSearchParams({ page: String(page), per_page: String(perPage) });
      const fetched = await this.get(`${path}?${query}`);
      if (!fetched.ok) return fetched;
      const body = record(fetched.value);
      const items = body?.[collection];
      if (!body || !Number.isSafeInteger(body.total_entries) || Number(body.total_entries) < 0 ||
          !Array.isArray(items) || items.length > perPage) {
        return err({ kind: "malformed" });
      }
      if (Number(body.total_entries) > maxPages * perPage) return err({ kind: "tooManyResults" });
      if (total !== undefined && total !== body.total_entries) return err({ kind: "unavailable" });
      total = Number(body.total_entries);
      for (const value of items) {
        const item = record(value);
        if (!item || !validId(item.id) || seen.has(item.id)) return err({ kind: "malformed" });
        seen.add(item.id);
        rows.push(item);
      }
      if (rows.length === total) return ok(rows);
      if (items.length === 0 || rows.length > total) return err({ kind: "unavailable" });
    }
    return err({ kind: "tooManyResults" });
  }

  /** A successful list proves the credential can read this account's businesses. */
  async businesses(scope: LocationScope): Promise<Result<ClinikoBusinessCatalogue, ClinikoCatalogueFailure>> {
    if (!validScope(scope) || !sameScope(this.scope, scope)) return err({ kind: "scopeMismatch" });
    const fetched = await this.list("/businesses", "businesses");
    if (!fetched.ok) return fetched;
    const options: ClinikoBusinessOption[] = [];
    for (const row of fetched.value) {
      if (!validId(row.id) || !(typeof row.show_in_online_bookings === "boolean" || row.show_in_online_bookings === null) ||
          !(row.archived_at === undefined || row.archived_at === null || typeof row.archived_at === "string")) {
        return err({ kind: "malformed" });
      }
      options.push({ businessId: row.id, name: display(row.business_name),
        timeZone: validTimeZone(row.time_zone_identifier) ? row.time_zone_identifier : null,
        onlineBooking: row.show_in_online_bookings === true, archived: typeof row.archived_at === "string" });
    }
    const observedAt = this.observedAt();
    return observedAt.ok ? ok({ scope: structuredClone(this.scope), observedAt: observedAt.value,
      credentialFingerprint: this.credentialHash, status: "complete", businesses: options }) : observedAt;
  }

  private observedAt(): Result<string, ClinikoCatalogueFailure> {
    let value: string;
    try { value = this.clock(); }
    catch { return err({ kind: "unavailable" }); }
    return validInstant(value) ? ok(value) : err({ kind: "unavailable" });
  }

  /** A route may re-use metadata only for the same credential, exact policy selection, and bounded age. */
  matchesCurrentSelection(snapshot: ClinikoSelectionSnapshot, scope: LocationScope,
                          selection: ClinikoSelection, maxAgeMs: number, now: string): boolean {
    if (!record(snapshot) || !record(selection) || !validScope(scope) || !validScope(snapshot.scope) ||
        !sameScope(this.scope, scope) || !sameScope(snapshot.scope, scope) ||
        snapshot.credentialFingerprint !== this.credentialHash ||
        !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > maxCatalogueAgeMs || !validInstant(now) ||
        !validInstant(snapshot.observedAt) || snapshot.status !== "candidate" ||
        !Array.isArray(snapshot.reasons) || snapshot.reasons.length !== 0 || !record(snapshot.selection)) return false;
    const age = Date.parse(now) - Date.parse(snapshot.observedAt);
    if (age < 0 || age > maxAgeMs) return false;
    return snapshot.selection.businessId === selection.businessId &&
      snapshot.selection.practitionerId === selection.practitionerId &&
      snapshot.selection.appointmentTypeId === selection.appointmentTypeId &&
      snapshot.selection.policyVersion === selection.policyVersion;
  }

  /** Re-read exact resources and relationships; nothing in this snapshot grants execution authority. */
  async inspect(scope: LocationScope, selection: ClinikoSelection):
    Promise<Result<ClinikoSelectionSnapshot, ClinikoCatalogueFailure>> {
    if (!validScope(scope) || !sameScope(this.scope, scope)) return err({ kind: "scopeMismatch" });
    if (!record(selection) || !validId(selection.businessId) || !validId(selection.practitionerId) ||
        !validId(selection.appointmentTypeId) || !/^[A-Za-z0-9._-]{1,128}$/.test(selection.policyVersion)) {
      return err({ kind: "invalidSelection" });
    }
    const business = await this.get(`/businesses/${selection.businessId}`);
    if (!business.ok) return business;
    const businessRow = record(business.value);
    if (!businessRow || businessRow.id !== selection.businessId ||
        !(typeof businessRow.show_in_online_bookings === "boolean" || businessRow.show_in_online_bookings === null) ||
        !(businessRow.archived_at === undefined || businessRow.archived_at === null || typeof businessRow.archived_at === "string") ||
        !(businessRow.appointment_type_ids === null || Array.isArray(businessRow.appointment_type_ids))) {
      return err({ kind: "malformed" });
    }
    const [practitioner, appointmentType, practitioners, appointmentTypes] = await Promise.all([
      this.get(`/practitioners/${selection.practitionerId}`),
      this.get(`/appointment_types/${selection.appointmentTypeId}`),
      this.list(`/businesses/${selection.businessId}/practitioners`, "practitioners"),
      this.list(`/practitioners/${selection.practitionerId}/appointment_types`, "appointment_types"),
    ]);
    if (!practitioner.ok) return practitioner;
    if (!appointmentType.ok) return appointmentType;
    if (!practitioners.ok) return practitioners;
    if (!appointmentTypes.ok) return appointmentTypes;
    const practitionerRow = record(practitioner.value);
    const typeRow = record(appointmentType.value);
    if (!practitionerRow || practitionerRow.id !== selection.practitionerId ||
        !(typeof practitionerRow.active === "boolean" || practitionerRow.active === null) ||
        !(typeof practitionerRow.show_in_online_bookings === "boolean" || practitionerRow.show_in_online_bookings === null) ||
        !typeRow || typeRow.id !== selection.appointmentTypeId ||
        !(typeof typeRow.show_in_online_bookings === "boolean" || typeRow.show_in_online_bookings === null) ||
        !(typeRow.archived_at === undefined || typeRow.archived_at === null || typeof typeRow.archived_at === "string")) {
      return err({ kind: "malformed" });
    }
    const reasons: ClinikoSelectionReason[] = [];
    if (!hasDisplay(businessRow.business_name)) reasons.push("businessNameUnknown");
    if (typeof businessRow.archived_at === "string") reasons.push("businessArchived");
    if (businessRow.show_in_online_bookings !== true) reasons.push("businessOnlineBookingDisabled");
    const timeZone = validTimeZone(businessRow.time_zone_identifier) ? businessRow.time_zone_identifier : null;
    if (!timeZone) reasons.push("businessTimeZoneUnknown");
    const businessTypeIds = businessRow.appointment_type_ids;
    if (businessTypeIds === null) reasons.push("businessTypeUnconfirmed");
    else if (!Array.isArray(businessTypeIds) || !businessTypeIds.every(validId)) return err({ kind: "malformed" });
    else if (!businessTypeIds.includes(selection.appointmentTypeId)) reasons.push("businessTypeNotSelected");
    if (practitionerRow.active !== true) reasons.push("practitionerInactive");
    if (!hasDisplay(practitionerRow.display_name)) reasons.push("practitionerNameUnknown");
    if (practitionerRow.show_in_online_bookings !== true) reasons.push("practitionerOnlineBookingDisabled");
    if (!practitioners.value.some(row => row.id === selection.practitionerId)) reasons.push("practitionerNotAtBusiness");
    if (typeof typeRow.archived_at === "string") reasons.push("appointmentTypeArchived");
    if (!hasDisplay(typeRow.name)) reasons.push("appointmentTypeNameUnknown");
    if (typeRow.show_in_online_bookings !== true) reasons.push("appointmentTypeOnlineBookingDisabled");
    if (!appointmentTypes.value.some(row => row.id === selection.appointmentTypeId)) reasons.push("appointmentTypeNotForPractitioner");
    const observedAt = this.observedAt();
    if (!observedAt.ok) return observedAt;
    return ok({ scope: structuredClone(this.scope), selection: { ...selection }, observedAt: observedAt.value,
      credentialFingerprint: this.credentialHash, businessName: display(businessRow.business_name),
      practitionerName: display(practitionerRow.display_name), appointmentTypeName: display(typeRow.name),
      timeZone, status: reasons.length ? "unavailable" : "candidate", reasons,
      patientActionMode: "unavailable", patientRequestMode: "unavailable" });
  }
}
