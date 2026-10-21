import { distinctFromClock, drawSqlCanaryCode } from "../support/verification-code-canary.ts";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { setup } from "../text/fixture.ts";
import { scanDisposableBackupCanaries } from "./backup-canary-scan.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

test("canary scan retains exact substring locations and ordering with bounded database round trips", async () => {
  const schema = `canary_${randomUUID().replaceAll("-", "")}`;
  await sql.raw(`create schema "${schema}"`).execute(db);
  const isolatedUrl = new URL(url!); isolatedUrl.searchParams.set("options", `-csearch_path=${schema}`);
  const isolated = connectPostgres(isolatedUrl.toString());
  let queries = 0;
  const observed = isolated.withPlugin({
    transformQuery: ({ node }) => { queries++; return node; },
    transformResult: async ({ result }) => result,
  });
  const quoted = "quote'_%\\needle", unicode = "synthetic-雪-needle", escaped = "\\000";
  try {
    await sql`create table canaries (value text)`.execute(isolated);
    await sql`create table "scan values" ("text value" text, metadata jsonb, bytes bytea, absent text)`.execute(isolated);
    await sql`insert into "scan values" values (${quoted + unicode}, ${JSON.stringify({ quoted, unicode })}::jsonb,
      ${Buffer.from([0])}, null), (null, null, null, null)`.execute(isolated);
    const wideColumns = Array.from({ length: 16 }, (_, index) => sql`${sql.id(`part ${index}`)} text`);
    await sql`create table "wide values" (${sql.join(wideColumns)})`.execute(isolated);
    await sql`insert into "wide values" values (${sql.join(Array.from({ length: 16 }, (_, index) =>
      index === 15 ? unicode : null))})`.execute(isolated);
    const canaries = [{ label: "unicode", value: unicode }, { label: "quoted", value: quoted },
      { label: "escaped", value: escaped }];
    assert.deepEqual(await scanPatientDataCanaries(observed, canaries), { ok: true, value: [
      { label: "unicode", table: "scan values", column: "text value" },
      { label: "quoted", table: "scan values", column: "text value" },
      { label: "unicode", table: "scan values", column: "metadata" },
      { label: "escaped", table: "scan values", column: "bytes" },
      { label: "unicode", table: "wide values", column: "part 15" },
    ] });
    assert.ok(queries < 8, `small diagnostic requires too many database round trips: ${queries}`);
    assert.deepEqual(await scanPatientDataCanaries(isolated, [{ label: "missing", value: "not-present-needle" }]), { ok: true, value: [] });
    await sql`create table c (value text)`.execute(isolated);
    await sql`insert into c values (${unicode})`.execute(isolated);
    assert.deepEqual(await scanPatientDataCanaries(isolated, [canaries[0]!, { label: "missing", value: "not-present-needle" }]), { ok: true, value: [
      { label: "unicode", table: "c", column: "value" },
      { label: "unicode", table: "scan values", column: "text value" },
      { label: "unicode", table: "scan values", column: "metadata" },
      { label: "unicode", table: "wide values", column: "part 15" },
    ] });
    const beforeInvalid = queries;
    assert.deepEqual(await scanPatientDataCanaries(observed, [{ label: "bad-label", value: quoted }]), { ok: false, error: { kind: "invalidInput" } });
    assert.equal(queries, beforeInvalid);
    // Keep the original small-schema checks above and also cross multiple query boundaries.
    const boundaryColumns = Array.from({ length: 130 }, (_, index) => sql`${sql.id(`boundary ${index}`)} text`);
    await sql`create table "batch values" (${sql.join(boundaryColumns)})`.execute(isolated);
    const boundaryIndexes = [0, 63, 64, 129];
    await sql`insert into "batch values" values (${sql.join(Array.from({ length: 130 }, (_, index) =>
      boundaryIndexes.includes(index) ? unicode : null))})`.execute(isolated);
    const beforeBoundary = queries;
    assert.deepEqual(await scanPatientDataCanaries(observed, [canaries[0]!]), { ok: true, value: [
      ...boundaryIndexes.map(index => ({ label: "unicode", table: "batch values", column: `boundary ${index}` })),
      { label: "unicode", table: "c", column: "value" },
      { label: "unicode", table: "scan values", column: "text value" },
      { label: "unicode", table: "scan values", column: "metadata" },
      { label: "unicode", table: "wide values", column: "part 15" },
    ] });
    assert.ok(queries - beforeBoundary < 8, "batched scan requires too many database round trips");
  } finally {
    await isolated.destroy();
    await sql.raw(`drop schema "${schema}" cascade`).execute(db);
  }
});

