import assert from "node:assert/strict";
import test from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 };
for (const lost of [false, true]) test(`E2E-360 compiled caller practitioner directory ${lost ? "retains an uncertain single attempt" : "confirms one named move"}`, options, async () => {
  await withClinicalRunner("reschedule", async call => {
    const play = async (text: string) => { await call.say(text); await call.mark(); };
    await play("I need to move an appointment."); await call.verify();
    await play("Show my existing appointments from October 4 through October 9."); await play("The first appointment.");
    await play("Show move times on October 8."); assert.match(call.spoken.at(-1)!, /Demo Practitioner/);
    await play("Who else can I see?"); assert.match(call.spoken.at(-1)!, /Option two, Demo Destination/);
    await play("With Demo Destination please."); assert.match(call.spoken.at(-1)!, /chosen Demo Destination/);
    assert.equal(call.mutations.length, 0); await play("Show move times on October 8.");
    await play("Option one."); assert.match(call.spoken.at(-1)!, /Demo Destination/); assert.equal(call.mutations.length, 0);
    if (lost) call.child.send({ kind: "loseWrite" });
    await call.say("Yes.");
    const moves = call.mutations.filter(m => m.method === "PATCH"); assert.equal(moves.length, 1);
    assert.equal(moves[0]!.path, "/v1/individual_appointments/91");
    assert.deepEqual(moves[0]!.body, { starts_at: "2026-10-08T05:00:00.000Z", ends_at: null, practitioner_id: "23" });
    if (lost) {
      assert.notEqual(call.spoken.at(-1), "Your appointment move is confirmed.");
      await call.mark(); await call.say("Yes.", false, true);
      assert.equal(call.mutations.filter(m => m.method === "PATCH").length, 1);
    } else assert.equal(call.spoken.at(-1), "Your appointment move is confirmed.");
    assert.equal(call.messages.some(message => message.kind === "modelTurn" && message.text === "With Demo Destination please."), false);
    await call.scan([...verificationCanaries.slice(0, 2), call.messages.find(m => m.kind === "verificationEmail")!.code!]);
  }, { smtp: true, practitionerMove: "directory" });
});
