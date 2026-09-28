import { Migrator } from "kysely";
import type { Kysely } from "kysely";
import { up, down } from "./migrations/001_text_probe.ts";

export async function migrate(db: Kysely<unknown>, direction: "up" | "down" = "up"): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => ({ "001_text_probe": { up, down } }) },
  });
  const outcome = direction === "up" ? await migrator.migrateToLatest() : await migrator.migrateDown();
  if (outcome.error) throw outcome.error;
  if (outcome.results?.some(result => result.status !== "Success")) throw new Error("migration failed");
}
