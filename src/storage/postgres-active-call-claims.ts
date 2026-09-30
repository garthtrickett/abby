import { createHmac, randomBytes } from "node:crypto";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { Client } from "pg";
import type { ActiveCallClaims, ActiveCallLease } from "../voice/twilio-ingress-server.ts";
import type Database from "./generated/Database.ts";

const accountSidPattern = /^AC[0-9a-f]{32}$/i;
const callSidPattern = /^CA[0-9a-f]{32}$/i;

/** Holds a PostgreSQL session lock for one active call, without storing a call key in a table. */
export class PostgresActiveCallClaims implements ActiveCallClaims {
  private readonly connectionString: string;
  private readonly key: Uint8Array;

  constructor(connectionString: string, key: Uint8Array) {
    if (!connectionString || !(key instanceof Uint8Array) || key.byteLength < 32) {
      throw new RangeError("invalid active-call claim configuration");
    }
    this.connectionString = connectionString;
    this.key = new Uint8Array(key);
  }

  private lockKey(accountRef: string, providerCallRef: string): string {
    const digest = createHmac("sha256", this.key)
      .update(JSON.stringify(["abby-active-call-v1", accountRef, providerCallRef])).digest();
    return digest.readBigInt64BE(0).toString();
  }

  /** Proves the injected ledger connection and this claim adapter share a PostgreSQL lock space. */
  async matchesDatabase(db: Kysely<Database>): Promise<boolean> {
    const key = randomBytes(8).readBigInt64BE(0).toString();
    return db.connection().execute(async owner => {
      const held = await sql<{ acquired: boolean }>`select pg_try_advisory_lock(${key}::bigint) as acquired`
        .execute(owner);
      if (held.rows[0]?.acquired !== true) throw new Error("active-call lock probe unavailable");
      try {
        const client = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 5_000 });
        client.on("error", () => {});
        try {
          await client.connect();
          const second = await client.query<{ acquired: boolean }>(
            "select pg_try_advisory_lock($1::bigint) as acquired", [key]);
          return second.rows[0]?.acquired === false;
        } finally { try { await client.end(); } catch { /* connection may have failed */ } }
      } finally {
        const unlocked = await sql<{ released: boolean }>`select pg_advisory_unlock(${key}::bigint) as released`
          .execute(owner);
        if (unlocked.rows[0]?.released !== true) throw new Error("active-call lock probe lost");
      }
    });
  }

  async claim(accountRef: string, providerCallRef: string): Promise<ActiveCallLease | undefined> {
    if (!accountSidPattern.test(accountRef) || !callSidPattern.test(providerCallRef)) {
      throw new RangeError("invalid active-call identity");
    }
    const client = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 5_000,
      application_name: "abby-active-call-claims" });
    let released = false;
    let resolveLost!: () => void;
    const lost = new Promise<void>(resolve => { resolveLost = resolve; });
    const onLoss = () => { if (!released) resolveLost(); };
    client.on("error", onLoss);
    client.on("end", onLoss);
    const key = this.lockKey(accountRef, providerCallRef);
    try {
      await client.connect();
      const result = await client.query<{ acquired: boolean }>(
        "select pg_try_advisory_lock($1::bigint) as acquired", [key]);
      if (result.rows[0]?.acquired !== true) {
        released = true;
        await client.end();
        return undefined;
      }
      return { lost, release: async () => {
        if (released) return;
        released = true;
        try {
          const unlocked = await client.query<{ released: boolean }>(
            "select pg_advisory_unlock($1::bigint) as released", [key]);
          if (unlocked.rows[0]?.released !== true) throw new Error("active-call claim lost");
        } finally { await client.end(); }
      } };
    } catch (error) {
      released = true;
      try { await client.end(); } catch { /* server releases a dead session */ }
      throw error;
    }
  }
}
