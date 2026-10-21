import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { captureSqlVerificationCanaryWindow, assertSqlVerificationCodeCanary } from "../support/sql-verification-canary.ts";
import { verificationNow, verificationCanaries } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const adminUrl = process.env.DATABASE_URL, baseline = connectPostgres(adminUrl);
after(() => baseline.destroy());
const canaryWindow = await captureSqlVerificationCanaryWindow(baseline);
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { representativeChangeCallFixture } = await import(new URL("test/support/representative-change-call.js", emitted).href) as typeof import("../support/representative-change-call.ts");
const { subjectMemoFixture } = await import(new URL("test/support/subject-memo.js", emitted).href) as typeof import("../support/subject-memo.ts");
const { clinikoWorkflowVoiceFixture, voiceUntil } = await import(new URL("test/support/cliniko-workflow-voice.js", emitted).href) as typeof import("../support/cliniko-workflow-voice.ts");
const { createOpenAIClinicalIntentResolver } = await import(new URL("src/standalone/openai-clinical-intent.js", emitted).href) as typeof import("../../src/standalone/openai-clinical-intent.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { PostgresPatientVerificationBudget } = await import(new URL("src/storage/postgres-patient-verification-budget.js", emitted).href) as typeof import("../../src/storage/postgres-patient-verification-budget.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { PostgresPatientPhoneIndex } = await import(new URL("src/storage/postgres-patient-phone-index.js", emitted).href) as typeof import("../../src/storage/postgres-patient-phone-index.ts");
const { PostgresPatientPhoneScan } = await import(new URL("src/storage/postgres-patient-phone-scan.js", emitted).href) as typeof import("../../src/storage/postgres-patient-phone-scan.ts");
const { decodeAdministrativeMemo } = await import(new URL("src/cliniko/administrative-memo.js", emitted).href) as typeof import("../../src/cliniko/administrative-memo.ts");
const { decodeClinikoReview } = await import(new URL("src/cliniko/review-request.js", emitted).href) as typeof import("../../src/cliniko/review-request.ts");
const { administrativeMemoRecordBinding } = await import(new URL("src/cliniko/administrative-memo-records.js", emitted).href) as typeof import("../../src/cliniko/administrative-memo-records.ts");
const { ok } = await import(new URL("src/core/model.js", emitted).href) as typeof import("../../src/core/model.ts");
const { commandProgress } = await import(new URL("src/reference/command-progress.js", emitted).href) as typeof import("../../src/reference/command-progress.ts");

for (const operation of ["cancel", "reschedule"] as const)
for (const mode of ["accepted", "wrongSubjectGrant", "withdrawn", "lostStored", "nativeUncertain"] as const)
test(`actual emitted signed representative ${operation} keeps memo subject, rolling180, SQL grants and full-backup privacy: ${mode}`, { timeout: 180000 }, async () => {
  const admin = connectPostgres(adminUrl), databaseName = `abby_rep_change_memo_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${databaseName}`;
  let created = false, db: ReturnType<typeof connectPostgres> | undefined;
  let f: Awaited<ReturnType<typeof representativeChangeCallFixture>> | undefined;
  let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined, memo: ReturnType<typeof subjectMemoFixture> | undefined;
  try {
    await sql.raw(`create database "${databaseName}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); await migrate(db);
    const unrelated = { tenantId: `unrelated-${randomUUID()}`, clinicId: "index", locationId: "main" }, fingerprint = "e".repeat(64);
    const links = [{ normalizedPhone: "+61400111222", patientId: "101" }];
    assert.ok((await new PostgresPatientPhoneIndex(db).publish(unrelated, links, "61", fingerprint)).ok);
    const scans = new PostgresPatientPhoneScan(db), staged = { ...unrelated, clinicId: "staged" }, begun = resultValue(await scans.begin(staged, "61", fingerprint));
    assert.ok((await scans.append(staged, begun.scanRef, { page: 1, totalEntries: 1, patientIds: ["101"], links })).ok);
    const retainedRef = randomUUID(); assert.ok((await new PostgresOutboundEffectBarrier(db, unrelated, fingerprint).claimOnce(retainedRef)).ok);
    const budget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-session-au5", maxPerMinute: 180 });
    const subjects = ["583746192837465", "683746192837465"] as const;
    f = await representativeChangeCallFixture(operation, { budget, subjectIds: subjects }); f.flow.dispose();
    const fixture = f, began = performance.now();
    const clock = () => { const now = new Date(Date.parse(verificationNow) + performance.now() - began).toISOString(); fixture.f.setTime(now); return now; };
    memo = subjectMemoFixture({ scope: f.f.scope, ...f.flowConfig.cliniko,
      authorRef: "clinic-approved-admin-memo", policy: { version: "admin-actions-v1", digest: "a".repeat(64) },
      clock: () => call?.currentTime() ?? clock(), deadlineMs: 5000 }, subjects[0], {
      ...(mode === "wrongSubjectGrant" ? { approvedPatientId: subjects[1] } : {}),
      ...(mode === "lostStored" ? { lostStored: true } : {}),
      barrierFor: (scope, binding) => new PostgresOutboundEffectBarrier(db!, scope, binding)
    });
    const retention = memo, stages: unknown[] = [];
    call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, clock, memo: memo.config,
      verificationBudget: new PostgresPatientVerificationBudget(db, f.f.scope), representativeInput: f.flowConfig.representativeInput }, flow => {
      const readMenu = flow.readReschedulingMenu.bind(flow), selectMenu = flow.selectReschedulingMenu.bind(flow), resolveChange = flow.resolveAppointmentChange.bind(flow);
      flow.readReschedulingMenu = async (...args: Parameters<typeof readMenu>) => { const result = await readMenu(...args);
        stages.push({ phase: "read", stage: args[0].stage, currentRangeMs: Date.parse(args[0].now) - Date.parse(args[0].from), ok: result.ok,
          ...(result.ok ? { resultStage: result.value.stage, choices: result.value.choices.length } : { code: result.error.kind }) }); return result; };
      flow.selectReschedulingMenu = async (...args: Parameters<typeof selectMenu>) => { const result = await selectMenu(...args);
        stages.push({ phase: "select", stage: args[0].stage, ok: result.ok, ...(result.ok ? { kind: result.value.kind } : { code: result.error.kind }) }); return result; };
      flow.resolveAppointmentChange = async (...args: Parameters<typeof resolveChange>) => { const result = await resolveChange(...args);
        stages.push({ phase: "resolve", ok: result.ok, ...(!result.ok ? { code: result.error.kind } : {}) }); return result; };
      const ordinary = createOpenAIClinicalIntentResolver({ apiKey: "synthetic", model: "synthetic", owner: flow, clinicDate: () => "2026-10-04",
        fetch: async () => { throw Error("Private patient data cannot reach the model"); } });
      return async (turn, signal) => {
        if (turn.text === "Yes") return ok({ kind: "affirm" });
        if (turn.text === "Are you still there?") return ok({ kind: "presence" });
        if (turn.text === "Did it finish") return ok({ kind: "outcome" });
        if (turn.text === "Cancellation appointments" || turn.text === "Cancel it") {
          const grant = await flow.cancellationProof(); assert.ok(grant);
          return turn.text === "Cancellation appointments" ? ok({ kind: "appointments", verificationRef: grant.verificationRef, from: call!.currentTime(), to: "2026-10-09T06:00:00.000Z" })
            : ok({ kind: "cancel", verificationRef: grant.verificationRef, targetRef: "selected" });
        }
        if (turn.text === "Move targets" || turn.text === "Move offers") return ok({ kind: "reschedulingMenu", stage: turn.text === "Move targets" ? "targets" : "offers",
          from: turn.text === "Move targets" ? call!.currentTime() : "2026-10-08", to: turn.text === "Move targets" ? "2026-10-09T06:00:00.000Z" : "2026-10-08" });
        if (turn.text === "Select target" || turn.text === "Select offer") return ok({ kind: "reschedulingChoice", stage: turn.text === "Select target" ? "targets" : "offers", choice: 1 });
        return ordinary(turn, signal);
      };
    }, { clinicalHost: true, ...(mode === "nativeUncertain" ? { lostWrite: true } : {}), beforeWriteResponse: async () => { if (mode === "withdrawn") retention.control.permitted = false; } });
    await call.turn(operation === "cancel" ? "Cancel an appointment for my partner" : "Move an appointment for my partner"); assert.ok(call.flow.representativeInputOwner); assert.equal(f.mail.length, 0);
    await call.mark(); await call.privateDigit("1"); await call.mark(); await f.waitForMail(1);
    for (const digit of `${f.mail[0]!.code}#`) call.sendEvent({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
    await voiceUntil(() => call!.spoken.at(-1) === "Please say the patient's first name.", "private representative patient field"); await call.mark();
    for (const field of [f.r.identity.firstName, f.r.identity.lastName, "5 March 1982"]) { await call.privateField(field); await call.mark(); }
    await call.privateDigit("1"); await call.mark(); await f.waitForMail(2);
    assert.notEqual(f.mail[0]!.email, f.mail[1]!.email); assert.equal(f.mail[1]!.email, f.r.patients.get(subjects[0])!.email);
    await call.verify(f.mail[1]!.code);
    // Real elapsed time, not a budget reset or a raised quota. The pause precedes
    // proposal and its action deadline; the caller/subject grants keep their original expiry.
    if (operation === "reschedule" && mode !== "nativeUncertain") {
      // A connected carrier keeps sending20ms audio frames during a pause.
      // Keep both real elapsed time and media time advancing; no stale-turn,
      // silence, lease, proof or quota limit is disabled or extended.
      const quiet = async (ms: number) => {
        const until = performance.now() + ms;
        while (performance.now() < until) { call!.media(false); await new Promise<void>(resolve => setTimeout(resolve, 20)); }
      };
      await call.turn("Please hold."); await call.mark(); await quiet(28000);
      await call.turn("Please wait while I check my diary."); await call.mark(); await quiet(28000);
      await call.turn("Are you still there?"); await call.mark(); await quiet(5000);
    }
    if (operation === "cancel") { await call.turn("Cancellation appointments"); await call.mark(); await call.turn("Cancel it"); }
    else { await call.turn("Move targets"); await call.mark(); await call.turn("Select target"); await call.mark();
      await call.turn("Move offers"); await call.mark(); await call.turn("Select offer"); }
    assert.equal(call.writes.length, 0); assert.equal(memo.posts.length, 0);
    const proposed = Object.values((await call.state()).actions).at(-1);
    assert.ok(proposed, JSON.stringify({ stages, flowClosed: call.flow.closed, voiceClosed: call.closed,
      lifecycle: (await call.state()).lifecycle, context: await call.flow.publicIntentContext() }));
    assert.equal(proposed.status, "awaitingConfirmation");
    await call.mark();
    if (operation === "cancel" && mode === "lostStored") {
      // Exercise accelerated carrier media ahead of wall time. Every quiet
      // batch is received before confirmation; all ordinary deadlines remain.
      for (let batch = 0; batch < 24; batch++) await call.privateQuiet();
    }
    await call.turn("Yes");
    assert.equal(call.writes.length, 1);
    assert.equal(call.writeRequests[0]!.path, operation === "cancel" ? "/v1/individual_appointments/91/cancel" : "/v1/individual_appointments/91");
    const nativeNotes = f.f.recalls[0]!.notes;
    const nativeReview = resultValue(decodeClinikoReview(nativeNotes)), nativeMarker = nativeReview.marker;
    assert.equal(nativeReview.request.patientId, subjects[0]); assert.equal(nativeReview.request.operation.kind, operation);
    const uncertain = mode === "nativeUncertain", denied = mode === "wrongSubjectGrant" || mode === "withdrawn";
    const retained = Object.values((await call.state()).actions).at(-1)!;
    if (uncertain) assert.ok(["uncertain", "needsReview"].includes(retained.status));
    else {
      assert.equal(call.spoken.at(-1), operation === "cancel" ? "Your appointment cancellation is confirmed." : "Your appointment move is confirmed.");
      assert.equal(retained.status, "committed"); await voiceUntil(() => retention.outcomes.length === 1, "independent memo completion");
      assert.equal(memo.outcomes[0]!.kind, denied ? "unavailable" : mode === "lostStored" ? "uncertain" : "accepted");
    }
    assert.equal(memo.posts.length, denied || uncertain ? 0 : 1); assert.equal(memo.rows.length, denied || uncertain ? 0 : 1);
    // A separately charged diagnostic can observe the synthetic native result;
    // it never supplies a receipt to Abby or upgrades its original uncertainty.
    assert.equal(await budget.claim(), null);
    const observed = await (await call.retainedNative.fetchPort("https://api.au5.cliniko.com/v1/individual_appointments/91", {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(5000), headers: { Accept: "application/json",
        Authorization: `Basic ${Buffer.from(f.flowConfig.cliniko.apiKey + ":").toString("base64")}`, "User-Agent": "Abby synthetic independent diagnostic" }
    })).json();
    assert.equal(observed.patient.links.self, `https://api.au5.cliniko.com/v1/patients/${subjects[0]}`);
    if (operation === "cancel") assert.notEqual(observed.cancelled_at, null);
    else { assert.equal(nativeReview.request.operation.kind, "reschedule"); if (nativeReview.request.operation.kind === "reschedule") {
      assert.equal(observed.starts_at, nativeReview.request.operation.newStartsAt); assert.equal(observed.ends_at, nativeReview.request.operation.newEndsAt);
    } }
    const binding = administrativeMemoRecordBinding(memo.config.native, memo.authentication)!;
    const purposes = await sql<{ total: number }>`select count(*)::int as total from outbound_effect_barriers where owner_binding = ${binding}`.execute(db);
    assert.equal(purposes.rows[0]!.total, denied || uncertain ? 0 : 1);
    if (!denied && !uncertain) {
      const decoded = resultValue(decodeAdministrativeMemo(memo.posts[0]!.content));
      assert.equal(decoded.patientId, subjects[0]); assert.notEqual(decoded.patientId, verificationCanaries[2]);
      assert.equal(decoded.direction, "inbound"); assert.equal(decoded.outcome.kind, operation === "cancel" ? "cancellationObserved" : "reschedulingObserved");
      assert.equal(decoded.sourceActionRef, nativeMarker);
      assert.deepEqual(resultValue(await new PostgresOutboundEffectBarrier(db, f.f.scope, binding).claimOnce(decoded.actionRef)), { claimed: false });
    }
    const verification = await sql<{ kind: string; attempts: number }>`select kind, attempts from patient_verification_budgets where tenant_id = ${f.f.scope.tenantId}`.execute(db);
    for (const kind of ["issue", "answer"] as const) assert.ok(verification.rows.some(row => row.kind === kind && row.attempts >= 2));
    await call.mark(); await call.turn("Did it finish"); assert.equal(call.writes.length, 1); assert.equal(memo.posts.length, denied || uncertain ? 0 : 1);
    const state = await call.state(), action = Object.values(state.actions).at(-1)!;
    assert.ok(action.mutation.request.kind === "cancel" || action.mutation.request.kind === "reschedule");
    assert.deepEqual(action, retained);
    const proof = action.mutation.request.patient.verificationRef;
    const publicData = JSON.stringify([call.modelTurns, call.transcripts, commandProgress(state, "representative-change-memo"), await call.flow.publicIntentContext()]);
    const privateValues = [...verificationCanaries, ...subjects, f.flowConfig.cliniko.apiKey, ...call.privateTranscripts, String(nativeNotes), nativeMarker, `Basic ${Buffer.from(f.flowConfig.cliniko.apiKey + ":").toString("base64")}`,
      "synthetic-workflow-voice-token", `AC${"4".repeat(32)}`,
      ...[...f.r.patients.values()].flatMap(row => [row.first_name, row.last_name, row.date_of_birth, row.email, ...row.patient_phone_numbers.map(phone => phone.number)]),
      ...f.mail.flatMap(row => [row.email, row.code]), ...f.f.recalls.map(row => String(row.notes)),
      ...f.f.recalls.map(row => resultValue(decodeClinikoReview(row.notes)).marker),
      ...memo.posts.flatMap(row => { const decoded = resultValue(decodeAdministrativeMemo(row.content));
        return [String(row.content), JSON.stringify(row), decoded.sourceActionRef, decoded.authentication]; }),
      memo.key.toString("hex"), memo.key.toString("base64"), proof];
    for (const secret of privateValues) assert.equal(publicData.includes(secret), false);
    await call.close();
    for (const message of f.mail) await assertSqlVerificationCodeCanary(db, message.code, canaryWindow);
    const canaries = [...privateValues, call.callId, state.sessionLease!.sessionId].filter(value => value.length >= 4);
    const probes = canaries.flatMap((value, i) => Array.from({ length: Math.ceil(value.length / 256) }, (_, n) => ({ label: `rep_change_memo_${i}_${n}`,
      value: value.slice(n * 256, (n + 1) * 256).length < 4 ? value.slice(-4) : value.slice(n * 256, (n + 1) * 256) })));
    for (let i = 0; i < probes.length; i += 12) assert.deepEqual(await scanPatientDataCanaries(db, probes.slice(i, i + 12)), { ok: true, value: [] });
    const dump = execFileSync("pg_dump", [target.toString(), "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
    const copy = (s: string) => s.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
    for (const raw of canaries) { const json = JSON.stringify(raw).slice(1, -1); for (const value of [raw, copy(raw), json, copy(json)]) assert.equal(dump.includes(value), false); }
    assert.equal(dump.includes(retainedRef), true); assert.equal((await db.selectFrom("patient_phone_index").selectAll().execute()).length, 1);
    assert.equal((await scans.verifyPage(staged, begun.scanRef, { page: 1, totalEntries: 1, patientIds: ["101"], links })).ok, true);
  } finally {
    try { await call?.close(); } finally {
      memo?.close(); try { await f?.close(); } finally {
        await db?.destroy(); try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); } finally { await admin.destroy(); }
      }
    }
  }
});
