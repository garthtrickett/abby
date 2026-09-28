import { setTimeout } from "node:timers/promises";
import type { Client } from "pg";

/** Let a just-destroyed pool release its last idle client before dropping the probe database. */
export async function dropProbeDatabase(admin: Client, name: string): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("invalid probe database name");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await admin.query(`DROP DATABASE "${name}"`);
      return;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "55006" || attempt === 9) throw error;
      await setTimeout(100);
    }
  }
}
