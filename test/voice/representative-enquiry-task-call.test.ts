import assert from "node:assert/strict";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { representativeCallOwnerFixture, representativeInputOptions } from "../support/representative-call-owner.ts";
import { syntheticTaskSequence } from "../support/call-task-sequence.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";

test("E2E-388 signed call checks two patients appointments with separate private proofs, played read receipts and no mutation", { timeout: 120_000 }, async () => {
  await withDisposablePostgres(async db => {
    const f = await representativeCallOwnerFixture({ multiplePatients: true, operation: "appointments.read" }); f.flow.dispose();
    const source = await syntheticTaskSequence({ ...f.flowConfig, representativeInput: representativeInputOptions(f) }, f.f.folder);
    await source.replace({ patientSelection: "independentlyVerifiedPatients" });
    let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
    try {
      call = await clinikoWorkflowVoiceFixture(db, source.config, flow => {
        const ordinary = createOpenAIClinicalIntentResolver({ apiKey: "synthetic", model: "synthetic", owner: flow, clinicDate: () => "2026-10-04",
          fetch: async () => { throw new Error("private identities cannot reach an ordinary model"); } });
        return async (turn, signal) => turn.text === "Appointments" ? ok({ kind: "appointmentEnquiry", from: verificationNow, to: "2026-10-09T06:00:00.000Z" })
          : ordinary(turn, signal);
      });
      let firstReceipt: unknown, firstOwner: typeof call.flow.representativeInputOwner;
      for (const [index, id] of (["43", "44"] as const).entries()) {
        const patient = f.r.patients.get(id)!;
        await call.turn(index === 0 ? "Check the appointment time for my husband" : "Check the appointment time for my son");
        if (index === 1) { assert.equal(firstOwner?.closed, true); assert.deepEqual((await call.state()).appointmentReads[0], firstReceipt); }
        const owner = call.flow.representativeInputOwner; assert.ok(owner); if (index === 0) firstOwner = owner;
        assert.equal(f.mail.length, index * 2); await call.mark(); await call.privateDigit("1");
        await call.mark(); await f.waitForMail(index * 2 + 1);
        for (const digit of `${f.mail.at(-1)!.code}#`) call.sendEvent({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
        await voiceUntil(() => call!.spoken.at(-1) === "Please say the patient's first name.", "private next patient field"); await call.mark();
        for (const field of [patient.first_name, patient.last_name, index === 0 ? "5 March 1982" : "28 February 2014"]) { await call.privateField(field); await call.mark(); }
        await call.privateDigit("1"); await call.mark(); await f.waitForMail(index * 2 + 2); assert.equal(f.mail.at(-1)!.email, patient.email);
        await call.verify(f.mail.at(-1)!.code); assert.equal(await call.flow.representativeStartupAvailable("appointments.read"), false);
        await call.turn("Appointments"); assert.equal((await call.state()).appointmentReads.at(-1)!.status, "shown");
        assert.match(call.spoken.at(-1)!, index === 0 ? /Thursday 8 October at 3:00 pm/i : /Thursday 8 October at 4:00 pm/i);
        assert.equal(await call.flow.representativeStartupAvailable("appointments.read"), false, "queued read speech is not completion");
        await call.mark();
        if (index === 0) { firstReceipt = structuredClone((await call.state()).appointmentReads[0]); assert.equal(await call.flow.representativeStartupAvailable("appointments.read"), true); }
      }
      assert.equal(await call.flow.representativeStartupAvailable("appointments.read"), false, "task count denies a third patient");
      assert.equal(call.writes.length, 0); assert.equal(f.writes, 0); assert.equal(f.f.recalls.length, 0);
      assert.equal(Object.keys((await call.state()).actions).length, 0); assert.deepEqual((await call.state()).appointmentReads[0], firstReceipt);
      assert.equal(f.mail.length, 4); assert.equal(call.privateTranscripts.length, 6);
      const secrets = [...f.r.patients.values()].flatMap(row => [row.first_name, row.last_name, row.date_of_birth, row.email]).concat(f.mail.map(row => row.code));
      const publicData = JSON.stringify([call.modelTurns, call.transcripts, await call.state(), await call.flow.publicIntentContext()]);
      for (const secret of secrets) assert.equal(publicData.includes(secret), false);
      assert.deepEqual(resultValue(await scanPatientDataCanaries(db, secrets.map((value, i) => ({ label: `enquiry_patients_${i}`, value })))), []);
    } finally { await call?.close(); await f.close(); }
  });
});
