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

type Scenario = Readonly<{ label: string; pass: "none" | "same" | "transfer"; result: "moved" | "disposed" | "lostAssociation"; memo: "accepted" | "lostStored" | "wrongSubject" }>;
const scenarios: readonly Scenario[] = [
  { label: "ordinary moved", pass: "none", result: "moved", memo: "accepted" },
  { label: "ordinary disposed pause", pass: "none", result: "disposed", memo: "accepted" },
  { label: "same-case pass moved", pass: "same", result: "moved", memo: "accepted" },
  { label: "same-case pass disposed pause", pass: "same", result: "disposed", memo: "accepted" },
  { label: "same-case pass association response lost", pass: "same", result: "lostAssociation", memo: "accepted" },
  { label: "same-case pass memo acknowledgement lost", pass: "same", result: "moved", memo: "lostStored" },
  { label: "same-case pass independent subject denied", pass: "same", result: "moved", memo: "wrongSubject" },
  { label: "cross-case pass moved", pass: "transfer", result: "moved", memo: "accepted" },
  { label: "cross-case pass disposed pause", pass: "transfer", result: "disposed", memo: "accepted" },
  { label: "cross-case pass association response lost", pass: "transfer", result: "lostAssociation", memo: "accepted" },
];

/** Each stage uses actual signed HTTP/WS serving, independent memo grants,
 * real elapsed native180 quota windows and played renewed consent. */
