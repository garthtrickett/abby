import assert from "node:assert/strict";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { representativeCallOwnerFixture, representativeInputOptions } from "../support/representative-call-owner.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("E2E-386 signed ordinary representative booking privately verifies caller and patient before one played native booking", { timeout: 120_000 }, async () => {
  await withDisposablePostgres(async db => {
    const f = await representativeCallOwnerFixture(); f.flow.dispose();
    let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
    try {
      call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, representativeInput: representativeInputOptions(f) }, flow => {
        const ordinary = createOpenAIClinicalIntentResolver({ apiKey: "synthetic", model: "synthetic", owner: flow, clinicDate: () => "2026-10-04",
          fetch: async () => { throw new Error("representative startup cannot require model patient data"); } });
        return async (turn, signal) => turn.text === "Times" ? ok({ kind: "bookingMenu", from: "2026-10-08", to: "2026-10-08" })
          : turn.text === "First option" ? ok({ kind: "bookingChoice", choice: 1 }) : turn.text === "Yes" ? ok({ kind: "affirm" }) : ordinary(turn, signal);
      });
      await call.turn("Book an appointment for my daughter");
      assert.match(call.spoken.at(-1)!, /verify you as the caller.*privately collect/);
      assert.ok(call.flow.representativeInputOwner); assert.equal(f.mail.length, 0);
      await call.mark(); await call.privateDigit("1");
      assert.match(call.spoken.at(-1)!, /First verify yourself/); assert.equal(f.mail.length, 0);
      await call.mark(); await f.waitForMail(1);
      for (const digit of `${f.mail[0]!.code}#`) call.sendEvent({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
      await voiceUntil(() => call!.spoken.at(-1) === "Please say the patient's first name.", "private first patient field"); await call.mark();
      for (const field of [f.r.identity.firstName, f.r.identity.lastName, "5 March 1982"]) { await call.privateField(field); await call.mark(); }
      assert.match(call.spoken.at(-1)!, /Synthetic Subject Canaries/); assert.equal(f.mail.length, 1);
      await call.privateDigit("1"); assert.match(call.spoken.at(-1)!, /Now verify/); assert.equal(f.mail.length, 1);
      await call.mark(); await f.waitForMail(2); assert.equal(f.mail[1]!.email, "subject-one-private@example.test");
      const privateCount = call.privateTranscripts.length, ordinaryFrames = call.transcriptionFrames;
      for (let i = 0; i < 7; i++) call.media(i < 2);
      await call.verify(f.mail[1]!.code);
      assert.equal(call.privateTranscripts.length, privateCount); assert.equal(call.transcriptionFrames, ordinaryFrames);
      await call.turn("Times"); await call.mark(); await call.turn("First option"); assert.equal(call.writes.length, 0);
      assert.equal(Object.values((await call.state()).actions).at(-1)!.status, "awaitingConfirmation");
      await call.mark(); await call.turn("Yes"); assert.equal(call.writes.length, 1);
      assert.equal(call.writeRequests[0]!.body.patient_id, "43"); assert.equal(call.spoken.at(-1), "Your booking is confirmed.");
      const state = await call.state(); assert.equal(Object.values(state.actions).at(-1)!.status, "committed");
      const publicData = JSON.stringify([call.modelTurns, call.transcripts, state, await call.flow.publicIntentContext()]);
      const secrets = [f.r.identity.firstName, f.r.identity.lastName, f.r.identity.dateOfBirth, ...f.mail.flatMap(row => [row.email, row.code])];
      for (const secret of secrets) assert.equal(publicData.includes(secret), false, "private data cannot enter public state or intent");
      for (const message of f.mail) assert.equal(JSON.stringify(call.spoken).includes(message.code), false);
      assert.deepEqual(resultValue(await scanPatientDataCanaries(db, secrets.map((value, i) => ({ label: `representative_${i}`, value })))), []);
    } finally { await call?.close(); await f.close(); }
  });
});

test("E2E-386 signed private representative input ignores premature start keys and disconnects without verification delivery", { timeout: 90_000 }, async () => {
  await withDisposablePostgres(async db => {
    const f = await representativeCallOwnerFixture(); f.flow.dispose();
    let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
    try {
      call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, representativeInput: representativeInputOptions(f) }, flow =>
        createOpenAIClinicalIntentResolver({ apiKey: "synthetic", model: "synthetic", owner: flow, clinicDate: () => "2026-10-04",
          fetch: async () => { throw new Error("unexpected public model call"); } }));
      await call.turn("Book an appointment for my daughter");
      const marks = call.sent.filter(item => item.event === "mark").length;
      await call.privateKey("1"); assert.equal(call.sent.filter(item => item.event === "mark").length, marks);
      assert.equal(f.mail.length, 0); assert.deepEqual(call.privateTranscripts, []);
      await call.mark(); await call.privateDigit("1"); assert.match(call.spoken.at(-1)!, /First verify yourself/);
      assert.equal(f.mail.length, 0); const owner = call.flow.representativeInputOwner; assert.ok(owner);
      await call.close(); assert.equal(owner.closed, true); assert.equal(call.flow.closed, true);
      assert.equal(f.mail.length, 0); assert.equal(call.writes.length, 0); assert.deepEqual(call.privateTranscripts, []);
      assert.equal((await owner.submitCallerCode("000000")).verified, false); call = undefined;
    } finally { await call?.close(); await f.close(); }
  });
});