test("database canary scan identifies current patient-data leaks without returning values", async () => {
  assert.equal(process.env.ABBY_LEDGER, "postgres");
  const app = await setup("pg-patient-canary-scan");
  const offerRef = "offer-private-canary-7421";
  const appointmentRef = "appointment-private-canary-8615";
  const callerText = "caller-private-canary-9532";
  await app.turn("offer-turn", callerText, { kind: "requestAction", request: app.book("physio", offerRef) });
  const pending = await app.pendingAction();
  await app.confirm(pending.key);
  await app.turn("cancel-turn", "Please cancel", { kind: "requestAction", request: {
    kind: "cancel", patient: app.patient,
    target: { scope: app.scope, patientRef: app.patient.patientRef, appointmentRef,
      startsAt: "2026-09-29T11:00:00.000Z", endsAt: "2026-09-29T11:30:00.000Z", timeZone: "Australia/Sydney" },
    terms: { version: "terms-1", approvedText: "No cancellation fee applies.", expiresAt: "2026-09-29T10:00:00.000Z" },
  } });

  const scan = await scanPatientDataCanaries(db, [
    { label: "offer", value: offerRef },
    { label: "appointment", value: appointmentRef },
    { label: "caller_text", value: callerText },
  ]);
  assert.equal(scan.ok, true, scan.ok ? "" : scan.error.kind);
  if (!scan.ok) return;
  const locations = new Set(scan.value.map(hit => `${hit.label}:${hit.table}.${hit.column}`));
  assert.equal(locations.has("offer:calls.state"), true);
  assert.equal(locations.has("offer:effect_outbox.payload"), true);
  assert.equal(locations.has("appointment:calls.state"), true);
  assert.equal(locations.has("appointment:staff_items.payload"), true);
  assert.equal(scan.value.some(hit => hit.label === "caller_text"), false);
  assert.equal(JSON.stringify(scan.value).includes(offerRef), false);
  assert.equal(JSON.stringify(scan.value).includes(appointmentRef), false);
  assert.deepEqual(await scanDisposableBackupCanaries(url, [
    { label: "offer", value: offerRef }, { label: "appointment", value: appointmentRef },
  ]), ["appointment", "offer"]);
});

test("six-digit verification canaries distinguish legitimate clock substrings and still expose actual code payloads", async () => {
  // A complete backup must retain every schema; give this deliberate injection
  // its own database rather than filtering unrelated concurrent fixtures out.
  const database = `abby_test_otp_clock_${randomUUID().replaceAll("-", "")}`;
  await sql.raw(`create database "${database}"`).execute(db);
  const target = new URL(url!); target.pathname = `/${database}`;
  const isolated = connectPostgres(target.toString());
  try {
    await sql`create table epoch_values (sent_at_ms jsonb, echo text)`.execute(isolated);
    const window = { sinceMs: 1792470200000, throughMs: 1792470860000 };
    await sql`insert into epoch_values values (${JSON.stringify([window.sinceMs, window.sinceMs + 1234, window.throughMs])}::jsonb, null)`.execute(isolated);
    const collision = Number(String(window.sinceMs).slice(0, 6));
    assert.deepEqual(await scanPatientDataCanaries(isolated, [{ label: "code", value: String(collision) }]),
      { ok: true, value: [{ label: "code", table: "epoch_values", column: "sent_at_ms" }] },
      "the unchanged raw scanner can flag a purely public clock value as an apparent OTP match");
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), [{ label: "code", value: String(collision) }]), ["code"]);
    let draws = 0;
    const safe = drawSqlCanaryCode(() => draws++ === 0 ? collision : 0, window), code = String(safe).padStart(6, "0");
    assert.equal(distinctFromClock(safe, window), true); assert.equal(draws, 2);
    assert.deepEqual(await scanPatientDataCanaries(isolated, [{ label: "code", value: code }]), { ok: true, value: [] });
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), [{ label: "code", value: code }]), []);
    await sql`update epoch_values set echo = ${"private code " + code}`.execute(isolated);
    assert.deepEqual(await scanPatientDataCanaries(isolated, [{ label: "code", value: code }]),
      { ok: true, value: [{ label: "code", table: "epoch_values", column: "echo" }] }, "actual code data remains detectable");
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), [{ label: "code", value: code }]), ["code"],
      "the actual raw code remains detectable in the unfiltered backup too");
  } finally { await isolated.destroy(); await sql.raw(`drop database "${database}"`).execute(db); }
});

test("SQL canaries cannot collide with any PostgreSQL-rendered microsecond fraction", async () => {
  const window = { sinceMs: 1792470200000, throughMs: 1792470860000 };
  const code = String(drawSqlCanaryCode(() => 0, window)).padStart(6, "0");
  const result = await sql<{ total: number; collisions: number; zero_ending_fractions: number; full: string; trimmed: string }>`
    with rendered as (
      select (timestamp '2026-10-20 12:34:56' + n * interval '1 microsecond')::text as value
      from generate_series(0, 999999) as fractions(n)
      union all
      select (timestamptz '2026-10-20 12:34:56+00' + n * interval '1 microsecond')::text as value
      from generate_series(0, 999999) as fractions(n)
    )
    select count(*)::integer as total,
      count(*) filter (where strpos(value, ${code}) > 0)::integer as collisions,
      count(*) filter (where length(substring(value from ${"\\.([0-9]+)"})) = 6
        and right(substring(value from ${"\\.([0-9]+)"}), 1) = '0')::integer as zero_ending_fractions,
      (timestamp '2026-10-20 12:34:56.123457')::text as full,
      (timestamp '2026-10-20 12:34:56.123450')::text as trimmed
    from rendered`.execute(db);
  assert.equal(result.rows[0]?.total, 2_000_000);
  assert.equal(result.rows[0]?.collisions, 0);
  assert.equal(result.rows[0]?.zero_ending_fractions, 0,
    "neither timestamp type can render any complete six-digit fraction ending in zero");
  assert.equal(result.rows[0]?.full, "2026-10-20 12:34:56.123457");
  assert.equal(result.rows[0]?.trimmed, "2026-10-20 12:34:56.12345");
});
