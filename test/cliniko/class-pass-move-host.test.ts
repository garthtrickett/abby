import assert from "node:assert/strict";
import test from "node:test";
import { classMoveFixture } from "../support/class-move.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

type Fixture = Awaited<ReturnType<typeof classMoveFixture>>;
async function confirm(f: Fixture, key: string, digest: string) {
  await f.play();
  resultValue(await f.reception.affirm(f.scope, f.turn("yes", "Yes"), key, digest, f.config.clock()));
  resultValue(await f.reception.drain(f.scope, f.callId, f.config.clock()));
  const state = await f.state();
  if (state.actions[key]?.status === "awaitingConfirmation") {
    assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
    const p = state.presentations[state.pendingPresentationId!]!;
    assert.ok("approvedText" in p); const seconds = /about (\d+) seconds/.exec(p.approvedText)?.[1]; assert.ok(seconds, p.approvedText);
    await f.play(); await f.pause(Number(seconds));
    resultValue(await f.reception.affirm(f.scope, f.turn("yes-again", "Yes"), key, digest, f.config.clock()));
    resultValue(await f.reception.drain(f.scope, f.callId, f.config.clock()));
  }
}
for (const differentService of [false, true]) for (const differentCase of [false, true])
  test(`E2E-410 ordinary SAM pass movement service=${differentService} case=${differentCase} binds played terms, actual native association and exact pass effects`, async () => {
    const f = await classMoveFixture(differentService, false, { differentCase, full: !differentCase });
    try {
      await f.verify(); const action = await f.prepare(); const presentation = (await f.state()).presentations[action.presentationId]!;
      assert.ok("approvedText" in presentation); assert.match(presentation.approvedText, differentCase ? /original pass releases one session.*destination pass uses one session/ : /pass session use unchanged/);
      assert.match(presentation.approvedText, /staff may need to confirm the replacement/); assert.equal(f.writes.length, 0);
      await confirm(f, action.key, action.digest);
      const state = await f.state(); assert.equal(state.actions[action.key]!.status, "committed", JSON.stringify({ claims: f.claims, windows: f.windowClaims, writes: f.writes.map(w => w.path), messages: state.callerMessages.slice(-2), steps: f.steps }));
      assert.deepEqual(f.writes.map(w => w.path), ["/v1/attendees", "/v1/attendees/101/cancel", "/v1/attendees/401"]);
      assert.deepEqual(f.writes[2]!.body, { patient_case_id: f.movePass!.destinationCaseId });
      const review = resultValue(decodeClinikoReview(f.recalls[0]!.notes)); assert.ok(review.request.operation.kind === "classMove"); assert.equal(review.request.operation.pass!.source.effect, "releaseOne");
      assert.ok(f.windowClaims.every(n => n <= 180), JSON.stringify(f.windowClaims));
      for (const secret of [f.movePass!.sourceCaseId, f.movePass!.destinationCaseId, "private-move-source-entitlement", "private-move-destination-entitlement", "synthetic-private-move-pass-note"])
        assert.equal(JSON.stringify([state.callerMessages, state.actions, state.presentations]).includes(secret), false);
      for (const secret of verificationCanaries) assert.equal(JSON.stringify([state.callerMessages, state.presentations]).includes(secret), false);
    } finally { await f.close(); }
  });
for (const effect of ["unchanged", "consumeOne"] as const) test(`E2E-410 ordinary SAM movement states the approved ${effect} extra-use effect before any native write`, async () => {
  const f = await classMoveFixture(false, false, { effect });
  try {
    await f.verify(); const action = await f.prepare(); const p = (await f.state()).presentations[action.presentationId]!; assert.ok("approvedText" in p);
    assert.match(p.approvedText, effect === "unchanged" ? /uses one additional pass session/ : /uses two additional pass sessions/);
    await confirm(f, action.key, action.digest); assert.equal((await f.state()).actions[action.key]!.status, "committed");
  } finally { await f.close(); }
});
test("E2E-410 pass terms not played cannot dispatch review, staging or pass association", async () => {
  const f = await classMoveFixture(false, false, { full: true });
  try { await f.verify(); const action = await f.prepare(); await f.reception.affirm(f.scope, f.turn("unplayed-yes", "Yes"), action.key, action.digest, f.config.clock());
    assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0); }
  finally { await f.close(); }
});
for (const fault of ["authority", "entitlement", "caseRule", "depleted", "moveTerms", "sourceApproval", "patientPermission"] as const)
  test(`E2E-410 ${fault} after played proposal cannot start pass movement or silently choose another case`, async () => {
    const f = await classMoveFixture(false, false, { full: true });
    try {
      await f.verify(); const action = await f.prepare();
      if (fault === "authority") f.movePass!.deny();
      if (fault === "entitlement") { const selected = f.movePass!.selection(); f.movePass!.select({ ...selected, destination: { ...selected.destination, entitlementRef: "other-pass" } }); }
      if (fault === "caseRule") f.movePass!.records[f.movePass!.sourceCaseId]!.include_cancelled_attendees = true;
      if (fault === "depleted") f.movePass!.records[f.movePass!.sourceCaseId]!.max_sessions = 1;
      if (fault === "moveTerms") {
        const current = resultValue(await f.config.movePolicy.current(f.scope));
        await f.replaceMove({ passMovement: { ...current.passMovement!, version: "changed-pass-terms" } });
      }
      if (fault === "sourceApproval") await f.replaceSource({ enabled: false });
      if (fault === "patientPermission") f.setPermitted(false);
      await f.play();
      await f.pause(61); // The ordinary quota window resets without weakening any claim.
      await f.reception.affirm(f.scope, f.turn("yes", "Yes"), action.key, action.digest, f.config.clock());
      await f.reception.drain(f.scope, f.callId, f.config.clock());
      assert.equal(f.writes.length, 0); assert.notEqual((await f.state()).actions[action.key]!.status, "committed");
      assert.equal(f.native.attendees.find(row => row.id === "101")!.cancelled_at, null);
    } finally { await f.close(); }
  });
for (const change of ["permission", "contact"] as const) test(`E2E-410 ${change} revoked inside the compound native observation discards it before any attendance write`, async () => {
  const f = await classMoveFixture(true, false, { differentCase: true });
  try {
    await f.verify(); const action = await f.prepare(); let revoked = false;
    f.movePass!.onRead(() => {
      if (!revoked && f.recalls.length) { revoked = true; if (change === "permission") f.setPermitted(false); else f.setEmail("changed-synthetic-contact@example.test"); }
    });
    await f.play(); await f.pause(61);
    await f.reception.affirm(f.scope, f.turn("yes", "Yes"), action.key, action.digest, f.config.clock());
    await f.reception.drain(f.scope, f.callId, f.config.clock());
    assert.equal(revoked, true); assert.equal(f.writes.length, 0); assert.notEqual((await f.state()).actions[action.key]!.status, "committed");
  } finally { await f.close(); }
});
