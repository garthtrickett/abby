import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import { referenceDefaultPolicy, MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { approvedSyntheticPolicy, withApprovedSyntheticVoice } from "../support/approved-voice.ts";
import { prepareOutboundVoiceEntry, outboundConversationProfileRef } from "../../src/voice/outbound-voice-entry.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";
import type { OutboundContactStopPolicy } from "../../src/voice/outbound-contact-stop.ts";
import { value } from "../support/outbound-records.ts";

const now = "2026-11-01T10:00:00.000Z";
async function fixture(stop: OutboundContactStopPolicy, incoming = false) {
  const scope = { tenantId: randomUUID(), clinicId: "clinic", locationId: "main" }, ledger = new MemoryLedger(async () => ok(true));
  const policy = approvedSyntheticPolicy({ ...referenceDefaultPolicy(scope), automationEnabled: true,
    greeting: { scope, version: "outbound-stop-v1", ownerRef: "clinic-owner", approved: true, approvedText: "Hello, this is Abby calling for the clinic.",
      effectiveFrom: "2026-10-01T00:00:00.000Z", effectiveUntil: "2026-12-01T00:00:00.000Z" } });
  const approval = { purpose: "outboundContact" as const, policy, runtimeConfigurationHash: "a".repeat(64) };
  const entry = value(await prepareOutboundVoiceEntry({ call: { key: { accountRef: "AC" + "1".repeat(32), providerCallRef: "CA" + "2".repeat(32) },
    scope, clinicNumber: "+61255550100", profileRef: outboundConversationProfileRef(approval)! }, ledger,
    source: { read: async () => ok(approval), current: () => true }, readiness: async () => ok(true), now: () => now, signal: new AbortController().signal }));
  let callId: string;
  if (incoming) { callId = entry.callId; value(await ledger.admit(callId, policy, { key: entry.key, dialedNumber: "+61255550100",
    acceptedAt: now, deadline: "2026-11-01T10:00:30.000Z" })); }
  else { const started = value(await entry.begin()); assert.equal(started.kind, "admitted"); if (started.kind !== "admitted") assert.fail(); callId = started.admission.receipt.callId; }
  const reception = new TextReception(ledger, withApprovedSyntheticVoice(new MemoryPolicyStore()), new ReferenceClinicHost([], []));
  let intentCalls = 0;
  const sessionId = randomUUID(), session = new VoiceSession(callId, sessionId, scope, ledger, reception,
    { enqueue: async () => "queued", clear: async () => true }, async () => { intentCalls++; return ok({ kind: "clarify" }); }, undefined, () => 0);
  session.protectOutboundContact(stop);
  const begin = () => session.attach(now);
  const speak = async (parts = ["stop", "calling"]) => {
    const generation = value(await session.speechStarted(now));
    value(session.acceptTranscript({ kind: "partial", sessionId, generation, utteranceId: "one", text: "partial alone is not a stop" }));
    for (const [index, text] of parts.entries())
      value(session.acceptTranscript({ kind: "segmentFinal", sessionId, generation, utteranceId: String(index), text, quality: "clear" }));
    return session.finishTurn(now);
  };
  return { scope, callId, sessionId, ledger, session, begin, speak, get intentCalls() { return intentCalls; } };
}

test("assembled outbound stop fences intent, new speech and delivery before the independent retention wait", async t => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(done => { enter = done; }), held = new Promise<void>(done => { release = done; }); t.after(release);
  const texts: string[] = [];
  const f = await fixture({ retentionDeadlineMs: 5000, inspect: turn => { texts.push(turn.text); return "stop"; },
    retainStop: async () => { enter(); await held; } }); t.after(() => f.ledger.dispose());
  value(await f.begin()); const pending = f.speak(); await entered;
  assert.deepEqual(texts, ["stop calling"]); assert.equal(f.intentCalls, 0); assert.equal(f.session.activeForDelivery(), false);
  assert.equal((await f.session.speechStarted(now)).ok, false); assert.equal((await f.session.dispatchPending(now)).ok, false);
  release(); assert.deepEqual(await pending, { ok: false, error: { kind: "outboundContactStopped" } });
  assert.equal(f.intentCalls, 0); assert.equal(f.session.activeForDelivery(), false);
  const state = value(await f.ledger.read(f.callId, f.scope)); assert.deepEqual(state.processedTurnIds, []); assert.deepEqual(state.actions, {});
});
test("continuing an outbound turn preserves the ordinary intent path without a retention call", async t => {
  let retained = 0;
  const f = await fixture({ retentionDeadlineMs: 100, inspect: () => "continue", retainStop: async () => { retained++; } }); t.after(() => f.ledger.dispose());
  value(await f.begin()); assert.equal((await f.speak(["hello", "clinic"])).ok, true); assert.equal(f.intentCalls, 1); assert.equal(retained, 0);
});
test("classifier failure ends contact without fabricating a positive durable stop", async t => {
  let retained = 0;
  const f = await fixture({ retentionDeadlineMs: 100, inspect: () => { throw Error("Synthetic unavailable recognizer"); }, retainStop: async () => { retained++; } });
  t.after(() => f.ledger.dispose()); value(await f.begin());
  assert.deepEqual(await f.speak(), { ok: false, error: { kind: "outboundContactStopped" } });
  assert.equal(retained, 0); assert.equal(f.intentCalls, 0); assert.equal(f.session.activeForDelivery(), false);
});
test("bounded native retention aborts an unresponsive port and never reopens contact", async t => {
  let signal: AbortSignal | undefined;
  const f = await fixture({ retentionDeadlineMs: 20, inspect: () => "stop", retainStop: async (_turn, active) => {
    signal = active; await new Promise<void>(() => {});
  } }); t.after(() => f.ledger.dispose()); value(await f.begin());
  assert.deepEqual(await f.speak(), { ok: false, error: { kind: "outboundContactStopped" } });
  assert.equal(signal?.aborted, true); assert.equal(f.session.activeForDelivery(), false); assert.equal(f.intentCalls, 0);
});
test("an incoming or legacy admission cannot attach the outbound-only stop policy", async t => {
  const f = await fixture({ retentionDeadlineMs: 100, inspect: () => "stop", retainStop: async () => assert.fail() }, true); t.after(() => f.ledger.dispose());
  assert.deepEqual(await f.begin(), { ok: false, error: { kind: "invalidTransition" } });
});
test("the policy is captured once before attach and cannot be swapped later", async t => {
  let retained = 0;
  const policy = { retentionDeadlineMs: 100, inspect: () => "stop" as const, retainStop: async () => { retained++; } };
  const f = await fixture(policy); t.after(() => f.ledger.dispose());
  assert.throws(() => f.session.protectOutboundContact(policy)); value(await f.begin());
  policy.retainStop = async () => assert.fail("replacement must not execute");
  assert.deepEqual(await f.speak(), { ok: false, error: { kind: "outboundContactStopped" } }); assert.equal(retained, 1);
});
