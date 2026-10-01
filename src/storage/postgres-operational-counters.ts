import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { LocationScope } from "../core/model.ts";
import { emptyOperationalCounts, operationalDays } from "../voice/operational-counts.ts";
import type { OperationalCounterKind, OperationalCounts, OperationalCounterStore } from "../voice/operational-counts.ts";
import type Database from "./generated/Database.ts";
import type { ClinicOperationalCountsTenantId, ClinicOperationalCountsClinicId,
  ClinicOperationalCountsLocationId, ClinicOperationalCountsKind } from "./generated/public/ClinicOperationalCounts.ts";
import type { ClinicOperationalDailyCountsTenantId, ClinicOperationalDailyCountsClinicId,
  ClinicOperationalDailyCountsLocationId, ClinicOperationalDailyCountsDate,
  ClinicOperationalDailyCountsKind } from "./generated/public/ClinicOperationalDailyCounts.ts";

function scoped(scope: LocationScope) {
  return { tenant_id: scope.tenantId as ClinicOperationalCountsTenantId,
    clinic_id: scope.clinicId as ClinicOperationalCountsClinicId,
    location_id: scope.locationId as ClinicOperationalCountsLocationId };
}

function dailyScope(scope: LocationScope) {
  return { tenant_id: scope.tenantId as ClinicOperationalDailyCountsTenantId,
    clinic_id: scope.clinicId as ClinicOperationalDailyCountsClinicId,
    location_id: scope.locationId as ClinicOperationalDailyCountsLocationId };
}

function dateValue(day: string) {
  return sql<ClinicOperationalDailyCountsDate>`${day}::date`;
}

/** Atomic shared totals and seven UTC daily buckets, without per-call records. */
export class PostgresOperationalCounters implements OperationalCounterStore {
  readonly #db: Kysely<Database>;
  readonly #pending = new Set<Promise<void>>();
  readonly #clock: () => string;

  constructor(db: Kysely<Database>, clock: () => string = () => new Date().toISOString()) {
    this.#db = db;
    this.#clock = clock;
  }

  record(scope: LocationScope, kind: OperationalCounterKind): Promise<void> {
    if (!Object.hasOwn(emptyOperationalCounts(), kind)) return Promise.reject(new RangeError("invalid operational counter kind"));
    let days: readonly string[];
    try { days = operationalDays(this.#clock()); }
    catch (error) { return Promise.reject(error); }
    const day = dateValue(days.at(-1)!);
    const cutoff = dateValue(days[0]!);
    const dailyRowScope = dailyScope(scope);
    const task = this.#db.transaction().execute(async transaction => {
      await transaction.insertInto("clinic_operational_counts")
        .values({ ...scoped(scope), kind: kind as ClinicOperationalCountsKind, count: "1" })
        .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id", "location_id", "kind"])
          .doUpdateSet({ count: sql<string>`clinic_operational_counts.count + 1` }))
        .execute();
      await transaction.insertInto("clinic_operational_daily_counts")
        .values({ ...dailyRowScope, date: day, kind: kind as ClinicOperationalDailyCountsKind, count: "1" })
        .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id", "location_id", "date", "kind"])
          .doUpdateSet({ count: sql<string>`clinic_operational_daily_counts.count + 1` }))
        .execute();
      await transaction.deleteFrom("clinic_operational_daily_counts")
        .where("tenant_id", "=", dailyRowScope.tenant_id)
        .where("clinic_id", "=", dailyRowScope.clinic_id)
        .where("location_id", "=", dailyRowScope.location_id)
        .where("date", "<", cutoff).execute();
    });
    this.#pending.add(task);
    void task.finally(() => { this.#pending.delete(task); }).catch(() => undefined);
    return task;
  }

  async snapshot(scope: LocationScope): Promise<OperationalCounts> {
    await this.drain();
    const { tenant_id, clinic_id, location_id } = scoped(scope);
    const rows = await this.#db.selectFrom("clinic_operational_counts")
      .select(["kind", "count"])
      .where("tenant_id", "=", tenant_id).where("clinic_id", "=", clinic_id)
      .where("location_id", "=", location_id).execute();
    const counts = emptyOperationalCounts();
    for (const row of rows) {
      if (!Object.hasOwn(counts, row.kind)) throw new Error("invalid operational counter kind");
      const value = Number(row.count);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid operational counter value");
      counts[row.kind as OperationalCounterKind] = value;
    }
    return counts;
  }

  async daily(scope: LocationScope) {
    await this.drain();
    const days = operationalDays(this.#clock());
    const { tenant_id, clinic_id, location_id } = dailyScope(scope);
    const cutoff = dateValue(days[0]!);
    // A read only prunes its own clinic; other scopes need their own cleanup run.
    await this.#db.deleteFrom("clinic_operational_daily_counts")
      .where("tenant_id", "=", tenant_id).where("clinic_id", "=", clinic_id)
      .where("location_id", "=", location_id).where("date", "<", cutoff).execute();
    const rows = await this.#db.selectFrom("clinic_operational_daily_counts")
      .select([sql<string>`date::text`.as("day"), "kind", "count"])
      .where("tenant_id", "=", tenant_id).where("clinic_id", "=", clinic_id)
      .where("location_id", "=", location_id).where("date", ">=", cutoff).execute();
    const countsByDay = new Map(days.map(day => [day, emptyOperationalCounts()]));
    for (const row of rows) {
      const counts = countsByDay.get(row.day);
      const value = Number(row.count);
      if (!counts || !Object.hasOwn(counts, row.kind) || !Number.isSafeInteger(value) || value < 1) {
        throw new Error("invalid operational daily value");
      }
      counts[row.kind as OperationalCounterKind] = value;
    }
    return { days: days.map(date => ({ date, counts: countsByDay.get(date)! })) };
  }

  /** Global expiry for idle clinics; invoke at startup and from an independent scheduler. */
  async pruneExpired(): Promise<void> {
    const cutoff = dateValue(operationalDays(this.#clock())[0]!);
    await this.#db.deleteFrom("clinic_operational_daily_counts").where("date", "<", cutoff).execute();
  }

  async drain(): Promise<void> { await Promise.allSettled([...this.#pending]); }
}
