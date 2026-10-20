import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ok } from "../../src/core/model.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { representativeCallOwnerFixture } from "../support/representative-call-owner.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";

test("E2E-386 private representative presentation uses actual voice playback receipts and stores no name or birth-date text", async () => {
  const f = await representativeCallOwnerFixture();
  const sent: { id: string; text: string }[] = [];
  const ledger = new MemoryLedger(async () => ok(true)), runtime = new CallRuntime(ledger, f.f.scope);
  const original = await f.f.state();
  resultValue(await runtime.admit(f.f.callId, original.policy, original.admission!));
  const reception = new TextReception(ledger, f.f.policies, f.flow);
  const greeting = original.policy.greeting!; assert.ok(greeting);
  const voice = new VoiceSession(f.f.callId, f.f.sessionId, f.f.scope, ledger, reception,
    { enqueue: async (id, text) => { sent.push({ id, text }); return "queued"; }, clear: async () => true },
    async () => ok({ kind: "clarify", reason: "changeUnsupported" }), undefined, () => 0, { greeting });
  try {
    resultValue(await voice.attach(verificationNow));
    const opening = resultValue(await voice.dispatchPending(verificationNow)); assert.ok(opening.playbackId);
    resultValue(await voice.acceptPlaybackResult(opening.playbackId, "played", verificationNow));
    const signal = new AbortController(), text = "Private identity example: Synthetic Subject Canaries, 5 March 1982.";
    let settled = false;
    const presenting = voice.presentPrivateRepresentative(text, signal.signal, verificationNow, "book").then(result => { settled = true; return result; });
    const deadline = Date.now() + 5000;
    while (sent.length < 2 && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
    assert.equal(sent.length, 2); assert.equal(sent[1]!.text, text); assert.equal(settled, false);
    const state = resultValue(await ledger.read(f.f.callId, f.f.scope)); assert.equal(JSON.stringify(state).includes("Subject Canaries"), false);
    assert.equal(JSON.stringify(state).includes("5 March 1982"), false);
    const privateNotice = Object.values(state.presentations).find(item => item.status === "started")!;
    assert.equal(privateNotice.kind, "notice"); assert.equal((privateNotice as { approvedText: string }).approvedText, "");
    resultValue(await voice.acceptPlaybackResult(sent[1]!.id, "played", verificationNow)); assert.equal(await presenting, true);
    const failed = voice.presentPrivateRepresentative("Private retry", signal.signal, verificationNow, "book");
    while (sent.length < 3 && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
    assert.equal(sent.length, 3);
    resultValue(await voice.acceptPlaybackResult(sent[2]!.id, "failed", verificationNow)); assert.equal(await failed, false);
    assert.equal(f.mail.length, 0); assert.equal(f.writes, 0);
  } finally { voice.stopTransientWork(); await f.close(); }
});

test("E2E-386 private representative prompt denies a foreign lease and recorded caller identity denial", async () => {
  const f = await representativeCallOwnerFixture();
  try {
    if ((await f.f.state()).pendingPresentationId) await f.play();
    assert.equal((await f.f.runtime.privateRepresentativePrompt(f.f.callId, randomUUID(), "foreign-session", "book", verificationNow)).ok, false);
    resultValue(await f.f.runtime.acceptTurn(f.f.turn("deny", "That is not me"), { kind: "callerIdentityDenied", reason: "identityDisagreement" }, verificationNow));
    assert.equal((await f.f.runtime.privateRepresentativePrompt(f.f.callId, randomUUID(), f.f.sessionId, "book", verificationNow)).ok, false);
    assert.equal(f.mail.length, 0); assert.equal(f.writes, 0);
  } finally { await f.close(); }
});
