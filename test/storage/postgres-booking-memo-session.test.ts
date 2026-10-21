import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { bookingMemoSessionFixture } = await import(new URL("test/support/booking-memo-session.js", emitted).href) as typeof import("../support/booking-memo-session.ts");
const { decodeAdministrativeMemo } = await import(new URL("src/cliniko/administrative-memo.js", emitted).href) as typeof import("../../src/cliniko/administrative-memo.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { PostgresPatientVerificationBudget } = await import(new URL("src/storage/postgres-patient-verification-budget.js", emitted).href) as typeof import("../../src/storage/postgres-patient-verification-budget.ts");
const { PostgresPatientPhoneIndex } = await import(new URL("src/storage/postgres-patient-phone-index.js", emitted).href) as typeof import("../../src/storage/postgres-patient-phone-index.ts");
const { PostgresPatientPhoneScan } = await import(new URL("src/storage/postgres-patient-phone-scan.js", emitted).href) as typeof import("../../src/storage/postgres-patient-phone-scan.ts");

for (const mode of ["accepted", "lostStored", "lostUnstored", "nonexact", "producerRevoked"] as const)
test(`actual emitted verified booking session, independent memo and all-column/full-backup privacy: ${mode}`, { timeout: 60000 }, async () => {
  const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl, "DATABASE_URL required");
  const admin = connectPostgres(adminUrl), databaseName = `abby_memo_session_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${databaseName}`;
  let created = false, db: ReturnType<typeof connectPostgres> | undefined, f: Awaited<ReturnType<typeof bookingMemoSessionFixture>> | undefined;
  try {
    await sql.raw(`create database "${databaseName}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); await migrate(db);
    // Retain legitimate unrelated phone aliases/staged scans and an opaque
    // effect while scanning every column and the whole unfiltered backup.
    const unrelated = { tenantId: `unrelated-${randomUUID()}`, clinicId: "index", locationId: "main" };
    const links = [{ normalizedPhone: "+61400111222", patientId: "101" }], fingerprint = "e".repeat(64);
    assert.ok((await new PostgresPatientPhoneIndex(db).publish(unrelated, links, "61", fingerprint)).ok);
    const staged = { ...unrelated, clinicId: "staged" }, scans = new PostgresPatientPhoneScan(db), begun = await scans.begin(staged, "61", fingerprint);
    assert.ok(begun.ok); assert.ok((await scans.append(staged, begun.value.scanRef, { page: 1, totalEntries: 1, patientIds: ["101"], links })).ok);
    const retainedRef = randomUUID(); assert.ok((await new PostgresOutboundEffectBarrier(db, unrelated, fingerprint).claimOnce(retainedRef)).ok);
    const scope = { tenantId: `memo-sql-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
    const budget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-session-au5", maxPerMinute: 180 });
    f = await bookingMemoSessionFixture({ scope, budget, verificationBudget: new PostgresPatientVerificationBudget(db, scope),
      barrierFor: (bound, owner) => new PostgresOutboundEffectBarrier(db!, bound, owner), ...(mode === "producerRevoked" ? {} : { mode }) });
    const proof = await f.prepare(); if (mode === "producerRevoked") f.setOnBooking(async () => { f!.gates.producer = false; });
    await f.drain(); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed"); assert.equal(f.posts, 1);
    assert.equal(f.memoPosts.length, mode === "producerRevoked" ? 0 : 1);
    assert.equal(f.outcomes[0]!.kind, mode === "producerRevoked" ? "unavailable" : mode === "accepted" ? "accepted" : "uncertain");
    await f.drain(); assert.equal(f.posts, 1); assert.equal(f.memoPosts.length, mode === "producerRevoked" ? 0 : 1);
    const consumed = (await sql<{ effect_ref: string }>`select * from outbound_effect_barriers where tenant_id=${scope.tenantId}`.execute(db)).rows;
    assert.equal(consumed.length, mode === "producerRevoked" ? 0 : 1);
    let authentication = "";
    if (f.memoPosts.length) {
      const decoded = decodeAdministrativeMemo(f.memoPosts[0]!.content); assert.ok(decoded.ok);
      assert.equal(decoded.value.outcome.appointmentRef, "cliniko:appointment:91"); assert.equal(decoded.value.patientId, verificationCanaries[2]);
      assert.equal(consumed[0]!.effect_ref, decoded.value.actionRef); authentication = decoded.value.authentication;
    }
    const requests = await db.selectFrom("cliniko_request_budgets").selectAll().execute(); assert.equal(requests.length, 1); assert.ok(Array.isArray(requests[0]!.sent_at_ms));
    assert.equal(requests[0]!.sent_at_ms.length, f.allTraffic.length + f.memoPosts.length, "same physical API-user bucket includes verification, clinical reads/writes and the independent memo");
    assert.deepEqual(await db.selectFrom("calls").selectAll().execute(), []);
    assert.equal((await sql`select * from outbound_effect_barriers where effect_ref=${retainedRef}`.execute(db)).rows.length, 1);
    assert.equal((await db.selectFrom("patient_phone_index").selectAll().execute()).length, 1);
    const canaries = [...verificationCanaries, f.mail[0]!.code, proof, f.callId, f.sessionId, f.key.toString("hex"), authentication,
      ...f.memoPosts.flatMap(row => [String(row.content), JSON.stringify(row)]), "2026-10-08T04:00:00.000Z"].filter(v => v.length >= 4);
    const chunks = canaries.flatMap((value, i) => Array.from({ length: Math.ceil(value.length / 256) }, (_, n) => ({ label: `memo_session_${i}_${n}`,
      value: value.slice(n * 256, (n + 1) * 256).length < 4 ? value.slice(-4) : value.slice(n * 256, (n + 1) * 256) })));
    for (let i = 0; i < chunks.length; i += 12) assert.deepEqual(await scanPatientDataCanaries(db, chunks.slice(i, i + 12)), { ok: true, value: [] });
    const dump = execFileSync("pg_dump", [target.toString(), "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
    const copy = (s: string) => s.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
    for (const raw of canaries) { const json = JSON.stringify(raw).slice(1, -1); for (const candidate of [raw, copy(raw), json, copy(json)]) assert.equal(dump.includes(candidate), false); }
    assert.equal(dump.includes(retainedRef), true, "unfiltered backup retains unrelated legitimate opaque evidence");
  } finally {
    await f?.close(); await db?.destroy();
    try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); } finally { await admin.destroy(); }
  }
});
