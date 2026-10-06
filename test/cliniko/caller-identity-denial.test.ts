import assert from "node:assert/strict";
import test from "node:test";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { bookingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";

test("E2E-319 denial aborts a held Cliniko read and its late response cannot restore a played menu or verification", { timeout: 30_000 }, async () => {
  const f = await bookingCallFlowFixture();
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  let reading: ReturnType<TextReception["readBookingMenu"]> | undefined;
  try {
    const reception = new TextReception(f.ledger, f.policies, f.flow, undefined, undefined, undefined, undefined, () => verificationNow);
    resultValue(await f.flow.choose("book")); f.flow.beginVerification();
    await voiceUntil(() => f.mail.length === 1, "private mail"); assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, true);
    f.setOnTimes(async () => { entered = true; await gate; });
    reading = reception.readBookingMenu(f.scope, f.turn("held-menu", "What times can I book?"), "2026-10-08", "2026-10-08", verificationNow);
    await voiceUntil(() => entered, "held availability read");
    const agent = new CommandGateway({ actorRef: "identity-agent", role: "agent", scope: f.scope }, f.policies, reception);
    resultValue(await agent.submit({ kind: "calls.callerIdentity.deny.v1", turn: f.turn("deny", "That isn't me."), reason: "identityDisagreement", now: verificationNow }));
    const traffic = f.allTraffic.length, mail = f.mail.length;
    assert.equal(f.flow.closed, false); assert.equal(f.flow.verificationRequired, false); assert.equal(f.flow.workflow, undefined);
    release(); const result = await reading; assert.equal(result.ok, false);
    const context = await f.flow.publicIntentContext(); assert.ok(context);
    assert.equal(context.callerIdentityDenied, "identityDisagreement"); assert.equal(context.lastMenu, null); assert.equal(context.lastAction, null);
    assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, false);
    assert.equal(f.flow.beginVerification(), false);
    for (const operation of ["book", "cancel", "reschedule", "appointments.read", "intake"] as const) assert.equal((await f.flow.choose(operation)).ok, false);
    assert.equal(f.allTraffic.length, traffic); assert.equal(f.mail.length, mail);
    assert.equal((await f.state()).availabilityReads.length, 0);
  } finally { release(); await reading; f.flow.dispose(); await f.close(); }
});

test("E2E-319 a scoped agent can deny identity during private OTP collection without accepting the pending code", { timeout: 30_000 }, async () => {
  const f = await bookingCallFlowFixture();
  try {
    const reception = new TextReception(f.ledger, f.policies, f.flow, undefined, undefined, undefined, undefined, () => verificationNow);
    resultValue(await f.flow.choose("book")); f.flow.beginVerification();
    await voiceUntil(() => f.mail.length === 1, "private code email"); assert.equal(f.flow.verificationRequired, true);
    resultValue(await reception.denyCallerIdentity(f.scope, f.turn("deny-private", "This is a shared phone."), "sharedPhone"));
    assert.equal(f.flow.verificationRequired, false); assert.equal(f.flow.closed, false);
    assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, false);
    assert.equal((await f.flow.choose("book")).ok, false); assert.equal(f.mail.length, 1);
    assert.equal((await f.state()).callerIdentityDenied, "sharedPhone");
  } finally { f.flow.dispose(); await f.close(); }
});
