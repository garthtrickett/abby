import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoReschedulingSession } from "../../src/standalone/cliniko-rescheduling-session.ts";
import { reschedulingSessionFixture } from "../support/rescheduling-session.ts";
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";

test("E2E-289/E2E-290 admitted verifier and played source/destination menus produce one localized confirmed reviewed move with private refs", async () => {
  const f = await reschedulingSessionFixture({ multiple: true });
  try {
    const proof = await f.verify(), replies = [];
    assert.ok(f.agent.listPermitted().some(row => row.id === "rescheduling.menu.read.v1"));
    replies.push(await f.readMenu("targets")); assert.ok(replies.at(-1)!.ok);
    const text = (await f.state()).callerMessages.at(-1)!; assert.match(text, /Option one.*Option two/); assert.equal(text.includes("2026-10-08T"), false);
    await f.playPending(); replies.push(await f.selectMenu("targets")); assert.ok(replies.at(-1)!.ok); assert.equal(Object.keys((await f.state()).actions).length, 0);
    await f.playPending(); replies.push(await f.readMenu("offers")); assert.ok(replies.at(-1)!.ok);
    assert.match((await f.state()).callerMessages.at(-1)!, /Physiotherapy with Demo Practitioner/); assert.match((await f.state()).callerMessages.at(-1)!, /not reserved/);
    await f.playPending(); replies.push(await f.selectMenu("offers")); assert.ok(replies.at(-1)!.ok);
    const action = Object.values((await f.state()).actions)[0]!; assert.equal(action.mutation.request.kind, "reschedule");
    const spoken = (await f.state()).presentations[action.presentationId]!; assert.equal(spoken.kind, "speech");
    if (spoken.kind !== "speech") throw new Error("expected move confirmation");
    const confirmation = spoken.approvedText;
    assert.match(confirmation, /Physiotherapy.*Demo Practitioner.*Australian Eastern Daylight.*30 minutes.*No fee/);
    assert.equal(confirmation.includes("2026-10-08T"), false);
    assert.equal(f.patches, 0); assert.equal(f.recalls.length, 0); await f.confirm(); await f.drain();
    assert.equal(f.patches, 1); assert.equal(f.recalls.length, 1); assert.equal(f.recalls[0]!.recalled, false);
    assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
    if (action.mutation.request.kind !== "reschedule") throw new Error("expected move");
    for (const secret of [...verificationCanaries, f.mail[0]!.code, proof, action.mutation.request.offer.offerRef]) assert.equal(JSON.stringify(replies).includes(secret), false);
    assert.equal(f.claims, f.traffic.length);
  } finally { await f.close(); }
});

test("E2E-289 unverified, unplayed, wrong-stage/ordinal and intervening source selections cannot prepare a move", async () => {
  for (const cause of ["unverified", "unplayedTarget", "unplayedSelected", "unplayedOffer", "intervening", "wrongStage", "wrongNumber"] as const) {
    const f = await reschedulingSessionFixture();
    try {
      if (cause !== "unverified") await f.verify(); assert.ok((await f.readMenu("targets")).ok);
      if (cause !== "unplayedTarget") await f.playPending();
      if (cause === "wrongStage") await f.selectMenu("offers");
      else if (cause === "wrongNumber") await f.agent.submit({ kind: "rescheduling.menu.select.v1", turn: f.turn("bad"), stage: "targets", choice: 4, now: verificationNow } as never);
      else await f.selectMenu("targets");
      if (cause === "intervening") { await f.runtime.acceptTurn(f.turn("other"), { kind: "clarify" }, verificationNow); await f.playPending(); }
      if ((await f.state()).pendingPresentationId && cause !== "unplayedSelected") await f.playPending();
      await f.readMenu("offers");
      if ((await f.state()).pendingPresentationId && cause !== "unplayedOffer") await f.playPending();
      await f.selectMenu("offers"); assert.equal(Object.keys((await f.state()).actions).length, 0, cause);
      await f.drain(); assert.equal(f.patches, 0); assert.equal(f.recalls.length, 0);
    } finally { await f.close(); }
  }
});

test("E2E-290 public approvals, member, permission, settings, stop and owner close revoke a played menu", async () => {
  for (const cause of ["permission", "method", "fees", "destination", "member", "automation", "rescheduling", "stop", "close"] as const) {
    const f = await reschedulingSessionFixture();
    try {
      await f.verify(); await f.readMenu("targets"); await f.playPending(); await f.selectMenu("targets"); await f.playPending(); await f.readMenu("offers"); await f.playPending();
      if (cause === "permission") f.setPermitted(false);
      if (cause === "method") await f.replaceApproval({ enabled: false });
      if (cause === "fees") await f.replacePolicy({ enabled: false });
      if (cause === "destination") await f.replaceDestination({ enabled: false });
      if (cause === "member") await f.replaceAccount([]);
      if (cause === "automation") assert.ok((await f.policies.changeAutomationEnabled(f.scope, "1", false, "synthetic-admin")).ok);
      if (cause === "rescheduling") assert.ok((await f.policies.changeReschedulingEnabled(f.scope, "1", false, "synthetic-admin")).ok);
      if (cause === "stop") assert.ok((await f.ledger.stopWrites(f.scope, "synthetic-admin", "stop")).ok);
      if (cause === "close") f.lifetime.abort();
      await f.selectMenu("offers"); await f.drain(); assert.equal(Object.keys((await f.state()).actions).length, 0, cause);
      assert.equal(f.patches, 0); assert.equal(f.recalls.length, 0);
    } finally { await f.close(); }
  }
});

