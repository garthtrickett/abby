import assert from "node:assert/strict";
import test from "node:test";
import { TextReception } from "../../src/reference/text-reception.ts";
import { bookingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";

test("E2E-320 a request boundary aborts a held read and a new self workflow cannot inherit its old proof or menu", { timeout: 30_000 }, async () => {
  const f = await bookingCallFlowFixture();
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false, reading: ReturnType<TextReception["readBookingMenu"]> | undefined;
  try {
    const reception = new TextReception(f.ledger, f.policies, f.flow, undefined, undefined, undefined, undefined, () => verificationNow);
    resultValue(await f.flow.choose("book")); f.flow.beginVerification();
    await voiceUntil(() => f.mail.length === 1, "first private mail"); assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, true);
    f.setOnTimes(async () => { entered = true; await gate; });
    reading = reception.readBookingMenu(f.scope, f.turn("held-menu", "What times can I book?"), "2026-10-08", "2026-10-08", verificationNow);
    await voiceUntil(() => entered, "held provider read");
    resultValue(await reception.respondRequestBoundary(f.scope, f.turn("proxy-boundary", "This is for my partner."), "proxyPatient"));
    assert.equal(f.flow.closed, false); assert.equal(f.flow.workflow, undefined); assert.equal(f.flow.verificationRequired, false);
    assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, false);
    release(); assert.equal((await reading).ok, false);
    assert.equal((await f.state()).availabilityReads.length, 0);
    assert.equal((await f.flow.publicIntentContext())?.lastMenu, null);
    resultValue(await f.flow.choose("book")); f.flow.beginVerification();
    await voiceUntil(() => f.mail.length === 2, "fresh private mail");
    assert.equal((await f.flow.submitCode(f.mail[1]!.code)).verified, true);
    assert.equal(f.flow.patientAccessDenied, false);
  } finally { release(); await reading; f.flow.dispose(); await f.close(); }
});
