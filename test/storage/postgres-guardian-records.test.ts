// E2E-426: clinic-approved non-patient guardian records and separate patient proof.
// Non-patient guardian: actual emitted clinical host, signed private media,
// shared native180, independent subject/action authority and full SQL restore privacy.
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
import type { GuardianVerificationSession as GuardianSession } from "../../src/standalone/guardian-verification-session.ts";
import type { CallerVerificationSession as CallerSession } from "../../src/standalone/caller-verification-session.ts";
import type { PrivateRepresentativeVoiceInput as PrivateInput } from "../../src/standalone/private-representative-voice-input.ts";

if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const adminUrl = process.env.DATABASE_URL, emitted = new URL("../../dist/runtime/", import.meta.url);
const { guardianCallOwnerFixture } = await import(new URL("test/support/guardian-call-owner.js", emitted).href) as typeof import("../support/guardian-call-owner.ts");
const { clinikoWorkflowVoiceFixture, voiceUntil } = await import(new URL("test/support/cliniko-workflow-voice.js", emitted).href) as typeof import("../support/cliniko-workflow-voice.ts");
const { createOpenAIClinicalIntentResolver } = await import(new URL("src/standalone/openai-clinical-intent.js", emitted).href) as typeof import("../../src/standalone/openai-clinical-intent.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { PostgresPatientVerificationBudget } = await import(new URL("src/storage/postgres-patient-verification-budget.js", emitted).href) as typeof import("../../src/storage/postgres-patient-verification-budget.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { commandProgress } = await import(new URL("src/reference/command-progress.js", emitted).href) as typeof import("../../src/reference/command-progress.ts");
const { ok } = await import(new URL("src/core/model.js", emitted).href) as typeof import("../../src/core/model.ts");
const { GuardianVerificationSession } = await import(new URL("src/standalone/guardian-verification-session.js", emitted).href) as typeof import("../../src/standalone/guardian-verification-session.ts");
const { CallerVerificationSession } = await import(new URL("src/standalone/caller-verification-session.js", emitted).href) as typeof import("../../src/standalone/caller-verification-session.ts");
const { PrivateRepresentativeVoiceInput } = await import(new URL("src/standalone/private-representative-voice-input.js", emitted).href) as typeof import("../../src/standalone/private-representative-voice-input.ts");

const scenarios = [
  { operation: "book", outcome: "accepted" }, { operation: "appointments.read", outcome: "accepted" },
  { operation: "cancel", outcome: "accepted" }, { operation: "reschedule", outcome: "accepted" },
  { operation: "book", outcome: "missingIdentity" }, { operation: "book", outcome: "missingAuthority" },
  { operation: "book", outcome: "withdrawnBeforeConsent" },
] as const;
for (const { operation, outcome } of scenarios)
test(`actual emitted signed non-patient guardian records ${operation}: ${outcome}`, { timeout: 240_000 }, async context => {
  const admin = connectPostgres(adminUrl), name = `abby_test_guardian_records_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const restoreName = `${name}_restored`, target = new URL(adminUrl), restoreTarget = new URL(adminUrl);
  target.pathname = `/${name}`; restoreTarget.pathname = `/${restoreName}`;
  let created = false, restored = false, db: ReturnType<typeof connectPostgres> | undefined, copyDb: ReturnType<typeof connectPostgres> | undefined;
  let f: Awaited<ReturnType<typeof guardianCallOwnerFixture>> | undefined, call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
  let canary: Awaited<ReturnType<typeof captureScopedSqlVerificationCanaryWindow>> | undefined;
  try {
    await sql.raw(`create database "${name}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); await migrate(db);
    const unrelated = { tenantId: `unrelated-${randomUUID()}`, clinicId: "clinic", locationId: "main" }, retained = randomUUID();
    resultValue(await new PostgresOutboundEffectBarrier(db, unrelated, "e".repeat(64)).claimOnce(retained));
    const original = await db.selectFrom("outbound_effect_barriers").selectAll().execute();
    canary = await captureScopedSqlVerificationCanaryWindow(db, target.toString());
    const budget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-session-au5", maxPerMinute: 180 });
    f = await guardianCallOwnerFixture({ operation, both: true, budget, subjectIds: ["583746192837465", "683746192837465"] }); f.flow.dispose();
    const proofRefs = new Set<string>(), guardianProof = GuardianVerificationSession.prototype.verifiedGuardian, patientProof = CallerVerificationSession.prototype.verifiedSubject;
    context.mock.method(GuardianVerificationSession.prototype, "verifiedGuardian", async function(this: GuardianSession, ...args: Parameters<typeof guardianProof>) {
      const proof = await guardianProof.apply(this, args); if (proof) proofRefs.add(proof.verificationRef); return proof;
    });
    context.mock.method(CallerVerificationSession.prototype, "verifiedSubject", async function(this: CallerSession, ...args: Parameters<typeof patientProof>) {
      const proof = await patientProof.apply(this, args); if (proof) proofRefs.add(proof.verificationRef); return proof;
    });
    const fixture = f, began = performance.now(), identityRecord = structuredClone(f.state.identity!), authorityRecord = structuredClone(f.state.authority!);
    const clock = () => { const now = new Date(Date.parse(verificationNow) + performance.now() - began).toISOString(); fixture.base.f.setTime(now); return now; };
    call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, clock, verificationBudget: new PostgresPatientVerificationBudget(db, f.base.f.scope) }, flow => {
      const ordinary = createOpenAIClinicalIntentResolver({ apiKey: "synthetic", model: "synthetic", owner: flow, clinicDate: () => "2026-10-04",
        fetch: async () => { throw Error("guardian identity and patient fields cannot require a public model request"); } });
      return async (turn, signal) => {
        if (turn.text === "Yes") return ok({ kind: "affirm" });
        if (turn.text === "Times") return ok({ kind: "bookingMenu", from: "2026-10-08", to: "2026-10-08" });
        if (turn.text === "First option") return ok({ kind: "bookingChoice", choice: 1 });
        if (turn.text === "Check appointments") return ok({ kind: "appointmentEnquiry", from: verificationNow, to: "2026-10-09T06:00:00.000Z" });
        if (turn.text === "Cancellation appointments" || turn.text === "Cancel it") {
          const grant = await flow.cancellationProof(); assert.ok(grant);
          return turn.text === "Cancellation appointments" ? ok({ kind: "appointments", verificationRef: grant.verificationRef, from: verificationNow, to: "2026-10-09T06:00:00.000Z" })
            : ok({ kind: "cancel", verificationRef: grant.verificationRef, targetRef: "selected" });
        }
        if (turn.text === "Move targets" || turn.text === "Move offers") return ok({ kind: "reschedulingMenu", stage: turn.text === "Move targets" ? "targets" : "offers",
          from: turn.text === "Move targets" ? verificationNow : "2026-10-08", to: turn.text === "Move targets" ? "2026-10-09T06:00:00.000Z" : "2026-10-08" });
        if (turn.text === "Select target" || turn.text === "Select offer") return ok({ kind: "reschedulingChoice", stage: turn.text === "Select target" ? "targets" : "offers", choice: 1 });
        return ordinary(turn, signal);
      };
    }, { clinicalHost: true, steadyMedia: true, ...(operation === "cancel" || operation === "reschedule" ? { nativeIndividualChanges: true } : {}) });
    const serving = call;
    const callSessionId = (await serving.state()).sessionLease?.sessionId; assert.ok(callSessionId);
    const request = operation === "book" ? "Book an appointment for my daughter" : operation === "cancel" ? "Cancel an appointment for my daughter"
      : operation === "reschedule" ? "Move an appointment for my daughter" : "Check the appointment time for my daughter";
    await serving.turn(request); assert.ok(serving.flow.representativeInputOwner); await serving.mark();
    await serving.privateDigit("1"); assert.match(serving.spoken.at(-1)!, /press one if you are a patient.*two.*not a patient/);
    assert.equal(f.base.mail.length, 0); assert.equal(f.counts.identities, 0); await serving.mark();
    await serving.privateDigit("2"); assert.match(serving.spoken.at(-1)!, /First verify yourself/); assert.equal(f.base.mail.length, 0);
    if (outcome === "missingIdentity") f.state.identity = undefined;
    await serving.mark();
    if (outcome === "missingIdentity") {
      const owner = serving.flow.representativeInputOwner!;
      let refusals = 0; const accept = PrivateRepresentativeVoiceInput.prototype.accept;
      context.mock.method(PrivateRepresentativeVoiceInput.prototype, "accept", async function(this: PrivateInput, ...args: Parameters<typeof accept>) {
        const result = await accept.apply(this, args); if (result === "failed") refusals++; return result;
      });
      for (let n = 0; n < 2; n++) for (const digit of "000000#") await serving.privateKey(digit);
      assert.equal(owner.closed, false);
      for (const digit of "000000") await serving.privateKey(digit);
      // The last rejected answer intentionally returns failed. The ordinary
      // privateKey helper requires no ingress failure, so observe this exact
      // refusal at its real input method and send only this final key directly.
      serving.sendEvent({ event: "dtmf", dtmf: { track: "inbound_track", digit: "#" } });
      await voiceUntil(() => owner.closed && refusals === 1, "missing guardian identity returns one explicit private refusal without native fallback");
      assert.equal(refusals, 1); assert.equal(owner.chooseCallerMethod("clinicPatient"), false); assert.equal(owner.beginPatientVerification(), false);
      assert.equal(f.base.mail.length, 0); assert.equal(f.counts.authorities, 0); assert.equal(f.reads.length, 0);
    } else {
      await f.base.waitForMail(1); assert.equal(f.base.mail[0]!.email, f.state.guardianEmail);
      for (const digit of `${f.base.mail[0]!.code}#`) serving.sendEvent({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
      await voiceUntil(() => serving.spoken.at(-1) === "Please say the patient's first name.", "fresh private guardian patient fields"); await serving.mark();
      for (const field of [f.base.r.identity.firstName, f.base.r.identity.lastName, "5 March 2014"]) { await serving.privateField(field); await serving.mark(); }
      const owner = serving.flow.representativeInputOwner!;
      if (outcome === "missingAuthority") {
        f.state.authority = undefined; await serving.privateKey("1"); await voiceUntil(() => owner.closed, "missing independent guardian action authority");
        assert.equal(f.base.mail.length, 1);
      } else {
        await serving.privateDigit("1"); await serving.mark(); await f.base.waitForMail(2);
        assert.equal(f.base.mail[1]!.email, "subject-one-private@example.test");
        const privateCount = serving.privateTranscripts.length, asrCount = serving.transcriptionFrames;
        for (let n = 0; n < 7; n++) serving.media(n < 2);
        await serving.verify(f.base.mail[1]!.code); assert.equal(serving.privateTranscripts.length, privateCount); assert.equal(serving.transcriptionFrames, asrCount);
        if (operation === "appointments.read") {
          await serving.turn("Check appointments"); assert.equal((await serving.state()).appointmentReads.at(-1)!.status, "shown"); await serving.mark();
        } else {
          if (operation === "book") { await serving.turn("Times"); await serving.mark(); await serving.turn("First option"); }
          else if (operation === "cancel") { await serving.turn("Cancellation appointments"); await serving.mark(); await serving.turn("Cancel it"); }
          else { await serving.turn("Move targets"); await serving.mark(); await serving.turn("Select target"); await serving.mark();
            await serving.turn("Move offers"); await serving.mark(); await serving.turn("Select offer"); }
          const action = Object.values((await serving.state()).actions).at(-1)!; assert.ok(action); assert.equal(action.status, "awaitingConfirmation");
          assert.equal(serving.writes.length, 0); await serving.mark();
          if (outcome === "withdrawnBeforeConsent") f.state.authority = { ...f.state.authority!, enabled: false };
          await serving.turn("Yes");
          const after = (await serving.state()).actions[action.key]!;
          if (outcome === "withdrawnBeforeConsent") { assert.notEqual(after.status, "committed"); assert.equal(serving.writes.length, 0); }
          else { assert.equal(after.status, "committed"); assert.equal(serving.writes.length, 1);
            assert.equal(serving.writeRequests[0]!.path, operation === "book" ? "/v1/individual_appointments" : operation === "cancel" ? "/v1/individual_appointments/91/cancel" : "/v1/individual_appointments/91");
            if (operation === "book") assert.equal(serving.writeRequests[0]!.body.patient_id, authorityRecord.subjectPatientId);
          }
        }
      }
    }
    const state = await serving.state();
    assert.equal(f.reads.some(path => path.endsWith(`/patients/${verificationCanaries[2]}`)), false, "guardian caller never needs a patient identity");
    const values = [...verificationCanaries, f.flowConfig.cliniko.apiKey, identityRecord.contactId, identityRecord.recordRef, identityRecord.recordVersion,
      authorityRecord.authorityRef, authorityRecord.subjectPatientId, f.state.guardianEmail, ...serving.privateTranscripts,
      "synthetic-workflow-voice-token", ...proofRefs, ...f.base.mail.flatMap(row => [row.email, row.code]), f.base.r.identity.firstName, f.base.r.identity.lastName, f.base.r.identity.dateOfBirth];
    const publicData = JSON.stringify([serving.modelTurns, serving.transcripts, commandProgress(state, "guardian-records"), await serving.flow.publicIntentContext()]);
    for (const value of values) if (value.length >= 4) assert.equal(publicData.includes(value), false);
    for (const message of f.base.mail) assert.equal(JSON.stringify(serving.spoken).includes(message.code), false);
    await serving.close(); call = undefined;
    for (const message of f.base.mail) await assertSqlVerificationCodeCanary(db, message.code, canary.window);
    const secrets = [...new Set([...values, serving.callId, callSessionId].filter(value => value.length >= 4))];
    const probes = secrets.flatMap((value, i) => Array.from({ length: Math.ceil(value.length / 256) }, (_, n) => ({ label: `guardian_records_${i}_${n}`,
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
    if (outcome !== "missingIdentity") { assert.equal(budgets.length, 1); assert.equal(budgets[0]!.max_per_minute, 180);
      const sent = budgets[0]!.sent_at_ms; assert.ok(Array.isArray(sent) && sent.length <= 180); }
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
