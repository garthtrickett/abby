import assert from "node:assert/strict";
import type { Kysely } from "kysely";
import type Database from "../../src/storage/generated/Database.ts";
import { assertDirectSqlVerificationCanaryContext, distinctFromClock, installDirectSqlVerificationCanaries, installScopedDirectSqlVerificationCanaries } from "./verification-code-canary.ts";
import type { CanaryClockWindow } from "./verification-code-canary.ts";

/** Snapshot BEFORE any fixture challenge. Existing legitimate budget rows are
 * retained and still scanned in full, including timestamps older than the new
 * fixture's future clock window. No current secret or post-write leak can enter
 * this snapshot to suppress its own privacy failure. */
export async function captureSqlVerificationCanaryWindow(db: Kysely<Database>): Promise<CanaryClockWindow> {
  return installDirectSqlVerificationCanaries(await priorClockExclusions(db));
}

export async function captureScopedSqlVerificationCanaryWindow(db: Kysely<Database>): Promise<ReturnType<typeof installScopedDirectSqlVerificationCanaries>> {
  return installScopedDirectSqlVerificationCanaries(await priorClockExclusions(db));
}

async function priorClockExclusions(db: Kysely<Database>): Promise<ReadonlySet<string>> {
  assertDirectSqlVerificationCanaryContext();
  const rows = await db.selectFrom("cliniko_request_budgets").select("sent_at_ms").limit(20001).execute();
  assert.ok(rows.length <= 20000, "Synthetic prior-clock snapshot exceeds its declared bound");
  const excluded = new Set<string>();
  for (const row of rows) {
    for (const part of JSON.stringify(row.sent_at_ms).matchAll(/[0-9]{6,}/g)) {
      const digits = part[0]; for (let i = 0; i <= digits.length - 6; i++) excluded.add(digits.slice(i, i + 6));
    }
    assert.ok(excluded.size <= 100000, "Synthetic prior-clock exclusions exceed their declared bound");
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
