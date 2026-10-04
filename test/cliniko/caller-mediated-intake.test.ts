import assert from "node:assert/strict";
import test from "node:test";
import { callIdFor } from "../../src/voice/admission.ts";
import { ClinikoIntakeSession } from "../../src/standalone/cliniko-intake-session.ts";
import { callerMediatedRecoveryText } from "../../src/standalone/owner-file-intake-policy.ts";
import { intakeDeferred, intakeDraft, intakeNow } from "../support/intake-edge.ts";
import { intakeSessionFixture } from "../support/intake-session.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

// E2E-295 actual admitted private intake -> real gateway/SAM -> provider edge. Remote clinical/mail approval remains synthetic.
test("E2E-295 separate played loss acknowledgment, private exact draft and email code precede SAM confirmation and one inspected create", async () => {
  const f = await intakeSessionFixture();
  try {
    assert.equal((await f.owner.collect(intakeDraft, { privacyAccepted: true, intakeAccepted: true })).ok, false);
    const draftRef = await f.prepare(); assert.ok(f.presented[0]!.includes(callerMediatedRecoveryText));
    for (const value of Object.values(intakeDraft)) assert.ok(f.presented[1]!.includes(value));
    const progress = await f.propose(draftRef); assert.ok(progress.ok);
    for (const value of [...Object.values(intakeDraft), f.mail[0]!.code]) assert.equal(JSON.stringify(progress).includes(value), false);
    assert.equal(f.posts, 0); assert.equal((await f.confirm(false)).ok, false, "separate SAM playback is required");
    resultValue(await f.confirm()); resultValue(await f.drain());
    const state = await f.state(), action = Object.values(state.actions)[0]!;
    assert.equal(action.status, "committed"); assert.equal(action.hostRef, "cliniko:patient:42"); assert.equal(f.posts, 1); assert.equal(f.claims, 3);
    assert.equal(state.callerMessages.at(-1), "Your details were saved. No appointment is confirmed yet.");
    assert.deepEqual(state.staffItems, {}); assert.ok(f.row); assert.ok(f.permissionDrafts.length >= 4);
    resultValue(await f.drain()); await f.propose(draftRef, "repeat"); resultValue(await f.drain()); assert.equal(f.posts, 1);
  } finally { await f.close(); }
});

test("E2E-295 interrupted terms, denied or foreign loss acknowledgment and missing privacy/intake consent cannot collect or mail", async () => {
  const interrupted = await intakeSessionFixture();
  try { interrupted.setPlayed(false); assert.equal((await interrupted.owner.begin()).ok, false); assert.equal(interrupted.mail.length, 0); assert.equal(interrupted.posts, 0); }
  finally { await interrupted.close(); }
  for (const denial of ["foreign", "false", "privacy", "intake"] as const) {
    const f = await intakeSessionFixture();
    try {
      const begun = resultValue(await f.owner.begin());
      assert.equal(await f.owner.acknowledgeRecovery(denial === "foreign" ? "foreign" : begun.recoveryRef, denial !== "false"), !["foreign", "false"].includes(denial));
      assert.equal((await f.owner.collect(intakeDraft, { privacyAccepted: denial !== "privacy", intakeAccepted: denial !== "intake" })).ok, false);
      assert.equal(f.mail.length, 0); assert.equal(f.traffic.length, 0);
    } finally { await f.close(); }
  }
});

