import { Migrator } from "kysely";
import type { Kysely } from "kysely";
import { up as up001, down as down001 } from "./migrations/001_text_probe.ts";
import { up as up002, down as down002 } from "./migrations/002_booking_setting_audit.ts";
import { up as up003, down as down003 } from "./migrations/003_tenant_scope_constraints.ts";
import { up as up004, down as down004 } from "./migrations/004_automation_setting_audit.ts";
import { up as up005, down as down005 } from "./migrations/005_clinic_write_stop.ts";

function createMigrator<DB>(db: Kysely<DB>): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: async () => ({
      "001_text_probe": { up: up001, down: down001 },
      "002_booking_setting_audit": { up: up002, down: down002 },
      "003_tenant_scope_constraints": { up: up003, down: down003 },
      "004_automation_setting_audit": { up: up004, down: down004 },
      "005_clinic_write_stop": { up: up005, down: down005 },
    }) },
  });
}

function assertMigration(outcome: Awaited<ReturnType<Migrator["migrateToLatest"]>>): void {
  if (outcome.error) throw outcome.error;
  if (outcome.results?.some(result => result.status !== "Success")) throw new Error("migration failed");
}

export async function migrate<DB>(db: Kysely<DB>, direction: "up" | "down" = "up"): Promise<void> {
  const migrator = createMigrator(db);
  assertMigration(direction === "up" ? await migrator.migrateToLatest() : await migrator.migrateDown());
}

/** Used by the upgrade probe to boot an actual older schema before seeding data. */
export async function migrateTo<DB>(db: Kysely<DB>, target: "001_text_probe" | "002_booking_setting_audit" | "003_tenant_scope_constraints" | "004_automation_setting_audit" | "005_clinic_write_stop"): Promise<void> {
  assertMigration(await createMigrator(db).migrateTo(target));
}
