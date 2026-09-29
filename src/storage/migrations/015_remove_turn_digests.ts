import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Remove previously persisted hashes of caller speech from existing call rows. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`update calls set state = state - 'processedTurnDigests' where state ? 'processedTurnDigests'`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Deleted speech-derived hashes cannot be reconstructed.
}
