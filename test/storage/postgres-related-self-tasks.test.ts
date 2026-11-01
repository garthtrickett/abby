// E2E-387/E2E-388: independent caller/related booking tasks and played-enquiry succession.
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

for (const { outcome, callerFirst, enquiryFirst } of [
  { outcome: "accepted", callerFirst: false, enquiryFirst: false },
  { outcome: "nativePermissionWithdrawn", callerFirst: false, enquiryFirst: false },
  { outcome: "accepted", callerFirst: true, enquiryFirst: false },
  { outcome: "accepted", callerFirst: false, enquiryFirst: true },
  { outcome: "nativePermissionWithdrawn", callerFirst: false, enquiryFirst: true },
  { outcome: "accepted", callerFirst: true, enquiryFirst: true },
  { outcome: "subjectOmitted", callerFirst: false, enquiryFirst: false },
  { outcome: "subjectAmbiguous", callerFirst: false, enquiryFirst: false },
] as const)
test(`actual emitted signed ${callerFirst ? "native-self" : "related"}${enquiryFirst ? " enquiry" : ""} then ${outcome.startsWith("subject") ? "unresolved-related" : callerFirst ? "related" : "native-self"} booking: ${outcome}`, { timeout: 240_000 }, async context => {
  const subjectFault = outcome === "subjectOmitted" || outcome === "subjectAmbiguous";
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
    f = await relatedSelfTaskSequenceFixture({ budget, subjectIds: ["583746192837465", "683746192837465"], ...(enquiryFirst ? { enquiry: true as const } : {}) }); f.flow.dispose();
    if (subjectFault) {
      const first = f.base.r.patients.get(f.base.r.subjectIds[0])!, second = f.base.r.patients.get(f.base.r.subjectIds[1])!;
      second.first_name = first.first_name; second.last_name = first.last_name;
      second.patient_phone_numbers = structuredClone(first.patient_phone_numbers);
      assert.equal(second.first_name, first.first_name); assert.equal(second.last_name, first.last_name);
      assert.deepEqual(second.patient_phone_numbers, first.patient_phone_numbers);
    }
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
          : turn.text === "Appointments" ? ok({ kind: "appointmentEnquiry", from: clock(), to: "2026-10-09T06:00:00.000Z" })
            : turn.text === "Did it finish" ? ok({ kind: "outcome" }) : ordinary(turn, signal);
    }, { clinicalHost: true, nativeIndividualChanges: true, maximumWrites: 2, steadyMedia: true });
    const serving = call, sessionId = (await serving.state()).sessionLease?.sessionId; assert.ok(sessionId);
    const excludePriorPublicNumbers = async () => canary!.excludePreexistingPublicText(JSON.stringify([serving.modelTurns, serving.transcripts,
      commandProgress(await serving.state(), "related-self"), await serving.flow.publicIntentContext()]));
    const verifyRelated = async (priorMail: number, operation: "book" | "appointments.read" = "book") => {
      await excludePriorPublicNumbers(); await serving.turn(operation === "book" ? "Book an appointment for my partner" : "Check the appointment time for my husband"); await serving.mark();
      const owner = serving.flow.representativeInputOwner; assert.ok(owner);
      await serving.privateDigit("1"); await serving.mark(); await fixture.base.waitForMail(priorMail + 1);
      for (const digit of `${fixture.base.mail[priorMail]!.code}#`) serving.sendEvent({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
      await voiceUntil(() => serving.spoken.at(-1) === "Please say the patient's first name.", "private related subject"); await serving.mark();
      for (const field of [fixture.base.r.identity.firstName, fixture.base.r.identity.lastName, "5 March 1982"]) { await serving.privateField(field); await serving.mark(); }
      await excludePriorPublicNumbers(); await serving.privateDigit("1"); await serving.mark(); await fixture.base.waitForMail(priorMail + 2);
      await serving.verify(fixture.base.mail[priorMail + 1]!.code); return owner;
    };
    const verifyCaller = async (priorMail: number, operation: "book" | "appointments.read" = "book") => {
      const previousWrites = serving.writes.length;
      await excludePriorPublicNumbers(); await serving.turn(operation === "book" ? "Book an appointment for myself" : "Check my appointments for myself");
      assert.equal(serving.flow.representativeInputOwner, undefined); assert.equal(serving.flow.verificationRequired, true);
      assert.equal(serving.writes.length, previousWrites);
      await serving.mark(); await fixture.base.waitForMail(priorMail + 1); assert.equal(fixture.base.mail[priorMail]!.email, verificationCanaries[0]);
      const asrCount = serving.transcriptionFrames, privateCount = serving.privateTranscripts.length;
      for (let n = 0; n < 7; n++) serving.media(n < 2);
      await serving.verify(fixture.base.mail[priorMail]!.code);
      assert.equal(serving.transcriptionFrames, asrCount); assert.equal(serving.privateTranscripts.length, privateCount);
    };
    const firstOperation = enquiryFirst ? "appointments.read" : "book";
    if (callerFirst) await verifyCaller(0, firstOperation);
    const firstOwner = callerFirst ? undefined : await verifyRelated(0, firstOperation);
    const book = async (beforeConsent?: () => void) => { await serving.turn("Times"); await serving.mark(); await serving.turn("First option");
      const action = Object.values((await serving.state()).actions).at(-1)!; assert.equal(action.status, "awaitingConfirmation");
      await serving.mark(); beforeConsent?.(); await serving.turn("Yes"); await serving.mark(); return (await serving.state()).actions[action.key]!; };
    let first: import("../../src/core/model.ts").ActionState | undefined;
    let firstRead: import("../../src/core/model.ts").CallState["appointmentReads"][number] | undefined;
    if (enquiryFirst) {
      await serving.turn("Appointments");
      const read = (await serving.state()).appointmentReads.at(-1); assert.ok(read); assert.equal(read.status, "shown");
      assert.equal((await serving.flow.publicIntentContext())?.nextTaskAvailable, undefined, "unplayed enquiry is not a completed task");
      firstRead = structuredClone(read); await serving.mark();
      assert.equal(serving.writes.length, 0); assert.equal(fixture.base.f.recalls.length, 0);
      assert.equal(Object.keys((await serving.state()).actions).length, 0);
    } else {
      first = await book(); assert.equal(first.status, "committed");
      assert.equal(serving.writes.length, 1); assert.equal(serving.writeRequests[0]!.body.patient_id, callerFirst ? verificationCanaries[2] : f.base.r.subjectIds[0]);
    }
    const receipt = first ? structuredClone(first) : firstRead;
    const priorWrites = enquiryFirst ? 0 : 1;
    // Real elapsed native quota window with ordinary hold/presence turns, as in
    // the existing signed two-patient cases. No lease or quota limit changes.
    const beganPause = performance.now(), quiet = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
    await serving.turn("Please hold."); await serving.mark(); await quiet(28000);
    await serving.turn("Please wait while I check my diary."); await serving.mark(); await quiet(28000);
    await serving.turn("Are you still there?"); await serving.mark(); await quiet(5000);
    assert.ok(performance.now() - beganPause >= 61_000);
    assert.equal((await serving.flow.publicIntentContext())?.nextTaskAvailable, true);
    if (subjectFault) {
      assert.ok(first && first.mutation.request.kind === "book");
      if (outcome === "subjectAmbiguous") {
        const original = fixture.base.r.patients.get(fixture.base.r.subjectIds[0])!, other = fixture.base.r.patients.get(fixture.base.r.subjectIds[1])!;
        other.date_of_birth = original.date_of_birth;
        fixture.base.r.authorizations.set(fixture.base.r.subjectIds[1], {
          ...fixture.base.r.authorizations.get(fixture.base.r.subjectIds[0])!, authorityRef: "independently-approved-second-adult" });
      }
      await excludePriorPublicNumbers(); await serving.turn("Book an appointment for another person"); await serving.mark();
      const owner = serving.flow.representativeInputOwner; assert.ok(owner); assert.notEqual(owner, firstOwner);
      assert.equal(firstOwner!.closed, true); assert.equal(fixture.base.mail.length, 2);
      await serving.privateDigit("1"); await serving.mark(); await fixture.base.waitForMail(3);
      for (const digit of `${fixture.base.mail[2]!.code}#`) serving.sendEvent({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
      await voiceUntil(() => serving.spoken.at(-1) === "Please say the patient's first name.", "new private subject after fresh actor proof"); await serving.mark();
      // A new actor code still grants no subject and cannot reuse the first offer.
      assert.equal((await serving.flow.resolveBooking(fixture.base.f.scope, first.mutation.request.patient.verificationRef,
        first.mutation.request.offer.offerRef, clock())).ok, false);
      assert.equal((await serving.flow.publicIntentContext())?.lastAction, null);
      if (outcome === "subjectAmbiguous") {
        for (const field of [fixture.base.r.identity.firstName, fixture.base.r.identity.lastName, "5 March 1982"]) {
          await serving.privateField(field); await serving.mark();
        }
        // No new prompt or code is expected when the exact native identity is
        // ambiguous. Observe the processed key and retirement of this owner.
        await serving.privateKey("1"); await voiceUntil(() => owner.closed, "ambiguous subject refusal");
      } else {
        // Leave the requested subject absent at the real private-media seam.
        // Old subject digits cannot supply the missing private identity.
        for (const digit of `${fixture.base.mail[1]!.code}#`) await serving.privateKey(digit);
        assert.equal(owner.closed, false); assert.equal(serving.closed, false);
        assert.equal(owner.beginPatientVerification(), false);
      }
      assert.equal(fixture.base.mail.length, 3); assert.equal(serving.writes.length, 1);
      assert.equal(serving.writeRequests.length, 1); assert.equal(fixture.base.f.recalls.length, 1);
      assert.equal(Object.keys((await serving.state()).actions).length, 1);
    } else {
      if (callerFirst) await verifyRelated(1);
      else { await verifyCaller(2); assert.equal(firstOwner!.closed, true); }
      if (first) {
        if (first.mutation.request.kind !== "book") throw Error("wrong original operation");
        assert.equal((await serving.flow.resolveBooking(f.base.f.scope, first.mutation.request.patient.verificationRef,
          first.mutation.request.offer.offerRef, clock())).ok, false);
      } else {
        assert.ok(firstRead); assert.equal((await serving.flow.publicIntentContext())?.lastAction, null);
        assert.equal(serving.writes.length, 0);
      }
      const second = await book(outcome === "nativePermissionWithdrawn" ? () => fixture.denySelf() : undefined);
      if (outcome === "accepted") {
        assert.equal(second.status, "committed"); assert.equal(serving.writes.length, priorWrites + 1);
        assert.equal(serving.writeRequests[priorWrites]!.body.patient_id, callerFirst ? f.base.r.subjectIds[0] : verificationCanaries[2]);
        if (first) { assert.notEqual(first.key, second.key); assert.notEqual(first.hostRef, second.hostRef); }
      } else { assert.notEqual(second.status, "committed"); assert.equal(serving.writes.length, priorWrites); }
    }
    if (first) {
      assert.deepEqual((await serving.state()).actions[first.key], receipt);
      if (!subjectFault) assert.deepEqual(await serving.flow.reconcile(first.mutation), { kind: "exactCommit", actionKey: first.key, hostRef: first.hostRef });
      assert.deepEqual(await serving.flow.write(first.mutation, clock()), { kind: "rejected", actionKey: first.key, reason: "forbidden" });
    } else {
      assert.deepEqual((await serving.state()).appointmentReads[0], receipt);
      assert.equal(Object.keys((await serving.state()).actions).length, 1);
    }
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