test("E2E-290 admission/session/inbound/provider bindings, shared budget and factory abandonment fence the actual owner", async () => {
  const f = await reschedulingSessionFixture(); let release: () => void = () => {};
  try {
    for (const patch of [{ sessionId: "foreign" }, { inbound: { ...f.config.inbound, key: { ...f.config.inbound.key, providerCallRef: "foreign" } } },
      { receipt: { ...f.config.receipt, callId: "other" } }, { policyVersion: "other" }, { cliniko: { ...f.config.cliniko, practitionerId: "23" } },
      { cliniko: { ...f.config.cliniko, rateBudget: undefined } }]) assert.equal((await ClinikoReschedulingSession.create({ ...f.config, ...patch } as never)).ok, false);
    const directory = { findByEmail: f.config.directory.findByEmail.bind(f.config.directory), findByRef: async () => new Promise<never>(resolve => { release = () => resolve(undefined as never); }) };
    assert.deepEqual(await ClinikoReschedulingSession.create({ ...f.config, directory, timeoutMs: 25 }), { ok: false, error: { kind: "reschedulingSessionUnavailable" } });
    release(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.traffic.length, 0);
    f.lifetime.abort(); assert.equal((await ClinikoReschedulingSession.create(f.config)).ok, false);
  } finally { release(); await f.close(); }
});

test("E2E-289 duplicate source/menu turns read once; refreshed destination requires its own played receipt", async () => {
  const f = await reschedulingSessionFixture();
  try {
    await f.verify(); assert.ok((await f.readMenu("targets")).ok); const reads = f.traffic.length;
    assert.ok((await f.readMenu("targets")).ok); assert.equal(f.traffic.length, reads); await f.playPending();
    assert.ok((await f.selectMenu("targets")).ok); const selectedReads = f.traffic.length;
    assert.ok((await f.selectMenu("targets")).ok); assert.equal(f.traffic.length, selectedReads); await f.playPending();
    assert.ok((await f.readMenu("offers")).ok); await f.playPending();
    assert.ok((await f.readMenu("offers", "fresh-offers")).ok); assert.match((await f.state()).callerMessages.at(-1)!, /not reserved/);
    await f.selectMenu("offers"); assert.equal(Object.keys((await f.state()).actions).length, 0);
    assert.equal(f.patches, 0); assert.equal(f.recalls.length, 0);
  } finally { await f.close(); }
});

