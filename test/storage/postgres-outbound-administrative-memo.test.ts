import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { captureSqlVerificationCanaryWindow, assertSqlVerificationCodeCanary } from "../support/sql-verification-canary.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const adminUrl = process.env.DATABASE_URL, baseline = connectPostgres(adminUrl);
after(() => baseline.destroy());
const canaryWindow = await captureSqlVerificationCanaryWindow(baseline, adminUrl);
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { outboundMemoFixture } = await import(new URL("test/support/outbound-memo.js", emitted).href) as typeof import("../support/outbound-memo.ts");
const { decodeAdministrativeMemo } = await import(new URL("src/cliniko/administrative-memo.js", emitted).href) as typeof import("../../src/cliniko/administrative-memo.ts");
const { administrativeMemoRecordBinding } = await import(new URL("src/cliniko/administrative-memo-records.js", emitted).href) as typeof import("../../src/cliniko/administrative-memo-records.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { PostgresPatientVerificationBudget } = await import(new URL("src/storage/postgres-patient-verification-budget.js", emitted).href) as typeof import("../../src/storage/postgres-patient-verification-budget.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { PostgresPatientPhoneIndex } = await import(new URL("src/storage/postgres-patient-phone-index.js", emitted).href) as typeof import("../../src/storage/postgres-patient-phone-index.ts");
const { PostgresPatientPhoneScan } = await import(new URL("src/storage/postgres-patient-phone-scan.js", emitted).href) as typeof import("../../src/storage/postgres-patient-phone-scan.ts");

for (const operation of ["book", "cancel", "reschedule"] as const)
for (const mode of ["accepted", "wrongSubjectGrant", "withdrawn", "lostStored", "nativeUncertain"] as const)
test(`actual emitted signed outgoing ${operation} memo uses SQL180, verification, permanent purpose and full-backup privacy: ${mode}`, { timeout: 180000 }, async () => {
  const admin = connectPostgres(adminUrl), name = `abby_out_memo_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${name}`;
  let created = false, db: ReturnType<typeof connectPostgres> | undefined;
  let c: Awaited<ReturnType<typeof outboundMemoFixture>> | undefined;
  try {
    await sql.raw(`create database "${name}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); await migrate(db);
    const unrelated = { tenantId: `unrelated-${randomUUID()}`, clinicId: "index", locationId: "main" }, fingerprint = "e".repeat(64);
    const links = [{ normalizedPhone: "+61400111222", patientId: "101" }];
    assert.ok((await new PostgresPatientPhoneIndex(db).publish(unrelated, links, "61", fingerprint)).ok);
    const scans = new PostgresPatientPhoneScan(db), staged = { ...unrelated, clinicId: "staged" }, begun = resultValue(await scans.begin(staged, "61", fingerprint));
    assert.ok((await scans.append(staged, begun.scanRef, { page: 1, totalEntries: 1, patientIds: ["101"], links })).ok);
    const retainedRef = randomUUID(); assert.ok((await new PostgresOutboundEffectBarrier(db, unrelated, fingerprint).claimOnce(retainedRef)).ok);
    const apiKey = `synthetic-outbound-memo-${randomUUID()}-au5`;
    c = await outboundMemoFixture(operation, mode, { apiKey, budget: new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 }),
      verificationBudgetFor: scope => new PostgresPatientVerificationBudget(db!, scope),
      sessionEffects: (scope, binding) => new PostgresOutboundEffectBarrier(db!, scope, binding),
      barrierFor: (scope, binding) => new PostgresOutboundEffectBarrier(db!, scope, binding) });
    const { code, publicData, privateValues } = await c.complete();
    const binding = administrativeMemoRecordBinding(c.memo.config.native, c.memo.authentication)!;
    const purposes = await sql<{ total: number }>`select count(*)::int as total from outbound_effect_barriers where owner_binding = ${binding}`.execute(db);
    assert.equal(purposes.rows[0]!.total, mode === "wrongSubjectGrant" || mode === "withdrawn" || mode === "nativeUncertain" ? 0 : 1);
    const scope = c.memo.config.native.scope;
    const verification = await sql<{ kind: string; attempts: number }>`select kind, attempts from patient_verification_budgets where tenant_id = ${scope.tenantId}`.execute(db);
    for (const kind of ["issue", "answer"] as const) assert.ok(verification.rows.some(row => row.kind === kind && row.attempts >= 1));
    const action = Object.values((await c.f.current()).actions)[0]!, request = action.mutation.request;
    assert.ok(request.kind === "book" || request.kind === "cancel" || request.kind === "reschedule");
    const proof = request.patient.verificationRef;
    const transport = c.f.transport;
    const original = transport.original.attempt;
    const privateContext = [JSON.stringify(transport.original), transport.original.recallRef, original.requestRecallRef, original.requestDigest,
      original.actionRef, original.requestActionRef, original.campaignRef, original.approvalRef, original.effectRef,
      ...(original.capacityAllocationRef ? [original.capacityAllocationRef] : []),
      ...(original.dncReferences ? Object.values(original.dncReferences) : []),
      ...(original.contactReferences ? Object.values(original.contactReferences) : []),
      transport.config.authToken, Buffer.from(transport.config.contextKey).toString("hex"), Buffer.from(transport.config.contextKey).toString("base64"),
      ...c.memo.posts.map(row => resultValue(decodeAdministrativeMemo(row.content)).authentication)];
    for (const secret of [proof, ...privateContext]) assert.equal(publicData.includes(secret), false);
    const canaries = [...privateValues, proof, ...privateContext, c.f.actualCallId, c.f.sessionId,
      transport.config.accountSid, transport.callSid, transport.streamSid].filter(value => value.length >= 4);
    await c.close();
    await assertSqlVerificationCodeCanary(db, code, canaryWindow);
    const probes = canaries.flatMap((value, i) => Array.from({ length: Math.ceil(value.length / 256) }, (_, n) => ({ label: `out_memo_${i}_${n}`,
      value: value.slice(n * 256, (n + 1) * 256).length < 4 ? value.slice(-4) : value.slice(n * 256, (n + 1) * 256) })));
    for (let i = 0; i < probes.length; i += 12) assert.deepEqual(await scanPatientDataCanaries(db, probes.slice(i, i + 12)), { ok: true, value: [] });
    const dump = execFileSync("pg_dump", [target.toString(), "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
    const copy = (s: string) => s.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
    for (const raw of canaries) { const json = JSON.stringify(raw).slice(1, -1); for (const value of [raw, copy(raw), json, copy(json)]) assert.equal(dump.includes(value), false); }
    assert.equal(dump.includes(retainedRef), true); assert.equal((await db.selectFrom("patient_phone_index").selectAll().execute()).length, 1);
    assert.equal((await scans.verifyPage(staged, begun.scanRef, { page: 1, totalEntries: 1, patientIds: ["101"], links })).ok, true);
  } finally {
    try { await c?.close(); } finally {
      await db?.destroy(); try { if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); } finally { await admin.destroy(); }
    }
  }
});
