import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { LocationScope } from "../core/model.ts";
import type { OperationalCounterKind, OperationalCounts, OperationalCounterStore } from "../voice/operational-counts.ts";
import type Database from "./generated/Database.ts";
import type { ClinicOperationalCountsTenantId, ClinicOperationalCountsClinicId,
  ClinicOperationalCountsLocationId, ClinicOperationalCountsKind } from "./generated/public/ClinicOperationalCounts.ts";

function scoped(scope: LocationScope) {
  return { tenant_id: scope.tenantId as ClinicOperationalCountsTenantId,
    clinic_id: scope.clinicId as ClinicOperationalCountsClinicId,
    location_id: scope.locationId as ClinicOperationalCountsLocationId };
}

function empty(): Record<OperationalCounterKind, number> {
  return { admissionDenied: 0, callOwnerStarted: 0, voiceFailure: 0, callEnded: 0,
    clinikoBudgetDenied: 0, clinikoBudgetUnavailable: 0, clinikoProvider429: 0,
    clinikoProviderUnavailable: 0 };
}

/** Atomic shared totals with fixed codes and no per-call row or event timestamp. */
export class PostgresOperationalCounters implements OperationalCounterStore {
  readonly #db: Kysely<Database>;
  readonly #pending = new Set<Promise<void>>();

  constructor(db: Kysely<Database>) { this.#db = db; }

  record(scope: LocationScope, kind: OperationalCounterKind): Promise<void> {
    if (!Object.hasOwn(empty(), kind)) return Promise.reject(new RangeError("invalid operational counter kind"));
    const task = this.#db.insertInto("clinic_operational_counts")
      .values({ ...scoped(scope), kind: kind as ClinicOperationalCountsKind, count: "1" })
      .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id", "location_id", "kind"])
        .doUpdateSet({ count: sql<string>`clinic_operational_counts.count + 1` }))
      .execute().then(() => undefined);
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
    const counts = empty();
    for (const row of rows) {
      if (!Object.hasOwn(counts, row.kind)) throw new Error("invalid operational counter kind");
      const value = Number(row.count);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid operational counter value");
      counts[row.kind as OperationalCounterKind] = value;
    }
    return counts;
  }

  async drain(): Promise<void> { await Promise.allSettled([...this.#pending]); }
}
