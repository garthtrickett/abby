import assert from "node:assert/strict";
import test from "node:test";
import { previousPractitionerFixture } from "../support/previous-practitioner.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

test("E2E-351 signed previous-practitioner reads use independent history proof and subject-bound fresh booking", { timeout: 180000 }, async () => {
  await withDisposablePostgres(async db => {
    const cases = ["book", "empty", "ambiguous", "cancelled", "noShow", "foreignPatient", "foreignBusiness", "unsorted", "future", "server",
      "revoked", "duringRead", "permission", "subjectChanged", "bookProof"] as const;
    let next = 0; const failures: unknown[] = [];
    await Promise.all(Array.from({ length: 3 }, async () => {
      for (;;) {
        const mode = cases[next++]; if (!mode) return;
        const f = await previousPractitionerFixture(); f.flow.dispose();
        let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
        const models: string[] = [];
        try {
          if (mode === "empty") f.setRows([]);
          if (mode === "ambiguous") f.setRows([f.row("71"), f.row("72", "24")]);
          if (mode === "cancelled" || mode === "noShow") f.setRows([{ ...f.row("73", "24", "2026-10-02T04:00:00.000Z"),
            ...(mode === "cancelled" ? { cancelled_at: "2026-10-01T05:00:00.000Z" } : { did_not_arrive: true }) }, f.row("71")]);
          if (mode === "foreignPatient") f.setRows([{ ...f.row("71"), patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/999" } } }]);
          if (mode === "foreignBusiness") f.setRows([{ ...f.row("71"), business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/12" } } }]);
          if (mode === "unsorted") f.setRows([f.row("70", "22", "2026-09-20T04:00:00.000Z"), f.row("71")]);
          if (mode === "future") f.setRows([f.row("71", "23", "2026-10-08T04:00:00.000Z")]);
          if (mode === "server") f.setFailure();
          call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model",
            clinicDate: () => "2026-10-04", fetch: async (_input, init) => {
              const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText; models.push(text); assert.equal(text, "Show times on October 8.");
              return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text",
                text: JSON.stringify({ kind: "menu", operation: null, stage: null, from: "2026-10-08", to: "2026-10-08", choice: null }) }] }] });
            } }), { appointmentTypeMetadata: { "34": { durationMinutes: 60 } } });
          const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
          if (mode === "bookProof") {
            await play("Book a 60-minute initial Physiotherapy appointment.");
            await voiceUntil(() => f.mail.length === 1, "existing booking proof"); await call.verify(f.mail[0]!.code);
          }
          const mailsBefore = f.mail.length;
          await play("Who did I see last time?"); assert.equal(f.historyReads, 0); assert.equal(call.writeRequests.length, 0);
          await voiceUntil(() => f.mail.length === mailsBefore + 1, "independent history read verification"); await call.verify(f.mail[mailsBefore]!.code);
          if (mode === "revoked") await f.replaceHistory({ enabled: false });
          if (mode === "permission") f.setPermission(false);
          if (mode === "duringRead") f.setOnHistoryRead(async () => f.replaceHistory({ enabled: false }));
          await play("Who did I see last time?");
          assert.equal(models.length, 0, "history requests/results must remain outside the classifier"); assert.equal(call.writeRequests.length, 0);
          if (["foreignPatient", "foreignBusiness", "unsorted", "future", "server", "revoked", "duringRead", "permission"].includes(mode)) {
            assert.match(call.spoken.at(-1)!, /can't check previous practitioners/); continue;
          }
          if (mode === "empty") { assert.match(call.spoken.at(-1)!, /couldn't find.*3650-day search period/); continue; }
          if (mode === "ambiguous") { assert.match(call.spoken.at(-1)!, /can't identify a single practitioner/); continue; }
          assert.match(call.spoken.at(-1)!, /past appointment record.*3650-day.*Demo B/);
          assert.ok(f.queries.every(filters => filters.includes(`patient_id:=${verificationCanaries[2]}`) && filters.includes("business_id:=11")));
          if (mode === "subjectChanged") f.setCandidate("999");
          await play("I'd like to book an appointment."); await play("Physiotherapy."); await play("Initial assessment."); await play("One hour.");
          await play("Demo B.");
          if (mode === "subjectChanged") {
            // Submitting the old read code privately waits for the actual new
            // verification startup. No old read proof can become booking proof.
            assert.equal((await call.flow.submitCode(f.mail[mailsBefore]!.code)).verified, false);
            assert.equal(f.mail.length, mailsBefore + 1); assert.equal(call.writeRequests.length, 0);
            assert.ok(f.traffic.every(path => !path.includes("/patients/999"))); continue;
          }
          await voiceUntil(() => f.mail.length === mailsBefore + 2, "separate booking verification"); await call.verify(f.mail[mailsBefore + 1]!.code);
          await play("Show times on October 8."); await play("The first time, please."); assert.match(call.spoken.at(-1)!, /Physiotherapy initial.*Demo B.*60 minutes/);
          await play("Yes."); assert.equal(call.writeRequests.length, 1); assert.equal(call.writeRequests[0]!.body.practitioner_id, "23");
          assert.equal(call.writeRequests[0]!.body.appointment_type_id, "34");
          assert.ok(f.permissions.includes("appointments.read") && f.permissions.includes("appointments.book"));
          await play("Who did I see last time?"); assert.equal(call.writeRequests.length, 1); assert.equal(f.mail.length, mailsBefore + 2);
        } catch (error) { failures.push(new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
        finally { await call?.close(); await f.close(); }
      }
    }));
    if (failures.length) throw new AggregateError(failures, failures.map(String).join("\n"));
    assert.deepEqual(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `history_${index}`, value }))), { ok: true, value: [] });
  });
});
