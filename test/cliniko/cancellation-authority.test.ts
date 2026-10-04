import assert from "node:assert/strict";
import test from "node:test";
import { concreteCancellationFixture } from "../support/cancellation-authority.ts";
import { cancellationCanaries, cancellationNow } from "../support/standalone-cancellation.ts";

test("E2E-276 actual protected selection, current owner policy and fresh target reach SAM confirmation/review/one cancellation", async () => {
  const f = await concreteCancellationFixture();
  try {
    assert.equal((await f.source.list(f.scope, "guessed-proof", cancellationNow, "2026-10-09T04:00:00.000Z", cancellationNow)).ok, false);
    assert.equal(f.traffic.length, 0);
    const verificationRef = await f.verify(), targetRef = await f.select(verificationRef);
    assert.notEqual(targetRef, "91"); assert.match(targetRef, /^[A-Za-z0-9_-]{32}$/);
    assert.equal((await f.source.resolve(f.query(verificationRef, "91"))).ok, false, "raw provider IDs are not selected call references");
    const proposed = await f.propose(verificationRef, targetRef); assert.ok(proposed.ok);
    const action = Object.values((await f.state()).actions)[0]!;
    assert.equal(action.mutation.request.kind, "cancel");
    if (action.mutation.request.kind === "cancel") assert.equal(action.mutation.request.terms.approvedText, f.record.standardTerms.approvedText);
    await f.confirm(); await f.drain(); assert.equal(f.patches, 1); assert.equal(f.recalls.length, 1);
    assert.equal(f.traffic.filter(value => value.startsWith("PATCH ")).length, 1);
    assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
    for (const privateValue of [...cancellationCanaries.slice(0, 2), f.mail[0]!.code]) assert.equal(JSON.stringify(proposed).includes(privateValue), false);
    await f.drain(); assert.equal(f.patches, 1);
  } finally { await f.close(); }
});

test("E2E-276 guessed, cross-call, re-listed and disposed selections cannot resolve or authorize protected targets", async () => {
  const a = await concreteCancellationFixture(), b = await concreteCancellationFixture({ scope: a.scope });
  try {
    const ref = await a.verify(), selected = await a.select(ref), query = a.query(ref, selected);
    assert.equal((await b.source.resolve({ ...query, callId: b.callId, sessionId: b.sessionId })).ok, false);
    for (const bad of [{ ...query, callId: "other" }, { ...query, patientId: "43" }, { ...query, verificationRef: "other-proof" },
      { ...query, scope: { ...a.scope, locationId: "other" } }, { ...query, policyVersion: "other" }, { ...query, now: "2026-10-04T04:01:00.000Z" }]) {
      assert.equal((await a.source.resolve(bad)).ok, false);
    }
    await a.select(ref); assert.equal((await a.source.resolve(query)).ok, false);
    const fresh = await a.select(ref); a.source.dispose(); assert.equal((await a.source.resolve(a.query(ref, fresh))).ok, false);
    assert.equal(a.patches + b.patches, 0);
  } finally { await a.close(); await b.close(); }
});

test("E2E-276 numbered appointment choice uses the played SAM list, fresh target, one selection and exact cancellation", async () => {
  const f = await concreteCancellationFixture({ multiple: true });
  try {
    const ref = await f.verify();
    const shown = await f.reception.checkAppointments(f.scope, { callId: f.callId, sessionId: f.sessionId,
      turnId: "list-options", text: "Which appointments can I cancel?", quality: "clear", at: cancellationNow }, ref,
      cancellationNow, "2026-10-09T04:00:00.000Z", cancellationNow); assert.ok(shown.ok);
    // Use the actual pending presentation rather than manufacturing played state.
    const presentation = (await f.state()).pendingPresentationId!; assert.ok(presentation);
    assert.ok((await f.runtime.startPresentation(f.callId, presentation, f.sessionId, cancellationNow)).ok);
    assert.ok((await f.runtime.resolvePresentation(f.callId, presentation, "played", f.sessionId, cancellationNow)).ok);
    const selected = await f.reception.selectAppointment(f.scope, { callId: f.callId, sessionId: f.sessionId,
      turnId: "choose-one", text: "The first appointment", quality: "clear", at: cancellationNow }, ref, 1, cancellationNow); assert.ok(selected.ok);
    assert.equal((await f.state()).appointmentReads.at(-1)?.shownCount, 1);
    assert.equal((await f.source.select(f.scope, ref, 1, cancellationNow)).ok, false, "one choice is consumed");
    assert.equal(f.patches, 0);
    assert.ok((await f.propose(ref, "selected")).ok); await f.confirm(); await f.drain();
    assert.equal(f.patches, 1); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
  } finally { await f.close(); }
});

