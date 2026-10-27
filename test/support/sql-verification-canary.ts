import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import type Database from "../../src/storage/generated/Database.ts";
import { assertDirectSqlVerificationCanaryContext, distinctFromClock, installDirectSqlVerificationCanaries, installScopedDirectSqlVerificationCanaries } from "./verification-code-canary.ts";
import type { CanaryClockWindow } from "./verification-code-canary.ts";

/** Snapshot BEFORE any fixture challenge. Schema constants and existing
 * legitimate rows can otherwise equal a six-digit code in the full SQL backup.
 * Only the synthetic draw excludes those pre-existing numbers: every actual
 * column and the unfiltered post-challenge backup are still scanned unchanged.
 * No current secret or post-write leak may enter this snapshot. */
export async function captureSqlVerificationCanaryWindow(db: Kysely<Database>, connectionString: string): Promise<CanaryClockWindow> {
  return installDirectSqlVerificationCanaries(await captureSqlVerificationCanaryExclusions(db, connectionString));
}

export async function captureScopedSqlVerificationCanaryWindow(db: Kysely<Database>, connectionString: string): Promise<ReturnType<typeof installScopedDirectSqlVerificationCanaries>> {
  return installScopedDirectSqlVerificationCanaries(await captureSqlVerificationCanaryExclusions(db, connectionString));
}

export async function captureSqlVerificationCanaryExclusions(db: Kysely<Database>, connectionString: string): Promise<ReadonlySet<string>> {
  assertDirectSqlVerificationCanaryContext();
  const target = new URL(connectionString), expected = new URL(process.env.DATABASE_URL!);
  expected.pathname = target.pathname;
  assert.ok(target.href === expected.href, "Canary snapshot must use the isolated fixture server and credentials");
  const current = await sql<{ name: string }>`select current_database() as name`.execute(db);
  assert.ok(current.rows.length === 1 && current.rows[0]!.name === decodeURIComponent(target.pathname.slice(1)),
    "Canary snapshot must use the exact connected fixture database");
  const rows = await db.selectFrom("cliniko_request_budgets").select("sent_at_ms").limit(20001).execute();
  assert.ok(rows.length <= 20000, "Synthetic prior-clock snapshot exceeds its declared bound");
  const snapshot = execFileSync("pg_dump", [connectionString, "--no-owner", "--no-privileges"],
    { timeout: 10000, maxBuffer: 8000000 }).toString();
  const excluded = new Set<string>();
  for (const text of [snapshot, ...rows.map(row => JSON.stringify(row.sent_at_ms))]) {
    for (const part of text.matchAll(/[0-9]{6,}/g)) {
      const digits = part[0]; for (let i = 0; i <= digits.length - 6; i++) excluded.add(digits.slice(i, i + 6));
    }
    assert.ok(excluded.size <= 100000, "Synthetic pre-challenge exclusions exceed their declared bound");
  }
  return excluded;
}

/** This is an extra fixture precondition, never a scanner exemption. Every
 * actual timestamp and the same all-column/unfiltered-backup checks remain. */
export async function assertSqlVerificationCodeCanary(db: Kysely<Database>, code: string, window: CanaryClockWindow): Promise<void> {
  assert.match(code, /^[0-9]{6}$/);
  assert.ok(Date.now() >= window.sinceMs && Date.now() <= window.throughMs, "Fixture left its declared canary clock window");
  assert.ok(distinctFromClock(Number(code), window), "Synthetic code collides with its declared clock window");
  const rows = await db.selectFrom("cliniko_request_budgets").select("sent_at_ms").execute();
  assert.ok(rows.every(row => !JSON.stringify(row.sent_at_ms).includes(code)), "Synthetic code collides with an actual request-budget timestamp");
}
