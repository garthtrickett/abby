import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { servicePractitionerFixture } from "../support/service-practitioner-preference.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

test("E2E-349 signed approved gender/name/any preferences bind the exact eligible writer set without fallback", { timeout: 180_000 }, async () => {
  await withDisposablePostgres(async db => {
    const cases = ["female", "male", "named", "any", "unknownMetadata", "unknownGender", "unplayed", "missingMember", "beforeConfirm", "changedGender",
      "afterReview", "groupFailure", "groupEmpty", "groupTie", "correction", "lost"] as const;
    let next = 0; const failures: unknown[] = [];
    await Promise.all(Array.from({ length: 3 }, async () => {
      for (;;) {
        const mode = cases[next++]; if (!mode) return;
        const f = await servicePractitionerFixture(); f.flow.dispose();
        let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
        const models: string[] = [];
        try {
          if (mode === "unknownMetadata") await f.replaceServices({ services: f.serviceApproval.services.map(service => ({ ...service,
            practitioners: service.practitioners.map(({ gender: _gender, ...member }) => member) })) });
          if (mode === "missingMember") await f.revokeMember(2);
          if (mode === "groupFailure") f.setFailure("23");
          if (mode === "groupEmpty") { f.setStarts("23", []); f.setStarts("24", []); }
          if (mode === "groupTie") f.setStarts("23", ["2026-10-08T01:00:00.000Z"]);
          call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model",
            clinicDate: () => "2026-10-04", fetch: async (_input, init) => {
              const value = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText; models.push(value);
              assert.equal(value, "Show times on October 8.");
              return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text",
                text: JSON.stringify({ kind: "menu", operation: null, stage: null, from: "2026-10-08", to: "2026-10-08", choice: null }) }] }] });
            } }), { lostWrite: mode === "lost", appointmentTypeMetadata: { "34": { durationMinutes: 60 } } });
          const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
          await play("I'd like to book an appointment."); await play("Physiotherapy."); await play("Initial assessment.");
          await call.turn("One hour."); assert.match(call.spoken.at(-1)!, /practitioner preference.*Demo Practitioner.*Demo B.*Demo C/);
          assert.equal(f.mail.length, 0);
          if (mode === "unplayed") {
            await call.turn("A female practitioner, please.", { interrupt: true }); await call.mark();
            assert.match(call.spoken.at(-1)!, /choose the service.*again/); assert.equal(f.mail.length, 0); continue;
          }
          await call.mark();
          await play(mode === "male" ? "A male practitioner, please." : mode === "named" ? "Demo B, please." : mode === "any" ? "Any."
            : mode === "unknownGender" ? "A non-binary practitioner, please." : "A female practitioner, please.");
          assert.equal(models.length, 0, "approved preferences must not be inferred by the classifier");
          if (["unknownMetadata", "unknownGender", "missingMember"].includes(mode)) {
            assert.equal(f.mail.length, 0); assert.equal(call.writeRequests.length, 0); await play("Yes.");
            assert.equal(f.mail.length, 0); assert.equal(call.writeRequests.length, 0); continue;
          }
          await voiceUntil(() => f.mail.length === 1, "preference verification"); await call.verify(f.mail[0]!.code);
          await play("Show times on October 8.");
          if (["groupFailure", "groupEmpty"].includes(mode)) {
            assert.doesNotMatch(call.spoken.at(-1)!, /option one/); await play("Yes."); assert.equal(call.writeRequests.length, 0); continue;
          }
          const preferred = mode === "male" ? "Demo Practitioner" : mode === "named" || mode === "groupTie" ? "Demo B" : "Demo C";
          assert.match(call.spoken.at(-1)!, new RegExp(`with ${preferred}`));
          const reads = f.traffic.filter(path => path.endsWith("/available_times"));
          if (mode === "male") assert.ok(reads.every(path => path.includes("/practitioners/22/")));
          else if (mode === "named") assert.ok(reads.every(path => path.includes("/practitioners/23/")));
          else if (mode !== "any") assert.ok(reads.every(path => !path.includes("/practitioners/22/")), "female availability cannot read the male default");
          assert.ok(reads.length > 0);
          await play("The first time, please."); let action = Object.values((await call.state()).actions).at(-1)!;
          assert.match(call.spoken.at(-1)!, new RegExp(`Physiotherapy initial.*${preferred}.*60 minutes`));
          if (mode === "correction") {
            const previous = action.key; await play("I prefer a male physiotherapist.");
            assert.equal((await call.state()).actions[previous]?.status, "canceled"); assert.equal(call.writeRequests.length, 0);
            await voiceUntil(() => f.mail.length === 2, "changed preference fresh verification"); await call.verify(f.mail[1]!.code);
            await play("Show times on October 8."); await play("The first time, please."); action = Object.values((await call.state()).actions).at(-1)!;
            assert.match(call.spoken.at(-1)!, /Physiotherapy initial.*Demo Practitioner.*60 minutes/);
          }
          if (mode === "changedGender") await f.replaceServices({ services: f.serviceApproval.services.map(service => ({ ...service,
            practitioners: service.practitioners.map(member => member.practitionerId === "24" ? { ...member, gender: "male" as const } : member) })) });
          if (mode === "beforeConfirm") await f.replaceServices({ enabled: false });
          if (mode === "afterReview") f.setOnRecall(async () => f.replaceServices({ enabled: false }));
          await play("Yes."); const blocked = mode === "beforeConfirm" || mode === "afterReview" || mode === "changedGender";
          assert.equal(call.writeRequests.length, blocked ? 0 : 1);
          assert.equal((await call.state()).actions[action.key]?.status, blocked ? "rejected" : mode === "lost" ? "uncertain" : "committed");
          if (!blocked) {
            assert.equal(call.writeRequests[0]!.body.practitioner_id, mode === "male" || mode === "correction" ? "22" : mode === "named" || mode === "groupTie" ? "23" : "24");
            assert.equal(call.writeRequests[0]!.body.appointment_type_id, "34"); assert.equal(call.writeRequests[0]!.body.business_id, "11");
            await play("I prefer a male physiotherapist."); assert.equal(call.writeRequests.length, 1); assert.equal(f.mail.length, mode === "correction" ? 2 : 1);
          }
        } catch (error) { failures.push(new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
        finally { await call?.close(); await f.close(); }
      }
    }));
    if (failures.length) throw new AggregateError(failures, failures.map(String).join("\n"));
    const canaries = [...verificationCanaries, "I prefer a male physiotherapist.", "A female practitioner, please."];
    assert.deepEqual(await scanPatientDataCanaries(db, canaries.map((value, index) => ({ label: `preference_${index}`, value }))), { ok: true, value: [] });
  });
});
