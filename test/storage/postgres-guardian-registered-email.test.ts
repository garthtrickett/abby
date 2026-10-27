// E2E-387: independent guardian proof when two native minor records share the actor registered email.
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
const { representativeCallOwnerFixture, representativeInputOptions } = await import(new URL("test/support/representative-call-owner.js", emitted).href) as typeof import("../support/representative-call-owner.ts");
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

for (const outcome of ["accepted", "missingAuthority", "recipientDrift"] as const)
test(`actual emitted signed guardian shared registered email retains independent child proof: ${outcome}`,
  { timeout: outcome === "accepted" ? 300_000 : 180_000 }, async () => {
  const admin = connectPostgres(adminUrl), databaseName = `abby_test_guardian_email_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${databaseName}`;
  let created = false, db: ReturnType<typeof connectPostgres> | undefined;
  let f: Awaited<ReturnType<typeof representativeCallOwnerFixture>> | undefined;
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
    f = await representativeCallOwnerFixture({ multiplePatients: true, guardian: true, budget, subjectIds: subjects }); f.flow.dispose();
    const fixture = f, beganAt = performance.now(), registeredEmail = verificationCanaries[0]!;
    for (const patient of f.r.patients.values()) patient.email = registeredEmail;
    const firstAuthority = structuredClone(f.r.authorizations.get(subjects[0]));
    const clock = () => { const now = new Date(Date.parse(verificationNow) + performance.now() - beganAt).toISOString(); fixture.f.setTime(now); return now; };
    // Native-shaped fixtures still exclude a slot after the first actual write.
    // Distinct recall IDs preserve independent review/receipt ownership.
    const port: typeof fetch = async (value, init) => {
      const response = await fixture.flowConfig.fetchPort(value, init), url = new URL(String(value));
      if (url.pathname === "/v1/recalls" && init?.method === "POST") {
        const row = await response.json(), stored = fixture.f.recalls.at(-1)!;
        stored.id = String(700 + fixture.f.recalls.length); row.id = stored.id;
        return Response.json(row, { status: response.status });
      }
      if (url.pathname.endsWith("/available_times") && response.status === 200) {
        const body = await response.json();
        body.available_times = body.available_times.filter((time: { appointment_start: string }) =>
          !call?.writeRequests.some(write => write.body.starts_at === time.appointment_start));
        body.total_entries = body.available_times.length; return Response.json(body);
      }
      return response;
    };
    const sequence = await syntheticTaskSequence({ ...f.flowConfig, clock, fetchPort: port,
      representativeInput: representativeInputOptions(f), verificationBudget: new PostgresPatientVerificationBudget(db, f.f.scope) }, f.f.folder);
    await sequence.replace({ patientSelection: "independentlyVerifiedPatients" });
    call = await clinikoWorkflowVoiceFixture(db, sequence.config, flow => {
      const ordinary = createOpenAIClinicalIntentResolver({ apiKey: "synthetic", model: "synthetic", owner: flow, clinicDate: () => "2026-10-04",
        fetch: async () => { throw Error("Private patient data cannot reach the model"); } });
      return async (turn, signal) => turn.text === "Times" ? ok({ kind: "bookingMenu", from: "2026-10-08", to: "2026-10-08" })
        : turn.text === "First option" ? ok({ kind: "bookingChoice", choice: 1 }) : turn.text === "Yes" ? ok({ kind: "affirm" })
        : turn.text === "Are you still there?" ? ok({ kind: "presence" }) : ordinary(turn, signal);
    }, { clinicalHost: true, maximumWrites: 2, steadyMedia: true });
    const serving = call;
    const select = async (index: 0 | 1) => {
      await serving.turn("Book an appointment for my child");
      assert.ok(serving.flow.representativeInputOwner); assert.equal(fixture.mail.length, index * 2);
      await serving.mark(); await serving.privateDigit("1"); await serving.mark(); await fixture.waitForMail(index * 2 + 1);
      for (const digit of `${fixture.mail.at(-1)!.code}#`) serving.sendEvent({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
      await voiceUntil(() => serving.spoken.at(-1) === "Please say the patient's first name.", "fresh child private field"); await serving.mark();
      const patient = fixture.r.patients.get(subjects[index])!;
      for (const field of [patient.first_name, patient.last_name, index === 0 ? "5 March 2014" : "28 February 2014"]) {
        await serving.privateField(field); await serving.mark();
      }
      if (index === 1 && outcome === "missingAuthority") {
        const owner = serving.flow.representativeInputOwner!;
        await serving.privateKey("1");
        await voiceUntil(() => owner.closed, "missing guardian permission refuses selected child");
        assert.equal(fixture.mail.length, 3); return;
      }
      await serving.privateDigit("1"); await serving.mark(); await fixture.waitForMail(index * 2 + 2);
      assert.equal(fixture.mail.at(-1)!.email, registeredEmail);
      if (index === 1 && outcome === "recipientDrift") {
        patient.email = "changed-subject-private@example.test";
        for (const digit of `${fixture.mail.at(-1)!.code}#`) await serving.privateKey(digit);
        assert.equal(serving.flow.verificationRequired, true, "changed native recipient cannot verify the outstanding challenge");
      } else await serving.verify(fixture.mail.at(-1)!.code);
    };
    const book = async (index: 0 | 1) => {
      await serving.turn("Times"); await serving.mark(); await serving.turn("First option");
      const action = Object.values((await serving.state()).actions).at(-1)!;
      assert.equal(action.status, "awaitingConfirmation"); assert.equal(serving.writes.length, index);
      await serving.mark(); await serving.turn("Yes");
      const settled = (await serving.state()).actions[action.key]!;
      assert.equal(settled.status, "committed"); assert.equal(serving.spoken.at(-1), "Your booking is confirmed.");
      assert.equal(serving.writeRequests[index]!.body.patient_id, subjects[index]); await serving.mark(); return settled;
    };
    await select(0); const firstOwner = serving.flow.representativeInputOwner!, first = await book(0), firstSnapshot = structuredClone(first);
    // Steady carrier20ms media and normal presence renew the actual lease. This
    // is a real61-second quota pause, not a source-clock jump or grant renewal.
    const beganPause = performance.now(), quiet = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
    await serving.turn("Please hold."); await serving.mark(); await quiet(28000);
    await serving.turn("Please wait while I check my diary."); await serving.mark(); await quiet(28000);
    await serving.turn("Are you still there?"); await serving.mark(); await quiet(5000);
    assert.ok(performance.now() - beganPause >= 61000);
    if (outcome === "missingAuthority") f.r.authorizations.delete(subjects[1]);
    else {
      const previous = f.r.authorizations.get(subjects[1])!;
      f.r.authorizations.set(subjects[1], { ...previous, authorityRef: "fresh-second-task-guardian", version: "2",
        expiresAt: new Date(Date.parse(serving.currentTime()) + 120000).toISOString() });
    }
    await select(1); assert.equal(firstOwner.closed, true);
    assert.notEqual(serving.flow.representativeInputOwner, firstOwner);
    if (outcome === "accepted") {
      assert.equal((await serving.flow.publicIntentContext())?.lastAction, null);
      const second = await book(1);
      if (first.mutation.request.kind !== "book" || second.mutation.request.kind !== "book") throw Error("wrong operation");
      assert.notEqual(first.mutation.request.patient.verificationRef, second.mutation.request.patient.verificationRef);
      assert.equal((await serving.flow.resolveBooking(f.f.scope, first.mutation.request.patient.verificationRef,
        first.mutation.request.offer.offerRef, serving.currentTime())).ok, false);
    }
    const expectedWrites = outcome === "accepted" ? 2 : 1, state = await serving.state();
    assert.equal(serving.writes.length, expectedWrites); assert.equal(f.f.recalls.length, expectedWrites);
    assert.equal(f.mail.length, outcome === "missingAuthority" ? 3 : 4);
    assert.ok(f.mail.every(row => row.email === registeredEmail));
    assert.deepEqual(state.actions[first.key], firstSnapshot);
    assert.deepEqual(f.r.authorizations.get(subjects[0]), firstAuthority, "earlier guardian authority cannot be renewed by task progression");
    for (const [index, row] of f.f.recalls.entries()) {
      const review: ClinikoDecodedReview = resultValue(decodeClinikoReview(row.notes));
      assert.equal(review.request.patientId, subjects[index]); assert.equal(review.request.operation.kind, "book");
    }
    assert.deepEqual(await serving.flow.write(first.mutation, serving.currentTime()), { kind: "rejected", actionKey: first.key, reason: "forbidden" });
    assert.equal(serving.writes.length, expectedWrites);
    const publicData = JSON.stringify([serving.modelTurns, serving.transcripts, commandProgress(state, "guardian-registered-email"), await serving.flow.publicIntentContext()]);
    const privateValues = [...verificationCanaries, ...subjects, f.flowConfig.cliniko.apiKey, ...serving.privateTranscripts,
      "synthetic-workflow-voice-token", `AC${"4".repeat(32)}`, ...f.mail.flatMap(row => [row.email, row.code]),
      ...[...f.r.patients.values()].flatMap(row => [row.first_name, row.last_name, row.date_of_birth, row.email, ...row.patient_phone_numbers.map(phone => phone.number)]),
      ...Object.values(state.actions).map(action => { const request = action.mutation.request;
        assert.ok(request.kind === "book"); return request.patient.verificationRef; }),
      ...f.f.recalls.flatMap(row => [String(row.notes), resultValue(decodeClinikoReview(row.notes)).marker])];
    for (const secret of privateValues) assert.equal(publicData.includes(secret), false);
    await serving.close(); call = undefined;
    for (const message of f.mail) await assertSqlVerificationCodeCanary(db, message.code, canary.window);
    const canaries = [...privateValues, serving.callId, state.sessionLease!.sessionId].filter(value => value.length >= 4);
    const probes = canaries.flatMap((value, i) => Array.from({ length: Math.ceil(value.length / 256) }, (_, n) => ({ label: `guardian_email_${i}_${n}`,
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
    for (const kind of ["issue", "answer"] as const) assert.ok(verification.rows.filter(row => row.kind === kind).reduce((sum, row) => sum + row.attempts, 0) >= (outcome === "missingAuthority" ? 3 : 4));
  } finally {
    try { await call?.close(); } finally {
      try { await f?.close(); } finally {
        canary?.close(); await db?.destroy();
        try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); } finally { await admin.destroy(); }
      }
    }
  }
});
