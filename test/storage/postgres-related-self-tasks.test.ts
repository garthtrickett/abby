// E2E-387: explicit native caller task after an independently approved related-person task.
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { captureScopedSqlVerificationCanaryWindow, assertSqlVerificationCodeCanary } from "../support/sql-verification-canary.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow, verificationCanaries } from "../support/caller-verification.ts";
import type { CallerVerificationSession as CallerSession } from "../../src/standalone/caller-verification-session.ts";

if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const adminUrl = process.env.DATABASE_URL, emitted = new URL("../../dist/runtime/", import.meta.url);
const { relatedSelfTaskSequenceFixture } = await import(new URL("test/support/related-self-task-sequence.js", emitted).href) as typeof import("../support/related-self-task-sequence.ts");
const { clinikoWorkflowVoiceFixture, voiceUntil } = await import(new URL("test/support/cliniko-workflow-voice.js", emitted).href) as typeof import("../support/cliniko-workflow-voice.ts");
const { createOpenAIClinicalIntentResolver } = await import(new URL("src/standalone/openai-clinical-intent.js", emitted).href) as typeof import("../../src/standalone/openai-clinical-intent.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { PostgresPatientVerificationBudget } = await import(new URL("src/storage/postgres-patient-verification-budget.js", emitted).href) as typeof import("../../src/storage/postgres-patient-verification-budget.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { commandProgress } = await import(new URL("src/reference/command-progress.js", emitted).href) as typeof import("../../src/reference/command-progress.ts");
const { ok } = await import(new URL("src/core/model.js", emitted).href) as typeof import("../../src/core/model.ts");
const { CallerVerificationSession } = await import(new URL("src/standalone/caller-verification-session.js", emitted).href) as typeof import("../../src/standalone/caller-verification-session.ts");

for (const outcome of ["accepted", "nativePermissionWithdrawn"] as const)
test(`actual emitted signed related then native-self booking: ${outcome}`, { timeout: 240_000 }, async context => {
  const admin = connectPostgres(adminUrl), name = `abby_test_related_self_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const restoreName = `${name}_restored`, target = new URL(adminUrl), restoreTarget = new URL(adminUrl);
  target.pathname = `/${name}`; restoreTarget.pathname = `/${restoreName}`;
  let created = false, restored = false, db: ReturnType<typeof connectPostgres> | undefined, copyDb: ReturnType<typeof connectPostgres> | undefined;
  let f: Awaited<ReturnType<typeof relatedSelfTaskSequenceFixture>> | undefined, call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
  let canary: Awaited<ReturnType<typeof captureScopedSqlVerificationCanaryWindow>> | undefined;
  try {
    await sql.raw(`create database "${name}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); await migrate(db);
    const unrelated = { tenantId: `unrelated-${randomUUID()}`, clinicId: "clinic", locationId: "main" }, retained = randomUUID();
    resultValue(await new PostgresOutboundEffectBarrier(db, unrelated, "e".repeat(64)).claimOnce(retained));
    const original = await db.selectFrom("outbound_effect_barriers").selectAll().execute();
    canary = await captureScopedSqlVerificationCanaryWindow(db, target.toString());
    const budget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-session-au5", maxPerMinute: 180 });
    f = await relatedSelfTaskSequenceFixture({ budget, subjectIds: ["583746192837465", "683746192837465"] }); f.flow.dispose();
    const proofRefs = new Set<string>(), verified = CallerVerificationSession.prototype.verifiedSubject;
    context.mock.method(CallerVerificationSession.prototype, "verifiedSubject", async function(this: CallerSession, ...args: Parameters<typeof verified>) {
      const proof = await verified.apply(this, args); if (proof) proofRefs.add(proof.verificationRef); return proof;
    });
    const fixture = f, began = performance.now();
    const clock = () => { const now = new Date(Date.parse(verificationNow) + performance.now() - began).toISOString(); fixture.base.f.setTime(now); return now; };
    call = await clinikoWorkflowVoiceFixture(db, { ...f.source.config, clock,
      verificationBudget: new PostgresPatientVerificationBudget(db, f.base.f.scope) }, flow => {
      const ordinary = createOpenAIClinicalIntentResolver({ apiKey: "synthetic", model: "synthetic", owner: flow, clinicDate: () => "2026-10-04",
        fetch: async () => { throw Error("explicit subject requests and private patient fields cannot require the model"); } });
      return async (turn, signal) => turn.text === "Times" ? ok({ kind: "bookingMenu", from: "2026-10-08", to: "2026-10-08" })
        : turn.text === "First option" ? ok({ kind: "bookingChoice", choice: 1 }) : turn.text === "Yes" ? ok({ kind: "affirm" })
          : turn.text === "Did it finish" ? ok({ kind: "outcome" }) : ordinary(turn, signal);
    }, { clinicalHost: true, nativeIndividualChanges: true, maximumWrites: 2, steadyMedia: true });
    const serving = call, sessionId = (await serving.state()).sessionLease?.sessionId; assert.ok(sessionId);
    const excludePriorPublicNumbers = async () => canary!.excludePreexistingPublicText(JSON.stringify([serving.modelTurns, serving.transcripts,
      commandProgress(await serving.state(), "related-self"), await serving.flow.publicIntentContext()]));
    await serving.turn("Book an appointment for my partner"); await serving.mark(); await excludePriorPublicNumbers();
    const firstOwner = serving.flow.representativeInputOwner; assert.ok(firstOwner);
    await serving.privateDigit("1"); await serving.mark(); await f.base.waitForMail(1);
    for (const digit of `${f.base.mail[0]!.code}#`) serving.sendEvent({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
    await voiceUntil(() => serving.spoken.at(-1) === "Please say the patient's first name.", "private related subject"); await serving.mark();
    for (const field of [f.base.r.identity.firstName, f.base.r.identity.lastName, "5 March 1982"]) { await serving.privateField(field); await serving.mark(); }
    await excludePriorPublicNumbers(); await serving.privateDigit("1"); await serving.mark(); await f.base.waitForMail(2);
    await serving.verify(f.base.mail[1]!.code);
    const book = async (beforeConsent?: () => void) => { await serving.turn("Times"); await serving.mark(); await serving.turn("First option");
      const action = Object.values((await serving.state()).actions).at(-1)!; assert.equal(action.status, "awaitingConfirmation");
      await serving.mark(); beforeConsent?.(); await serving.turn("Yes"); await serving.mark(); return (await serving.state()).actions[action.key]!; };
    const first = await book(); assert.equal(first.status, "committed"); const receipt = structuredClone(first);
    assert.equal(serving.writes.length, 1); assert.equal(serving.writeRequests[0]!.body.patient_id, f.base.r.subjectIds[0]);
    // Real elapsed native quota window with ordinary hold/presence turns, as in
    // the existing signed two-patient cases. No lease or quota limit changes.
    const beganPause = performance.now(), quiet = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
    await serving.turn("Please hold."); await serving.mark(); await quiet(28000);
    await serving.turn("Please wait while I check my diary."); await serving.mark(); await quiet(28000);
    await serving.turn("Are you still there?"); await serving.mark(); await quiet(5000);
    assert.ok(performance.now() - beganPause >= 61_000);
    assert.equal((await serving.flow.publicIntentContext())?.nextTaskAvailable, true);
    await excludePriorPublicNumbers(); await serving.turn("Book an appointment for myself");
    assert.equal(firstOwner.closed, true); assert.equal(serving.flow.representativeInputOwner, undefined);
    assert.equal(serving.flow.verificationRequired, true); assert.equal(serving.writes.length, 1);
    await serving.mark(); await f.base.waitForMail(3); assert.equal(f.base.mail[2]!.email, verificationCanaries[0]);
    const asrCount = serving.transcriptionFrames, privateCount = serving.privateTranscripts.length;
    for (let n = 0; n < 7; n++) serving.media(n < 2);
    await serving.verify(f.base.mail[2]!.code);
    assert.equal(serving.transcriptionFrames, asrCount); assert.equal(serving.privateTranscripts.length, privateCount);
    if (first.mutation.request.kind !== "book") throw Error("wrong original operation");
    assert.equal((await serving.flow.resolveBooking(f.base.f.scope, first.mutation.request.patient.verificationRef,
      first.mutation.request.offer.offerRef, clock())).ok, false);
    const second = await book(outcome === "nativePermissionWithdrawn" ? () => fixture.denySelf() : undefined);
    if (outcome === "accepted") {
      assert.equal(second.status, "committed"); assert.equal(serving.writes.length, 2);
      assert.equal(serving.writeRequests[1]!.body.patient_id, verificationCanaries[2]);
      assert.notEqual(first.key, second.key); assert.notEqual(first.hostRef, second.hostRef);
    } else { assert.notEqual(second.status, "committed"); assert.equal(serving.writes.length, 1); }
    assert.deepEqual((await serving.state()).actions[first.key], receipt);
    assert.deepEqual(await serving.flow.reconcile(first.mutation), { kind: "exactCommit", actionKey: first.key, hostRef: first.hostRef });
    assert.deepEqual(await serving.flow.write(first.mutation, clock()), { kind: "rejected", actionKey: first.key, reason: "forbidden" });
    const state = await serving.state();
    assert.equal((await serving.flow.publicIntentContext())?.nextTaskAvailable, undefined);
    const values = [...verificationCanaries, f.source.config.cliniko.apiKey, ...f.base.r.subjectIds,
      ...serving.privateTranscripts, "synthetic-workflow-voice-token", ...proofRefs, ...f.base.mail.flatMap(row => [row.email, row.code]),
      f.base.r.identity.firstName, f.base.r.identity.lastName, f.base.r.identity.dateOfBirth];
    const publicData = JSON.stringify([serving.modelTurns, serving.transcripts, commandProgress(state, "related-self"), await serving.flow.publicIntentContext()]);
    for (const value of values) if (value.length >= 4) assert.equal(publicData.includes(value), false);
    for (const mail of f.base.mail) assert.equal(JSON.stringify(serving.spoken).includes(mail.code), false);
    await serving.close(); call = undefined;
    for (const mail of f.base.mail) await assertSqlVerificationCodeCanary(db, mail.code, canary.window);
    const secrets = [...new Set([...values, serving.callId, sessionId].filter(value => value.length >= 4))];
    const probes = secrets.flatMap((value, i) => Array.from({ length: Math.ceil(value.length / 256) }, (_, n) => ({ label: `related_self_${i}_${n}`,
      value: value.slice(n * 256, (n + 1) * 256).length < 4 ? value.slice(-4) : value.slice(n * 256, (n + 1) * 256) })));
    for (let n = 0; n < probes.length; n += 12) assert.deepEqual(resultValue(await scanPatientDataCanaries(db, probes.slice(n, n + 12))), []);
    const dump = execFileSync("pg_dump", [target.toString(), "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 });
    const text = dump.toString(), escaped = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
    for (const value of secrets) for (const form of [value, escaped(value), JSON.stringify(value).slice(1, -1), escaped(JSON.stringify(value).slice(1, -1))]) assert.equal(text.includes(form), false);
    assert.ok(text.includes(retained)); assert.deepEqual(await db.selectFrom("outbound_effect_barriers").selectAll().execute(), original);
    await sql.raw(`create database "${restoreName}"`).execute(admin); restored = true;
    execFileSync("psql", [restoreTarget.toString(), "--no-psqlrc", "--set=ON_ERROR_STOP=1"], { input: dump, timeout: 10_000, maxBuffer: 8_000_000 });
    copyDb = connectPostgres(restoreTarget.toString());
    for (let n = 0; n < probes.length; n += 12) assert.deepEqual(resultValue(await scanPatientDataCanaries(copyDb, probes.slice(n, n + 12))), []);
    assert.deepEqual(await copyDb.selectFrom("outbound_effect_barriers").selectAll().execute(), original);
    const budgets = await db.selectFrom("cliniko_request_budgets").select(["max_per_minute", "sent_at_ms"]).execute();
    assert.equal(budgets.length, 1); assert.equal(budgets[0]!.max_per_minute, 180);
    assert.ok(Array.isArray(budgets[0]!.sent_at_ms) && budgets[0]!.sent_at_ms.length <= 180);
  } finally {
    try { await call?.close(); } finally {
      try { await f?.close(); } finally {
        canary?.close(); await copyDb?.destroy(); await db?.destroy();
        try { if (restored) await sql.raw(`drop database "${restoreName}" with (force)`).execute(admin);
          if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); } finally { await admin.destroy(); }
      }
    }
  }
});
