import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { ok } from "../../src/core/model.ts";
import { bookingCallFlowFixture, cancellationCallFlowFixture, reschedulingCallFlowFixture, intakeCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { intakeDraft } from "../support/intake-edge.ts";

describe("isolated signed clinical call workflows", { concurrency: 2 }, () => {

test("E2E-299 signed Cliniko workflows run concurrently through actual HTTP/WS, private codes, spoken menus and played confirmations", { timeout: 120_000, concurrency: 3 }, async t => {
  await withDisposablePostgres(async db => {
    let activeCalls = 0, maxActiveCalls = 0;
    const cases = (["book", "cancel", "reschedule"] as const).flatMap(operation => [false, true].map(lostWrite => ({ operation, lostWrite })));
    await Promise.all(cases.map(({ operation, lostWrite }) => t.test(`${operation}: ${lostWrite ? "lost response" : "confirmed"}`, { concurrency: true }, async () => {
      const f = operation === "book" ? await bookingCallFlowFixture() : operation === "cancel" ? await cancellationCallFlowFixture() : await reschedulingCallFlowFixture();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      f.flow.dispose();
      try {
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, flow => async turn => {
          if (turn.text === "Yes") return ok({ kind: "affirm" });
          if (turn.text === "Start") return ok({ kind: "workflow", operation });
          if (operation === "book") return turn.text === "Times" ? ok({ kind: "bookingMenu", from: "2026-10-08", to: "2026-10-08" }) : ok({ kind: "bookingChoice", choice: 2 });
          if (operation === "reschedule") return turn.text === "Source" || turn.text === "Destination"
            ? ok({ kind: "reschedulingMenu", stage: turn.text === "Source" ? "targets" : "offers", from: turn.text === "Source" ? verificationNow : "2026-10-08", to: turn.text === "Source" ? "2026-10-09T06:00:00.000Z" : "2026-10-08" })
            : ok({ kind: "reschedulingChoice", stage: turn.text === "Select source" ? "targets" : "offers", choice: turn.text === "Select source" ? 1 : 2 });
          const grant = await flow.cancellationProof(); assert.ok(grant);
          return turn.text === "Appointments" ? ok({ kind: "appointments", verificationRef: grant.verificationRef, from: verificationNow, to: "2026-10-09T06:00:00.000Z" })
            : ok({ kind: "cancel", verificationRef: grant.verificationRef, targetRef: "selected" });
        }, { lostWrite });
        maxActiveCalls = Math.max(maxActiveCalls, ++activeCalls);
        await call.turn("Start"); assert.match(call.spoken.at(-1)!, /six-digit code.*keypad/); await call.mark();
        await voiceUntil(() => f.mail.length === 1, "synthetic verification email"); const frames = call.transcriptionFrames;
        // Spoken code audio is discarded, rather than added to the ordinary transcript queue.
        for (let i = 0; i < 7; i++) call.media(i < 2);
        await call.verify(f.mail[0]!.code);
        assert.equal(call.transcriptionFrames, frames, "code audio and fresh quiet frames never reach transcription");
        if (operation === "book") { await call.turn("Times"); await call.mark(); await call.turn("Second option"); }
        if (operation === "cancel") { await call.turn("Appointments"); await call.mark(); await call.turn("Cancel this appointment"); }
        if (operation === "reschedule") {
          await call.turn("Source"); await call.mark(); await call.turn("Select source"); await call.mark();
          await call.turn("Destination"); await call.mark(); await call.turn("Select destination");
        }
        assert.ok(call.transcriptionFrames > frames); assert.equal(call.writes.length, 0);
        const proposed = Object.values((await call.state()).actions).at(-1)!; assert.equal(proposed.status, "awaitingConfirmation");
        assert.match(call.spoken.at(-1)!, operation === "book" ? /Physiotherapy.*Demo Practitioner.*30 minutes/ : /cancel|reschedul|move/i);
        await call.mark(); await call.turn("Yes");
        assert.equal(call.writes.length, 1); assert.equal(Object.values((await call.state()).actions).at(-1)!.status, lostWrite ? "uncertain" : "committed");
        if (lostWrite) {
          assert.match(call.spoken.at(-1)!, /can't confirm|couldn't confirm|not confirmed|unconfirmed/i);
          assert.equal(call.spoken.at(-1)!.includes("is confirmed"), false);
          // Deliberately wrong classifier suggestion: no pending action exists to affirm.
          await call.mark(); await call.turn("Yes", { expectedFailure: "confirmationMissing" }); assert.equal(call.writes.length, 1, "an uncertain write cannot be replayed by affirmation");
        } else assert.equal(call.spoken.at(-1), operation === "book" ? "Your booking is confirmed." : operation === "cancel"
          ? "Your appointment cancellation is confirmed." : "Your appointment move is confirmed.");
        for (const secret of [f.mail[0]!.code, ...verificationCanaries.slice(0, 2)]) assert.equal(JSON.stringify([call.modelTurns, call.transcripts, call.spoken]).includes(secret), false);
        assert.equal(f.mail.length, 1);
      } finally { if (call) { await call.close(); activeCalls--; } await f.close(); }
    })));
    assert.ok(maxActiveCalls >= 2, "the signed calls must actually overlap");
    const scan = resultValue(await scanPatientDataCanaries(db, verificationCanaries.slice(0, 2).map((value, i) => ({ label: `voice_${i}`, value }))));
    assert.deepEqual(scan, []);
  });
});

test("E2E-300 signed new-patient voice registration privately collects fields, hears recovery terms, verifies code and separately books", { timeout: 90_000 }, async () => {
  await withDisposablePostgres(async db => {
    const f = await intakeCallFlowFixture(); f.flow.dispose();
    let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
    try {
      call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, flow => async turn => {
        if (turn.text === "Start") return ok({ kind: "workflow", operation: "intake" });
        if (turn.text === "Save") { const ref = flow.intakeDraftRef; assert.ok(ref); return ok({ kind: "intake", draftRef: ref }); }
        if (turn.text === "Yes") return ok({ kind: "affirm" });
        return turn.text === "Times" ? ok({ kind: "bookingMenu", from: "2026-10-08", to: "2026-10-08" }) : ok({ kind: "bookingChoice", choice: 2 });
      });
      await call.turn("Start"); await call.mark(); await call.privateDigit("1");
      assert.match(call.spoken.at(-1)!, /kept in Cliniko.*saved without an appointment or a staff request.*will not retry automatically.*Contact the clinic/);
      assert.equal(f.mail.length, 0); assert.equal(f.provider.patientPosts, 0);
      await call.mark(); // Actual completion of the separately approved privacy/intake/recovery terms.
      await voiceUntil(() => call!.spoken.at(-1)!.includes("Press one to acknowledge"), "separate recovery acknowledgment prompt");
      await call.mark(); await call.privateDigit("1"); assert.equal(call.spoken.at(-1), "Please say your first name."); await call.mark();
      for (const text of [intakeDraft.firstName, intakeDraft.lastName, "21 June 1987", "private-intake-canary at example dot test"]) {
        await call.privateField(text); await call.mark();
      }
      assert.ok(call.spoken.some(text => text.includes(`date of birth ${intakeDraft.dateOfBirth}`) && text.includes(intakeDraft.email)), "the exact draft must be read back over the actual stream");
      await voiceUntil(() => f.mail.length === 1 && call!.spoken.at(-1)!.includes("six digits on the keypad"), "private code prompt"); await call.mark();
      const privateFinals = call.privateTranscripts.length; for (let i = 0; i < 7; i++) call.media(i < 2);
      await call.verify(f.mail[0]!.code); assert.equal(call.privateTranscripts.length, privateFinals, "code audio cannot enter even private field transcription");
      assert.equal(f.provider.patientPosts, 0); await call.turn("Save"); await call.mark(); await call.turn("Yes");
      assert.equal(f.provider.patientPosts, 1); assert.equal(call.writes.length, 0); assert.equal(f.provider.recalls.length, 0);
      await call.mark(); await call.turn("Times"); await call.mark(); await call.turn("Second option");
      assert.equal(call.writes.length, 0); await call.mark(); await call.turn("Yes");
      assert.equal(call.writes.length, 1); assert.equal(f.provider.recalls.length, 1); assert.equal(call.spoken.at(-1), "Your booking is confirmed.");
      const state = await call.state(); assert.deepEqual(Object.values(state.actions).map(action => action.status), ["committed", "committed"]);
      const ordinary = JSON.stringify([call.transcripts, call.modelTurns, state.callerMessages]);
      for (const secret of [intakeDraft.firstName, intakeDraft.lastName, intakeDraft.dateOfBirth, intakeDraft.email, f.mail[0]!.code]) assert.equal(ordinary.includes(secret), false);
      assert.equal(JSON.stringify(call.spoken).includes(f.mail[0]!.code), false);
      assert.deepEqual(resultValue(await scanPatientDataCanaries(db, [intakeDraft.firstName, intakeDraft.email, intakeDraft.dateOfBirth, f.mail[0]!.code]
        .map((value, i) => ({ label: `private_registration_${i}`, value })))), []);
    } finally { await call?.close(); await f.close(); }
  });
});

test("E2E-301 signed caller interruption and disconnect cannot commit an unplayed booking confirmation", { timeout: 90_000, concurrency: 2 }, async t => {
  await withDisposablePostgres(async db => {
    await Promise.all((["interrupt", "disconnect"] as const).map(cause => t.test(cause, { concurrency: true }, async () => {
      const f = await bookingCallFlowFixture(); f.flow.dispose();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      try {
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, () => async turn => turn.text === "Start" ? ok({ kind: "workflow", operation: "book" })
          : turn.text === "Times" ? ok({ kind: "bookingMenu", from: "2026-10-08", to: "2026-10-08" }) : ok({ kind: "bookingChoice", choice: 2 }));
        await call.turn("Start"); await call.mark(); await voiceUntil(() => f.mail.length === 1, "verification mail"); await call.verify(f.mail[0]!.code);
        await call.turn("Times"); await call.mark(); await call.turn("Second option");
        const action = Object.values((await call.state()).actions)[0]!; assert.equal(action.status, "awaitingConfirmation");
        if (cause === "interrupt") {
          await call.turn("Times", { interrupt: true });
          assert.equal((await call.state()).actions[action.key]!.status, "canceled");
          assert.match(call.spoken.at(-1)!, /option one.*option two/);
        } else {
          await call.close(); assert.equal(call.flow.workflow, undefined); assert.equal((await call.flow.submitCode(f.mail[0]!.code)).verified, false); call = undefined;
        }
        assert.equal(f.recalls.length, 0); assert.equal(call?.writes.length ?? 0, 0);
      } finally { await call?.close(); await f.close(); }
    })));
  });
});

