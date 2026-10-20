import assert from "node:assert/strict";
import test from "node:test";
import { reschedulingAuthorityFixture } from "../support/rescheduling-authority.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

const move = { fromPractitionerId: "22", toPractitionerId: "23", appointmentTypeId: "33", durationMinutes: 30 };
for (const sameTime of [false, true]) test(`E2E-359 approved practitioner change with ${sameTime ? "unchanged" : "changed"} time reaches one inspected in-place move`, async () => {
  const f = await reschedulingAuthorityFixture({ destinationPractitionerId: "23", practitionerMoves: [move], sameTime });
  try {
    const proof = await f.verify(), selected = await f.select(proof);
    const evidence = resultValue(await f.source.resolve(f.query(proof, selected.targetRef, selected.offerRef)));
    assert.equal(evidence.kind, "reschedule"); if (evidence.kind === "reschedule") assert.equal(evidence.destinationPractitionerId, "23");
    resultValue(await f.proposeSelection(proof, selected));
    const state = await f.state(), action = Object.values(state.actions)[0]!; assert.equal(action.kind, "reschedule");
    const presentation = state.presentations[action.presentationId]!; assert.ok(presentation.kind === "speech");
    assert.match(presentation.approvedText, /Demo Destination/);
    assert.doesNotMatch(presentation.approvedText, /appointment with Demo Destination on/);
    if (sameTime) assert.match(presentation.approvedText, /changing the practitioner/);
    assert.equal(f.patches, 0); resultValue(await f.confirm()); await f.drain();
    assert.equal(f.patches, 1); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
    const review = resultValue(decodeClinikoReview(f.recalls[0]!.notes));
    assert.equal(review.request.operation.kind, "reschedule");
    if (review.request.operation.kind === "reschedule") {
      assert.equal(review.request.operation.appointmentId, "91"); assert.equal(review.request.operation.practitionerId, "22");
      assert.equal(review.request.operation.newPractitionerId, "23"); assert.equal(review.request.operation.appointmentTypeId, "33");
    }
    assert.equal(f.traffic.some(request => /POST \/v1\/individual_appointments/.test(request)), false);
    for (const value of [...verificationCanaries.slice(0, 2), f.mail[0]!.code]) assert.equal(JSON.stringify(action).includes(value), false);
    await f.drain(); assert.equal(f.patches, 1);
  } finally { await f.close(); }
});

for (const change of ["unapproved", "reverse", "wrongDestination", "wrongType", "wrongDuration"] as const) test(`E2E-359 ${change} practitioner pair cannot authorize a move`, async () => {
  const pair = { ...move };
  if (change === "reverse") { pair.fromPractitionerId = "23"; pair.toPractitionerId = "22"; }
  if (change === "wrongDestination") pair.toPractitionerId = "24";
  if (change === "wrongType") pair.appointmentTypeId = "34";
  if (change === "wrongDuration") pair.durationMinutes = 60;
  const f = await reschedulingAuthorityFixture({ destinationPractitionerId: "23", ...(change !== "unapproved" ? { practitionerMoves: [pair] } : {}) });
  try {
    const proof = await f.verify(), selected = await f.select(proof);
    assert.equal((await f.source.resolve(f.query(proof, selected.targetRef, selected.offerRef))).ok, false); assert.equal(f.patches, 0);
  } finally { await f.close(); }
});

for (const change of ["withdrawn", "destination", "inactive", "relationship", "name", "permission", "lost"] as const) test(`E2E-359 ${change} after practitioner proposal preserves one-send and uncertainty rules`, async () => {
  const f = await reschedulingAuthorityFixture({ destinationPractitionerId: "23", practitionerMoves: [move], lostMove: change === "lost" });
  try {
    const proof = await f.verify(), selected = await f.select(proof); resultValue(await f.proposeSelection(proof, selected));
    f.setOnRecall(async () => {
      if (change === "withdrawn") await f.replacePolicy({ practitionerMoves: [] });
      else if (change === "destination") await f.replaceDestination({ approved: false });
      else if (change === "permission") f.setPermitted(false);
      else if (change !== "lost") f.setFailure(change);
    });
    resultValue(await f.confirm()); await f.drain(); assert.equal(f.patches, change === "lost" ? 1 : 0);
    assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed");
    await f.drain(); assert.equal(f.patches, change === "lost" ? 1 : 0);
  } finally { await f.close(); }
});

for (const change of ["duplicate", "samePractitioner", "unknownKey", "oversized"] as const) test(`E2E-359 malformed ${change} approval cannot grant practitioner movement`, async () => {
  const f = await reschedulingAuthorityFixture({ destinationPractitionerId: "23", practitionerMoves: [move] });
  try {
    const proof = await f.verify(), selected = await f.select(proof);
    const invalid = change === "duplicate" ? [move, move] : change === "samePractitioner" ? [{ ...move, toPractitionerId: "22" }] :
      change === "unknownKey" ? [{ ...move, grantAnyPractitioner: true }] : Array.from({ length: 73 }, () => move);
    await f.replacePolicy({ practitionerMoves: invalid });
    assert.equal((await f.source.resolve(f.query(proof, selected.targetRef, selected.offerRef))).ok, false); assert.equal(f.patches, 0);
  } finally { await f.close(); }
});
