import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { captureSqlVerificationCanaryWindow, assertSqlVerificationCodeCanary } from "./sql-verification-canary.ts";
import { verificationNow, verificationCanaries } from "./caller-verification.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const adminUrl = process.env.DATABASE_URL, baseline = connectPostgres(adminUrl);
after(() => baseline.destroy());
const canaryWindow = await captureSqlVerificationCanaryWindow(baseline, adminUrl);
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { representativeCallOwnerFixture, representativeInputOptions } = await import(new URL("test/support/representative-call-owner.js", emitted).href) as typeof import("./representative-call-owner.ts");
const { subjectMemoFixture } = await import(new URL("test/support/subject-memo.js", emitted).href) as typeof import("./subject-memo.ts");
const { clinikoWorkflowVoiceFixture, voiceUntil } = await import(new URL("test/support/cliniko-workflow-voice.js", emitted).href) as typeof import("./cliniko-workflow-voice.ts");
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

const { syntheticTaskSequence } = await import(new URL("test/support/call-task-sequence.js", emitted).href) as typeof import("./call-task-sequence.ts");

export function registerMultiplePatientMemoCases(cohort: "sequential" | "pending"): void {
  const modes = cohort === "sequential" ? ["accepted", "firstDenied", "secondDenied", "lostStored"] as const
    : ["firstClinicalUncertain", "pendingPrior"] as const;
  for (const mode of modes)
  test(`actual emitted signed multiple-patient memos retain each original subject and source: ${mode}`, { timeout: 180000 }, async () => {
    const admin = connectPostgres(adminUrl), databaseName = `abby_multi_memo_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(adminUrl); target.pathname = `/${databaseName}`;
    let created = false, db: ReturnType<typeof connectPostgres> | undefined;
    let f: Awaited<ReturnType<typeof representativeCallOwnerFixture>> | undefined;
    let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined, memo: ReturnType<typeof subjectMemoFixture> | undefined;
    let release: () => void = () => {};
    try {
      await sql.raw(`create database "${databaseName}"`).execute(admin); created = true;
      db = connectPostgres(target.toString()); await migrate(db);
      const unrelated = { tenantId: `unrelated-${randomUUID()}`, clinicId: "index", locationId: "main" }, fingerprint = "e".repeat(64);
      const links = [{ normalizedPhone: "+61400111222", patientId: "101" }];
      assert.ok((await new PostgresPatientPhoneIndex(db).publish(unrelated, links, "61", fingerprint)).ok);
      const scans = new PostgresPatientPhoneScan(db), staged = { ...unrelated, clinicId: "staged" }, begun = resultValue(await scans.begin(staged, "61", fingerprint));
      assert.ok((await scans.append(staged, begun.scanRef, { page: 1, totalEntries: 1, patientIds: ["101"], links })).ok);
      const retainedRef = randomUUID(); assert.ok((await new PostgresOutboundEffectBarrier(db, unrelated, fingerprint).claimOnce(retainedRef)).ok);
      const subjects = ["583746192837465", "683746192837465"] as const;
      const budget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-session-au5", maxPerMinute: 180 });
      f = await representativeCallOwnerFixture({ multiplePatients: true, subjectIds: subjects, budget }); f.flow.dispose();
      const fixture = f, began = performance.now();
      const clock = () => { const now = new Date(Date.parse(verificationNow) + performance.now() - began).toISOString(); fixture.f.setTime(now); return now; };
      memo = subjectMemoFixture({ scope: f.f.scope, ...f.flowConfig.cliniko,
        authorRef: "clinic-approved-admin-memo", policy: { version: "admin-actions-v1", digest: "a".repeat(64) },
        clock: () => call?.currentTime() ?? clock(), deadlineMs: 5000 }, subjects, {
        ...(mode === "firstDenied" ? { approvedPatientId: subjects[1] } : mode === "secondDenied" ? { approvedPatientId: subjects[0] } : {}),
        ...(mode === "lostStored" ? { lostStored: true } : {}), barrierFor: (scope, binding) => new PostgresOutboundEffectBarrier(db!, scope, binding) });
      const retention = memo;
      let entered = false;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const memoConfig = mode === "pendingPrior" ? { ...memo.config, fetchPort: async (...args: Parameters<typeof fetch>) => {
        entered = true; await gate; return retention.config.fetchPort!(...args);
      } } : memo.config;
      const port: typeof fetch = async (value, init) => {
        const response = await fixture.flowConfig.fetchPort(value, init), url = new URL(String(value));
        if (url.pathname === "/v1/recalls" && init?.method === "POST") {
          const row = await response.json(), stored = fixture.f.recalls.at(-1)!;
          const id = String(700 + fixture.f.recalls.length); stored.id = id; row.id = id;
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
      const tasks = await syntheticTaskSequence({ ...f.flowConfig, clock, memo: memoConfig, fetchPort: port,
        verificationBudget: new PostgresPatientVerificationBudget(db, f.f.scope), representativeInput: representativeInputOptions(f) }, f.f.folder);
      await tasks.replace({ patientSelection: "independentlyVerifiedPatients" });
      call = await clinikoWorkflowVoiceFixture(db, tasks.config, flow => {
        const ordinary = createOpenAIClinicalIntentResolver({ apiKey: "synthetic", model: "synthetic", owner: flow, clinicDate: () => "2026-10-04",
          fetch: async () => { throw Error("Private patient fields cannot reach the model"); } });
        return async (turn, signal) => turn.text === "Times" ? ok({ kind: "bookingMenu", from: "2026-10-08", to: "2026-10-08" })
          : turn.text === "First option" ? ok({ kind: "bookingChoice", choice: 1 }) : turn.text === "Yes" ? ok({ kind: "affirm" })
          : turn.text === "Did it finish" ? ok({ kind: "outcome" }) : turn.text === "Are you still there?" ? ok({ kind: "presence" }) : ordinary(turn, signal);
      }, { clinicalHost: true, maximumWrites: 2, ...(mode === "firstClinicalUncertain" ? { lostWrite: true } : {}) });
      const serving = call;
      const verify = async (index: 0 | 1) => {
        await serving.turn(index === 0 ? "Book an appointment for my partner" : "Book an appointment for my child");
        assert.ok(serving.flow.representativeInputOwner); assert.equal(fixture.mail.length, index * 2);
        await serving.mark(); await serving.privateDigit("1"); await serving.mark(); await fixture.waitForMail(index * 2 + 1);
        for (const digit of `${fixture.mail.at(-1)!.code}#`) serving.sendEvent({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
        await voiceUntil(() => serving.spoken.at(-1) === "Please say the patient's first name.", "fresh private selected patient"); await serving.mark();
        const patient = fixture.r.patients.get(subjects[index])!;
        for (const field of [patient.first_name, patient.last_name, index === 0 ? "5 March 1982" : "28 February 2014"]) {
          await serving.privateField(field); await serving.mark();
        }
        await serving.privateDigit("1"); await serving.mark(); await fixture.waitForMail(index * 2 + 2);
        assert.equal(fixture.mail.at(-1)!.email, patient.email); await serving.verify(fixture.mail.at(-1)!.code);
      };
      const book = async (index: 0 | 1) => {
        await serving.turn("Times"); await serving.mark(); await serving.turn("First option");
        assert.equal(serving.writes.length, index);
        assert.equal(Object.values((await serving.state()).actions).at(-1)!.status, "awaitingConfirmation");
        await serving.mark(); await serving.turn("Yes");
        assert.equal(serving.writes.length, index + 1); assert.equal(serving.writeRequests[index]!.body.patient_id, subjects[index]);
        return Object.values((await serving.state()).actions).at(-1)!;
      };
      const nativeMarker = (index: number) => {
        const marker = /^Abby booking ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(String(serving.writeRequests[index]!.body.notes))?.[1];
        assert.ok(marker); return marker;
      };
      await verify(0); const firstOwner = serving.flow.representativeInputOwner;
      const first = await book(0), firstSnapshot = structuredClone(first), firstSource = nativeMarker(0);
      if (mode === "firstClinicalUncertain") {
        assert.ok(["uncertain", "needsReview"].includes(first.status));
        assert.equal(retention.posts.length, 0); assert.equal(retention.outcomes.length, 0);
        assert.equal(await serving.flow.representativeStartupAvailable("book"), false);
        await serving.mark(); await serving.turn("Book an appointment for my child");
        assert.equal(serving.flow.representativeInputOwner, firstOwner); assert.equal(fixture.mail.length, 2);
        assert.equal(serving.writes.length, 1); assert.deepEqual((await serving.state()).actions[first.key], firstSnapshot);
      } else if (mode === "pendingPrior") {
        assert.equal(first.status, "committed"); await voiceUntil(() => entered, "first pending memo native dispatch", 5000); assert.equal(retention.rows.length, 0);
        await serving.mark(); await serving.turn("Book an appointment for my child");
        assert.notEqual(serving.flow.representativeInputOwner, firstOwner); assert.equal(firstOwner?.closed, true);
        release(); await voiceUntil(() => retention.outcomes.length === 1, "original pending memo completion");
        assert.equal(retention.outcomes[0]!.kind, "accepted"); assert.equal(serving.writes.length, 1); assert.equal(fixture.mail.length, 2);
        assert.deepEqual((await serving.state()).actions[first.key], firstSnapshot);
      } else {
        assert.equal(first.status, "committed"); assert.equal(serving.spoken.at(-1), "Your booking is confirmed.");
        await voiceUntil(() => retention.outcomes.length === 1, "first independent memo completion"); await serving.mark();
        const quiet = async (ms: number) => { const until = performance.now() + ms;
          while (performance.now() < until) { serving.media(false); await new Promise<void>(resolve => setTimeout(resolve, 20)); } };
        await serving.turn("Please hold."); await serving.mark(); await quiet(28000);
        await serving.turn("Please wait while I check my diary."); await serving.mark(); await quiet(28000);
        await serving.turn("Are you still there?"); await serving.mark(); await quiet(5000);
        await verify(1); assert.notEqual(serving.flow.representativeInputOwner, firstOwner); assert.equal(firstOwner?.closed, true);
        assert.notEqual(fixture.mail[1]!.email, fixture.mail[3]!.email);
        const second = await book(1); assert.equal(second.status, "committed");
        assert.equal(serving.spoken.at(-1), "Your booking is confirmed.");
        await voiceUntil(() => retention.outcomes.length === 2, "second independent memo completion");
        assert.deepEqual((await serving.state()).actions[first.key], firstSnapshot);
        assert.notEqual(firstSource, nativeMarker(1));
        assert.deepEqual(retention.outcomes.map(row => row.kind), mode === "firstDenied" ? ["unavailable", "accepted"]
          : mode === "secondDenied" ? ["accepted", "unavailable"] : mode === "lostStored" ? ["uncertain", "uncertain"] : ["accepted", "accepted"]);
      }
      const expected = mode === "firstClinicalUncertain" ? [] : mode === "firstDenied" ? [subjects[1]]
        : mode === "secondDenied" || mode === "pendingPrior" ? [subjects[0]] : [...subjects];
      const retained = retention.posts.map(row => resultValue(decodeAdministrativeMemo(row.content)));
      assert.deepEqual(retained.map(row => row.patientId), expected); assert.equal(retention.rows.length, expected.length);
      assert.equal(new Set(retention.rows.map(row => row.id)).size, expected.length);
      const binding = administrativeMemoRecordBinding(retention.config.native, retention.authentication)!;
      const purposes = await sql<{ total: number }>`select count(*)::int as total from outbound_effect_barriers where owner_binding = ${binding}`.execute(db);
      assert.equal(purposes.rows[0]!.total, expected.length);
      for (const row of retained) {
        assert.equal(row.direction, "inbound"); assert.equal(row.outcome.kind, "bookingConfirmed");
        assert.equal(row.sourceActionRef, row.patientId === subjects[0] ? firstSource : nativeMarker(1));
        assert.deepEqual(resultValue(await new PostgresOutboundEffectBarrier(db, f.f.scope, binding).claimOnce(row.actionRef)), { claimed: false });
      }
      const verification = await sql<{ kind: string; attempts: number }>`select kind, attempts from patient_verification_budgets where tenant_id = ${f.f.scope.tenantId}`.execute(db);
      for (const kind of ["issue", "answer"] as const) assert.ok(verification.rows.filter(row => row.kind === kind).reduce((n, row) => n + row.attempts, 0) >= (cohort === "sequential" ? 4 : 2));
      const state = await serving.state(), actions = Object.values(state.actions);
      const proofs = actions.map(action => { assert.equal(action.mutation.request.kind, "book");
        if (action.mutation.request.kind !== "book") throw Error("Expected native booking proof"); return action.mutation.request.patient.verificationRef; });
      const privateValues = [...verificationCanaries, ...subjects, ...proofs, f.flowConfig.cliniko.apiKey,
        Buffer.from(`${f.flowConfig.cliniko.apiKey}:`).toString("base64"), ...serving.privateTranscripts,
        ...[...f.r.patients.values()].flatMap(row => [row.first_name, row.last_name, row.date_of_birth, row.email, ...row.patient_phone_numbers.map(phone => phone.number)]),
        ...f.mail.flatMap(row => [row.email, row.code]), ...serving.writeRequests.flatMap((row, i) => [String(row.body.notes), nativeMarker(i)]),
        ...f.f.recalls.flatMap(row => [String(row.notes), resultValue(decodeClinikoReview(row.notes)).marker]),
        ...retention.posts.flatMap(row => [String(row.content), JSON.stringify(row), resultValue(decodeAdministrativeMemo(row.content)).authentication]),
        retention.key.toString("hex"), retention.key.toString("base64")];
      const publicData = JSON.stringify([serving.modelTurns, serving.transcripts, commandProgress(state, "multiple-patient-memo"), await serving.flow.publicIntentContext()]);
      for (const [index, value] of privateValues.entries()) assert.equal(publicData.includes(value), false, `private canary index ${index}`);
      await serving.close();
      for (const message of f.mail) await assertSqlVerificationCodeCanary(db, message.code, canaryWindow);
      const canaries = [...privateValues, serving.callId, state.sessionLease!.sessionId].filter(value => value.length >= 4);
      const probes = canaries.flatMap((value, i) => Array.from({ length: Math.ceil(value.length / 256) }, (_, n) => ({ label: `multi_memo_${i}_${n}`,
        value: value.slice(n * 256, (n + 1) * 256).length < 4 ? value.slice(-4) : value.slice(n * 256, (n + 1) * 256) })));
      for (let i = 0; i < probes.length; i += 12) assert.deepEqual(await scanPatientDataCanaries(db, probes.slice(i, i + 12)), { ok: true, value: [] });
      const dump = execFileSync("pg_dump", [target.toString(), "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
      const copy = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
      for (const raw of canaries) { const json = JSON.stringify(raw).slice(1, -1); for (const value of [raw, copy(raw), json, copy(json)]) assert.equal(dump.includes(value), false); }
      assert.equal(dump.includes(retainedRef), true); assert.equal((await db.selectFrom("patient_phone_index").selectAll().execute()).length, 1);
      assert.equal((await scans.verifyPage(staged, begun.scanRef, { page: 1, totalEntries: 1, patientIds: ["101"], links })).ok, true);
    } finally {
      release(); try { await call?.close(); } finally { memo?.close(); try { await f?.close(); } finally {
        await db?.destroy(); try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); } finally { await admin.destroy(); }
      } }
    }
  });
}