test("E2E-302 private registration rejects premature consent and cleans up decline or disconnect without mail or patient writes", { timeout: 90_000, concurrency: 2 }, async t => {
  await withDisposablePostgres(async db => {
    await Promise.all((["decline", "disconnect"] as const).map(cause => t.test(cause, { concurrency: true }, async () => {
      const f = await intakeCallFlowFixture(); f.flow.dispose();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      try {
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, () => async () => ok({ kind: "workflow", operation: "intake" }));
        await call.turn("I am a new patient"); await call.mark(); await call.privateDigit("1");
        assert.equal(call.privateTranscripts.length, 0);
        // Neither a premature digit nor speech can acknowledge unplayed recovery terms.
        call.sendEvent({ event: "dtmf", dtmf: { track: "inbound_track", digit: "1" } });
        for (let frame = 0; frame < 7; frame++) call.media(frame < 2);
        await call.mark();
        await voiceUntil(() => call!.spoken.at(-1)!.includes("Press one to acknowledge"), "explicit private consent still required");
        assert.equal(call.spoken.some(text => text === "Please say your first name."), false);
        assert.equal(call.privateTranscripts.length, 0); assert.equal(f.mail.length, 0);
        const owner = call.flow;
        if (cause === "decline") {
          await call.mark(); call.sendEvent({ event: "dtmf", dtmf: { track: "inbound_track", digit: "*" } });
          await voiceUntil(() => owner.closed, "declined private owner closed");
        } else { await call.close(); call = undefined; }
        assert.equal(owner.closed, true); assert.equal(owner.intakeDraftRef, undefined);
        assert.equal(f.mail.length, 0); assert.equal(f.provider.patientPosts, 0); assert.equal(f.provider.bookingPosts, 0);
        assert.equal(f.provider.recalls.length, 0);
      } finally { await call?.close(); await f.close(); }
    })));
  });
});
});
