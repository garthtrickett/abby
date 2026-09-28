import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";

export type ClinikoAvailabilityConfig = Readonly<{
  scope: LocationScope;
  apiKey: string;
  contactEmail: string;
  businessId: string;
  practitionerId: string;
  appointmentTypeId: string;
}>;

export type ClinikoAvailabilityFailure = Readonly<{
  kind: "invalidConfig" | "scopeMismatch" | "invalidRange" | "forbidden" | "notFound" | "rateLimited" | "unavailable" | "malformed" | "tooManyResults";
  resetAt?: string;
}>;

export type ClinikoAvailability =
  | Readonly<{ kind: "notEligible"; reason: "business" | "practitioner" | "appointmentType" }>
  | Readonly<{
    kind: "times";
    scope: LocationScope;
    businessRef: string;
    practitionerRef: string;
    appointmentTypeRef: string;
    startsAt: readonly string[];
    reservable: false;
  }>;

const maxBodyBytes = 1_000_000;
const perPage = 100;
const maxPages = 10;

function validId(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

async function boundedJson(response: Response): Promise<Result<unknown, ClinikoAvailabilityFailure>> {
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
  } catch {
    return err({ kind: "malformed" });
  } finally {
    reader.releaseLock();
  }
}

export class ClinikoAvailabilityReader {
  private readonly scope: LocationScope;
  private readonly businessId: string;
  private readonly practitionerId: string;
  private readonly appointmentTypeId: string;
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly userAgent: string;
  private readonly fetchPort: typeof fetch;

  private constructor(config: ClinikoAvailabilityConfig, shard: string, fetchPort: typeof fetch) {
    this.scope = structuredClone(config.scope);
    this.businessId = config.businessId;
    this.practitionerId = config.practitionerId;
    this.appointmentTypeId = config.appointmentTypeId;
    this.baseUrl = `https://api.${shard}.cliniko.com/v1`;
    this.authorization = `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`;
    this.userAgent = `Abby (${config.contactEmail})`;
    this.fetchPort = fetchPort;
  }

  static create(config: ClinikoAvailabilityConfig, fetchPort: typeof fetch = fetch): Result<ClinikoAvailabilityReader, ClinikoAvailabilityFailure> {
    const shard = config.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1];
    if (!shard || !config.apiKey.slice(0, -(shard.length + 1)) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.contactEmail) ||
        !config.scope.tenantId || !config.scope.clinicId || !config.scope.locationId ||
        !validId(config.businessId) || !validId(config.practitionerId) || !validId(config.appointmentTypeId)) return err({ kind: "invalidConfig" });
    return ok(new ClinikoAvailabilityReader(config, shard, fetchPort));
  }

  private async get(path: string): Promise<Result<unknown, ClinikoAvailabilityFailure>> {
    let response: Response;
    try {
      response = await this.fetchPort(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: this.authorization, "User-Agent": this.userAgent },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return err({ kind: "unavailable" });
    }
    if (response.status === 401 || response.status === 403) return err({ kind: "forbidden" });
    if (response.status === 404) return err({ kind: "notFound" });
    if (response.status === 429) {
      const reset = response.headers.get("X-RateLimit-Reset");
      const seconds = reset && /^[0-9]+$/.test(reset) ? Number(reset) : NaN;
      return err(Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 8_640_000_000_000
        ? { kind: "rateLimited", resetAt: new Date(seconds * 1000).toISOString() } : { kind: "rateLimited" });
    }
    if (response.status === 422) return err({ kind: "invalidRange" });
    if (response.status >= 500) return err({ kind: "unavailable" });
    if (response.status !== 200) return err({ kind: "malformed" });
    return boundedJson(response);
  }

  private async onlineFlag(id: string, path: string): Promise<Result<boolean, ClinikoAvailabilityFailure>> {
    const fetched = await this.get(path);
    if (!fetched.ok) return fetched;
    const body = record(fetched.value);
    if (!body || String(body.id) !== id || typeof body.show_in_online_bookings !== "boolean") return err({ kind: "malformed" });
    if (body.archived_at !== undefined && body.archived_at !== null) return ok(false);
    return ok(body.show_in_online_bookings);
  }

  async list(scope: LocationScope, from: string, to: string): Promise<Result<ClinikoAvailability, ClinikoAvailabilityFailure>> {
    if (!sameScope(this.scope, scope)) return err({ kind: "scopeMismatch" });
    if (!validDate(from) || !validDate(to) || Date.parse(`${to}T00:00:00Z`) < Date.parse(`${from}T00:00:00Z`) ||
        Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 7 * 86_400_000) return err({ kind: "invalidRange" });

    const resources = [
      ["business", this.businessId, `/businesses/${this.businessId}`],
      ["practitioner", this.practitionerId, `/practitioners/${this.practitionerId}`],
      ["appointmentType", this.appointmentTypeId, `/appointment_types/${this.appointmentTypeId}`],
    ] as const;
    for (const [kind, id, path] of resources) {
      const flag = await this.onlineFlag(id, path);
      if (!flag.ok) return flag;
      if (!flag.value) return ok({ kind: "notEligible", reason: kind });
    }

    const prefix = `/businesses/${this.businessId}/practitioners/${this.practitionerId}/appointment_types/${this.appointmentTypeId}/available_times`;
    const startsAt: string[] = [];
    let totalEntries: number | undefined;
    for (let page = 1; page <= maxPages; page += 1) {
      const query = new URLSearchParams({ from, to, page: String(page), per_page: String(perPage) });
      const fetched = await this.get(`${prefix}?${query}`);
      if (!fetched.ok) return fetched;
      const body = record(fetched.value);
      if (!body || !Number.isInteger(body.total_entries) || Number(body.total_entries) < 0 || !Array.isArray(body.available_times)) return err({ kind: "malformed" });
      const count = Number(body.total_entries);
      if (count > maxPages * perPage) return err({ kind: "tooManyResults" });
      if (totalEntries !== undefined && count !== totalEntries) return err({ kind: "unavailable" });
      totalEntries = count;
      for (const candidate of body.available_times) {
        const row = record(candidate);
        if (!row || typeof row.appointment_start !== "string" || !Number.isFinite(Date.parse(row.appointment_start))) return err({ kind: "malformed" });
        startsAt.push(new Date(row.appointment_start).toISOString());
      }
      if (startsAt.length >= count) break;
      if (body.available_times.length === 0) return err({ kind: "unavailable" });
    }
    if (startsAt.length !== totalEntries || new Set(startsAt).size !== startsAt.length) return err({ kind: "unavailable" });
    return ok({ kind: "times", scope: structuredClone(this.scope), businessRef: this.businessId, practitionerRef: this.practitionerId,
      appointmentTypeRef: this.appointmentTypeId, startsAt, reservable: false });
  }
}
