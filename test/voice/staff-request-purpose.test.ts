import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { clinikoStaffCallFlowFixture } from "../support/cliniko-staff-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { staffRequestSubjects, staffRequestSubjectLabel, staffRequestSubjectLimit, staffSubjectUnavailable } from "../../src/core/staff-request-subject.ts";
import type { StaffRequestSubject } from "../../src/core/staff-request-subject.ts";
import { staffPurposeQuestions } from "../support/staff-request-purpose.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("E2E-323 a verified invoice request preserves its purpose in Cliniko without reading or sending a billing document", { timeout: 60_000 }, async () => {
  await withDisposablePostgres(async db => {
    const f = await clinikoStaffCallFlowFixture(); f.flow.dispose();
    let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
    try {
      call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04",
        fetch: async () => Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ kind: "unsupported", operation: null, stage: null, from: null, to: null, choice: null }) }] }] }) }));
      await call.turn("Could the clinic send my paid receipt again?"); await call.mark();
      await voiceUntil(() => f.mail.length === 1, "independent staff verification"); await call.verify(f.mail[0]!.code);
      await call.turn("Please send that request."); await call.mark();
      assert.equal(f.staffPosts, 1); assert.equal(call.writes.length, 0);
      assert.match(String(f.recalls[0]?.notes), /"requestSubject":"invoiceCopy"/);
      assert.match(call.spoken.at(-1)!, /invoice.*saved.*billing document/);
      assert.ok(!f.traffic.some(path => /invoices|invoice_items|payments|patient_communications/.test(path)));
    } finally { await call?.close(); await f.close(); }
  });
});

