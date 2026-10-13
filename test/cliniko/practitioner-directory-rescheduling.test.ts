import assert from "node:assert/strict";
import test from "node:test";
import { reschedulingSessionFixture } from "../support/rescheduling-session.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { PlayedPractitionerSelection } from "../../src/standalone/played-practitioner-selection.ts";
import { verificationNow } from "../support/caller-verification.ts";
import { reschedulingAuthorityFixture } from "../support/rescheduling-authority.ts";

const move = { fromPractitionerId: "22", toPractitionerId: "23", appointmentTypeId: "33", durationMinutes: 30 };
async function source(f: Awaited<ReturnType<typeof reschedulingSessionFixture>>) {
  await f.verify(); resultValue(await f.readMenu("targets")); await f.playPending();
  resultValue(await f.selectMenu("targets")); await f.playPending();
}

test("E2E-360 played practitioner choice retains source identity and reaches one named inspected move", async () => {
  const f = await reschedulingSessionFixture({ practitionerChoices: ["23"], practitionerMoves: [move] });
  try {
    await source(f); resultValue(await f.readMenu("offers"));
    assert.match((await f.state()).callerMessages.at(-1)!, /Demo Practitioner/); await f.playPending();
    resultValue(await f.readMenu("practitioners"));
    assert.match((await f.state()).callerMessages.at(-1)!, /Option one, Demo Practitioner; Option two, Demo Destination/);
    assert.equal(Object.keys((await f.state()).actions).length, 0); assert.equal(f.patches, 0);
    await f.playPending(); resultValue(await f.selectMenu("practitioners", 2));
    assert.match((await f.state()).callerMessages.at(-1)!, /chosen Demo Destination.*not been moved/);
    await f.playPending(); resultValue(await f.readMenu("offers", "fresh-destination-times"));
    assert.match((await f.state()).callerMessages.at(-1)!, /Demo Destination/);
    await f.playPending(); resultValue(await f.selectMenu("offers", 1));
    const state = await f.state(), action = Object.values(state.actions)[0]!;
    assert.equal(action.mutation.request.kind, "reschedule");
    if (action.mutation.request.kind !== "reschedule") throw new Error("expected move");
    assert.equal(action.mutation.request.target.appointmentRef, "91"); assert.equal(action.mutation.request.practitionerChange, true);
    const confirmation = state.presentations[action.presentationId]!; assert.equal(confirmation.kind, "speech");
    assert.match(confirmation.approvedText, /Demo Destination/); assert.equal(f.patches, 0);
    resultValue(await f.confirm()); resultValue(await f.drain()); assert.equal(f.patches, 1);
    assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
    const review = resultValue(decodeClinikoReview(f.recalls[0]!.notes));
    assert.equal(review.request.operation.kind, "reschedule");
    if (review.request.operation.kind === "reschedule") {
      assert.equal(review.request.operation.practitionerId, "22"); assert.equal(review.request.operation.newPractitionerId, "23");
    }
    assert.equal(f.traffic.some(request => request.startsWith("POST /v1/individual_appointments")), false);
  } finally { await f.close(); }
});

test("E2E-360 listing alternatives preserves the original practitioner until a played explicit choice", async () => {
  const f = await reschedulingSessionFixture({ practitionerChoices: ["23"], practitionerMoves: [move] });
  try {
    await source(f); resultValue(await f.readMenu("practitioners")); await f.playPending();
    resultValue(await f.readMenu("offers")); assert.match((await f.state()).callerMessages.at(-1)!, /Physiotherapy with Demo Practitioner/);
    await f.playPending(); resultValue(await f.selectMenu("offers"));
    const action = Object.values((await f.state()).actions)[0]!;
    assert.equal(action.mutation.request.kind, "reschedule");
    if (action.mutation.request.kind === "reschedule") assert.equal(action.mutation.request.practitionerChange, undefined);
    assert.equal(f.patches, 0);
  } finally { await f.close(); }
});

for (const invalid of ["unplayed", "pairWithdrawal", "approvalWithdrawal", "inactive", "nameDrift", "permission"] as const) {
  test(`E2E-360 ${invalid} directory choice cannot create a move`, async () => {
    const f = await reschedulingSessionFixture({ practitionerChoices: ["23"], practitionerMoves: [move] });
    try {
      await source(f); resultValue(await f.readMenu("practitioners"));
      if (invalid !== "unplayed") await f.playPending();
      if (invalid === "pairWithdrawal") await f.replacePolicy({ practitionerMoves: [] });
      if (invalid === "approvalWithdrawal") await f.replacePractitioner("23", { enabled: false });
      if (invalid === "inactive") f.setFailure("inactive");
      if (invalid === "nameDrift") f.setFailure("name");
      if (invalid === "permission") f.sessionConfig.permission.allows = async () => false;
      await f.selectMenu("practitioners", 2);
      assert.equal(Object.keys((await f.state()).actions).length, 0); assert.equal(f.patches, 0); assert.equal(f.recalls.length, 0);
    } finally { await f.close(); }
  });
}