export function runSignedStagedClassMovementMemoCases(): void {
for (const scenario of scenarios) test(`actual emitted signed staged class movement retains only its owned report: ${scenario.label}`, {
  timeout: scenario.pass !== "none" ? 360000 : 180000,
}, async () => {
  const hasPass = scenario.pass !== "none";
  const admin = connectPostgres(adminUrl), databaseName = `abby_signed_staged_memo_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${databaseName}`;
  let created = false, db: ReturnType<typeof connectPostgres> | undefined;
  let canaryScope: Awaited<ReturnType<typeof captureScopedSqlVerificationCanaryWindow>> | undefined;
  let f: Awaited<ReturnType<typeof classMoveCallFlowFixture>> | undefined;
  let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined, memo: ReturnType<typeof subjectMemoFixture> | undefined;
  try {
    await sql.raw(`create database "${databaseName}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); await migrate(db);
    canaryScope = await captureScopedSqlVerificationCanaryWindow(db);
    const unrelatedScope = { tenantId: `unrelated-${randomUUID()}`, clinicId: "clinic", locationId: "other" }, unrelatedRef = randomUUID();
    assert.ok((await new PostgresOutboundEffectBarrier(db, unrelatedScope, "e".repeat(64)).claimOnce(unrelatedRef)).ok);
    const links = [{ normalizedPhone: "+61400111222", patientId: "101" }], fingerprint = "e".repeat(64);
    assert.ok((await new PostgresPatientPhoneIndex(db).publish(unrelatedScope, links, "61", fingerprint)).ok);
    const scans = new PostgresPatientPhoneScan(db), staged = { ...unrelatedScope, clinicId: "staged" };
    const begun = resultValue(await scans.begin(staged, "61", fingerprint));
    assert.ok((await scans.append(staged, begun.scanRef, { page: 1, totalEntries: 1, patientIds: ["101"], links })).ok);
    const scope = { tenantId: `signed-staged-memo-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
    const budget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-class-au5", maxPerMinute: 180 });
    const began = performance.now();
    const clock = () => { const now = new Date(Date.parse(verificationNow) + performance.now() - began).toISOString(); f?.setTime(now); return now; };
    f = await classMoveCallFlowFixture(false, false, hasPass ? { full: true, ...(scenario.pass === "transfer" ? { differentCase: true } : {}) } : undefined, true, true, { scope, budget,
      verificationBudget: new PostgresPatientVerificationBudget(db, scope), memoFor: native => {
        memo = subjectMemoFixture({ ...native, authorRef: "clinic-approved-admin-memo", policy: { version: "admin-actions-v1", digest: "a".repeat(64) },
          clock: () => call?.currentTime() ?? clock(), deadlineMs: 5000 }, verificationCanaries[2]!, {
          ...(scenario.memo === "wrongSubject" ? { approvedPatientId: "583746192837465" } : {}),
          ...(scenario.memo === "lostStored" ? { lostStored: true } : {}),
          barrierFor: (bound, binding) => new PostgresOutboundEffectBarrier(db!, bound, binding) });
        return memo.config;
      } });
    f.flow.dispose(); assert.ok(memo); const retention = memo, fixture = f, publicInputs: unknown[] = [];
    const passState = () => {
      const pass = fixture.movePass; assert.ok(pass);
      const used = (id: string) => pass.caseRows(id).filter(row => row.archived_at === null && row.deleted_at === null &&
        (row.cancelled_at !== null ? pass.records[id]!.include_cancelled_attendees : row.arrived === false ? pass.records[id]!.include_dna_attendees : true)).length;
      return { sourceUsed: used(pass.sourceCaseId), destinationUsed: used(pass.destinationCaseId),
        caseLinked: pass.caseRows(pass.destinationCaseId).some(row => row.id === "401") };
    };
    if (hasPass) assert.deepEqual(passState(), { sourceUsed: 2, destinationUsed: scenario.pass === "transfer" ? 1 : 2, caseLinked: false });
    if (scenario.result === "lostAssociation") f.lose("association");
    call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, clock }, flow => {
      const ordinary = createOpenAIClinicalIntentResolver({ apiKey: "synthetic", model: "synthetic", owner: flow, clinicDate: () => "2026-10-04",
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body)), context = JSON.parse(body.input[1].content); publicInputs.push(context);
          assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
          const decision = { kind: "menu", operation: null, stage: "targets", from: "2026-10-08" as string | null, to: "2026-10-08" as string | null, choice: null as number | null };
          if (context.callerText === "Show my class bookings on October 8.") { /* Exact original date. */ }
          else if (context.callerText === "Show replacement classes on October 9.") Object.assign(decision, { stage: "offers", from: "2026-10-09", to: "2026-10-09" });
          else if (context.callerText === "The first time please.") Object.assign(decision, { kind: "choice", stage: context.reschedulingTargetSelected ? "offers" : "targets", from: null, to: null, choice: 1 });
          else assert.fail("Unexpected public staged class movement classifier request");
          return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
        } });
      return async (turn, signal) => turn.text === "Did it finish" ? ok({ kind: "outcome" }) : ordinary(turn, signal);
    }, { clinicalHost: true, classMove: true, maximumWrites: hasPass ? 3 : 2 });
    const serving = call; f.bindNativeCall(() => serving.state());
    const wait = async (seconds: number) => {
      assert.ok(Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 60);
      const before = fixture.writes.length, memos = retention.posts.length;
      const quiet = setInterval(() => serving.media(false), 20);
      try { await new Promise<void>(resolve => setTimeout(resolve, seconds * 1000 + 500)); }
      finally { clearInterval(quiet); }
      assert.equal(fixture.writes.length, before); assert.equal(retention.posts.length, memos);
    };
    const choose = async () => {
      await serving.turn("The first time please.");
      const notice = /wait about (\d+) seconds, then choose your option again/.exec(serving.spoken.at(-1)!);
      if (notice) { assert.equal(fixture.writes.length, 0); await serving.mark(); await wait(Number(notice[1])); await serving.turn("The first time please."); }
    };
    const prepareStage = async (stage: "replacement" | "original" | "association" | "associationInspection") => {
      const writes = fixture.writes.length, mailCount = fixture.mail.length;
      await serving.turn("Continue my class move");
      for (let attempt = 0; attempt < 4; attempt++) {
        const notice = /wait about (\d+) seconds, then ask to continue/.exec(serving.spoken.at(-1)!);
        if (notice) { await serving.mark(); await wait(Number(notice[1])); await serving.turn("Continue my class move"); continue; }
        if (/registered email again/.test(serving.spoken.at(-1)!)) {
          await serving.mark(); await voiceUntil(() => fixture.mail.length > mailCount, "renewed private staged memo proof");
          await serving.verify(fixture.mail.at(-1)!.code); await serving.turn("Continue my class move"); continue;
        }
        break;
      }
      assert.equal(fixture.writes.length, writes); assert.equal(retention.posts.length, 0);
      const wording = { replacement: /separate confirmation to create the replacement/, original: /separate confirmation to cancel the original/,
        association: /separate confirmation to associate the replacement/, associationInspection: /separate confirmation to inspect whether/ };
      assert.match(serving.spoken.at(-1)!, wording[stage]);
      await serving.mark(); await serving.turn("Yes");
    };
    await serving.turn("Move my Pilates class"); await serving.mark();
    await voiceUntil(() => fixture.mail.length === 1, "registered-channel staged memo proof");
    const frames = serving.transcriptionFrames; await serving.verify(fixture.mail[0]!.code); assert.equal(serving.transcriptionFrames, frames);
    await serving.turn("Show my class bookings on October 8."); await serving.mark(); await choose(); await serving.mark();
    await serving.turn("Show replacement classes on October 9."); await serving.mark(); await choose();
    const action = Object.values((await serving.state()).actions).at(-1)!; assert.equal(action.status, "awaitingConfirmation");
    assert.deepEqual([fixture.writes.length, fixture.recalls.length, retention.posts.length], [0, 0, 0]);
    await serving.mark(); await serving.turn("Yes");
    const affirmativeWait = /wait about (\d+) seconds/.exec(serving.spoken.at(-1)!);
    if (affirmativeWait) { assert.equal(fixture.writes.length, 0); await serving.mark(); await wait(Number(affirmativeWait[1])); await serving.turn("Yes"); }
    if (!fixture.writes.length) { await serving.mark(); await prepareStage("replacement"); }
    assert.equal(fixture.writes.length, 1); assert.equal(retention.posts.length, 0);
    assert.equal((await serving.state()).actions[action.key]!.status, "pendingContinuation"); await serving.mark();
    if (scenario.result === "disposed") await serving.close();
    else {
      for (const stage of hasPass ? ["original", "association", "associationInspection"] as const : ["original"] as const) {
        await prepareStage(stage);
        if (scenario.result === "lostAssociation" && stage === "association") { await serving.mark(); break; }
        if (stage !== (hasPass ? "associationInspection" : "original")) assert.equal(retention.posts.length, 0);
        await serving.mark();
      }
    }
    const state = await serving.state();
    assert.equal(state.actions[action.key]!.status, scenario.result === "moved" ? "committed" : "needsReview");
    await voiceUntil(() => retention.outcomes.length === 1, "independent final or disposed movement report");
    const count = scenario.memo === "wrongSubject" ? 0 : 1;
    assert.equal(retention.posts.length, count); assert.equal(retention.rows.length, count);
    assert.equal(retention.outcomes[0]!.kind, scenario.memo === "wrongSubject" ? "unavailable" : scenario.memo === "lostStored" ? "uncertain" : "accepted");
    const review = resultValue(decodeClinikoReview(fixture.recalls[0]!.notes)); assert.equal(review.request.operation.kind, "classMove");
    if (review.request.operation.kind !== "classMove") throw Error("Expected original native movement review");
    assert.equal(review.request.operation.attendeeId, "101"); assert.equal(review.request.operation.sessionId, "91");
    assert.equal(review.request.operation.newSessionId, "94");
    const originalAction = review.request.operation.attendanceActionId;
    const expectedWrites = scenario.result === "disposed" ? ["POST /v1/attendees"] : ["POST /v1/attendees", "PATCH /v1/attendees/101/cancel", ...(hasPass ? ["PATCH /v1/attendees/401"] : [])];
    assert.deepEqual(serving.writes, expectedWrites); assert.equal(fixture.writes.length, expectedWrites.length); assert.equal(fixture.recalls.length, 1);
    if (hasPass) assert.deepEqual(passState(), {
      sourceUsed: scenario.pass === "transfer" && scenario.result !== "disposed" ? 1 : 2,
      destinationUsed: scenario.pass === "transfer" && scenario.result === "disposed" ? 1 : 2,
      caseLinked: scenario.result !== "disposed",
    }, "native counter truth stays separate from a lost association acknowledgement and the retained workflow report");
    if (count) {
      const decoded = resultValue(decodeAdministrativeMemo(retention.posts[0]!.content)); assert.equal(decoded.patientId, verificationCanaries[2]);
      assert.equal(decoded.direction, "inbound"); assert.equal(decoded.businessId, "11");
      assert.equal(decoded.sourceActionRef, originalAction); assert.equal(decoded.actionRef, administrativeMemoActionRef(originalAction));
      assert.equal(decoded.outcome.kind, "classMovementReported");
      if (decoded.outcome.kind !== "classMovementReported") throw Error("Expected staged native movement report");
      assert.equal(decoded.outcome.appointmentRef, "cliniko:booking:94");
      assert.equal(decoded.outcome.original.appointmentRef, "cliniko:booking:91");
      assert.equal(decoded.outcome.original.attendeeRef, "cliniko:attendee:101");
      assert.equal(decoded.outcome.replacementAttendeeRef, "cliniko:attendee:401");
      assert.equal(decoded.outcome.completion, scenario.result === "moved" ? "moved" : "needsReview");
      assert.deepEqual(decoded.outcome.progress, { original: scenario.result === "disposed" ? "notSent" : "inspectedCancelled", replacement: "inspectedActive",
        caseAssociation: !hasPass ? "notApplicable" : scenario.result === "disposed" ? "unlinked" : scenario.result === "lostAssociation" ? "uncertain" : "inspectedLinked" });
      assert.equal(decoded.outcome.verification.basis, "nativeWorkflowReportBestEffort");
      const binding = administrativeMemoRecordBinding(retention.config.native, retention.authentication)!;
      assert.deepEqual(resultValue(await new PostgresOutboundEffectBarrier(db, scope, binding).claimOnce(decoded.actionRef)), { claimed: false });
    }
    const binding = administrativeMemoRecordBinding(retention.config.native, retention.authentication)!;
    assert.equal((await db.selectFrom("outbound_effect_barriers").selectAll().where("owner_binding", "=", binding).execute()).length, count);
    const requests = await db.selectFrom("cliniko_request_budgets").selectAll().execute();
    assert.equal(requests.length, 1); assert.ok(requests.every(row => row.max_per_minute === 180 && Array.isArray(row.sent_at_ms) && row.sent_at_ms.length > 0 && row.sent_at_ms.length <= 180));
    if (scenario.result !== "disposed") {
      await serving.turn("Did it finish");
      assert.equal(fixture.writes.length, expectedWrites.length); assert.equal(retention.posts.length, count);
    }
    const publicData = JSON.stringify([publicInputs, serving.modelTurns, serving.transcripts, serving.spoken, commandProgress(state, "signed-staged-memo"), await serving.flow.publicIntentContext()]);
    const secrets = [...verificationCanaries, fixture.flowConfig.cliniko.apiKey, Buffer.from(`${fixture.flowConfig.cliniko.apiKey}:`).toString("base64"),
      ...fixture.mail.flatMap(row => [row.email, row.code]), originalAction, review.marker, ...fixture.recalls.map(row => String(row.notes)),
      "811222333444555666", "811222333444555667", "private-move-source-entitlement", "private-move-destination-entitlement", "synthetic-private-move-pass-name", "synthetic-private-move-pass-note",
      "private-class-shared-note", "private-attendee-note", "private-other-name", ...retention.posts.flatMap(row => [String(row.content), JSON.stringify(row)]),
      retention.key.toString("hex"), retention.key.toString("base64")];
    for (const [index, value] of secrets.entries()) assert.equal(publicData.includes(value), false, `private staged memo index ${index}`);
    await serving.close(); assert.equal(fixture.writes.length, expectedWrites.length); assert.equal(retention.posts.length, count);
    for (const row of fixture.mail) await assertSqlVerificationCodeCanary(db, row.code, canaryScope.window);
    const probes = [...secrets, serving.callId, state.sessionLease!.sessionId].filter(value => value.length >= 4).flatMap((value, i) =>
      Array.from({ length: Math.ceil(value.length / 200) }, (_, n) => ({ label: `staged_memo_${i}_${n}`, value: value.slice(Math.min(n * 200, value.length - 4), n * 200 + 200) })));
    for (let i = 0; i < probes.length; i += 12) assert.deepEqual(resultValue(await scanPatientDataCanaries(db, probes.slice(i, i + 12))), []);
    const dump = execFileSync("pg_dump", [target.toString(), "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
    const copy = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
    for (const { value } of probes) { const json = JSON.stringify(value).slice(1, -1); for (const encoded of [value, copy(value), json, copy(json)]) assert.equal(dump.includes(encoded), false); }
    assert.equal(dump.includes(unrelatedRef), true); assert.equal((await db.selectFrom("patient_phone_index").selectAll().execute()).length, 1);
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
