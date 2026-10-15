import { ClinikoAvailabilityReader, availabilityReadDeadlineMs } from "./availability.ts";
import type { ClinikoAvailability, ClinikoAvailabilityConfig, ClinikoAvailabilityFailure } from "./availability.ts";
import { boundedClinikoJson } from "./bounded-json.ts";
import { claimClinikoBudget, isClinikoRequestBudget, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";
import { calendarDate, calendarInstant, rosterStarts, validRosterSearchPlan } from "./roster-calendar.ts";
import type { CalendarInterval, DailyRoster, RosterSearchPlan } from "./roster-calendar.ts";
import { clinicDayStartUtc } from "../standalone/clinic-clock.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";

type Row = Record<string, unknown>;
const object = (value: unknown): Row | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
const id = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
const minute = (value: unknown): number | undefined => {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return undefined;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
};
type Snapshot = Readonly<{ daily: readonly DailyRoster[]; extra: readonly CalendarInterval[]; busy: readonly CalendarInterval[] }>;
class CalendarPageLimit extends Error {
  readonly total: number;
  constructor(total: number) { super("calendar page limit"); this.total = total; }
}
type BusyRecord = Readonly<{ id: string; interval?: CalendarInterval }>;

/** No patient/chart information leaves this edge. Each protected caller read
 * requires complete, twice-observed calendar sources and current metadata. */
export class ClinikoRosterAvailabilityReader {
  readonly #config: Readonly<ClinikoAvailabilityConfig & { rateBudget: ClinikoRequestBudget }>;
  readonly #metadata: ClinikoAvailabilityReader;
  readonly #fetch: typeof fetch;
  readonly #clock: () => string;
  readonly #base: string;
  constructor(config: ClinikoAvailabilityConfig & { rateBudget: ClinikoRequestBudget }, fetchPort: typeof fetch = fetch,
    clock: () => string = () => new Date().toISOString()) {
    const metadata = ClinikoAvailabilityReader.create(config, fetchPort, clock);
    if (!metadata.ok || !isClinikoRequestBudget(config.rateBudget) || typeof fetchPort !== "function" || typeof clock !== "function") throw new TypeError("invalid roster reader");
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) }); this.#metadata = metadata.value;
    this.#base = `https://api.${config.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)![1]}.cliniko.com/v1`;
    this.#fetch = fetchPort; this.#clock = clock;
  }
  async #get(path: string, signal: AbortSignal): Promise<Result<unknown, ClinikoAvailabilityFailure>> {
    if (signal.aborted) return err({ kind: "unavailable" });
    const limited = await claimClinikoBudget(this.#config.rateBudget); if (limited) return err(limited);
    if (signal.aborted) return err({ kind: "unavailable" });
    try {
      const response = await this.#fetch(`${this.#base}${path}`, { method: "GET", redirect: "error", signal,
        headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${this.#config.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${this.#config.contactEmail})` } });
      if (response.status === 429) return err(await observeCliniko429(this.#config.rateBudget, response.headers.get("X-RateLimit-Reset")));
      if (response.status === 401 || response.status === 403) return err({ kind: "forbidden" });
      if (response.status !== 200) return err({ kind: "unavailable" });
      const parsed = await boundedClinikoJson(response); return signal.aborted ? err({ kind: "unavailable" }) : parsed;
    } catch { return err({ kind: "unavailable" }); }
  }
  #link(value: unknown, resource: string): string | undefined {
    const self = object(object(value)?.links)?.self;
    if (typeof self !== "string" || !self.startsWith(`${this.#base}/${resource}/`)) return undefined;
    const found = self.slice(`${this.#base}/${resource}/`.length); return id(found) ? found : undefined;
  }
  async #collection<T>(name: string, filters: readonly string[], decode: (row: Row) => T, signal: AbortSignal): Promise<T[]> {
    const rows: T[] = [], seen = new Set<string>(); let total: number | undefined;
    for (let page = 1; page <= 10; page++) {
      const query = new URLSearchParams({ page: String(page), per_page: "100", sort: "id:asc" });
      for (const filter of filters) query.append("q[]", filter);
      const result = await this.#get(`/${name}?${query}`, signal); if (!result.ok) throw new Error("calendar source unavailable");
      const body = object(result.value), entries = body?.[name];
      if (!body || !Array.isArray(entries) || !Number.isSafeInteger(body.total_entries) || Number(body.total_entries) < 0 ||
          total !== undefined && total !== body.total_entries) throw new Error("incomplete calendar source");
      total = Number(body.total_entries);
      if (total > 1000) throw new CalendarPageLimit(total);
      if (entries.length !== Math.min(100, Math.max(0, total - (page - 1) * 100))) throw new Error("incomplete calendar page");
      for (const entry of entries) {
        const row = object(entry);
        if (!row || !id(row.id) || seen.has(row.id) || this.#link(row, name) !== row.id ||
            this.#link(row.practitioner, "practitioners") !== this.#config.practitionerId) throw new Error("invalid calendar binding");
        seen.add(row.id); rows.push(decode(row));
      }
      if (rows.length === total) {
        if (object(body.links)?.next != null) throw new Error("inconsistent calendar pagination");
        return rows;
      }
    }
    throw new Error("calendar source exceeds bound");
  }
  #datedInterval(row: Row): CalendarInterval {
    const start = calendarInstant(row.starts_at), end = calendarInstant(row.ends_at);
    if (start === undefined || end === undefined || start >= end) throw new Error("unsupported calendar interval");
    return { start, end };
  }
  #nativeInterval(row: Row, recurrenceApproved: boolean): CalendarInterval {
    if (row.repeat_rule !== null) {
      const rule = object(row.repeat_rule);
      if (!recurrenceApproved || !rule ||
          Object.keys(rule).sort().join(",") !== "number_of_repeats,repeat_type,repeating_interval" ||
          typeof rule.repeat_type !== "string" || !["Daily", "Weekly", "Monthly"].includes(rule.repeat_type) ||
          (rule.number_of_repeats !== null && (!Number.isSafeInteger(rule.number_of_repeats) || Number(rule.number_of_repeats) < 1)) ||
          !Number.isSafeInteger(rule.repeating_interval) || Number(rule.repeating_interval) < 1 || Number(rule.repeating_interval) > 100) throw new Error("unsupported calendar recurrence");
    }
    // Each returned appointment/block has its own native identity and actual
    // start/end instants. Busy and opening authority are separately approved;
    // neither permits inferring another date from this row's repeat metadata.
    return this.#datedInterval(row);
  }
  async #busy(name: string, lower: string, upper: string, plan: RosterSearchPlan, signal: AbortSignal, depth = 0): Promise<BusyRecord[]> {
    try {
      return await this.#collection(name, [`practitioner_id:=${this.#config.practitionerId}`, `starts_at:<${upper}`, `ends_at:>${lower}`], row => {
      if (!this.#link(row.business, "businesses")) throw new Error("missing busy business");
      for (const flag of ["archived_at", "deleted_at", ...(name === "individual_appointments" ? ["cancelled_at"] : [])]) {
        if (row[flag] !== null && calendarInstant(row[flag]) === undefined) throw new Error("unknown busy activity");
      }
      if ([row.archived_at, row.deleted_at, ...(name === "individual_appointments" ? [row.cancelled_at] : [])].some(flag => flag !== null)) return { id: String(row.id) };
      const interval = this.#nativeInterval(row, plan.busyRecurrence === "nativeOccurrences");
      if (interval.start >= Date.parse(upper) || interval.end <= Date.parse(lower)) throw new Error("foreign busy range");
      return { id: String(row.id), interval };
      }, signal);
    } catch (error) {
      const first = Date.parse(lower), last = Date.parse(upper);
      if (!(error instanceof CalendarPageLimit) || signal.aborted || depth >= 7 || last - first <= 86_400_000) throw error;
      const middle = new Date(first + Math.floor((last - first) / 2)).toISOString();
      // Both half-open overlap queries include an interval crossing the split.
      // The same native record must agree before it can be deduplicated.
      const left = await this.#busy(name, lower, middle, plan, signal, depth + 1);
      const right = await this.#busy(name, middle, upper, plan, signal, depth + 1);
      const merged = new Map(left.map(row => [row.id, row]));
      for (const row of right) {
        const previous = merged.get(row.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error("changing split calendar record");
        merged.set(row.id, row);
      }
      if (merged.size !== error.total) throw new Error("incomplete split calendar total");
      return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
    }
  }
  async #snapshot(lower: string, upper: string, zone: string, plan: RosterSearchPlan, signal: AbortSignal): Promise<Snapshot> {
    const c = this.#config, practitioner = `practitioner_id:=${c.practitionerId}`, business = `business_id:=${c.businessId}`;
    const busy = async (name: string) => (await this.#busy(name, lower, upper, plan, signal)).flatMap(row => row.interval ? [row.interval] : []);
    const [daily, extra, individual, group, unavailable] = await Promise.all([
      this.#collection("daily_availabilities", [practitioner, business], row => {
        if (this.#link(row.business, "businesses") !== c.businessId || !Number.isInteger(row.day_of_week) ||
            Number(row.day_of_week) < 0 || Number(row.day_of_week) > 7 || row.availabilities !== null && !Array.isArray(row.availabilities) ||
            Array.isArray(row.availabilities) && row.availabilities.length > 0 && row.time_zone_identifier !== zone) throw new Error("invalid daily roster");
        return { dayOfWeek: Number(row.day_of_week), intervals: (row.availabilities as unknown[] | null ?? []).map(value => {
          const window = object(value), startMinute = minute(window?.starts_at), endMinute = window?.ends_at === "24:00" ? 1440 : minute(window?.ends_at);
          if (startMinute === undefined || endMinute === undefined || startMinute >= endMinute) throw new Error("invalid roster clock");
          return { startMinute, endMinute };
        }) };
      }, signal),
      this.#collection("availability_blocks", [practitioner, business], row => {
        if (this.#link(row.business, "businesses") !== c.businessId) throw new Error("foreign extra availability");
        return this.#nativeInterval(row, plan.openingRecurrence === "nativeOccurrences");
      }, signal), busy("individual_appointments"), busy("group_appointments"), busy("unavailable_blocks"),
    ]);
    return { daily, extra, busy: [...individual, ...group, ...unavailable] };
  }
  async listBooking(scope: LocationScope, from: string, to: string, durationMinutes: number, plan: RosterSearchPlan,
    parentSignal?: AbortSignal): Promise<Result<ClinikoAvailability, ClinikoAvailabilityFailure>> {
    const failure = () => err({ kind: "unavailable" as const });
    const first = calendarDate(from), last = calendarDate(to);
    if (!this.#metadata.matchesScope(scope)) return err({ kind: "scopeMismatch" });
    if (!validRosterSearchPlan(plan) || first === undefined || last === undefined || last < first || (last - first) / 86_400_000 + 1 > plan.maxSearchDays) return err({ kind: "invalidRange" });
    const local = AbortSignal.timeout(availabilityReadDeadlineMs), signal = parentSignal ? AbortSignal.any([local, parentSignal]) : local;
    const work = (async (): Promise<Result<ClinikoAvailability, ClinikoAvailabilityFailure>> => {
      try {
        const metadata = await this.#metadata.describeRosterBooking(scope, durationMinutes, signal);
        if (!metadata.ok) return metadata;
        if (metadata.value.kind === "notEligible") return ok(metadata.value);
        if (!metadata.value.offering) return failure();
        const zone = metadata.value.timeZone, lower = clinicDayStartUtc(zone, from), upper = clinicDayStartUtc(zone, new Date(last + 86_400_000).toISOString().slice(0, 10));
        const busyUpper = new Date(Date.parse(upper) + durationMinutes * 60_000).toISOString();
        const before = await this.#snapshot(lower, busyUpper, zone, plan, signal), after = await this.#snapshot(lower, busyUpper, zone, plan, signal);
        const again = await this.#metadata.describeRosterBooking(scope, durationMinutes, signal);
        if (!again.ok || JSON.stringify(again.value) !== JSON.stringify(metadata.value) || JSON.stringify(before) !== JSON.stringify(after) || signal.aborted) return failure();
        const startsAt = rosterStarts({ from, to, timeZone: zone, durationMinutes, plan, ...after, signal });
        return ok({ kind: "times", scope: { ...scope }, sourceRef: `cliniko:roster:${this.#config.businessId}:${this.#config.practitionerId}:${this.#config.appointmentTypeId}`,
          reservable: false, startsAt, observedAt: this.#clock(), timeZone: zone, offering: metadata.value.offering,
          businessRef: this.#config.businessId, practitionerRef: this.#config.practitionerId, appointmentTypeRef: this.#config.appointmentTypeId });
      } catch { return failure(); }
    })();
    let stop = () => {};
    const aborted = new Promise<ReturnType<typeof failure>>(resolve => { stop = () => resolve(failure()); signal.addEventListener("abort", stop); if (signal.aborted) stop(); });
    try { return await Promise.race([work, aborted]); } finally { signal.removeEventListener("abort", stop); }
  }
}
