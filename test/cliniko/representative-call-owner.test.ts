import { representativeCallOwnerFixture } from "../support/representative-call-owner.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { ClinikoRepresentativeCallOwner } from "../../src/standalone/cliniko-representative-call-owner.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow, verificationCanaries } from "../support/caller-verification.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";


test("E2E-385 private representative call owner retains a separately verified actor through patient selection and one confirmed native booking", async () => {
  const f = await representativeCallOwnerFixture(); let owner: ClinikoRepresentativeCallOwner | undefined;
  try {
    owner = resultValue(await ClinikoRepresentativeCallOwner.create(f.config));
    assert.equal(f.mail.length, 0); assert.equal(owner.beginCallerVerification(), true);
    await f.waitForMail(1); assert.equal(f.mail[0]!.email, verificationCanaries[0]);
    assert.equal((await owner.submitCallerCode(f.mail[0]!.code)).verified, true);
    assert.deepEqual(resultValue(await owner.selectPatient(f.r.identity)), { codeRequired: true });
    assert.equal(f.mail.length, 1); f.flow.beginVerification(); await f.waitForMail(2);
    assert.equal(f.mail[1]!.email, "subject-one-private@example.test");
    assert.equal((await f.flow.submitCode(f.mail[1]!.code)).verified, true);
    const reception = new TextReception(f.f.ledger, f.f.policies, f.flow);
    const agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.f.scope }, f.f.policies, reception, undefined, undefined, undefined, f.f.ledger);
    if ((await f.f.state()).pendingPresentationId) await f.play();
    resultValue(await agent.submit({ kind: "booking.offers.read.v1", turn: f.f.turn("menu"), from: "2026-10-08", to: "2026-10-08", now: verificationNow })); await f.play();
    resultValue(await agent.submit({ kind: "booking.offers.select.v1", turn: f.f.turn("select"), choice: 1, now: verificationNow }));
    const action = Object.values((await f.f.state()).actions)[0]!; assert.ok(action, (await f.f.state()).callerMessages.at(-1)); assert.equal(f.writes, 0);
    await f.play(); resultValue(await reception.affirm(f.f.scope, f.f.turn("affirm", "Yes"), action.key, action.digest, verificationNow));
    await reception.drain(f.f.scope, f.f.callId, verificationNow);
    assert.equal((await f.f.state()).actions[action.key]!.status, "committed"); assert.equal(f.writes, 1);
    const publicText = JSON.stringify(await f.flow.publicIntentContext());
    for (const secret of [f.r.identity.firstName, f.r.identity.lastName, f.r.identity.dateOfBirth, ...f.mail.flatMap(message => [message.email, message.code])]) assert.equal(publicText.includes(secret), false);
    owner.dispose(); assert.equal(owner.closed, true); assert.equal((await owner.submitCallerCode(f.mail[0]!.code)).verified, false);
  } finally { owner?.dispose(); await f.close(); }
});

test("E2E-385 private representative call owner rejects foreign context and a separate rate budget before delivery", async () => {
  for (const fault of ["account", "session", "budget", "caller"] as const) {
    const f = await representativeCallOwnerFixture();
    try {
      const context = { ...f.config.context, cliniko: { ...f.config.context.cliniko }, inbound: { ...f.config.context.inbound } };
      if (fault === "account") context.cliniko.apiKey = "foreign-account-au5";
      if (fault === "session") context.sessionId = "foreign-session";
      if (fault === "budget") context.cliniko.rateBudget = new ClinikoReadBudget(200);
      if (fault === "caller") context.inbound.presentedCallerNumber = "+61499999000";
      assert.equal((await ClinikoRepresentativeCallOwner.create({ ...f.config, context })).ok, false);
      assert.equal(f.mail.length, 0); assert.equal(f.writes, 0);
    } finally { await f.close(); }
  }
});

test("E2E-385 private representative call owner requires fresh caller permission and independently current subject permission", async () => {
  for (const fault of ["unverified", "actor", "subject"] as const) {
    const f = await representativeCallOwnerFixture(); let owner: ClinikoRepresentativeCallOwner | undefined;
    try {
      owner = resultValue(await ClinikoRepresentativeCallOwner.create(f.config));
      if (fault !== "unverified") { owner.beginCallerVerification(); await f.waitForMail(1); assert.equal((await owner.submitCallerCode(f.mail[0]!.code)).verified, true); }
      if (fault === "actor") f.revokeActor();
      if (fault === "subject") f.revokeSubject();
      const selected = await owner.selectPatient(f.r.identity);
      if (fault === "subject") {
        assert.equal(selected.ok, true); f.flow.beginVerification(); assert.equal((await f.flow.submitCode("000000")).verified, false);
      } else assert.equal(selected.ok, false);
      assert.equal(f.mail.length, fault === "unverified" ? 0 : 1); assert.equal(f.writes, 0);
    } finally { owner?.dispose(); await f.close(); }
  }
});