test("E2E-276 target/location/timezone/status/link/response changes and revoked permission reject the fresh target", async () => {
  for (const failure of ["patient", "business", "foreignLink", "time", "archive", "cancelled", "missingField", "server", "oversize", "timeZone", "businessArchive", "permission"] as const) {
    const f = await concreteCancellationFixture();
    try {
      const ref = await f.verify(), target = await f.select(ref);
      if (failure === "permission") f.revoke(); else f.setFailure(failure);
      assert.equal((await f.source.resolve(f.query(ref, target))).ok, false); assert.equal(f.patches, 0);
      assert.equal(f.recalls.length, 0);
    } finally { await f.close(); }
  }
});

test("E2E-276 policy, membership, selected target and provider metadata changes after played confirmation cannot send", async () => {
  for (const change of ["terms", "reason", "disabled", "membership", "time", "type", "practitioner", "cancellationOff", "stop", "permission"] as const) {
    const f = await concreteCancellationFixture();
    try {
      const ref = await f.verify(), target = await f.select(ref); assert.ok((await f.propose(ref, target)).ok); await f.confirm();
      f.setOnRecall(async () => {
        if (change === "terms") await f.replacePolicy({ standardTerms: { ...f.record.standardTerms, version: "changed" } });
        if (change === "reason") await f.replacePolicy({ cancellationReason: 60 });
        if (change === "disabled") await f.replacePolicy({ enabled: false });
        if (change === "membership") await f.replaceAccount([{ ...f.account, membershipVersion: "revoked" }]);
        if (change === "cancellationOff") assert.ok((await f.policy.changeCancellationEnabled(f.scope, "1", false, "synthetic-admin")).ok);
        if (change === "stop") assert.ok((await f.ledger.stopWrites(f.scope, "synthetic-admin", "stop")).ok);
        if (change === "permission") f.revoke();
        if (["time", "type", "practitioner"].includes(change)) f.setFailure(change);
      });
      await f.drain(); assert.equal(f.recalls.length, 1); assert.equal(f.patches, 0);
      assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed");
    } finally { await f.close(); }
  }
});

test("E2E-276 held target reads time out or close without late authority, mutation or restored selection", async () => {
  for (const close of [false, true]) {
    const f = await concreteCancellationFixture({ timeoutMs: 100 });
    try {
      const ref = await f.verify(), target = await f.select(ref); f.setHold(true);
      const pending = f.source.resolve(f.query(ref, target));
      if (close) f.source.dispose();
      assert.equal((await pending).ok, false); f.release();
      await new Promise<void>(resolve => setImmediate(resolve));
      if (close) assert.equal((await f.source.resolve(f.query(ref, target))).ok, false);
      assert.equal(f.patches, 0);
    } finally { await f.close(); }
  }
});

test("E2E-277 crossing the fee notice boundary after confirmation cannot send using the old fee wording", async () => {
  const f = await concreteCancellationFixture({ startsAt: "2026-10-05T04:00:00.000Z" });
  try {
    const ref = await f.verify(), target = await f.select(ref); assert.ok((await f.propose(ref, target)).ok);
    const request = Object.values((await f.state()).actions)[0]!.mutation.request;
    assert.equal(request.kind, "cancel"); if (request.kind === "cancel") assert.equal(request.terms.version, "standard-1");
    await f.confirm(); f.setOnRecall(async () => { f.setSourceTime("2026-10-04T04:00:00.001Z"); }); await f.drain();
    assert.equal(f.recalls.length, 1); assert.equal(f.patches, 0);
    assert.equal(f.traffic.some(value => value.startsWith("PATCH ")), false);
    assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed");
  } finally { await f.close(); }
});
