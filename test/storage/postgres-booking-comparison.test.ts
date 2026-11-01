// E2E-313: approved original-versus-alternative booking comparison.
// R02: emitted serving modules, signed media, real SQL/native budget and exact original return.
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
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";

if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const adminUrl = process.env.DATABASE_URL;
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { bookingCatalogueFixture } = await import(new URL("test/support/cliniko-booking-catalogue.js", emitted).href) as typeof import("../support/cliniko-booking-catalogue.ts");
const { servicePractitionerFixture } = await import(new URL("test/support/service-practitioner-preference.js", emitted).href) as typeof import("../support/service-practitioner-preference.ts");
const { clinikoWorkflowVoiceFixture, voiceUntil } = await import(new URL("test/support/cliniko-workflow-voice.js", emitted).href) as typeof import("../support/cliniko-workflow-voice.ts");
const { createOpenAIClinicalIntentResolver } = await import(new URL("src/standalone/openai-clinical-intent.js", emitted).href) as typeof import("../../src/standalone/openai-clinical-intent.ts");
const { PostgresClinikoRequestBudget } = await import(new URL("src/storage/postgres-cliniko-request-budget.js", emitted).href) as typeof import("../../src/storage/postgres-cliniko-request-budget.ts");
const { PostgresPatientVerificationBudget } = await import(new URL("src/storage/postgres-patient-verification-budget.js", emitted).href) as typeof import("../../src/storage/postgres-patient-verification-budget.ts");
const { commandProgress } = await import(new URL("src/reference/command-progress.js", emitted).href) as typeof import("../../src/reference/command-progress.ts");

