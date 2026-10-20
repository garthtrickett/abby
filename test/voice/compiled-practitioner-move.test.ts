import assert from "node:assert/strict";
import { test } from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 };
for (const practitionerMove of ["changedTime", "sameTime"] as const) test(`E2E-359 compiled ${practitionerMove} move confirms the new practitioner and patches the same appointment once`, options, async () => {
  await withClinicalRunner("reschedule", async call => {
    const play = async (text: string) => { await call.say(text); await call.mark(); };
    await play("Start"); await call.verify(); await play("Source"); await play("Select source");
    await play("Destination"); assert.match(call.spoken.at(-1)!, /Demo Destination/);
    await call.say("Select destination"); assert.match(call.spoken.at(-1)!, /Demo Destination/);
    if (practitionerMove === "sameTime") assert.match(call.spoken.at(-1)!, /changing the practitioner/);
    assert.equal(call.mutations.length, 0); await call.mark(); await call.say("Yes");
    const moves = call.mutations.filter(m => m.method === "PATCH"); assert.equal(moves.length, 1);
    assert.equal(moves[0]!.path, "/v1/individual_appointments/91");
    assert.deepEqual(moves[0]!.body, { starts_at: practitionerMove === "sameTime" ? "2026-10-08T04:00:00.000Z" : "2026-10-08T06:00:00.000Z", ends_at: null, practitioner_id: "23" });
    assert.equal(call.mutations.some(m => m.method === "POST" && m.path === "/v1/individual_appointments"), false);
    assert.equal(call.spoken.at(-1), "Your appointment move is confirmed.");
    await call.scan([...verificationCanaries.slice(0, 2), call.messages.find(m => m.kind === "verificationEmail")!.code!]);
  }, { smtp: true, practitionerMove });
});

test("E2E-359 compiled uncertain practitioner move retains one attempted PATCH and cannot claim completion", options, async () => {
  await withClinicalRunner("reschedule", async call => {
    const play = async (text: string) => { await call.say(text); await call.mark(); };
    await play("Start"); await call.verify(); await play("Source"); await play("Select source");
    await play("Destination"); await play("Select destination");
    call.child.send({ kind: "loseWrite" }); await call.say("Yes");
    assert.equal(call.mutations.filter(m => m.method === "PATCH").length, 1); assert.notEqual(call.spoken.at(-1), "Your appointment move is confirmed.");
    await call.mark(); await call.say("Yes", false, true); assert.equal(call.mutations.filter(m => m.method === "PATCH").length, 1);
  }, { smtp: true, practitionerMove: "changedTime" });
});
