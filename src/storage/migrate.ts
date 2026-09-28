import { Migrator } from "kysely";
import type { Kysely } from "kysely";
import { up as up001, down as down001 } from "./migrations/001_text_probe.ts";
import { up as up002, down as down002 } from "./migrations/002_booking_setting_audit.ts";

export async function migrate(db: Kysely<unknown>, direction: "up" | "down" = "up"): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => ({
      "001_text_probe": { up: up001, down: down001 },
      "002_booking_setting_audit": { up: up002, down: down002 },
    }) },
  });
  const outcome = direction === "up" ? await migrator.migrateToLatest() : await migrator.migrateDown();
  if (outcome.error) throw outcome.error;
  if (outcome.results?.some(result => result.status !== "Success")) throw new Error("migration failed");
}
