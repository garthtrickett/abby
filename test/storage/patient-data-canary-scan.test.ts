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
    await sql`create table "scan values" ("text value" text, metadata jsonb, bytes bytea, absent text)`.execute(isolated);
    await sql`insert into "scan values" values (${quoted + unicode}, ${JSON.stringify({ quoted, unicode })}::jsonb,
      ${Buffer.from([0])}, null), (null, null, null, null)`.execute(isolated);
    const canaries = [{ label: "unicode", value: unicode }, { label: "quoted", value: quoted },
      { label: "escaped", value: escaped }];
    assert.deepEqual(await scanPatientDataCanaries(observed, canaries), { ok: true, value: [
      { label: "unicode", table: "scan values", column: "text value" },
      { label: "quoted", table: "scan values", column: "text value" },
      { label: "unicode", table: "scan values", column: "metadata" },
      { label: "escaped", table: "scan values", column: "bytes" },
    ] });
    assert.ok(queries < 8, `small diagnostic requires too many database round trips: ${queries}`);
    assert.deepEqual(await scanPatientDataCanaries(isolated, [{ label: "missing", value: "not-present-needle" }]), { ok: true, value: [] });
    await sql`create table c (value text)`.execute(isolated);
    await sql`insert into c values (${unicode})`.execute(isolated);
    assert.deepEqual(await scanPatientDataCanaries(isolated, [canaries[0]!, { label: "missing", value: "not-present-needle" }]), { ok: true, value: [
      { label: "unicode", table: "c", column: "value" },
      { label: "unicode", table: "scan values", column: "text value" },
      { label: "unicode", table: "scan values", column: "metadata" },
    ] });
    const beforeInvalid = queries;
    assert.deepEqual(await scanPatientDataCanaries(observed, [{ label: "bad-label", value: quoted }]), { ok: false, error: { kind: "invalidInput" } });
    assert.equal(queries, beforeInvalid);
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