for (const outcome of ["originalReturn", "originalUnavailable", "alternativeWithdrawn", "durationCorrection", "serviceCorrection"] as const)
test(`actual emitted signed booking comparison preserves original choice: ${outcome}`, { timeout: 180_000 }, async () => {
  const admin = connectPostgres(adminUrl), name = `abby_test_comparison_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${name}`;
  let created = false, db: ReturnType<typeof connectPostgres> | undefined;
  let f: Awaited<ReturnType<typeof bookingCatalogueFixture>> | Awaited<ReturnType<typeof servicePractitionerFixture>> | undefined;
  let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
  let canary: Awaited<ReturnType<typeof captureScopedSqlVerificationCanaryWindow>> | undefined;
  try {
    await sql.raw(`create database "${name}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); await migrate(db);
    canary = await captureScopedSqlVerificationCanaryWindow(db, target.toString());
    const serviceChange = outcome === "durationCorrection" || outcome === "serviceCorrection";
    f = serviceChange ? await servicePractitionerFixture() : await bookingCatalogueFixture(); f.flow.dispose();
    const fixture = f, began = performance.now();
    const clock = () => { const now = new Date(Date.parse(verificationNow) + performance.now() - began).toISOString(); fixture.setTime(now); return now; };
    const budget = new PostgresClinikoRequestBudget(db, { apiKey: f.flowConfig.cliniko.apiKey, maxPerMinute: 180 });
    const modelTexts: string[] = [];
    call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, clock, cliniko: { ...f.flowConfig.cliniko, rateBudget: budget },
      verificationBudget: new PostgresPatientVerificationBudget(db, f.scope) }, owner => createOpenAIClinicalIntentResolver({ owner,
      apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_input, init) => {
        const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText; modelTexts.push(text);
        assert.ok(["I need to book an appointment.", "The first time, please.", "Show times on October 8."].includes(text));
        const begin = text === "I need to book an appointment.", menu = text === "Show times on October 8.";
        return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text",
          text: JSON.stringify({ kind: begin ? "workflow" : menu ? "menu" : "choice", operation: begin ? "book" : null, stage: null,
            from: menu ? "2026-10-08" : null, to: menu ? "2026-10-08" : null, choice: begin || menu ? null : 1 }) }] }] });
      } }), { clinicalHost: true, steadyMedia: true,
      appointmentTypeMetadata: { "33": { durationMinutes: 30 }, "34": { durationMinutes: 60 }, "35": { durationMinutes: 45 }, "36": { durationMinutes: 45 } } });
    const serving = call, play = async (text: string) => { await serving.turn(text); await serving.mark(); };
    await play(serviceChange ? "Book a sixty-minute initial Physiotherapy appointment." : "I need to book an appointment.");
    await voiceUntil(() => fixture.mail.length === 1, "comparison private challenge");
    await serving.verify(f.mail[0]!.code);
    await play(serviceChange ? "Show times on October 8." : "I prefer Demo A.");
    if (outcome === "originalUnavailable") f.setFailure("server");
    await serving.turn("Anyone is fine. What is the soonest opening?");
    if (outcome === "originalUnavailable") {
      assert.doesNotMatch(serving.spoken.at(-1)!, /original choice|earlier eligible|couldn't find|option one/);
      assert.equal(Object.keys((await serving.state()).actions).length, 0);
    } else {
      assert.match(serving.spoken.at(-1)!, serviceChange
        ? /original.*Physiotherapy initial.*Demo Practitioner.*Thursday 8 October.*60 minutes/s
        : /original.*Physiotherapy.*Demo A.*Thursday 8 October.*30 minutes/s);
      assert.match(serving.spoken.at(-1)!, serviceChange ? /Demo C.*earlier/s : /Demo B.*earlier/s); await serving.mark();
      if (outcome === "originalReturn") {
        assert.ok("setAlternateStarts" in f);
        f.setStarts(["2026-10-09T04:00:00.000Z"]);
        await play("Can I go back to my original practitioner?");
        assert.match(serving.spoken.at(-1)!, /with Demo A.*Friday 9 October/s);
        assert.doesNotMatch(serving.spoken.at(-1)!, /Thursday 8 October|with Demo B/);
      }
      if (serviceChange) {
        await play("Can I go back to my original practitioner?");
        assert.match(serving.spoken.at(-1)!, /Physiotherapy initial.*Demo Practitioner.*60 minutes/s);
        assert.doesNotMatch(serving.spoken.at(-1)!, /with Demo B|with Demo C/);
      }
      await serving.turn("The first time, please.");
      let action = Object.values((await serving.state()).actions).at(-1)!;
      assert.equal(action.status, "awaitingConfirmation"); assert.equal(serving.writeRequests.length, 0);
      await serving.mark();
      if (serviceChange) {
        const old = action;
        await play(outcome === "durationCorrection" ? "I want a 45-minute appointment." : "Book a 45-minute initial Massage appointment.");
        assert.equal((await serving.state()).actions[old.key]?.status, "canceled");
        assert.equal(serving.writeRequests.length, 0); assert.equal(f.recalls.length, 0);
        await voiceUntil(() => fixture.mail.length === 2, "comparison correction fresh private challenge");
        const beforePrivateAudio = serving.modelTurns.length;
        serving.media(true); serving.media(true); await serving.privateQuiet();
        assert.equal(serving.flow.verificationRequired, true);
        assert.equal(serving.modelTurns.length, beforePrivateAudio, "private verification audio must bypass public transcription/classification");
        assert.equal(serving.writeRequests.length, 0);
        await serving.verify(f.mail[1]!.code);
        await play("Show times on October 8.");
        assert.match(serving.spoken.at(-1)!, outcome === "durationCorrection" ? /Physiotherapy short initial/ : /Massage initial/);
        assert.doesNotMatch(serving.spoken.at(-1)!, /original choice|with Demo B|with Demo C/);
        await serving.turn("The first time, please.");
        action = Object.values((await serving.state()).actions).at(-1)!;
        assert.notEqual(action.key, old.key); assert.equal(action.status, "awaitingConfirmation");
        assert.equal(action.mutation.request.kind, "book");
        if (action.mutation.request.kind !== "book" || old.mutation.request.kind !== "book") throw Error("expected independent exact booking proposals");
        assert.notEqual(action.mutation.request.patient.verificationRef, old.mutation.request.patient.verificationRef);
        assert.match(serving.spoken.at(-1)!, /Demo Practitioner.*45 minutes/s);
        assert.equal(serving.writeRequests.length, 0); await serving.mark();
      }
      if (outcome === "alternativeWithdrawn") { assert.ok("revokeAlternate" in f); await f.revokeAlternate(); }
      await serving.turn("Yes");
      assert.equal((await serving.state()).actions[action.key]?.status, outcome === "originalReturn" || serviceChange ? "committed" : "rejected");
      if (outcome === "originalReturn" || serviceChange) {
        assert.equal(serving.writeRequests.length, 1);
        const sent = serving.writeRequests[0]!;
        assert.equal(sent.path, "/v1/individual_appointments"); assert.equal(sent.method, "POST");
        assert.deepEqual([sent.body.business_id, sent.body.practitioner_id, sent.body.appointment_type_id, sent.body.patient_id],
          ["11", "22", outcome === "durationCorrection" ? "36" : outcome === "serviceCorrection" ? "35" : "33", verificationCanaries[2]]);
        assert.equal(sent.body.starts_at, serviceChange ? "2026-10-08T04:00:00.000Z" : "2026-10-09T04:00:00.000Z");
        assert.equal(sent.body.ends_at, serviceChange ? "2026-10-08T04:45:00.000Z" : "2026-10-09T04:30:00.000Z");
        const receipt = structuredClone((await serving.state()).actions[action.key]);
        await serving.mark(); await play("Yes");
        assert.deepEqual((await serving.state()).actions[action.key], receipt); assert.equal(serving.writeRequests.length, 1);
      }
    }
    const expected = outcome === "originalReturn" || serviceChange ? 1 : 0, state = await serving.state();
    assert.equal(serving.writeRequests.length, expected); assert.equal(f.recalls.length, expected);
    const publicData = JSON.stringify([serving.modelTurns, serving.transcripts, commandProgress(state, "comparison"), await serving.flow.publicIntentContext()]);
    const privateValues = [...verificationCanaries, f.flowConfig.cliniko.apiKey, ...serving.privateTranscripts,
      "synthetic-workflow-voice-token", ...f.mail.flatMap(row => [row.email, row.code]),
      ...Object.values(state.actions).map(action => action.mutation.request.kind === "book" ? action.mutation.request.patient.verificationRef : ""),
      ...f.recalls.map(row => String(row.notes))].filter(value => value.length >= 4);
    for (const secret of privateValues) assert.equal(publicData.includes(secret), false);
    assert.ok(modelTexts.every(text => !text.includes("original practitioner") && !text.includes("Demo A") && !text.includes("Anyone")));
    await serving.close(); call = undefined;
    for (const message of f.mail) await assertSqlVerificationCodeCanary(db, message.code, canary.window);
    const canaries = [...privateValues, serving.callId, state.sessionLease!.sessionId];
    const probes = canaries.flatMap((value, index) => Array.from({ length: Math.ceil(value.length / 256) }, (_, n) => ({ label: `comparison_${index}_${n}`,
      value: value.slice(n * 256, (n + 1) * 256).length < 4 ? value.slice(-4) : value.slice(n * 256, (n + 1) * 256) })));
    for (let i = 0; i < probes.length; i += 12) assert.deepEqual(resultValue(await scanPatientDataCanaries(db, probes.slice(i, i + 12))), []);
    const dump = execFileSync("pg_dump", [target.toString(), "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
    const copy = (text: string) => text.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
    for (const raw of canaries) for (const value of [raw, copy(raw), JSON.stringify(raw).slice(1, -1), copy(JSON.stringify(raw).slice(1, -1))]) assert.equal(dump.includes(value), false);
    const budgetRef = createHash("sha256").update(`abby-cliniko-budget-v1\0${f.flowConfig.cliniko.apiKey}`).digest("hex");
    const { rows } = await sql<{ max_per_minute: number; sent_at_ms: unknown }>`select max_per_minute, sent_at_ms
      from cliniko_request_budgets where budget_ref = ${budgetRef}`.execute(db);
    assert.equal(rows.length, 1); assert.equal(rows[0]!.max_per_minute, 180);
    assert.ok(Array.isArray(rows[0]!.sent_at_ms) && rows[0]!.sent_at_ms.length > 0 && rows[0]!.sent_at_ms.length <= 180);
  } finally {
    try { await call?.close(); } finally {
      try { await f?.close(); } finally {
        canary?.close(); await db?.destroy();
        try { if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); } finally { await admin.destroy(); }
      }
    }
  }
});

// R03: this call's clinic binding is fixed. An uninterpretable request for the
// other clinic cannot preserve old unsent consent or retarget a completed write.
// The existing fixture deliberately fails classification for the new request;
// these cases qualify that failure boundary, not live model interpretation.
for (const chosen of ["North", "South"] as const) for (const prior of ["proposed", "committed"] as const)
test(`actual compiled same-clock clinic correction preserves fixed scope: ${chosen} ${prior}`, { timeout: 120_000 }, async () => {
  await withClinicalRunner("book", async call => {
    const play = async (text: string) => { await call.say(text); await call.mark(); };
    const other = chosen === "North" ? "South" : "North";
    const selected = call.locations.find(row => row.scope.locationId === (chosen === "North" ? "main" : "south"));
    assert.ok(selected); assert.equal(call.locations.length, 2);
    await play(chosen);
    await play("Book a 60-minute initial Physiotherapy appointment.");
    await call.verify();
    const mail = call.messages.find(row => row.kind === "verificationEmail");
    assert.ok(mail?.code && mail.email); assert.deepEqual(mail.scope, selected.scope);
    const delivery = call.messages.find(row => row.kind === "smtpDelivery");
    assert.ok(delivery?.accepted && delivery.envelopeMatches && delivery.codeMatches);
    await play("Show times on October 8."); await play("The first time, please.");
    assert.equal(call.mutations.length, 0);
    const confirmation = call.spoken.at(-1)!;
    assert.match(confirmation, /Physiotherapy.*60 minutes/s);
    if (prior === "committed") {
      await play("Yes."); assert.equal(call.spoken.at(-1), "Your booking is confirmed.");
      assert.equal(call.mutations.filter(row => row.path === "/v1/individual_appointments").length, 1);
    }
    const originalWrites = structuredClone(call.mutations);
    const correction = `Please change the clinic to ${other} at the same time instead.`;
    const modelTurnsBefore = call.messages.filter(row => row.kind === "modelTurn").length;
    await play(correction);
    assert.equal(call.messages.filter(row => row.kind === "modelTurn").length, modelTurnsBefore + 1);
    assert.equal(call.messages.filter(row => row.kind === "modelTurn").at(-1)?.text, correction,
      "the actual correction must reach the fixture's unavailable classifier");
    assert.doesNotMatch(call.spoken.at(-1)!, /Your booking is confirmed|has been moved|is now at/);
    assert.deepEqual(call.mutations, originalWrites);
    await play("Yes.");
    assert.deepEqual(call.mutations, originalWrites, "a later yes cannot revive the old offer or repeat a completed write");
    assert.equal(call.messages.filter(row => row.kind === "verificationEmail").length, 1);
    assert.equal(call.messages.filter(row => row.kind === "verificationResult" && row.verified).length, 1);
    for (const message of call.messages.filter(row => ["providerRequest", "permissionDecision", "verificationEmail"].includes(row.kind))) {
      assert.deepEqual(message.scope, selected.scope, "no patient lookup, grant or write may fall back to the other clinic");
    }
    const appointments = call.mutations.filter(row => row.path === "/v1/individual_appointments");
    assert.equal(appointments.length, prior === "committed" ? 1 : 0);
    if (prior === "committed") {
      assert.equal(appointments[0]!.body?.business_id, selected.businessId);
      assert.equal(appointments[0]!.body?.appointment_type_id, "34");
      assert.equal(appointments[0]!.body?.starts_at, "2026-10-08T04:00:00.000Z",
        "both independently approved clinic fixtures use this exact clock time");
      assert.equal(call.spoken.filter(text => text === "Your booking is confirmed.").length, 1);
    }
    const privateValues = [...verificationCanaries, "south-registered@example.test", mail.code, mail.email];
    for (const text of call.messages.filter(row => row.kind === "modelTurn").map(row => row.text!)) {
      for (const value of privateValues) assert.equal(text.includes(value), false);
    }
    await call.scan(privateValues);
    const dump = execFileSync("pg_dump", [call.connectionString, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
    const copy = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
    for (const raw of privateValues) for (const value of [raw, copy(raw), JSON.stringify(raw).slice(1, -1), copy(JSON.stringify(raw).slice(1, -1))]) {
      assert.equal(dump.includes(value), false);
    }
  }, { services: true, smtp: true, locations: true });
});
