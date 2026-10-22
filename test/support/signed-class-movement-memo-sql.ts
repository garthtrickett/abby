import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { captureScopedSqlVerificationCanaryWindow, assertSqlVerificationCodeCanary } from "./sql-verification-canary.ts";
import { verificationNow, verificationCanaries } from "./caller-verification.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const adminUrl = process.env.DATABASE_URL;
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { classMoveCallFlowFixture } = await import(new URL("test/support/class-move-call-flow.js", emitted).href) as typeof import("./class-move-call-flow.ts");
const { subjectMemoFixture } = await import(new URL("test/support/subject-memo.js", emitted).href) as typeof import("./subject-memo.ts");
const { clinikoWorkflowVoiceFixture, voiceUntil } = await import(new URL("test/support/cliniko-workflow-voice.js", emitted).href) as typeof import("./cliniko-workflow-voice.ts");
const { createOpenAIClinicalIntentResolver } = await import(new URL("src/standalone/openai-clinical-intent.js", emitted).href) as typeof import("../../src/standalone/openai-clinical-intent.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { PostgresPatientVerificationBudget } = await import(new URL("src/storage/postgres-patient-verification-budget.js", emitted).href) as typeof import("../../src/storage/postgres-patient-verification-budget.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { PostgresPatientPhoneIndex } = await import(new URL("src/storage/postgres-patient-phone-index.js", emitted).href) as typeof import("../../src/storage/postgres-patient-phone-index.ts");
const { PostgresPatientPhoneScan } = await import(new URL("src/storage/postgres-patient-phone-scan.js", emitted).href) as typeof import("../../src/storage/postgres-patient-phone-scan.ts");
const { decodeAdministrativeMemo, administrativeMemoActionRef } = await import(new URL("src/cliniko/administrative-memo.js", emitted).href) as typeof import("../../src/cliniko/administrative-memo.ts");
const { decodeClinikoReview } = await import(new URL("src/cliniko/review-request.js", emitted).href) as typeof import("../../src/cliniko/review-request.ts");
const { administrativeMemoRecordBinding } = await import(new URL("src/cliniko/administrative-memo-records.js", emitted).href) as typeof import("../../src/cliniko/administrative-memo-records.ts");
const { commandProgress } = await import(new URL("src/reference/command-progress.js", emitted).href) as typeof import("../../src/reference/command-progress.ts");
const { ok } = await import(new URL("src/core/model.js", emitted).href) as typeof import("../../src/core/model.ts");

type MovementReport = Extract<import("../../src/cliniko/administrative-memo.ts").AdministrativeMemoOutcome, { kind: "classMovementReported" }>;
type MovementExpectation = Readonly<{
  status: import("../../src/core/model.ts").ActionStatus; writes: readonly string[]; memoRows: 0 | 1;
  memoOutcome?: import("../../src/standalone/administrative-memo-retention.ts").MemoRetentionOutcome["kind"];
  report?: Pick<MovementReport, "completion" | "replacementAttendeeRef"> & Pick<MovementReport["progress"], "original" | "replacement">;
}>;
const originalCancellation = ["POST /v1/attendees", "PATCH /v1/attendees/101/cancel"] as const;
const replacementCancellation = ["POST /v1/attendees", "PATCH /v1/attendees/401/cancel"] as const;
const moved: MovementExpectation = { status: "committed", writes: originalCancellation, memoRows: 1, memoOutcome: "accepted",
  report: { completion: "moved", original: "inspectedCancelled", replacement: "inspectedActive", replacementAttendeeRef: "cliniko:attendee:401" } };
const expectations = {
  moved,
  wrongSubjectGrant: { ...moved, memoRows: 0, memoOutcome: "unavailable" },
  withdrawn: { ...moved, memoRows: 0, memoOutcome: "unavailable" },
  lostStored: { ...moved, memoOutcome: "uncertain" },
  lostOriginal: { status: "uncertain", writes: originalCancellation, memoRows: 1, memoOutcome: "accepted",
    report: { completion: "needsReview", original: "uncertain", replacement: "inspectedActive", replacementAttendeeRef: "cliniko:attendee:401" } },
  lostReplacement: { status: "uncertain", writes: ["POST /v1/attendees"], memoRows: 1, memoOutcome: "accepted",
    report: { completion: "needsReview", original: "notSent", replacement: "uncertain" } },
  restored: { status: "rejected", writes: replacementCancellation, memoRows: 1, memoOutcome: "accepted",
    report: { completion: "restored", original: "notSent", replacement: "inspectedCancelled", replacementAttendeeRef: "cliniko:attendee:401" } },
  lostCompensation: { status: "uncertain", writes: replacementCancellation, memoRows: 1, memoOutcome: "accepted",
    report: { completion: "needsReview", original: "notSent", replacement: "uncertain", replacementAttendeeRef: "cliniko:attendee:401" } },
  lostReview: { status: "uncertain", writes: [], memoRows: 0 }
} as const satisfies Record<string, MovementExpectation>;

/** One patient and an actual two-leg workflow, never an inferred atomic move. */
export function runSignedClassMovementMemoCases(): void {
for (const mode of Object.keys(expectations) as (keyof typeof expectations)[])
test(`actual emitted signed ordinary class movement keeps its original report and native180/privacy: ${mode}`, { timeout: 180000 }, async () => {
  const expected: MovementExpectation = expectations[mode];
  const admin = connectPostgres(adminUrl), databaseName = `abby_signed_class_move_memo_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${databaseName}`;
  let created = false, db: ReturnType<typeof connectPostgres> | undefined;
  let canaryScope: Awaited<ReturnType<typeof captureScopedSqlVerificationCanaryWindow>> | undefined;
  let f: Awaited<ReturnType<typeof classMoveCallFlowFixture>> | undefined;
  let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined, memo: ReturnType<typeof subjectMemoFixture> | undefined;
  try {
    await sql.raw(`create database "${databaseName}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); await migrate(db);
    canaryScope = await captureScopedSqlVerificationCanaryWindow(db);
    const unrelated = { tenantId: `unrelated-${randomUUID()}`, clinicId: "index", locationId: "main" }, fingerprint = "e".repeat(64);
    const links = [{ normalizedPhone: "+61400111222", patientId: "101" }];
    assert.ok((await new PostgresPatientPhoneIndex(db).publish(unrelated, links, "61", fingerprint)).ok);
    const scans = new PostgresPatientPhoneScan(db), staged = { ...unrelated, clinicId: "staged" }, begun = resultValue(await scans.begin(staged, "61", fingerprint));
    assert.ok((await scans.append(staged, begun.scanRef, { page: 1, totalEntries: 1, patientIds: ["101"], links })).ok);
    const retainedRef = randomUUID(); assert.ok((await new PostgresOutboundEffectBarrier(db, unrelated, fingerprint).claimOnce(retainedRef)).ok);
    const scope = { tenantId: `signed-class-move-memo-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
    const budget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-class-au5", maxPerMinute: 180 });
    const began = performance.now();
    const clock = () => { const now = new Date(Date.parse(verificationNow) + performance.now() - began).toISOString(); f?.setTime(now); return now; };
    f = await classMoveCallFlowFixture(false, false, undefined, false, true, { scope, budget,
      verificationBudget: new PostgresPatientVerificationBudget(db, scope), memoFor: native => {
        memo = subjectMemoFixture({ ...native, authorRef: "clinic-approved-admin-memo", policy: { version: "admin-actions-v1", digest: "a".repeat(64) },
          clock: () => call?.currentTime() ?? clock(), deadlineMs: 5000 }, verificationCanaries[2]!, {
          ...(mode === "wrongSubjectGrant" ? { approvedPatientId: "583746192837465" } : {}),
          ...(mode === "lostStored" ? { lostStored: true } : {}), barrierFor: (bound, binding) => new PostgresOutboundEffectBarrier(db!, bound, binding) });
        return memo.config;
      } });
    f.flow.dispose(); assert.ok(memo); const retention = memo, fixture = f, publicIntentInputs: unknown[] = [];
    if (mode === "lostOriginal") f.lose("original"); if (mode === "lostReplacement") f.lose("replacement");
    if (mode === "lostReview") f.lose("review"); if (mode === "lostCompensation") f.lose("compensation");
    if (mode === "restored" || mode === "lostCompensation") f.phasePermission(phase => phase !== "cancelOriginal");
    call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, clock }, flow => {
      const ordinary = createOpenAIClinicalIntentResolver({ apiKey: "synthetic", model: "synthetic", owner: flow, clinicDate: () => "2026-10-04",
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body)), context = JSON.parse(body.input[1].content); publicIntentInputs.push(context);
          assert.equal(body.store, false); assert.equal(body.text.format.strict, true); assert.equal(context.classService.moveAvailable, true);
          const decision = { kind: "menu", operation: null, stage: "targets", from: "2026-10-08" as string | null, to: "2026-10-08" as string | null, choice: null as number | null };
          if (context.callerText === "Show my class bookings on October 8.") { /* Initial exact target date. */ }
          else if (context.callerText === "Show replacement classes on October 9.") Object.assign(decision, { stage: "offers", from: "2026-10-09", to: "2026-10-09" });
          else if (context.callerText === "The first time please.") Object.assign(decision, { kind: "choice", stage: context.reschedulingTargetSelected ? "offers" : "targets", from: null, to: null, choice: 1 });
          else assert.fail("Unexpected public class movement classifier request");
          return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
        } });
      return async (turn, signal) => turn.text === "Did it finish" ? ok({ kind: "outcome" }) : ordinary(turn, signal);
    }, { clinicalHost: true, classMove: true, maximumWrites: 2 });
    const serving = call; f.bindNativeCall(() => serving.state());
    await serving.turn("Move my Pilates class"); assert.match(serving.spoken.at(-1)!, /six-digit code.*keypad/); await serving.mark();
    await voiceUntil(() => fixture.mail.length === 1, "registered-channel class move proof");
    const frames = serving.transcriptionFrames; await serving.verify(f.mail[0]!.code); assert.equal(serving.transcriptionFrames, frames);
    await serving.turn("Show my class bookings on October 8."); assert.match(serving.spoken.at(-1)!, /Which appointment/); await serving.mark();
    await serving.turn("The first time please."); assert.match(serving.spoken.at(-1)!, /selected your appointment/); await serving.mark();
    await serving.turn("Show replacement classes on October 9."); assert.match(serving.spoken.at(-1)!, /Option one|option one/i); await serving.mark();
    await serving.turn("The first time please.");
    let state = await serving.state(); const action = Object.values(state.actions).at(-1)!;
    assert.equal(action.status, "awaitingConfirmation"); assert.deepEqual([f.recalls.length, f.writes.length, retention.posts.length], [0, 0, 0]);
    assert.match(serving.spoken.at(-1)!, /book the replacement before cancelling the original/);
    if (action.mutation.request.kind !== "reschedule") throw Error("Expected class rescheduling action");
    const proof = action.mutation.request.patient.verificationRef;
    await serving.mark(); if (mode === "withdrawn") retention.control.permitted = false;
    await serving.turn("Yes"); state = await serving.state();
    assert.equal(state.actions[action.key]!.status, expected.status,
      JSON.stringify({ phase: "signed-class-move-result", mode, status: state.actions[action.key]!.status, claims: f.claims, writes: serving.writes.length }));
    const expectedWrites = expected.writes.length;
    assert.equal(f.writes.length, expectedWrites); assert.deepEqual(serving.writes, expected.writes); assert.equal(f.recalls.length, 1);
    const review = resultValue(decodeClinikoReview(f.recalls[0]!.notes)); assert.equal(review.request.operation.kind, "classMove");
    if (review.request.operation.kind !== "classMove") throw Error("Expected original movement review");
    const originalAction = review.request.operation.attendanceActionId;
    assert.equal(review.request.operation.attendeeId, "101"); assert.equal(review.request.operation.sessionId, "91");
    assert.equal(review.request.operation.newSessionId, "94");
    if (expected.memoOutcome) await voiceUntil(() => retention.outcomes.length === 1, "independent move report retention");
    assert.equal(retention.posts.length, expected.memoRows); assert.equal(retention.rows.length, expected.memoRows);
    assert.equal(retention.outcomes.length, expected.memoOutcome ? 1 : 0);
    if (expected.memoOutcome) assert.equal(retention.outcomes[0]!.kind, expected.memoOutcome);
    const binding = administrativeMemoRecordBinding(retention.config.native, retention.authentication)!;
    const purposes = await sql<{ total: number }>`select count(*)::int as total from outbound_effect_barriers where owner_binding = ${binding}`.execute(db);
    assert.equal(purposes.rows[0]!.total, expected.memoRows);
    if (expected.memoRows) {
      assert.ok(expected.report);
      const decoded = resultValue(decodeAdministrativeMemo(retention.posts[0]!.content));
      assert.equal(decoded.patientId, verificationCanaries[2]); assert.equal(decoded.direction, "inbound"); assert.equal(decoded.sourceActionRef, originalAction);
      assert.equal(decoded.actionRef, administrativeMemoActionRef(originalAction)); assert.equal(decoded.outcome.kind, "classMovementReported");
      if (decoded.outcome.kind !== "classMovementReported") throw Error("Expected native workflow report");
      const outcome = decoded.outcome;
      assert.equal(outcome.appointmentRef, "cliniko:booking:94"); assert.equal(outcome.original.appointmentRef, "cliniko:booking:91");
      assert.equal(outcome.original.attendeeRef, "cliniko:attendee:101"); assert.equal(outcome.verification.basis, "nativeWorkflowReportBestEffort");
      assert.equal(outcome.verification.reportedAt, decoded.occurredAt); assert.equal(outcome.progress.caseAssociation, "notApplicable");
      assert.equal(outcome.completion, expected.report.completion);
      assert.equal(outcome.progress.original, expected.report.original); assert.equal(outcome.progress.replacement, expected.report.replacement);
      assert.equal(outcome.replacementAttendeeRef, expected.report.replacementAttendeeRef);
      assert.deepEqual(resultValue(await new PostgresOutboundEffectBarrier(db, scope, binding).claimOnce(decoded.actionRef)), { claimed: false });
    }
    const requests = await db.selectFrom("cliniko_request_budgets").selectAll().execute();
    assert.equal(requests.length, 1); assert.equal(requests[0]!.max_per_minute, 180);
    assert.ok(Array.isArray(requests[0]!.sent_at_ms) && requests[0]!.sent_at_ms.length > 0 && requests[0]!.sent_at_ms.length <= 180);
    const verification = await sql<{ kind: string; attempts: number }>`select kind, attempts from patient_verification_budgets where tenant_id = ${scope.tenantId}`.execute(db);
    for (const kind of ["issue", "answer"]) assert.ok(verification.rows.some(row => row.kind === kind && row.attempts >= 1));
    await serving.mark(); await serving.turn("Did it finish"); assert.equal(serving.writes.length, expectedWrites); assert.equal(retention.posts.length, expected.memoRows);
    state = await serving.state();
    const privateValues = [...verificationCanaries, f.flowConfig.cliniko.apiKey, Buffer.from(`${f.flowConfig.cliniko.apiKey}:`).toString("base64"),
      f.mail[0]!.email, f.mail[0]!.code, proof, originalAction, review.marker,
      "private-class-shared-note", "private-attendee-note", "private-other-name",
      ...f.recalls.map(row => String(row.notes)), ...retention.posts.flatMap(row => [String(row.content), JSON.stringify(row), resultValue(decodeAdministrativeMemo(row.content)).authentication]),
      retention.key.toString("hex"), retention.key.toString("base64")];
    const publicData = JSON.stringify([publicIntentInputs, serving.modelTurns, serving.transcripts, commandProgress(state, "signed-class-move-memo"), await serving.flow.publicIntentContext()]);
    for (const [index, value] of privateValues.entries()) assert.equal(publicData.includes(value), false, `private move canary index ${index}`);
    await serving.close(); await assertSqlVerificationCodeCanary(db, f.mail[0]!.code, canaryScope.window);
    const canaries = [...privateValues, serving.callId, state.sessionLease!.sessionId].filter(value => value.length >= 4);
    const probes = canaries.flatMap((value, i) => Array.from({ length: Math.ceil(value.length / 256) }, (_, n) => ({ label: `signed_move_memo_${i}_${n}`,
      value: value.slice(n * 256, (n + 1) * 256).length < 4 ? value.slice(-4) : value.slice(n * 256, (n + 1) * 256) })));
    for (let i = 0; i < probes.length; i += 12) assert.deepEqual(await scanPatientDataCanaries(db, probes.slice(i, i + 12)), { ok: true, value: [] });
    const dump = execFileSync("pg_dump", [target.toString(), "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
    const copy = (s: string) => s.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
    for (const raw of canaries) { const json = JSON.stringify(raw).slice(1, -1); for (const value of [raw, copy(raw), json, copy(json)]) assert.equal(dump.includes(value), false); }
    assert.equal(dump.includes(retainedRef), true); assert.equal((await db.selectFrom("patient_phone_index").selectAll().execute()).length, 1);
    assert.equal((await scans.verifyPage(staged, begun.scanRef, { page: 1, totalEntries: 1, patientIds: ["101"], links })).ok, true);
  } finally {
    try { await call?.close(); } finally { memo?.close(); try { await f?.close(); } finally {
      try { canaryScope?.close(); } finally {
        await db?.destroy(); try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); } finally { await admin.destroy(); }
      }
    } }
  }
});
}