test("E2E-360 caller name and ordinal map only to a current played directory page", async () => {
  const f = await reschedulingSessionFixture({ practitionerChoices: ["23"], practitionerMoves: [move] });
  try {
    await source(f);
    const query = { scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.config.policyVersion,
      turnId: "directory", now: verificationNow, stage: "practitioners" as const, signal: f.lifetime.signal,
      from: "2026-10-08", to: "2026-10-08", priorTurnId: "select-targets" };
    const read = resultValue(await f.owner.effects.readReschedulingMenu(query)); assert.equal(read.stage, "practitioners");
    if (read.stage !== "practitioners") throw new Error("expected directory");
    const selector = new PlayedPractitionerSelection(); selector.remember("menu-practitioners", read);
    resultValue(await f.readMenu("practitioners"));
    assert.deepEqual(selector.resolve("With Demo Destination please", await f.state(), verificationNow), { kind: "clarify", reason: "menuUnavailable" });
    await f.playPending();
    assert.deepEqual(selector.resolve("With Demo Destination please", await f.state(), verificationNow), { kind: "reschedulingChoice", stage: "practitioners", choice: 2 });
    assert.deepEqual(selector.resolve("Option two", await f.state(), verificationNow), { kind: "reschedulingChoice", stage: "practitioners", choice: 2 });
    assert.deepEqual(selector.resolve("Option two", { ...await f.state(), callId: "another-call" }, verificationNow), { kind: "clarify", reason: "menuUnavailable" });
    assert.equal(selector.resolve("With someone we have not heard", await f.state(), verificationNow), undefined);
    assert.deepEqual(selector.resolve("Option three", await f.state(), verificationNow), { kind: "clarify", reason: "menuAmbiguous" });
  } finally { await f.close(); }
});

test("E2E-360 practitioner pages remain tied to the selected appointment and played previous page", async () => {
  const ids = ["23", "24", "25", "26", "27"];
  const f = await reschedulingSessionFixture({ practitionerChoices: ids, practitionerMoves: ids.map(toPractitionerId => ({ ...move, toPractitionerId })) });
  try {
    await source(f); resultValue(await f.readMenu("practitioners"));
    assert.match((await f.state()).callerMessages.at(-1)!, /Option three, Demo Practitioner 24.*other practitioners/);
    await f.playPending();
    resultValue(await f.agent.submit({ kind: "rescheduling.menu.read.v1", turn: f.turn("directory-page-two", "Other practitioners"),
      stage: "practitioners", nextPractitioners: true, from: "2026-10-08", to: "2026-10-08", now: verificationNow }));
    assert.match((await f.state()).callerMessages.at(-1)!, /Option one, Demo Practitioner 25; Option two, Demo Practitioner 26; Option three, Demo Practitioner 27/);
    assert.doesNotMatch((await f.state()).callerMessages.at(-1)!, /To hear more/);
    await f.playPending(); resultValue(await f.selectMenu("practitioners", 3, "select-second-page"));
    assert.match((await f.state()).callerMessages.at(-1)!, /chosen Demo Practitioner 27/);
    assert.equal(f.patches, 0); assert.equal(Object.keys((await f.state()).actions).length, 0);
  } finally { await f.close(); }
});

test("E2E-360 changing practitioner invalidates all times offered for the previous member", async () => {
  const f = await reschedulingAuthorityFixture({ practitionerChoices: ["23"], practitionerMoves: [move] });
  try {
    const proof = await f.verify(), selected = await f.select(proof), query = f.query(proof, selected.targetRef, selected.offerRef);
    const directory = resultValue(await f.source.practitioners(query));
    assert.equal(await f.source.choosePractitioner(query, "23", directory.choices[1]!.name), true);
    assert.equal((await f.source.resolve(query)).ok, false, "a time offered for the original member must not be reused");
    const fresh = resultValue(await f.source.listOffers(f.scope, proof, "2026-10-08", "2026-10-08", verificationNow));
    assert.notEqual(fresh.choices[0]!.offerRef, selected.offerRef);
    const evidence = resultValue(await f.source.resolve({ ...query, offerRef: fresh.choices[0]!.offerRef }));
    assert.equal(evidence.kind, "reschedule");
    if (evidence.kind === "reschedule") assert.equal(evidence.destinationPractitionerId, "23");
    assert.equal(f.patches, 0);
  } finally { await f.close(); }
});