test("E2E-323 signed purpose requests require independent verification and preserve exact saved/uncertain receipts without billing or waitlist actions", { timeout: 180_000 }, async () => {
  await withDisposablePostgres(async db => {
    const modes = ["unavailable", "unapproved", "saved", "lost", "revoked", "changed", "expired"] as const;
    const cases: { subject: StaffRequestSubject; mode: string }[] = staffRequestSubjects.flatMap(subject => modes.map(mode => ({ subject, mode })));
    cases.push(...["model", "modelAfterCode", "differentPurpose", "oldProposal", "committed", "quoted", "negated", "interruptedPrompt"].map(mode => ({ subject: "invoiceCopy" as const, mode })));
    const run = async ({ subject, mode }: typeof cases[number]) => {
      const f = await clinikoStaffCallFlowFixture({ approved: mode !== "unapproved", lostResponse: mode === "lost" }); f.flow.dispose();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      const bodies: string[] = []; let models = 0;
      try {
        const { staff: _staff, ...withoutStaff } = f.flowConfig;
        call = await clinikoWorkflowVoiceFixture(db, mode === "unavailable" ? withoutStaff : f.flowConfig, owner =>
          createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04",
            fetch: async (_url, init) => {
              models++; bodies.push(String(init?.body));
              const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
              const book = text === "I need to book an appointment.", menu = text === "What times are available on October 8?";
              const cue = text === "Could somebody arrange another copy of my settled account paperwork?" || text === "Please explain what you found.";
              const decision = { kind: book ? "workflow" : menu ? "menu" : cue ? "invoiceCopy" : "unsupported", operation: book ? "book" : null,
                stage: null, from: menu ? "2026-10-08" : null, to: menu ? "2026-10-08" : null, choice: null };
              return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
            } }));
        const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
        if (["oldProposal", "committed"].includes(mode)) {
          await play("I need to book an appointment."); await voiceUntil(() => f.mail.length === 1, "clinical-only email proof"); await call.verify(f.mail[0]!.code);
          await play("What times are available on October 8?"); await play("The first time, please.");
          if (mode === "committed") await play("Yes");
        }
        const before = await call.state(), writes = call.writes.length, count = models, staffPosts = f.staffPosts;
        const question = mode === "model" ? "Could somebody arrange another copy of my settled account paperwork?" : mode === "quoted" ? "My friend asked 'could the clinic send my paid receipt again' yesterday." :
          mode === "negated" ? "I don't need an invoice copy or a refund." : staffPurposeQuestions[subject];
        await call.turn(question); if (mode !== "interruptedPrompt") await call.mark();
        if (["quoted", "negated"].includes(mode)) { assert.equal(f.mail.length, 0); assert.equal(f.staffPosts, 0); assert.equal(call.flow.verificationRequired, false); assert.equal(models, count + 1); return; }
        if (["unavailable", "unapproved"].includes(mode)) { assert.equal(call.spoken.at(-1), staffSubjectUnavailable(subject)); assert.equal(f.mail.length, 0); assert.equal(f.staffPosts, 0); return; }
        assert.match(call.spoken.at(-1)!, /Before saving a staff request/); assert.ok(call.spoken.at(-1)!.includes(staffRequestSubjectLabel[subject]));
        assert.ok(call.spoken.at(-1)!.includes(staffRequestSubjectLimit[subject]));
        await voiceUntil(() => f.mail.length === (["oldProposal", "committed"].includes(mode) ? 2 : 1), "separate staff email proof"); assert.equal(f.staffPosts, staffPosts, `${subject}/${mode}: no task before staff code`);
        if (mode === "interruptedPrompt") { await call.close(); call = undefined; assert.equal(f.staffPosts, 0); return; }
        await call.verify(f.mail.at(-1)!.code);
        if (mode === "revoked") f.denyStaffPermission();
        if (mode === "changed") await f.replaceStaffApproval({ reviewCadenceMinutes: 45 });
        if (mode === "expired") await f.replaceStaffApproval({ effectiveUntil: "2026-10-04T06:00:00.000Z" });
        await play(mode === "modelAfterCode" ? "Please explain what you found." : "Please send that request.");
        if (["revoked", "changed", "expired", "modelAfterCode"].includes(mode)) { assert.match(call.spoken.at(-1)!, /can't .*request/); assert.equal(f.staffPosts, 0); assert.equal(Object.keys((await call.state()).staffItems).length, 0); return; }
        const state = await call.state(), item = Object.values(state.staffItems).at(-1)!; assert.ok(item);
        assert.equal(item.requestSubject, subject); assert.equal(f.staffPosts, staffPosts + 1); assert.equal(call.writes.length, writes);
        assert.match(String(f.recalls.at(-1)?.notes), new RegExp(`"requestSubject":"${subject}"`));
        assert.ok(call.spoken.at(-1)!.includes(staffRequestSubjectLabel[subject])); assert.ok(call.spoken.at(-1)!.includes(staffRequestSubjectLimit[subject]));
        assert.equal(item.status, mode === "lost" ? "needsReview" : "open");
        assert.match(call.spoken.at(-1)!, mode === "lost" ? /can't confirm whether.*saved or received.*won't send.*again/ : /was saved.*can't confirm.*read/);
        const saved = await call.state();
        await play(mode === "differentPurpose" ? staffPurposeQuestions.chargeReview : "Has somebody received my message?");
        assert.equal(f.staffPosts, staffPosts + 1); assert.equal(call.writes.length, writes);
        if (mode === "lost") {
          const observed = Object.values((await call.state()).staffItems).at(-1)!;
          assert.equal(observed.status, "open", "an exact Cliniko observation may recover saved status, never human receipt");
          assert.equal(observed.requestSubject, subject); assert.equal(observed.key, item.key);
          assert.match(call.spoken.at(-1)!, /can't confirm whether.*saved or received|was saved.*can't confirm.*read/);
          await play("Has somebody received my message?");
          assert.match(call.spoken.at(-1)!, /was saved.*can't confirm.*read/); assert.equal(f.staffPosts, staffPosts + 1);
        } else assert.deepEqual((await call.state()).staffItems, saved.staffItems);
        if (mode === "differentPurpose") { assert.ok(call.spoken.at(-1)!.includes(staffRequestSubjectLabel.invoiceCopy)); assert.ok(call.spoken.at(-1)!.includes(staffSubjectUnavailable("chargeReview"))); }
        if (mode === "oldProposal") { assert.ok(Object.values((await call.state()).actions).every(action => action.status === "canceled")); await play("Yes"); assert.equal(call.writes.length, 0); }
        if (mode === "committed") assert.deepEqual((await call.state()).actions, before.actions);
        assert.ok(!f.traffic.some(path => /invoices|invoice_items|payments|patient_communications|waiting_lists/.test(path)));
        assert.ok(verificationCanaries.every(canary => bodies.every(body => !body.includes(canary))));
        assert.ok(!call.transcripts.includes(f.mail.at(-1)!.code));
      } catch (error) { throw new Error(`${subject}/${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      finally { await call?.close(); await f.close(); }
    };
    let next = 0; const failures: unknown[] = [];
    const settled = await Promise.allSettled(Array.from({ length: 4 }, async () => { for (;;) { const item = cases[next++]; if (!item) return; try { await run(item); } catch (error) { failures.push(error); } } }));
    for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, [...verificationCanaries, "invoiceCopy", "chargeReview", "waitlistInterest"].map((value, i) => ({ label: `staff_purpose_${i}`, value })))), []);
  });
});
