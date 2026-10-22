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
const { financialClassBookingFixture } = await import(new URL("test/support/financial-class-booking.js", emitted).href) as typeof import("./financial-class-booking.ts");
const { subjectMemoFixture } = await import(new URL("test/support/subject-memo.js", emitted).href) as typeof import("./subject-memo.ts");
const { clinikoWorkflowVoiceFixture, voiceUntil } = await import(new URL("test/support/cliniko-workflow-voice.js", emitted).href) as typeof import("./cliniko-workflow-voice.ts");
const { createOpenAIClinicalIntentResolver } = await import(new URL("src/standalone/openai-clinical-intent.js", emitted).href) as typeof import("../../src/standalone/openai-clinical-intent.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { PostgresFinancialEffectBarrier } = await import(new URL("src/storage/postgres-financial-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-financial-effect-barrier.ts");
const { financialRecordOwnerBinding } = await import(new URL("src/cliniko/financial-record-retention.js", emitted).href) as typeof import("../../src/cliniko/financial-record-retention.ts");
const { decodeClinikoFinancialIntent } = await import(new URL("src/cliniko/financial-review-intent.js", emitted).href) as typeof import("../../src/cliniko/financial-review-intent.ts");
const { PostgresPatientVerificationBudget } = await import(new URL("src/storage/postgres-patient-verification-budget.js", emitted).href) as typeof import("../../src/storage/postgres-patient-verification-budget.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { PostgresPatientPhoneIndex } = await import(new URL("src/storage/postgres-patient-phone-index.js", emitted).href) as typeof import("../../src/storage/postgres-patient-phone-index.ts");
const { PostgresPatientPhoneScan } = await import(new URL("src/storage/postgres-patient-phone-scan.js", emitted).href) as typeof import("../../src/storage/postgres-patient-phone-scan.ts");
const { decodeAdministrativeMemo } = await import(new URL("src/cliniko/administrative-memo.js", emitted).href) as typeof import("../../src/cliniko/administrative-memo.ts");
const { decodeClinikoReview } = await import(new URL("src/cliniko/review-request.js", emitted).href) as typeof import("../../src/cliniko/review-request.ts");
const { administrativeMemoRecordBinding } = await import(new URL("src/cliniko/administrative-memo-records.js", emitted).href) as typeof import("../../src/cliniko/administrative-memo-records.ts");
const { ok } = await import(new URL("src/core/model.js", emitted).href) as typeof import("../../src/core/model.ts");
const { commandProgress } = await import(new URL("src/reference/command-progress.js", emitted).href) as typeof import("../../src/reference/command-progress.ts");

/** Each authority/entitlement cohort retains its ordinary isolated test child. */
export function registerSignedClassBookingMemoCases(passes: boolean, options: Readonly<{ requiredFinancial?: true }> = {}): void {
for (const mode of [...["accepted", "wrongSubjectGrant", "lostStored", "clinicalResponseLost"] as const, ...(options.requiredFinancial ? ["financialResponseLost"] as const : [])])
test(`actual emitted signed ${passes ? "pass" : "ordinary"} class booking ${options.requiredFinancial ? "with required financial consent " : ""}preserves one patient memo and native180/privacy: ${mode}`, { timeout: 180000 }, async () => {
  const admin = connectPostgres(adminUrl), databaseName = `abby_signed_class_memo_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${databaseName}`;
  let canaryScope: Awaited<ReturnType<typeof captureScopedSqlVerificationCanaryWindow>> | undefined;
  let created = false, db: ReturnType<typeof connectPostgres> | undefined;
  let f: Awaited<ReturnType<typeof financialClassBookingFixture>> | undefined;
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
    const scope = { tenantId: `signed-class-memo-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
    const budget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-class-au5", maxPerMinute: 180 });
    const began = performance.now();
    const clock = () => { const now = new Date(Date.parse(verificationNow) + performance.now() - began).toISOString(); f?.setTime(now); return now; };
    f = await financialClassBookingFixture({ scope, budget, budgetLimit: 180, passes, required: options.requiredFinancial === true,
      ...(mode === "financialResponseLost" ? { lostObservation: true } : {}),
      barrierFor: native => new PostgresFinancialEffectBarrier(db!, scope, resultValue(financialRecordOwnerBinding(native))),
      verificationBudget: new PostgresPatientVerificationBudget(db, scope), memoFor: native => {
        memo = subjectMemoFixture({ ...native, authorRef: "clinic-approved-admin-memo", policy: { version: "admin-actions-v1", digest: "a".repeat(64) },
          clock: () => call?.currentTime() ?? clock(), deadlineMs: 5000 }, verificationCanaries[2]!, {
          ...(mode === "wrongSubjectGrant" ? { approvedPatientId: "583746192837465" } : {}),
          ...(mode === "lostStored" ? { lostStored: true } : {}), barrierFor: (bound, binding) => new PostgresOutboundEffectBarrier(db!, bound, binding) });
        return memo.config;
      } });
    assert.ok(memo); const retention = memo, fixture = f;
    if (options.requiredFinancial) {
      f.host.dispose(); f.session.dispose();
      assert.equal(Reflect.set(f.flowConfig.financial!.presentation, "play", async () => { assert.fail("Shared financial playback cannot stand in for the current call"); }), true);
    }
    let modelRequests = 0;
    call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, clock }, flow => {
      const ordinary = createOpenAIClinicalIntentResolver({ apiKey: "synthetic", model: "synthetic", owner: flow, clinicDate: () => "2026-10-04",
        fetch: async () => { modelRequests++; throw Error("Private class data cannot reach the model"); } });
      return async (turn, signal) => turn.text === "Times" ? ok({ kind: "bookingMenu", from: "2026-10-08", to: "2026-10-08" })
        : turn.text === "First option" ? ok({ kind: "bookingChoice", choice: 1 }) : turn.text === "Yes" ? ok({ kind: "affirm" })
        : turn.text === "Did it finish" ? ok({ kind: "outcome" }) : turn.text === "Are you still there?" ? ok({ kind: "presence" }) : ordinary(turn, signal);
    }, { clinicalHost: true, ...(mode === "clinicalResponseLost" ? { lostWrite: true } : {}) });
    const serving = call; f.bindNativeCall(() => serving.state());
    await serving.turn("Book my Pilates class"); await serving.mark();
    await voiceUntil(() => fixture.mail.length === 1, "registered-channel class proof");
    const frames = serving.transcriptionFrames; await serving.verify(f.mail[0]!.code); assert.equal(serving.transcriptionFrames, frames);
    await serving.turn("Times"); await serving.mark(); await serving.turn("First option");
    if (options.requiredFinancial) {
      await serving.mark(); assert.equal(Object.keys((await serving.state()).actions).length, 0);
      assert.equal(serving.writes.length, 0); assert.equal(retention.posts.length, 0);
      const financial = serving.flow.financialBookingInput; assert.ok(financial);
      let parts = 0;
      while (financial.inputAdmission()?.phase === "unplayed" && parts++ < 16) {
        const before = serving.transcriptionFrames;
        await serving.privateDigit("1"); serving.media(true); for (let i = 0; i < 5; i++) serving.media(false);
        await serving.privateKey("1"); assert.equal(financial.readySelection, undefined); assert.equal(serving.transcriptionFrames, before);
        await serving.mark(); await voiceUntil(() => financial.inputAdmission() !== undefined || !financial.inputActive, "actual played financial segment");
      }
      assert.ok(parts > 2); assert.equal(financial.inputAdmission()?.phase, "awaiting"); assert.equal(financial.readySelection, undefined);
      assert.equal(Object.keys((await serving.state()).actions).length, 0);
      await serving.privateKey("1"); await serving.privateQuiet(); assert.ok(financial.readySelection);
      assert.equal(serving.writes.length, 0); assert.equal(retention.posts.length, 0);
      await serving.turn("continue booking"); assert.equal(modelRequests, 0);
    }
    let state = await serving.state(), action = Object.values(state.actions).at(-1)!;
    assert.equal(action.status, "awaitingConfirmation"); assert.equal(serving.writes.length, 0); assert.equal(retention.posts.length, 0);
    await serving.mark(); await serving.turn("Yes");
    // The voice owner has already retired the transient notice from its pending
    // slot. Follow the actual played capacity instruction, as the existing
    // signed pass-booking runner does; a fresh affirmative is still required.
    const wait = /wait about (\d+) seconds/.exec(serving.spoken.at(-1)!);
    if (wait) {
      const seconds = Number(wait[1]); assert.ok(seconds >= 1 && seconds <= 60);
      assert.match(serving.spoken.at(-1)!, /say yes again/); assert.match(serving.spoken.at(-1)!, /not reserved/);
      assert.equal(serving.writes.length, 0); assert.equal(retention.posts.length, 0); await serving.mark();
      const until = performance.now() + (seconds + 1) * 1000;
      while (performance.now() < until) {
        serving.media(false); await new Promise<void>(resolve => setTimeout(resolve, 20));
      }
      assert.equal(serving.writes.length, 0, "waiting cannot dispatch the earlier affirmative");
      await serving.turn("Yes"); state = await serving.state();
    }
    state = await serving.state(); action = Object.values(state.actions).at(-1)!;
    assert.equal(action.status, mode === "clinicalResponseLost" ? "uncertain" : "committed", JSON.stringify({ phase: "pass-confirmation", lastSpeech: serving.spoken.at(-1), claims: f.claims, writes: serving.writes.length }));
    assert.deepEqual(serving.writes, ["POST /v1/attendees"]); assert.equal(f.writes.length, 1); assert.equal(f.cancellations.length, 0);
    assert.equal(serving.writeRequests[0]!.body.patient_id, verificationCanaries[2]);
    const review = resultValue(decodeClinikoReview(f.recalls[0]!.notes)); assert.equal(review.request.operation.kind, "classBook");
    if (review.request.operation.kind !== "classBook") throw Error("Expected class attendance source");
    const originalAction = review.request.operation.attendanceActionId;
    assert.match(originalAction, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(serving.writeRequests[0]!.body.notes, `Abby attendance ${originalAction}`);
    assert.equal(serving.writeRequests[0]!.body.patient_case_id, passes ? f.pass.caseId : undefined);
    if (mode !== "clinicalResponseLost") await voiceUntil(() => retention.outcomes.length === 1, "independent class memo completion");
    const expected = mode === "wrongSubjectGrant" || mode === "clinicalResponseLost" ? 0 : 1;
    assert.equal(retention.posts.length, expected); assert.equal(retention.rows.length, expected);
    assert.equal(retention.outcomes.length, mode === "clinicalResponseLost" ? 0 : 1);
    if (mode !== "clinicalResponseLost") assert.equal(retention.outcomes[0]!.kind, mode === "wrongSubjectGrant" ? "unavailable" : mode === "lostStored" ? "uncertain" : "accepted");
    const binding = administrativeMemoRecordBinding(retention.config.native, retention.authentication)!;
    const purposes = await sql<{ total: number }>`select count(*)::int as total from outbound_effect_barriers where owner_binding = ${binding}`.execute(db);
    assert.equal(purposes.rows[0]!.total, expected);
    if (expected) {
      const decoded = resultValue(decodeAdministrativeMemo(retention.posts[0]!.content));
      assert.equal(decoded.patientId, verificationCanaries[2]); assert.equal(decoded.direction, "inbound"); assert.equal(decoded.sourceActionRef, originalAction);
      assert.equal(decoded.outcome.kind, "classBookingConfirmed");
      if (decoded.outcome.kind !== "classBookingConfirmed") throw Error("Expected exact class booking memo");
      assert.equal(decoded.outcome.appointmentRef, "cliniko:booking:94"); assert.equal(decoded.outcome.attendeeRef, "cliniko:attendee:401");
      assert.deepEqual(resultValue(await new PostgresOutboundEffectBarrier(db, scope, binding).claimOnce(decoded.actionRef)), { claimed: false });
    }
    const financialPrivate: string[] = [];
    if (options.requiredFinancial) {
      const rows = [...f.funding.rows.values()], intentRow = rows.find(row => String(row.notes).includes("financial intent")); assert.ok(intentRow);
      const intent = resultValue(decodeClinikoFinancialIntent(intentRow.notes));
      assert.equal(intent.patientId, verificationCanaries[2]); assert.equal(intent.booking.kind, "classBook");
      assert.equal(intent.booking.actionRef, originalAction); assert.equal(intent.payment.amount, 1200); assert.equal(intent.payment.currency, "gbp");
      assert.equal(rows.length, mode === "clinicalResponseLost" ? 1 : 2);
      const financeOwner = resultValue(financialRecordOwnerBinding(f.config.native));
      const exclusions = await sql<{ effect_ref: string }>`select effect_ref from financial_effect_barriers where owner_binding = ${financeOwner}`.execute(db);
      const permittedOpaquePurposes = rows.map(row => /^Abby request ([0-9a-f-]{36})\n/.exec(String(row.notes))?.[1]);
      assert.ok(permittedOpaquePurposes.every(Boolean)); assert.deepEqual(exclusions.rows.map(row => row.effect_ref).sort(), permittedOpaquePurposes.sort());
      const text = serving.spoken.find(text => text.includes("GBP 12.00")); assert.ok(text);
      financialPrivate.push(text, "GBP 12.00", intent.recipient.address, "The clinic will review late payment. A pass count does not prove payment.", ...rows.map(row => String(row.notes)));
      const privateKey = f.config.privateKey.export({ type: "pkcs8", format: "der" });
      financialPrivate.push(privateKey.toString("hex"), privateKey.toString("base64"));
      if (mode !== "clinicalResponseLost") {
        const observation = f.proof(); assert.equal(observation.targetRef, "cliniko:attendee:401");
        assert.equal(observation.bookingActionRef, originalAction); assert.equal(observation.financialActionRef, intent.actionRef); assert.ok(observation.financialConsent);
        assert.deepEqual(observation.classCreationRequest, { sessionId: "94", ...(passes ? { patientCaseId: f.pass.caseId } : {}) });
        financialPrivate.push(observation.financialConsent.presentationRef, observation.financialConsent.presentationDigest, observation.financialConsent.acceptanceRef);
      }
    } else assert.equal(f.funding.rows.size, 0);
    const requests = await db.selectFrom("cliniko_request_budgets").selectAll().execute();
    assert.equal(requests.length, 1); assert.equal(requests[0]!.max_per_minute, 180);
    assert.ok(Array.isArray(requests[0]!.sent_at_ms) && requests[0]!.sent_at_ms.length > 0 && requests[0]!.sent_at_ms.length <= 180);
    const verification = await sql<{ kind: string; attempts: number }>`select kind, attempts from patient_verification_budgets where tenant_id = ${scope.tenantId}`.execute(db);
    for (const kind of ["issue", "answer"]) assert.ok(verification.rows.some(row => row.kind === kind && row.attempts >= 1));
    await serving.mark(); await serving.turn("Did it finish"); assert.equal(serving.writes.length, 1); assert.equal(retention.posts.length, expected);
    state = await serving.state(); assert.equal(action.mutation.request.kind, "book");
    if (action.mutation.request.kind !== "book") throw Error("Expected verified class patient");
    const privateValues = [...verificationCanaries, ...financialPrivate, f.flowConfig.cliniko.apiKey, Buffer.from(`${f.flowConfig.cliniko.apiKey}:`).toString("base64"),
      f.mail[0]!.email, f.mail[0]!.code, action.mutation.request.patient.verificationRef, originalAction, String(serving.writeRequests[0]!.body.notes),
      f.pass.caseId, f.pass.entitlementRef, "private-class-shared-note", "private-attendee-note", "private-other-name", "private-pass-name-canary", "private-pass-notes-canary", "private-pass-referral-canary",
      ...f.recalls.map(row => String(row.notes)), ...f.recalls.map(row => resultValue(decodeClinikoReview(row.notes)).marker),
      ...retention.posts.flatMap(row => [String(row.content), JSON.stringify(row), resultValue(decodeAdministrativeMemo(row.content)).authentication]),
      retention.key.toString("hex"), retention.key.toString("base64")];
    const publicData = JSON.stringify([serving.modelTurns, serving.transcripts, commandProgress(state, "signed-class-memo"), await serving.flow.publicIntentContext()]);
    for (const [index, value] of privateValues.entries()) assert.equal(publicData.includes(value), false, `private class canary index ${index}`);
    await serving.close(); await assertSqlVerificationCodeCanary(db, f.mail[0]!.code, canaryScope.window);
    const canaries = [...privateValues, serving.callId, state.sessionLease!.sessionId].filter(value => value.length >= 4);
    const probes = canaries.flatMap((value, i) => Array.from({ length: Math.ceil(value.length / 256) }, (_, n) => ({ label: `signed_class_memo_${i}_${n}`,
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
