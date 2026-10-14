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

test("E2E-387 signed two-person task sequence privately re-verifies one pinned caller and each patient before separate played native bookings", { timeout: 120_000 }, async () => {
  await withDisposablePostgres(async db => {
    const f = await representativeCallOwnerFixture({ multiplePatients: true }); f.flow.dispose();
    const source = await syntheticTaskSequence({ ...f.flowConfig, representativeInput: representativeInputOptions(f) }, f.f.folder);
    await source.replace({ patientSelection: "independentlyVerifiedPatients" });
    let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
    try {
      call = await clinikoWorkflowVoiceFixture(db, source.config, flow => {
        const ordinary = createOpenAIClinicalIntentResolver({ apiKey: "synthetic", model: "synthetic", owner: flow, clinicDate: () => "2026-10-04",
          fetch: async () => { throw new Error("private patient fields cannot reach a model"); } });
        return async (turn, signal) => turn.text === "Times" ? ok({ kind: "bookingMenu", from: "2026-10-08", to: "2026-10-08" })
          : turn.text === "First option" ? ok({ kind: "bookingChoice", choice: 1 }) : turn.text === "Second option" ? ok({ kind: "bookingChoice", choice: 2 })
            : turn.text === "Yes" ? ok({ kind: "affirm" }) : ordinary(turn, signal);
      }, { maximumWrites: 2 });
      let firstReceipt: unknown, firstOwner: typeof call.flow.representativeInputOwner;
      for (const [index, id] of (["43", "44"] as const).entries()) {
        const patient = f.r.patients.get(id)!;
        await call.turn(index === 0 ? "Book an appointment for my daughter" : "Book an appointment for my son");
        if (index === 1) { assert.equal(firstOwner?.closed, true); assert.deepEqual(Object.values((await call.state()).actions)[0], firstReceipt); }
        const owner = call.flow.representativeInputOwner; assert.ok(owner); if (index === 0) firstOwner = owner;
        assert.equal(f.mail.length, index * 2); await call.mark(); await call.privateDigit("1");
        assert.match(call.spoken.at(-1)!, /First verify yourself/); await call.mark(); await f.waitForMail(index * 2 + 1);
        for (const digit of `${f.mail.at(-1)!.code}#`) call.sendEvent({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
        await voiceUntil(() => call!.spoken.at(-1) === "Please say the patient's first name.", "fresh private patient collection"); await call.mark();
        for (const field of [patient.first_name, patient.last_name, index === 0 ? "5 March 1982" : "28 February 2014"]) { await call.privateField(field); await call.mark(); }
        await call.privateDigit("1"); assert.match(call.spoken.at(-1)!, /Now verify/);
        await call.mark(); await f.waitForMail(index * 2 + 2); assert.equal(f.mail.at(-1)!.email, patient.email);
        await call.verify(f.mail.at(-1)!.code); assert.equal((await call.flow.publicIntentContext())?.lastAction, null);
        await call.turn("Times"); await call.mark(); await call.turn(index === 0 ? "First option" : "Second option");
        assert.equal(call.writes.length, index); await call.mark(); await call.turn("Yes");
        assert.equal(call.writes.length, index + 1); assert.equal(call.spoken.at(-1), "Your booking is confirmed.");
        assert.equal(Object.values((await call.state()).actions).at(-1)!.status, "committed");
        if (index === 0) firstReceipt = structuredClone(Object.values((await call.state()).actions)[0]); await call.mark();
      }
      assert.deepEqual(call.writeRequests.map(row => row.body.patient_id), ["43", "44"]); assert.equal(f.mail.length, 4);
      assert.deepEqual(Object.values((await call.state()).actions)[0], firstReceipt); assert.equal(call.privateTranscripts.length, 6);
      const secrets = [...f.r.patients.values()].flatMap(row => [row.first_name, row.last_name, row.date_of_birth, row.email]).concat(f.mail.map(row => row.code));
      const publicData = JSON.stringify([call.modelTurns, call.transcripts, await call.state(), await call.flow.publicIntentContext()]);
      for (const secret of secrets) assert.equal(publicData.includes(secret), false);
      assert.deepEqual(resultValue(await scanPatientDataCanaries(db, secrets.map((value, i) => ({ label: `multi_patient_${i}`, value })))), []);
      await call.close(); assert.equal(firstOwner?.closed, true); call = undefined;
    } finally { await call?.close(); await f.close(); }
  });
});
