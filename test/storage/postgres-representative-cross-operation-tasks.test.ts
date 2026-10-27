// E2E-389: independently approved patient cancellation/rescheduling through signed HTTP/media and SQL.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { captureScopedSqlVerificationCanaryWindow, assertSqlVerificationCodeCanary } from "../support/sql-verification-canary.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow, verificationCanaries } from "../support/caller-verification.ts";
import type { ClinikoDecodedReview } from "../../src/cliniko/review-request.ts";

if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const adminUrl = process.env.DATABASE_URL;
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { representativeChangeCallFixture } = await import(new URL("test/support/representative-change-call.js", emitted).href) as typeof import("../support/representative-change-call.ts");
const { syntheticTaskSequence } = await import(new URL("test/support/call-task-sequence.js", emitted).href) as typeof import("../support/call-task-sequence.ts");
const { clinikoWorkflowVoiceFixture, voiceUntil } = await import(new URL("test/support/cliniko-workflow-voice.js", emitted).href) as typeof import("../support/cliniko-workflow-voice.ts");
const { createOpenAIClinicalIntentResolver } = await import(new URL("src/standalone/openai-clinical-intent.js", emitted).href) as typeof import("../../src/standalone/openai-clinical-intent.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { PostgresPatientVerificationBudget } = await import(new URL("src/storage/postgres-patient-verification-budget.js", emitted).href) as typeof import("../../src/storage/postgres-patient-verification-budget.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { PostgresPatientPhoneIndex } = await import(new URL("src/storage/postgres-patient-phone-index.js", emitted).href) as typeof import("../../src/storage/postgres-patient-phone-index.ts");
const { PostgresPatientPhoneScan } = await import(new URL("src/storage/postgres-patient-phone-scan.js", emitted).href) as typeof import("../../src/storage/postgres-patient-phone-scan.ts");
const { decodeClinikoReview } = await import(new URL("src/cliniko/review-request.js", emitted).href) as typeof import("../../src/cliniko/review-request.ts");
const { commandProgress } = await import(new URL("src/reference/command-progress.js", emitted).href) as typeof import("../../src/reference/command-progress.ts");
const { ok } = await import(new URL("src/core/model.js", emitted).href) as typeof import("../../src/core/model.ts");

for (const order of [["cancel", "reschedule"], ["reschedule", "cancel"]] as const)
for (const uncertain of [false, true])
test(`actual emitted signed cross-patient ${order[0]} then ${order[1]} retains each subject and receipt: ${uncertain ? "unknownFirst" : "accepted"}`,
  { timeout: uncertain ? 180_000 : 300_000 }, async () => {
  const admin = connectPostgres(adminUrl), databaseName = `abby_test_rep_cross_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${databaseName}`;
  let created = false, db: ReturnType<typeof connectPostgres> | undefined;
  let f: Awaited<ReturnType<typeof representativeChangeCallFixture>> | undefined;
  let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
  let canary: Awaited<ReturnType<typeof captureScopedSqlVerificationCanaryWindow>> | undefined;
  try {
    await sql.raw(`create database "${databaseName}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); await migrate(db);
    const unrelated = { tenantId: `unrelated-${randomUUID()}`, clinicId: "index", locationId: "main" }, fingerprint = "e".repeat(64);
    const links = [{ normalizedPhone: "+61400111222", patientId: "101" }];
    resultValue(await new PostgresPatientPhoneIndex(db).publish(unrelated, links, "61", fingerprint));
    const scans = new PostgresPatientPhoneScan(db), staged = { ...unrelated, clinicId: "staged" }, begun = resultValue(await scans.begin(staged, "61", fingerprint));
    resultValue(await scans.append(staged, begun.scanRef, { page: 1, totalEntries: 1, patientIds: ["101"], links }));
    const retainedRef = randomUUID(); resultValue(await new PostgresOutboundEffectBarrier(db, unrelated, fingerprint).claimOnce(retainedRef));
    const unrelatedBudget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-unrelated-budget-user", maxPerMinute: 1 });
    assert.equal(await unrelatedBudget.claim(), null);
    const originalIndex = await db.selectFrom("patient_phone_index").selectAll().execute();
    const originalBarriers = await db.selectFrom("outbound_effect_barriers").selectAll().execute();
    const originalForeign = await db.selectFrom("cliniko_request_budgets").selectAll().execute();
    canary = await captureScopedSqlVerificationCanaryWindow(db, target.toString());
    const budget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-session-au5", maxPerMinute: 180 });
    const subjects = ["583746192837465", "683746192837465"] as const;
    f = await representativeChangeCallFixture(order[0], { budget, subjectIds: subjects }); f.flow.dispose();
    const fixture = f, beganAt = performance.now();
    const clock = () => { const now = new Date(Date.parse(verificationNow) + performance.now() - beganAt).toISOString(); fixture.f.setTime(now); return now; };
    const sequence = await syntheticTaskSequence({ ...f.flowConfig, clock,
      verificationBudget: new PostgresPatientVerificationBudget(db, f.f.scope) }, f.f.folder);
    await sequence.replace({ patientSelection: "independentlyVerifiedPatients" });
    call = await clinikoWorkflowVoiceFixture(db, sequence.config, flow => {
      const ordinary = createOpenAIClinicalIntentResolver({ apiKey: "synthetic", model: "synthetic", owner: flow, clinicDate: () => "2026-10-04",
        fetch: async () => { throw Error("Private patient data cannot reach the model"); } });
      return async (turn, signal) => {
        if (turn.text === "Yes") return ok({ kind: "affirm" });
        if (turn.text === "Are you still there?") return ok({ kind: "presence" });
        if (turn.text === "Cancellation appointments" || turn.text === "Cancel it") {
          const grant = await flow.cancellationProof(); assert.ok(grant);
          return turn.text === "Cancellation appointments" ? ok({ kind: "appointments", verificationRef: grant.verificationRef,
            from: call!.currentTime(), to: "2026-10-09T06:00:00.000Z" }) : ok({ kind: "cancel", verificationRef: grant.verificationRef, targetRef: "selected" });
        }
        if (turn.text === "Move targets" || turn.text === "Move offers") return ok({ kind: "reschedulingMenu", stage: turn.text === "Move targets" ? "targets" : "offers",
          from: turn.text === "Move targets" ? call!.currentTime() : "2026-10-08", to: turn.text === "Move targets" ? "2026-10-09T06:00:00.000Z" : "2026-10-08" });
        if (turn.text === "Select target" || turn.text === "Select offer") return ok({ kind: "reschedulingChoice", stage: turn.text === "Select target" ? "targets" : "offers", choice: 1 });
        return ordinary(turn, signal);
      };
    }, { clinicalHost: true, nativeIndividualChanges: true, maximumWrites: 2, steadyMedia: true, ...(uncertain ? { lostWrite: true } : {}) });
    const serving = call, originalCaller = structuredClone(f.rows.get("93"));
    const waitForWindow = async () => {
      // The fixture sends continuous20ms quiet packets even while native/private
      // callbacks are awaited. Do not double-send during these real-time pauses.
      const quiet = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
      const began = performance.now();
      await serving.turn("Please hold."); await serving.mark(); await quiet(28000);
      await serving.turn("Please wait while I check my diary."); await serving.mark(); await quiet(28000);
      await serving.turn("Are you still there?"); await serving.mark(); await quiet(5000);
      assert.ok(performance.now() - began >= 61_000, "quota pause must use actual elapsed time");
    };
    let first: Awaited<ReturnType<typeof serving.state>>["actions"][string] | undefined;
    for (const [index, operation] of order.entries()) {
      if (index === 1) {
        await waitForWindow();
        // Independent synthetic clinic issuance before the next subject's
        // fresh selection. The first grant and both120s durations are unchanged.
        const previous = f.r.authorizations.get(subjects[1])!;
        f.r.authorizations.set(subjects[1], { ...previous, authorityRef: "fresh-second-task-guardian", version: "2",
          expiresAt: new Date(Date.parse(serving.currentTime()) + 120_000).toISOString() });
      }
      const patient: Readonly<{ first_name: string; last_name: string; email: string }> = f.r.patients.get(subjects[index]!)!;
      await serving.turn(operation === "cancel" ? index === 0 ? "Cancel an appointment for my partner" : "Cancel an appointment for my son"
        : index === 0 ? "Move an appointment for my partner" : "Move an appointment for my son");
      await serving.mark(); await serving.privateDigit("1"); await serving.mark(); await f.waitForMail(index * 2 + 1);
      for (const digit of `${f.mail.at(-1)!.code}#`) serving.sendEvent({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
      await voiceUntil(() => serving.spoken.at(-1) === "Please say the patient's first name.", "fresh patient field"); await serving.mark();
      for (const field of [patient.first_name, patient.last_name, index === 0 ? "5 March 1982" : "28 February 2014"]) { await serving.privateField(field); await serving.mark(); }
      await serving.privateDigit("1"); await serving.mark(); await f.waitForMail(index * 2 + 2);
      assert.equal(f.mail.at(-1)!.email, patient.email); await serving.verify(f.mail.at(-1)!.code);
      if (index === 1) { assert.deepEqual((await serving.state()).actions[first!.key], first); assert.equal((await serving.flow.publicIntentContext())?.lastAction, null); }
      if (operation === "reschedule") await waitForWindow();
      if (operation === "cancel") { await serving.turn("Cancellation appointments");
        assert.equal((await serving.state()).appointmentReads.at(-1)?.status, "shown");
        await serving.mark(); await serving.turn("Cancel it"); }
      else { await serving.turn("Move targets"); await serving.mark(); await serving.turn("Select target"); await serving.mark();
        await serving.turn("Move offers"); await serving.mark(); await serving.turn("Select offer"); }
      const action = Object.values((await serving.state()).actions).at(-1)!; assert.equal(action.status, "awaitingConfirmation");
      assert.equal(serving.writes.length, index); await serving.mark(); await serving.turn("Yes");
      const settled = (await serving.state()).actions[action.key]!;
      assert.equal(serving.writes.length, index + 1); assert.equal(f.patches.length, index + 1);
      assert.equal(serving.writeRequests[index]!.path, operation === "cancel" ? `/v1/individual_appointments/${index === 0 ? "91" : "92"}/cancel` : `/v1/individual_appointments/${index === 0 ? "91" : "92"}`);
      if (uncertain) {
        assert.ok(["uncertain", "needsReview"].includes(settled.status)); first = structuredClone(settled); await serving.mark();
        await serving.turn("Cancel an appointment for my son");
        assert.equal(f.mail.length, 2); assert.equal(serving.writes.length, 1); assert.equal(f.patches.length, 1);
        assert.deepEqual((await serving.state()).actions[first.key], first); break;
      }
      assert.equal(settled.status, "committed"); assert.equal(serving.spoken.at(-1), operation === "cancel" ? "Your appointment cancellation is confirmed." : "Your appointment move is confirmed.");
      if (index === 0) first = structuredClone(settled); await serving.mark();
      const review: ClinikoDecodedReview = resultValue(decodeClinikoReview(f.f.recalls[index]!.notes));
      assert.equal(review.request.patientId, subjects[index]); assert.equal(review.request.operation.kind, operation);
      assert.deepEqual(f.rows.get("93"), originalCaller);
    }
    const state = await serving.state(); assert.ok(first); assert.deepEqual(state.actions[first.key], first);
    assert.equal(f.mail.length, uncertain ? 2 : 4); assert.equal(f.f.recalls.length, uncertain ? 1 : 2);
    assert.deepEqual(await serving.flow.write(first.mutation, serving.currentTime()), { kind: "rejected", actionKey: first.key, reason: "forbidden" });
    assert.equal(serving.writes.length, uncertain ? 1 : 2);
    const publicData = JSON.stringify([serving.modelTurns, serving.transcripts, commandProgress(state, "cross-patient-operations"), await serving.flow.publicIntentContext()]);
    const privateValues = [...verificationCanaries, ...subjects, f.flowConfig.cliniko.apiKey, ...serving.privateTranscripts,
      "synthetic-workflow-voice-token", `AC${"4".repeat(32)}`, ...f.mail.flatMap(row => [row.email, row.code]),
      ...[...f.r.patients.values()].flatMap(row => [row.first_name, row.last_name, row.date_of_birth, row.email, ...row.patient_phone_numbers.map(phone => phone.number)]),
      ...Object.values(state.actions).map(action => { const request = action.mutation.request;
        assert.ok(request.kind === "cancel" || request.kind === "reschedule"); return request.patient.verificationRef; }),
      ...f.f.recalls.flatMap(row => [String(row.notes), resultValue(decodeClinikoReview(row.notes)).marker])];
    for (const secret of privateValues) assert.equal(publicData.includes(secret), false);
    await serving.close(); call = undefined;
    for (const message of f.mail) await assertSqlVerificationCodeCanary(db, message.code, canary.window);
    const canaries = [...privateValues, serving.callId, state.sessionLease!.sessionId].filter(value => value.length >= 4);
    const probes = canaries.flatMap((value, i) => Array.from({ length: Math.ceil(value.length / 256) }, (_, n) => ({ label: `rep_cross_${i}_${n}`,
      value: value.slice(n * 256, (n + 1) * 256).length < 4 ? value.slice(-4) : value.slice(n * 256, (n + 1) * 256) })));
    for (let i = 0; i < probes.length; i += 12) assert.deepEqual(resultValue(await scanPatientDataCanaries(db, probes.slice(i, i + 12))), []);
    const dump = execFileSync("pg_dump", [target.toString(), "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
    const copy = (s: string) => s.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
    for (const raw of canaries) for (const value of [raw, copy(raw), JSON.stringify(raw).slice(1, -1), copy(JSON.stringify(raw).slice(1, -1))]) assert.equal(dump.includes(value), false);
    assert.ok(dump.includes(retainedRef));
    assert.deepEqual(await db.selectFrom("patient_phone_index").selectAll().execute(), originalIndex);
    assert.deepEqual(await db.selectFrom("outbound_effect_barriers").selectAll().execute(), originalBarriers);
    assert.equal((await scans.verifyPage(staged, begun.scanRef, { page: 1, totalEntries: 1, patientIds: ["101"], links })).ok, true);
    const budgetRef = createHash("sha256").update("abby-cliniko-budget-v1\0synthetic-session-au5").digest("hex");
    const currentBudget = await sql<{ max_per_minute: number; sent_at_ms: unknown }>`select max_per_minute, sent_at_ms from cliniko_request_budgets where budget_ref = ${budgetRef}`.execute(db);
    assert.equal(currentBudget.rows.length, 1); assert.equal(currentBudget.rows[0]!.max_per_minute, 180);
    const recent = currentBudget.rows[0]!.sent_at_ms;
    assert.ok(Array.isArray(recent) && recent.length <= 180);
    const allBudgets = await db.selectFrom("cliniko_request_budgets").selectAll().execute();
    assert.deepEqual(allBudgets.filter(row => originalForeign.some(original => original.budget_ref === row.budget_ref)), originalForeign);
    const verification = await sql<{ kind: string; attempts: number }>`select kind, attempts from patient_verification_budgets where tenant_id = ${f.f.scope.tenantId}`.execute(db);
    for (const kind of ["issue", "answer"] as const) assert.ok(verification.rows.filter(row => row.kind === kind).reduce((sum, row) => sum + row.attempts, 0) >= (uncertain ? 2 : 4));
  } finally {
    try { await call?.close(); } finally {
      try { await f?.close(); } finally {
        canary?.close(); await db?.destroy();
        try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); } finally { await admin.destroy(); }
      }
    }
  }
});
