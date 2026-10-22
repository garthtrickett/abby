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
const adminUrl = process.env.DATABASE_URL, emitted = new URL("../../dist/runtime/", import.meta.url);
const { serviceBookingFixture } = await import(new URL("test/support/service-booking-catalogue.js", emitted).href) as typeof import("./service-booking-catalogue.ts");
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
const { commandProgress } = await import(new URL("src/reference/command-progress.js", emitted).href) as typeof import("../../src/reference/command-progress.ts");
const { ok } = await import(new URL("src/core/model.js", emitted).href) as typeof import("../../src/core/model.ts");

type Service = "initial" | "massage" | "followUp" | "switch" | "duration";
type Fault = "none" | "wrongSubject" | "withdrawn" | "memoResponseLost" | "clinicalResponseLost" | "catalogueRevoked" | "afterReviewRevoked";
type Scenario = Readonly<{ service: Service; fault: Fault }>;
const scenarios: readonly Scenario[] = [
  { service: "initial", fault: "none" }, { service: "massage", fault: "none" }, { service: "followUp", fault: "none" },
  { service: "switch", fault: "none" }, { service: "duration", fault: "none" },
  { service: "initial", fault: "wrongSubject" }, { service: "initial", fault: "withdrawn" },
  { service: "initial", fault: "memoResponseLost" }, { service: "initial", fault: "clinicalResponseLost" },
  { service: "initial", fault: "catalogueRevoked" }, { service: "initial", fault: "afterReviewRevoked" },
];
const requested: Readonly<Record<Service, string>> = {
  initial: "Book a sixty-minute initial Physiotherapy appointment.", massage: "Book a 45-minute initial Massage appointment.",
  followUp: "Book a 30-minute follow-up Physiotherapy appointment. I am a returning patient, this is not a new problem, and my last visit was 2 months ago.",
  switch: "Book a sixty-minute initial Physiotherapy appointment.", duration: "Book a 45-minute initial Physiotherapy appointment.",
};
function expectedOutcome(scenario: Scenario) {
  const blocked = scenario.fault === "catalogueRevoked" || scenario.fault === "afterReviewRevoked";
  const uncertain = scenario.fault === "clinicalResponseLost", denied = scenario.fault === "wrongSubject" || scenario.fault === "withdrawn";
  const typeId = scenario.service === "massage" || scenario.service === "switch" ? "35" : scenario.service === "followUp" ? "33" : "34";
  return { writes: blocked ? 0 : 1, status: blocked ? "rejected" : uncertain ? "uncertain" : "committed",
    memoCount: blocked || uncertain || denied ? 0 : 1,
    memoOutcome: blocked || uncertain ? undefined : denied ? "unavailable" : scenario.fault === "memoResponseLost" ? "uncertain" : "accepted",
    typeId, duration: typeId === "35" ? 45 : typeId === "33" ? 30 : 60,
    proofCount: scenario.service === "switch" || scenario.service === "duration" ? 2 : 1 };
}