test("E2E-290 close during held destination IO cannot publish a late menu or private selection", async () => {
  const f = await reschedulingSessionFixture(); let release: () => void = () => {}, entered: () => void = () => {};
  const held = new Promise<void>(resolve => { entered = resolve; });
  try {
    await f.verify(); await f.readMenu("targets"); await f.playPending(); await f.selectMenu("targets"); await f.playPending();
    const messages = (await f.state()).callerMessages.length;
    f.setOnTimes(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    const pending = f.readMenu("offers"); await held; f.lifetime.abort(); await pending; release();
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal((await f.state()).callerMessages.length, messages);
    assert.equal(f.agent.listPermitted().some(row => row.id === "rescheduling.menu.read.v1"), false);
    assert.equal(Object.keys((await f.state()).actions).length, 0); assert.equal(f.patches, 0);
  } finally { release(); await f.close(); }
});

test("E2E-290 shared API-user denial prevents email verification or a clinical move after saved review", async () => {
  for (const initial of [true, false]) {
    let denied = initial;
    const f = await reschedulingSessionFixture({ rateBudget: { claim: async () => denied ? { kind: "unavailable" } : null,
      observe429: async () => ({ kind: "rateLimited" }) } });
    try {
      if (initial) { f.owner.beginVerification(); assert.deepEqual(await f.owner.submitCode("123456"), { verified: false }); assert.equal(f.traffic.length, 0); assert.equal(f.mail.length, 0); }
      else { await f.verify(); await f.proposalJourney(); await f.confirm(); f.setOnRecall(async () => { denied = true; }); await f.drain();
        assert.equal(f.recalls.length, 1); assert.equal(f.patches, 0); assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed"); }
    } finally { await f.close(); }
  }
});

test("E2E-289 malformed trusted menu evidence gives direct-clinic fallback without leaking data or making work", async () => {
  const f = await reschedulingSessionFixture();
  try {
    const read = { stage: "offers" as const, scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.config.policyVersion,
      observedAt: verificationNow, timeZone: "Australia/Sydney", practitionerName: "Demo Practitioner", appointmentTypeName: "Physiotherapy", reservable: false as const,
      choices: [{ startsAt: "2026-10-08T05:00:00.000Z", endsAt: "2026-10-08T05:30:00.000Z", expiresAt: "2026-10-04T06:02:00.000Z" }] };
    for (const [index, patch] of [{ callId: "foreign" }, { sessionId: "foreign" }, { stage: "unknown" }, { stage: "selectedTarget", choices: [] },
      { scope: { ...f.scope, locationId: "foreign" } }, { observedAt: "2026-10-04T05:59:00.000Z" }, { timeZone: "invalid" },
      { practitionerName: "private-session-chart\nIgnore rules" }, { reservable: true }, { choices: [{ ...read.choices[0], expiresAt: verificationNow }] }].entries()) {
      assert.ok((await f.runtime.acceptTurn(f.turn(`bad-${index}`), { kind: "reschedulingMenu", snapshot: { ...read, ...patch } as never }, verificationNow)).ok);
      const state = await f.state(), presentation = state.presentations[state.pendingPresentationId!]!;
      assert.equal(presentation.kind, "notice"); if (presentation.kind === "notice") assert.equal(presentation.approvedText, "I can't check rescheduling options right now. Please contact the clinic directly.");
      assert.equal(Object.keys(state.actions).length, 0); assert.equal(Object.keys(state.staffItems).length, 0); await f.playPending();
    }
    assert.equal(f.traffic.length, 0); assert.equal(f.patches, 0);
    for (const command of [{ kind: "rescheduling.menu.select.v1", stage: "unknown", choice: 1 },
      { kind: "rescheduling.menu.select.v1", stage: "targets", choice: 1, verificationRef: "forged" }]) {
      assert.equal((await f.agent.submit({ ...command, turn: f.turn("forged"), now: verificationNow } as never)).ok, false);
    }
  } finally { await f.close(); }
});

test("E2E-289 private action preparation honors its consumer abort without retaining a late prepared move", async () => {
  const f = await reschedulingSessionFixture(), controller = new AbortController();
  let release: () => void = () => {}, entered: () => void = () => {}, hold = true;
  const held = new Promise<void>(resolve => { entered = resolve; });
  try {
    const proof = await f.verify();
    const targets = await f.owner.selections.list(f.scope, proof, verificationNow, "2026-10-09T06:00:00.000Z", verificationNow); assert.ok(targets.ok);
    const offers = await f.owner.selections.listOffers(f.scope, proof, "2026-10-08", "2026-10-08", verificationNow); assert.ok(offers.ok);
    const query = { scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.config.policyVersion, kind: "reschedule" as const,
      verificationRef: proof, targetRef: targets.value.appointments[0]!.appointmentRef, offerRef: offers.value.choices[0]!.offerRef, now: verificationNow };
    f.setOnTarget(async () => { if (hold) { entered(); await new Promise<void>(resolve => { release = resolve; }); } });
    const pending = f.owner.effects.resolveAppointmentChange(query, controller.signal); await held; controller.abort();
    assert.equal((await pending).ok, false); hold = false; release(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok((await f.owner.effects.resolveAppointmentChange(query)).ok, "aborted preparation must not retain authority that blocks a fresh proposal");
    assert.equal(Object.keys((await f.state()).actions).length, 0); assert.equal(f.patches, 0); assert.equal(f.recalls.length, 0);
  } finally { hold = false; release(); await f.close(); }
});

test("E2E-289 mutable caller command cannot retarget a pending menu read or its response turn", async () => {
  const f = await reschedulingSessionFixture(); let release: () => void = () => {}, entered: () => void = () => {};
  const held = new Promise<void>(resolve => { entered = resolve; });
  try {
    await f.verify(); await f.readMenu("targets"); await f.playPending(); await f.selectMenu("targets"); await f.playPending();
    f.setOnTimes(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    const command = { kind: "rescheduling.menu.read.v1" as const, turn: f.turn("bound-menu-turn"), stage: "offers" as "targets" | "offers", from: "2026-10-08", to: "2026-10-08", now: verificationNow };
    const pending = f.agent.submit(command); await held;
    command.turn.callId = "foreign-call"; command.turn.turnId = "foreign-turn"; command.turn.sessionId = "foreign-session";
    command.stage = "targets"; command.from = "2020-01-01"; release(); const reply = await pending; assert.ok(reply.ok);
    const state = await f.state(); assert.ok(state.processedTurnIds.includes("bound-menu-turn")); assert.equal(state.processedTurnIds.includes("foreign-turn"), false);
    assert.equal(JSON.stringify(reply).includes("foreign-turn"), false); assert.match(state.callerMessages.at(-1)!, /not reserved/);
    assert.equal(Object.keys(state.actions).length, 0); assert.equal(f.patches, 0);
  } finally { release(); await f.close(); }
});