test("E2E-295 correction destroys old draft/code, invalid corrections revoke usable work and proxy/minor/foreign phones stay denied", async () => {
  const f = await intakeSessionFixture();
  try {
    const old = await f.prepare();
    const replacement = resultValue(await f.owner.collect({ ...intakeDraft, firstName: "CorrectedCaller" }, { privacyAccepted: true, intakeAccepted: true }));
    assert.notEqual(replacement.draftRef, old);
    assert.equal((await f.owner.resolveIntake({ scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: "policy-1", draftRef: old, now: intakeNow })).ok, false);
    assert.equal((await f.owner.collect({ ...intakeDraft, dateOfBirth: "2020-01-01" }, { privacyAccepted: true, intakeAccepted: true })).ok, false);
    assert.equal((await f.owner.submitCode(f.mail.at(-1)!.code)).verified, false); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

test("E2E-295 valid mailbox possession cannot manufacture independent clinical permission or survive expiry/revocation/stop", async () => {
  for (const change of ["permission", "expiry", "approval", "membership", "automation", "stop", "lease", "close"] as const) {
    const f = await intakeSessionFixture();
    try {
      const ref = await f.prepare(); resultValue(await f.propose(ref)); resultValue(await f.confirm());
      if (change === "permission") f.setAllowed(false);
      if (change === "expiry") f.setTime("2026-10-04T12:05:00.000Z");
      if (change === "approval") await f.replaceApproval({ enabled: false });
      if (change === "membership") await f.replaceAccount({ membershipVersion: "new" });
      if (change === "automation") f.changeCurrent({ automationEnabled: false });
      if (change === "stop") resultValue(await f.ledger.stopWrites(f.scope, "admin", "stop"));
      if (change === "lease") f.setTime("2026-10-04T12:00:31.000Z");
      if (change === "close") f.lifetime.abort();
      await f.drain(); assert.equal(f.posts, 0, change);
    } finally { await f.close(); }
  }
});

test("E2E-295 candidates deny creation and possible-create loss/read mismatch never claims a staff request or retries", async () => {
  for (const mode of ["one", "ambiguous", "lost", "readMismatch", "revokedAfterSend"] as const) {
    const f = await intakeSessionFixture();
    try {
      const ref = await f.prepare();
      if (mode === "one" || mode === "ambiguous") f.setCandidates(mode === "one" ? 1 : 2);
      if (mode === "lost") f.setLoss();
      if (mode === "readMismatch") f.setReadMismatch();
      if (mode === "revokedAfterSend") f.onRead(async () => { f.setAllowed(false); });
      resultValue(await f.propose(ref)); resultValue(await f.confirm()); resultValue(await f.drain());
      const state = await f.state(), action = Object.values(state.actions)[0]!;
      if (mode === "one" || mode === "ambiguous") { assert.equal(f.posts, 0); assert.equal(action.status, "rejected"); }
      else {
        assert.equal(f.posts, 1); assert.equal(action.status, "uncertain"); assert.ok(f.row);
        assert.match(state.callerMessages.at(-1)!, /No appointment or staff request is confirmed\. Contact the clinic/);
        assert.equal(state.callerMessages.some(text => text.includes("pending review")), false);
        f.setTime("2026-10-04T12:05:01.000Z"); resultValue(await f.drain());
        assert.deepEqual((await f.state()).staffItems, {}); assert.equal(f.posts, 1);
      }
    } finally { await f.close(); }
  }
});

test("E2E-295 call binding, shared budget and disabled subsequent calls cannot create an owner or inherit old intake work", async () => {
  const f = await intakeSessionFixture();
  try {
    for (const patch of [{ sessionId: "foreign" }, { policyVersion: "foreign" }, { inbound: { ...f.inbound, dialedNumber: "+6125550198" } },
      { cliniko: { ...f.config.cliniko, apiKey: "foreign-au5" } }, { cliniko: { ...f.config.cliniko, rateBudget: undefined } }]) {
      const result = await ClinikoIntakeSession.create({ ...f.config, ...patch } as typeof f.config); if (result.ok) result.value.dispose(); assert.equal(result.ok, false);
    }
    const ref = await f.prepare(); f.changeCurrent({ firstTimeIntakeEnabled: false, firstTimeIntakeVersion: "2", capabilities: { ...(await f.state()).policy.capabilities, intake: "unavailable" } });
    // Raw setting edits apply to later admissions; the captured call's public approval is unchanged.
    resultValue(await f.propose(ref)); resultValue(await f.confirm()); resultValue(await f.drain()); assert.equal(f.posts, 1);
    assert.equal((await ClinikoIntakeSession.create(f.config)).ok, false, "a replacement cannot resume an already proposed registration in the same call");
    const inbound = { ...f.inbound, key: { ...f.inbound.key, providerCallRef: "next-disabled-intake" } }, next = callIdFor(inbound.key);
    const current = resultValue(await f.policies.read(f.scope));
    resultValue(await f.runtime.admit(next, current, { key: inbound.key, dialedNumber: inbound.dialedNumber, acceptedAt: intakeNow, deadline: "2026-10-04T12:00:30.000Z" }));
    resultValue(await f.runtime.activate(next, "next-session", intakeNow));
    const receipt = resultValue(await f.ledger.findAdmission(next))!;
    assert.equal((await ClinikoIntakeSession.create({ ...f.config, inbound, receipt, sessionId: "next-session" })).ok, false);
  } finally { await f.close(); }
});

test("E2E-295 abandoned mail, permission and provider waits cannot reopen closed authority or publish a late receipt", async () => {
  for (const checkpoint of ["mail", "permission", "post"] as const) {
    const f = await intakeSessionFixture(); const entered = intakeDeferred<void>(), release = intakeDeferred<void>();
    try {
      const held = async () => { entered.resolve(); await release.promise; };
      let pending: Promise<unknown>;
      if (checkpoint === "mail") {
        const begun = resultValue(await f.owner.begin()); assert.ok(await f.owner.acknowledgeRecovery(begun.recoveryRef, true));
        f.onMail(held); pending = f.owner.collect(intakeDraft, { privacyAccepted: true, intakeAccepted: true });
      } else {
        const ref = await f.prepare(); resultValue(await f.propose(ref)); resultValue(await f.confirm());
        if (checkpoint === "permission") f.onPermission(held); else f.onPost(held);
        pending = f.drain();
      }
      await entered.promise; f.lifetime.abort(); await pending; release.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(f.posts, checkpoint === "post" ? 1 : 0); assert.equal((await f.owner.submitCode(f.mail.at(-1)!.code)).verified, false);
      const state = await f.state(); assert.equal(Object.values(state.actions).some(action => action.status === "committed"), false);
    } finally { release.resolve(); await f.close(); }
  }
});


test("E2E-295 failed mail, three private answers and held admission checks never grant a prospective patient permission", async () => {
  for (const accepted of [true, false]) {
    const f = await intakeSessionFixture();
    try {
      f.setMailAccepted(accepted); const begun = resultValue(await f.owner.begin()); assert.ok(await f.owner.acknowledgeRecovery(begun.recoveryRef, true));
      resultValue(await f.owner.collect(intakeDraft, { privacyAccepted: true, intakeAccepted: true }));
      for (let i=0; i<3; i++) assert.equal((await f.owner.submitCode("invalid")).verified, false);
      assert.equal((await f.owner.submitCode(f.mail[0]!.code)).verified, false); assert.equal(f.posts, 0);
      assert.equal((await f.owner.resolveIntake({ scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: "policy-1", draftRef: "foreign", now: intakeNow })).ok, false);
      assert.equal((await ClinikoIntakeSession.create({ ...f.config, timeoutMs: 10, policies: { read: () => new Promise(() => {}) } })).ok, false);
    } finally { await f.close(); }
  }
});


test("E2E-295 changing a proposed draft or withdrawing a previously acknowledged loss risk revokes the old SAM mutation", async () => {
  for (const change of ["correction", "withdrawal"] as const) {
    const f = await intakeSessionFixture();
    try {
      const ref = await f.prepare(); resultValue(await f.propose(ref));
      const action = Object.values((await f.state()).actions)[0]!;
      if (change === "correction") assert.equal((await f.owner.collect({ ...intakeDraft, firstName: "ChangedAfterProposal" }, { privacyAccepted: true, intakeAccepted: true })).ok, false);
      else { assert.equal(action.mutation.request.kind, "intake"); const request = action.mutation.request;
        assert.equal(await f.owner.acknowledgeRecovery(request.kind === "intake" ? request.consentRef : "foreign", false), false); }
      resultValue(await f.confirm()); resultValue(await f.drain()); assert.equal(f.posts, 0, change);
      assert.equal(Object.values((await f.state()).actions)[0]!.status, "rejected");
    } finally { await f.close(); }
  }
});

test("E2E-295 renewing the call lease does not renew the original prospective mailbox proof", async () => {
  const f = await intakeSessionFixture();
  try {
    const ref = await f.prepare(); resultValue(await f.propose(ref)); resultValue(await f.confirm());
    for (let seconds = 20; seconds <= 300; seconds += 20) {
      const at = new Date(Date.parse(intakeNow)+seconds*1000).toISOString();
      f.setTime(at); const lease = (await f.state()).sessionLease!;
      resultValue(await f.runtime.renewSession(f.callId, f.sessionId, lease.version, at));
    }
    assert.ok(Date.parse((await f.state()).sessionLease!.expiresAt) > Date.parse("2026-10-04T12:05:00.000Z"));
    resultValue(await f.drain()); assert.equal(f.posts, 0); assert.equal(Object.values((await f.state()).actions)[0]!.status, "rejected");
  } finally { await f.close(); }
});
