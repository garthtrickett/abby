import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { PostgresOutboundEffectBarrier } from "../../src/storage/postgres-outbound-effect-barrier.ts";
import { PostgresPatientPhoneIndex } from "../../src/storage/postgres-patient-phone-index.ts";
import { PostgresPatientPhoneScan } from "../../src/storage/postgres-patient-phone-scan.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { assertDirectSqlVerificationCanaryContext } from "./verification-code-canary.ts";
import { captureScopedSqlVerificationCanaryWindow } from "./sql-verification-canary.ts";
import type { CanaryClockWindow } from "./verification-code-canary.ts";

type Connection = ReturnType<typeof connectPostgres>;
type Close = () => void | Promise<unknown>;
type Fixture = Readonly<{ db: Connection; peer: Connection; connectionString: string;
  canaryWindow: CanaryClockWindow; defer(close: Close): void }>;
const preservedTables = ["patient_phone_index", "patient_phone_sync", "patient_phone_clinic_status", "patient_phone_scan",
  "patient_phone_scan_seen", "patient_phone_scan_links", "outbound_effect_barriers"] as const;

/** Create a database inside the already admitted isolated server, never a new
 * unaccounted container. Both owners share this exact migrated database. */
async function createOwnedDatabase(adminUrl: string) {
  assertDirectSqlVerificationCanaryContext();
  assert.equal(adminUrl, process.env.DATABASE_URL);
  const admin = connectPostgres(adminUrl), name = `abby_verification_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${name}`;
  let created = false, db: Connection | undefined, peer: Connection | undefined, closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const failures: unknown[] = [];
    const destroyed = await Promise.allSettled([db?.destroy(), peer?.destroy()]);
    for (const result of destroyed) if (result.status === "rejected") failures.push(result.reason);
    try { if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); } catch (error) { failures.push(error); }
    try { await admin.destroy(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Owned verification database cleanup failed");
  })();
  try {
    await sql.raw(`create database "${name}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); peer = connectPostgres(target.toString());
    await migrate(db);
    return { db, peer, connectionString: target.toString(), close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Verification database setup or cleanup failed"); }
    throw error;
  }
}

async function preserveUnrelatedRows(db: Connection) {
  const scope = { tenantId: "verification-unrelated", clinicId: "index", locationId: "main" }, fingerprint = "e".repeat(64);
  const links = [{ normalizedPhone: "+61411111111", patientId: "101" }];
  // SQL verification canaries always end in zero. Keep every six-digit
  // substring of this pre-existing public sentinel outside that space.
  for (let start = 0; start <= links[0]!.normalizedPhone.length - 6; start++) {
    const part = links[0]!.normalizedPhone.slice(start, start + 6);
    assert.ok(!/^[0-9]{6}$/.test(part) || Number(part) % 10 !== 0);
  }
  assert.deepEqual(await new PostgresOutboundEffectBarrier(db, scope, fingerprint).claimOnce("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
    { ok: true, value: { claimed: true } });
  assert.ok((await new PostgresPatientPhoneIndex(db).publish(scope, links, "61", fingerprint)).ok);
  const scans = new PostgresPatientPhoneScan(db), staged = { ...scope, clinicId: "staged" };
  const begun = await scans.begin(staged, "61", fingerprint); assert.ok(begun.ok);
  assert.ok((await scans.append(staged, begun.value.scanRef, { page: 1, totalEntries: 1, patientIds: ["101"], links })).ok);
  const read = async (table: typeof preservedTables[number]) =>
    (await sql<{ row: unknown }>`select to_jsonb(t) as row from ${sql.id(table)} as t`.execute(db)).rows.map(row => row.row);
  const before = new Map(await Promise.all(preservedTables.map(async table => [table, await read(table)] as const)));
  return async () => {
    for (const [table, rows] of before) {
      const after = await read(table);
      for (const row of rows) assert.ok(after.some(candidate => isDeepStrictEqual(candidate, row)), `Unrelated full row changed: ${table}`);
    }
  };
}

/** Challenge, peer budget, barriers, full scans and backup all belong to one
 * case. Concurrent authentication files cannot add unrelated canary matches.
 * Every initial phone/index/staged/effect row is retained, including on failure. */
export async function withIsolatedVerificationSql(adminUrl: string, run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const owned = await createOwnedDatabase(adminUrl), deferred: Close[] = [];
  let canary: Awaited<ReturnType<typeof captureScopedSqlVerificationCanaryWindow>> | undefined;
  let retained: (() => Promise<void>) | undefined, originalFailure: unknown, failed = false;
  try {
    retained = await preserveUnrelatedRows(owned.db);
    canary = await captureScopedSqlVerificationCanaryWindow(owned.db);
    await run({ db: owned.db, peer: owned.peer, connectionString: owned.connectionString, canaryWindow: canary.window,
      defer: close => { assert.equal(typeof close, "function"); deferred.push(close); } });
  } catch (error) { failed = true; originalFailure = error; throw error; }
  finally {
    const failures: unknown[] = [];
    for (const close of deferred.reverse()) try { await close(); } catch (error) { failures.push(error); }
    try { await retained?.(); } catch (error) { failures.push(error); }
    try { canary?.close(); } catch (error) { failures.push(error); }
    try { await owned.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failed ? [originalFailure, ...failures] : failures, "Verification case or cleanup failed");
  }
}

/** Deliberately persist only a synthetic code in a separate disposable probe.
 * The unchanged full-column scanner must still detect this authentication
 * column; the actual clinical database and its full backup remain untouched. */
export async function assertIsolatedVerificationCanary(adminUrl: string, code: string): Promise<void> {
  assert.match(code, /^[0-9]{6}$/);
  const probe = await createOwnedDatabase(adminUrl);
  let originalFailure: unknown, failed = false;
  try {
    await sql`insert into admin_sign_in_rate_limits (key_digest, attempts) values (${"a".repeat(58) + code}, 1)`.execute(probe.db);
    assert.deepEqual(await scanPatientDataCanaries(probe.db, [{ label: "actual_code_probe", value: code }]), { ok: true,
      value: [{ label: "actual_code_probe", table: "admin_sign_in_rate_limits", column: "key_digest" }] });
  } catch (error) { failed = true; originalFailure = error; throw error; }
  finally {
    try { await probe.close(); } catch (cleanup) {
      throw new AggregateError(failed ? [originalFailure, cleanup] : [cleanup], "Verification canary probe or cleanup failed");
    }
  }
}
