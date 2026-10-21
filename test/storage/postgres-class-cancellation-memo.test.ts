import assert from "node:assert/strict";
import test from "node:test";
import crypto, { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { captureScopedSqlVerificationCanaryWindow, assertSqlVerificationCodeCanary } from "../support/sql-verification-canary.ts";

const originalRandomInt = crypto.randomInt;

const emitted = new URL("../../dist/runtime/", import.meta.url);
const { classCancellationMemoFixture } = await import(new URL("test/support/class-cancellation-memo.js", emitted).href) as typeof import("../support/class-cancellation-memo.ts");
const { decodeAdministrativeMemo, administrativeMemoActionRef } = await import(new URL("src/cliniko/administrative-memo.js", emitted).href) as typeof import("../../src/cliniko/administrative-memo.ts");
const { decodeClinikoReview } = await import(new URL("src/cliniko/review-request.js", emitted).href) as typeof import("../../src/cliniko/review-request.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { PostgresPatientVerificationBudget } = await import(new URL("src/storage/postgres-patient-verification-budget.js", emitted).href) as typeof import("../../src/storage/postgres-patient-verification-budget.ts");
const { PostgresPatientPhoneIndex } = await import(new URL("src/storage/postgres-patient-phone-index.js", emitted).href) as typeof import("../../src/storage/postgres-patient-phone-index.ts");
const { PostgresPatientPhoneScan } = await import(new URL("src/storage/postgres-patient-phone-scan.js", emitted).href) as typeof import("../../src/storage/postgres-patient-phone-scan.ts");

const modes = ["accepted", "lostStored", "lostUnstored", "nonexact", "producerRevoked", "clinicalResponseLost"] as const;
const cases = [
  ...modes.map(mode => ({ passes: undefined, mode })),
  ...(["releaseOne", "unchanged", "consumeOne"] as const).flatMap(passes => (["accepted", "lostStored", "clinicalResponseLost"] as const).map(mode => ({ passes, mode }))),
];

for (const { passes, mode } of cases)
test(`actual emitted ${passes ?? "ordinary"} admitted class cancellation, original reviewed purpose and all-column/full-backup privacy: ${mode}`, { timeout: 120000 }, async () => {
  const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl, "DATABASE_URL required");
  const admin = connectPostgres(adminUrl), databaseName = `abby_class_cancel_memo_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${databaseName}`;
  let canary: Awaited<ReturnType<typeof captureScopedSqlVerificationCanaryWindow>> | undefined;
  let created = false, db: ReturnType<typeof connectPostgres> | undefined, f: Awaited<ReturnType<typeof classCancellationMemoFixture>> | undefined;
  try {
    await sql.raw(`create database "${databaseName}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); await migrate(db);
    assert.equal(crypto.randomInt, originalRandomInt);
    canary = await captureScopedSqlVerificationCanaryWindow(db);
    const unrelated = { tenantId: `unrelated-${randomUUID()}`, clinicId: "index", locationId: "main" };
    const links = [{ normalizedPhone: "+61400111222", patientId: "101" }], fingerprint = "e".repeat(64);
    assert.ok((await new PostgresPatientPhoneIndex(db).publish(unrelated, links, "61", fingerprint)).ok);
    const staged = { ...unrelated, clinicId: "staged" }, scans = new PostgresPatientPhoneScan(db), begun = await scans.begin(staged, "61", fingerprint);
    assert.ok(begun.ok); assert.ok((await scans.append(staged, begun.value.scanRef, { page: 1, totalEntries: 1, patientIds: ["101"], links })).ok);
    const retainedRef = randomUUID(); assert.ok((await new PostgresOutboundEffectBarrier(db, unrelated, fingerprint).claimOnce(retainedRef)).ok);
    const scope = { tenantId: `memo-sql-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
    const budget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-class-au5", maxPerMinute: 180 });
    const headroom: { requested: number; result: string }[] = [], check = budget.checkHeadroom.bind(budget);
    budget.checkHeadroom = async requests => { const result = await check(requests); headroom.push({ requested: requests, result: result?.kind ?? "available" }); return result; };
    let memoBeginning = false; const memoClaims: number[][] = [], claim = budget.claim.bind(budget);
    budget.claim = async () => {
      // Separate memo permission begins only after the known inspected cancellation;
      // observe the real prior rolling-minute state without changing its clock.
      const rows = memoBeginning ? await db!.selectFrom("cliniko_request_budgets").select("sent_at_ms").execute() : undefined;
      const result = await claim();
      if (rows && result === null) { assert.equal(rows.length, 1); const times: unknown = rows[0]!.sent_at_ms; assert.ok(Array.isArray(times) && times.every(n => typeof n === "number")); memoClaims.push(times as number[]); }
      return result;
    };
    f = await classCancellationMemoFixture({ scope, budget, ...(passes ? { passes } : {}), realQuotaWait: true,
      verificationBudget: new PostgresPatientVerificationBudget(db, scope), barrierFor: (bound, owner) => new PostgresOutboundEffectBarrier(db!, bound, owner),
      ...(mode === "clinicalResponseLost" || mode === "producerRevoked" ? {} : { mode }) });
    f.gates.onAllowed = async () => { memoBeginning = true; };
    await f.prepare(); if (mode === "producerRevoked") f.gates.producer = false; if (mode === "clinicalResponseLost") f.loseWrite();
    await f.drain();
    const action = Object.values((await f.state()).actions).at(-1)!; assert.equal(action.mutation.request.kind, "cancel");
    const proof = action.mutation.request.patient.verificationRef;
    if (mode === "clinicalResponseLost") assert.notEqual(action.status, "committed"); else assert.equal(action.status, "committed", JSON.stringify({ claims: f.claims, headroom, writes: f.writes.length }));
    assert.equal(f.writes.length, 1);
    const expectedPosts = mode === "producerRevoked" || mode === "clinicalResponseLost" ? 0 : 1;
    assert.equal(f.memoPosts.length, expectedPosts);
    assert.equal(f.outcomes.length, mode === "clinicalResponseLost" ? 0 : 1);
    if (mode !== "clinicalResponseLost") assert.equal(f.outcomes[0]!.kind, mode === "producerRevoked" ? "unavailable" : mode === "accepted" ? "accepted" : "uncertain");
    assert.equal(f.memoRows.length, expectedPosts && mode !== "lostUnstored" ? 1 : 0);
    await f.drain(); assert.equal(f.writes.length, 1); assert.equal(f.memoPosts.length, expectedPosts);
    const consumed = (await sql<{ effect_ref: string }>`select * from outbound_effect_barriers where tenant_id=${scope.tenantId}`.execute(db)).rows;
    assert.equal(consumed.length, expectedPosts);
    const review = decodeClinikoReview(f.recalls[0]!.notes); assert.ok(review.ok); assert.equal(review.value.request.operation.kind, "classCancel");
    const originalAction = review.value.marker;
    let authentication = "";
    if (expectedPosts) {
      const decoded = decodeAdministrativeMemo(f.memoPosts[0]!.content); assert.ok(decoded.ok);
      assert.equal(decoded.value.sourceActionRef, originalAction); assert.equal(decoded.value.actionRef, administrativeMemoActionRef(originalAction));
      assert.equal(consumed[0]!.effect_ref, decoded.value.actionRef); assert.equal(decoded.value.patientId, verificationCanaries[2]);
      assert.equal(decoded.value.outcome.kind, "classCancellationObserved");
      assert.equal(decoded.value.outcome.appointmentRef, "cliniko:booking:91"); assert.equal(decoded.value.outcome.attendeeRef, "cliniko:attendee:101");
      assert.equal(decoded.value.outcome.verification.basis, "acknowledgedAndObservedBestEffort"); assert.equal(decoded.value.outcome.verification.observedAt, decoded.value.occurredAt);
      authentication = decoded.value.authentication;
    }
    const requests = await db.selectFrom("cliniko_request_budgets").selectAll().execute(); assert.equal(requests.length, 1); assert.ok(Array.isArray(requests[0]!.sent_at_ms));
    assert.equal(requests[0]!.max_per_minute, 180); assert.ok(f.claims >= requests[0]!.sent_at_ms.length && requests[0]!.sent_at_ms.length > 0 && requests[0]!.sent_at_ms.length <= 180);
    assert.equal(memoClaims.length, expectedPosts, "only the separately permitted memo enters this claimed native write after the known inspected cancellation");
    if (expectedPosts) {
      const at = requests[0]!.sent_at_ms.at(-1)!;
      assert.deepEqual(requests[0]!.sent_at_ms, [...memoClaims[0]!.filter(t => t > at - 60000), at], "one real memo increment and legitimate rolling expiry; earlier preparation is not charged twice across windows");
    }
    assert.deepEqual(await db.selectFrom("calls").selectAll().execute(), []);
    assert.equal((await sql`select * from outbound_effect_barriers where effect_ref=${retainedRef}`.execute(db)).rows.length, 1);
    assert.equal((await db.selectFrom("patient_phone_index").selectAll().execute()).length, 1);
    await assertSqlVerificationCodeCanary(db, f.mail[0]!.code, canary.window);
    const canaries = [...verificationCanaries, f.mail[0]!.code, proof, f.callId, f.sessionId, f.key.toString("hex"), authentication, review.value.marker, originalAction, f.pass.caseId, f.pass.entitlementRef,
      "private-class-shared-note", "private-attendee-note", "private-other-name", "private-cancel-case-name", "private-cancel-case-notes", "private-cancel-case-referral",
      ...f.recalls.map(row => String(row.notes)), ...f.memoPosts.flatMap(row => [String(row.content), JSON.stringify(row)]), "2026-10-08T04:00:00.000Z"].filter(v => v.length >= 4);
    const chunks = canaries.flatMap((value, i) => Array.from({ length: Math.ceil(value.length / 256) }, (_, n) => ({ label: `class_cancel_memo_${i}_${n}`,
      value: value.slice(n * 256, (n + 1) * 256).length < 4 ? value.slice(-4) : value.slice(n * 256, (n + 1) * 256) })));
    for (let i = 0; i < chunks.length; i += 12) assert.deepEqual(await scanPatientDataCanaries(db, chunks.slice(i, i + 12)), { ok: true, value: [] });
    const dump = execFileSync("pg_dump", [target.toString(), "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
    const copy = (s: string) => s.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
    for (const raw of canaries) { const json = JSON.stringify(raw).slice(1, -1); for (const candidate of [raw, copy(raw), json, copy(json)]) assert.equal(dump.includes(candidate), false); }
    assert.equal(dump.includes(retainedRef), true, "unfiltered backup preserves legitimate unrelated opaque evidence");
  } finally {
    try { await f?.close(); } finally {
      try { canary?.close(); assert.equal(crypto.randomInt, originalRandomInt); } finally {
        await db?.destroy();
        try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); } finally { await admin.destroy(); }
      }
    }
  }
});