/** Real signed serving/verification/native owners; only clinic/provider services are synthetic. */
export function registerCatalogueBookingMemoCases(): void {
for (const scenario of scenarios) test(`actual emitted signed catalogue booking keeps exact native memo and privacy: ${scenario.service}/${scenario.fault}`, { timeout: 180000 }, async () => {
  const expected = expectedOutcome(scenario), admin = connectPostgres(adminUrl), name = `abby_catalogue_memo_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${name}`;
  let created = false, db: ReturnType<typeof connectPostgres> | undefined;
  let canary: Awaited<ReturnType<typeof captureScopedSqlVerificationCanaryWindow>> | undefined;
  let fixture: Awaited<ReturnType<typeof serviceBookingFixture>> | undefined;
  let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined, memo: ReturnType<typeof subjectMemoFixture> | undefined;
  try {
    await sql.raw(`create database "${name}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); await migrate(db); canary = await captureScopedSqlVerificationCanaryWindow(db);
    const unrelated = { tenantId: `unrelated-${randomUUID()}`, clinicId: "index", locationId: "main" }, fingerprint = "e".repeat(64);
    const links = [{ normalizedPhone: "+61400111222", patientId: "101" }], retainedRef = randomUUID();
    assert.ok((await new PostgresPatientPhoneIndex(db).publish(unrelated, links, "61", fingerprint)).ok);
    const scans = new PostgresPatientPhoneScan(db), staged = { ...unrelated, clinicId: "staged" }, begun = resultValue(await scans.begin(staged, "61", fingerprint));
    assert.ok((await scans.append(staged, begun.scanRef, { page: 1, totalEntries: 1, patientIds: ["101"], links })).ok);
    assert.ok((await new PostgresOutboundEffectBarrier(db, unrelated, fingerprint).claimOnce(retainedRef)).ok);
    const preserved = {
      index: await db.selectFrom("patient_phone_index").selectAll().execute(),
      effect: (await sql`select * from outbound_effect_barriers where effect_ref = ${retainedRef}`.execute(db)).rows,
    };
    const scope = { tenantId: `catalogue-memo-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
    const budget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-session-au5", maxPerMinute: 180 });
    fixture = await serviceBookingFixture({ scope, budget, verificationBudget: new PostgresPatientVerificationBudget(db, scope) }); fixture.flow.dispose();
    const f = fixture, began = performance.now(), publicInputs: unknown[] = [];
    const clock = () => { const now = new Date(Date.parse(verificationNow) + performance.now() - began).toISOString(); f.setTime(now); return now; };
    memo = subjectMemoFixture({ scope, ...f.flowConfig.cliniko, authorRef: "clinic-approved-admin-memo",
      policy: { version: "admin-actions-v1", digest: "a".repeat(64) }, clock: () => call?.currentTime() ?? clock(), deadlineMs: 5000 }, verificationCanaries[2]!, {
      ...(scenario.fault === "wrongSubject" ? { approvedPatientId: "583746192837465" } : {}),
      ...(scenario.fault === "memoResponseLost" ? { lostStored: true } : {}),
      barrierFor: (bound, binding) => new PostgresOutboundEffectBarrier(db!, bound, binding),
    });
    const retention = memo;
    call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, clock, memo: retention.config }, owner => {
      const ordinary = createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic", model: "synthetic", clinicDate: () => "2026-10-04",
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body)), context = JSON.parse(body.input[1].content); publicInputs.push(context);
          assert.equal(context.callerText, "Show times on October 8."); assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
          return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text",
            text: JSON.stringify({ kind: "menu", operation: null, stage: null, from: "2026-10-08", to: "2026-10-08", choice: null }) }] }] });
        } });
      return async (turn, signal) => turn.text === "Did it finish" ? ok({ kind: "outcome" }) : ordinary(turn, signal);
    }, { clinicalHost: true, lostWrite: scenario.fault === "clinicalResponseLost",
      beforeWriteResponse: async () => { if (scenario.fault === "withdrawn") retention.control.permitted = false; },
      appointmentTypeMetadata: { "33": { durationMinutes: 30 }, "34": { durationMinutes: 60 }, "35": { durationMinutes: 45 }, "36": { durationMinutes: 45 } } });
    const serving = call, play = async (text: string) => { await serving.turn(text); await serving.mark(); };
    await play(requested[scenario.service]); await voiceUntil(() => f.mail.length === 1, "catalogue patient verification"); await serving.verify(f.mail[0]!.code);
    await play("Show times on October 8."); await play("The first time, please.");
    let action = Object.values((await serving.state()).actions).at(-1)!; assert.equal(action.status, "awaitingConfirmation");
    assert.equal(serving.writeRequests.length, 0); assert.equal(retention.posts.length, 0);
    if (scenario.service === "switch" || scenario.service === "duration") {
      const oldAction = action.key;
      await play(scenario.service === "switch" ? requested.massage : "I want an hour appointment.");
      assert.equal((await serving.state()).actions[oldAction]!.status, "canceled");
      assert.equal(serving.writeRequests.length, 0); assert.equal(retention.posts.length, 0);
      await voiceUntil(() => f.mail.length === 2, "fresh selected-service verification"); await serving.verify(f.mail[1]!.code);
      await play("Show times on October 8."); await play("The first time, please.");
      action = Object.values((await serving.state()).actions).at(-1)!;
    }
    assert.equal(action.mutation.request.kind, "book");
    if (action.mutation.request.kind !== "book") throw Error("Expected catalogue booking");
    assert.equal(action.mutation.request.offer.presentation?.durationMinutes, expected.duration);
    assert.equal(f.mail.length, expected.proofCount);
    if (scenario.fault === "catalogueRevoked") await f.replaceServices({ enabled: false });
    if (scenario.fault === "afterReviewRevoked") f.setOnRecall(async () => f.replaceServices({ enabled: false }));
    await play("Yes");
    const state = await serving.state(); assert.equal(state.actions[action.key]!.status, expected.status);
    assert.equal(serving.writeRequests.length, expected.writes);
    if (expected.memoOutcome) await voiceUntil(() => retention.outcomes.length === 1, "independent catalogue memo result");
    else assert.equal(retention.outcomes.length, 0, "no owned acknowledgement supplies memo authority");
    assert.equal(retention.posts.length, expected.memoCount); assert.equal(retention.rows.length, expected.memoCount);
    if (expected.memoOutcome) assert.equal(retention.outcomes[0]!.kind, expected.memoOutcome);
    let marker = "";
    if (expected.writes) {
      const body = serving.writeRequests[0]!.body;
      assert.equal(body.business_id, "11"); assert.equal(body.practitioner_id, "22"); assert.equal(body.patient_id, verificationCanaries[2]);
      assert.equal(body.appointment_type_id, expected.typeId);
      assert.equal(Date.parse(String(body.ends_at)) - Date.parse(String(body.starts_at)), expected.duration * 60000);
      marker = /^Abby booking ([0-9a-f-]{36})$/.exec(String(body.notes))?.[1] ?? ""; assert.ok(marker);
      if (expected.memoCount) {
        const decoded = resultValue(decodeAdministrativeMemo(retention.posts[0]!.content));
        assert.equal(decoded.patientId, body.patient_id); assert.equal(decoded.direction, "inbound");
        assert.equal(decoded.sourceActionRef, marker); assert.equal(decoded.outcome.kind, "bookingConfirmed");
        if (decoded.outcome.kind !== "bookingConfirmed") throw Error("Expected owned catalogue booking acknowledgement");
        assert.equal(decoded.outcome.startsAt, new Date(String(body.starts_at)).toISOString());
        assert.equal(decoded.outcome.endsAt, new Date(String(body.ends_at)).toISOString());
        const binding = administrativeMemoRecordBinding(retention.config.native, retention.authentication)!;
        assert.deepEqual(resultValue(await new PostgresOutboundEffectBarrier(db, scope, binding).claimOnce(decoded.actionRef)), { claimed: false });
      }
    }
    const binding = administrativeMemoRecordBinding(retention.config.native, retention.authentication)!;
    assert.equal((await db.selectFrom("outbound_effect_barriers").selectAll().where("owner_binding", "=", binding).execute()).length, expected.memoCount);
    await play("Did it finish"); assert.equal(serving.writeRequests.length, expected.writes); assert.equal(retention.posts.length, expected.memoCount);
    const publicData = JSON.stringify([publicInputs, serving.modelTurns, serving.transcripts, serving.spoken, commandProgress(state, "catalogue-memo"), await serving.flow.publicIntentContext()]);
    const secrets = [...verificationCanaries, f.flowConfig.cliniko.apiKey, Buffer.from(`${f.flowConfig.cliniko.apiKey}:`).toString("base64"),
      ...f.mail.flatMap(row => [row.email, row.code]), marker, ...f.recalls.flatMap(row => [String(row.notes), resultValue(decodeClinikoReview(row.notes)).marker]),
      ...retention.posts.flatMap(row => [String(row.content), JSON.stringify(row), resultValue(decodeAdministrativeMemo(row.content)).authentication]),
      action.mutation.request.patient.verificationRef, retention.key.toString("hex"), retention.key.toString("base64")].filter(value => value.length >= 4);
    for (const secret of secrets) assert.equal(publicData.includes(secret), false);
    await serving.close(); assert.equal(serving.writeRequests.length, expected.writes); assert.equal(retention.posts.length, expected.memoCount);
    for (const message of f.mail) await assertSqlVerificationCodeCanary(db, message.code, canary.window);
    const probes = [...secrets, serving.callId, state.sessionLease!.sessionId].flatMap((value, i) =>
      Array.from({ length: Math.ceil(value.length / 200) }, (_, n) => ({ label: `catalogue_memo_${i}_${n}`, value: value.slice(Math.min(n * 200, value.length - 4), n * 200 + 200) })));
    for (let i = 0; i < probes.length; i += 12) assert.deepEqual(resultValue(await scanPatientDataCanaries(db, probes.slice(i, i + 12))), []);
    const dump = execFileSync("pg_dump", [target.toString(), "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
    const copy = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
    for (const { value } of probes) { const json = JSON.stringify(value).slice(1, -1); for (const raw of [value, copy(value), json, copy(json)]) assert.equal(dump.includes(raw), false); }
    assert.deepEqual(await db.selectFrom("patient_phone_index").selectAll().execute(), preserved.index);
    assert.deepEqual((await sql`select * from outbound_effect_barriers where effect_ref = ${retainedRef}`.execute(db)).rows, preserved.effect);
    assert.equal((await scans.verifyPage(staged, begun.scanRef, { page: 1, totalEntries: 1, patientIds: ["101"], links })).ok, true);
    assert.equal(dump.includes(retainedRef), true);
    const requests = await db.selectFrom("cliniko_request_budgets").selectAll().execute();
    assert.equal(requests.length, 1); assert.ok(requests.every(row => row.max_per_minute === 180 && Array.isArray(row.sent_at_ms) && row.sent_at_ms.length > 0 && row.sent_at_ms.length <= 180));
  } finally {
    try { await call?.close(); } finally { memo?.close(); try { await fixture?.close(); } finally {
      try { canary?.close(); } finally { await db?.destroy(); try {
        if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin);
      } finally { await admin.destroy(); } }
    } }
  }
});
}
