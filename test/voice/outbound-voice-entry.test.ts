import assert from "node:assert/strict";
import test from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { err, ok } from "../../src/core/model.ts";
import { referenceDefaultPolicy, MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { approvedSyntheticPolicy, syntheticSpeech, withApprovedSyntheticVoice } from "../support/approved-voice.ts";
import { outboundConversationProfileRef, prepareOutboundVoiceEntry } from "../../src/voice/outbound-voice-entry.ts";
import type { OutboundConversationApproval } from "../../src/voice/outbound-voice-entry.ts";
import { ConnectedVoiceCall } from "../../src/voice/connected-voice-call.ts";
import { TwilioConnectedCall } from "../../src/voice/twilio-connected-call.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";
import { callIdFor } from "../../src/voice/admission.ts";
const now = "2026-11-01T10:00:00.000Z", accountSid = `AC${"1".repeat(32)}`, callSid = `CA${"2".repeat(32)}`, streamSid = `MZ${"3".repeat(32)}`;
const scope = { tenantId: "outbound-conversation", clinicId: "clinic", locationId: "main" };
function fixture(ledger = new MemoryLedger()) {
  let current = true;
  const policy = approvedSyntheticPolicy({ ...referenceDefaultPolicy(scope), automationEnabled: true,
    greeting: { scope, version: "outbound-v1", ownerRef: "clinic-owner", approved: true,
      approvedText: "Hello, this is Abby calling on behalf of the clinic.",
      effectiveFrom: "2026-10-01T00:00:00.000Z", effectiveUntil: "2026-12-01T00:00:00.000Z" } });
  const approval: OutboundConversationApproval = { purpose: "outboundContact", policy, runtimeConfigurationHash: "a".repeat(64) };
  const call = { key: { accountRef: accountSid, providerCallRef: callSid }, scope, clinicNumber: "+61255550100", profileRef: outboundConversationProfileRef(approval)! };
  const signal = new AbortController();
  const config = { call, ledger, source: { read: async () => ok(approval), current: () => current },
    readiness: async () => ok(true as const), now: () => now, signal: signal.signal };
  return { policy, approval, call, ledger, config, signal, revoke: () => { current = false; } };
}
test("outgoing entry drives actual Twilio greeting/playback/session closure without an incoming event", async t => {
  const f = fixture(), prepared = await prepareOutboundVoiceEntry(f.config); assert.equal(prepared.ok, true); if (!prepared.ok) return;
  assert.equal(prepared.value.prelocation, undefined);
  const sent: Record<string, unknown>[] = [], spoken: string[] = [];
  const reception = new TextReception(f.ledger, withApprovedSyntheticVoice(new MemoryPolicyStore()), new ReferenceClinicHost([], []));
  const call = new TwilioConnectedCall({ entry: prepared.value, sessionId: "outbound-session", ledger: f.ledger,
    fullFactory: (receipt, session, playback) => new VoiceSession(receipt.callId, session, receipt.scope, f.ledger, reception, playback,
      async () => ok({ kind: "handoff", reason: "callerRequested" })),
    ...syntheticSpeech({ synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } },
      transcription: { accept: async () => ok([]), flush: async () => ok([]) } }),
    streamStartedAt: now, now: () => now, send: json => { sent.push(JSON.parse(json)); return "queued"; } });
  t.after(() => call.disconnect());
  assert.deepEqual(spoken, []);
  assert.equal((await call.receive(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }))).ok, true);
  const started = await call.receive(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
    start: { accountSid, callSid, streamSid, tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } } }));
  assert.equal(started.ok, true, started.ok ? "" : started.error.kind);
  assert.deepEqual(spoken, [f.policy.greeting!.approvedText]); assert.deepEqual(sent.map(v => v.event), ["media", "mark"]);
  const mark = sent[1]!.mark as { name: string };
  assert.equal((await call.receive(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid, mark }))).ok, true);
  const state = await f.ledger.read(callIdFor(f.call.key), scope); assert.equal(state.ok, true);
  if (state.ok) {
    assert.deepEqual(state.value.admission, { direction: "outbound", key: f.call.key, clinicNumber: f.call.clinicNumber,
      acceptedAt: now, deadline: "2026-11-01T10:00:30.000Z" });
    assert.equal(Object.values(state.value.presentations)[0]?.status, "played");
  }
  assert.equal((await call.disconnect()).ok, true);
  const ended = await f.ledger.read(callIdFor(f.call.key), scope); assert.equal(ended.ok, true); if (ended.ok) assert.equal(ended.value.lifecycle, "ended");
});
for (const changed of ["greeting", "speech", "model", "purpose", "scope", "media", "playback"] as const)
  test(`outgoing pinned profile refuses changed ${changed} before a call is admitted`, async () => {
    const f = fixture(), next = structuredClone(f.approval);
    if (changed === "greeting") Object.assign(next.policy, { greeting: { ...next.policy.greeting!, approvedText: "Changed greeting." } });
    if (changed === "speech") Object.assign(next.policy, { voiceProfile: { ...next.policy.voiceProfile!, synthesisVersion: "different" } });
    if (changed === "model") Object.assign(next, { runtimeConfigurationHash: "b".repeat(64) });
    if (changed === "media") Object.assign(next, { mediaOptions: { silenceMs: 200 } });
    if (changed === "playback") Object.assign(next, { playbackOptions: { maxChunks: 4 } });
    if (changed === "purpose") Object.assign(next, { purpose: "incoming" });
    if (changed === "scope") Object.assign(next.policy, { scope: { ...scope, locationId: "other" } });
    const result = await prepareOutboundVoiceEntry({ ...f.config, source: { ...f.config.source, read: async () => ok(next) } });
    assert.equal(result.ok, false); assert.deepEqual(await f.ledger.findAdmission(callIdFor(f.call.key)), { ok: true, value: null });
  });
test("expired or legacy untimed greetings, missing readiness and private descriptor additions refuse", async () => {
  const expired = fixture();
  Object.assign(expired.approval.policy, { greeting: { ...expired.policy.greeting!, effectiveUntil: "2026-10-31T00:00:00.000Z" } });
  expired.call.profileRef = outboundConversationProfileRef(expired.approval)!;
  assert.equal((await prepareOutboundVoiceEntry(expired.config)).ok, false);
  const legacy = fixture();
  const { effectiveFrom: _from, effectiveUntil: _until, ...untimed } = legacy.policy.greeting!;
  Object.assign(legacy.approval.policy, { greeting: untimed }); assert.equal(outboundConversationProfileRef(legacy.approval), undefined);
  const f = fixture(); assert.equal((await prepareOutboundVoiceEntry({ ...f.config, readiness: async () => err({ kind: "readinessFailed", missing: ["voiceProfile"] }) })).ok, false);
  assert.equal((await prepareOutboundVoiceEntry({ ...f.config, call: { ...f.call, recipientNumber: "+61455550999" } as typeof f.call })).ok, false);
});
test("revocation during readiness and ignored-abort policy loading cannot create admission", async () => {
  const f = fixture();
  assert.equal((await prepareOutboundVoiceEntry({ ...f.config, readiness: async () => { f.revoke(); return ok(true as const); } })).ok, false);
  const g = fixture(), pending = prepareOutboundVoiceEntry({ ...g.config, source: { ...g.config.source, read: () => new Promise(() => {}) } });
  g.signal.abort(); assert.equal((await pending).ok, false);
  assert.deepEqual(await g.ledger.findAdmission(callIdFor(g.call.key)), { ok: true, value: null });
});

test("independent approval lost during the real ledger read prevents physical speech binding and retires the session", async () => {
  class WithheldLedger extends MemoryLedger {
    afterRead: (() => void) | undefined;
    override async read(...args: Parameters<MemoryLedger["read"]>) { const result = await super.read(...args); this.afterRead?.(); return result; }
  }
  const ledger = new WithheldLedger(), f = fixture(ledger), prepared = await prepareOutboundVoiceEntry(f.config);
  assert.equal(prepared.ok, true); if (!prepared.ok) return;
  let opened = 0;
  ledger.afterRead = f.revoke;
  const physical = syntheticSpeech({ synthesis: { async *stream() { throw Error("must not synthesize"); } },
    transcription: { accept: async () => ok([]), flush: async () => ok([]) } });
  const call = new ConnectedVoiceCall({ entry: prepared.value, sessionId: "revoked-session", ledger,
    fullFactory: () => { throw Error("must not construct a clinical session"); },
    speech: { create(...args) { opened++; return physical.speech.create(...args); } },
    output: { queueChunk: async () => "queued", finishQueue: async () => "queued", clear: async () => true } });
  assert.equal((await call.begin(now)).ok, false); assert.equal(opened, 0);
  const ended = await ledger.read(callIdFor(f.call.key), scope); assert.equal(ended.ok, true); if (ended.ok) assert.equal(ended.value.lifecycle, "ended");
});

test("outgoing greeting expiry after preparation refuses a stale host-current claim before session admission", async () => {
  const f = fixture(); let at = now;
  Object.assign(f.approval.policy, { greeting: { ...f.approval.policy.greeting!, effectiveUntil: "2026-11-01T10:00:10.000Z" } });
  f.call.profileRef = outboundConversationProfileRef(f.approval)!;
  const prepared = await prepareOutboundVoiceEntry({ ...f.config, now: () => at });
  assert.equal(prepared.ok, true); if (!prepared.ok) return;
  at = "2026-11-01T10:00:20.000Z";
  assert.equal(prepared.value.current?.(), false, "expired approved greeting cannot borrow a stale true from its host port");
  assert.equal((await prepared.value.begin()).ok, false);
  assert.deepEqual(await f.ledger.findAdmission(callIdFor(f.call.key)), { ok: true, value: null });
});

test("provider-terminal selection is explicit and absent fields preserve both prior physical profile projections", () => {
  const f = fixture();
  assert.equal(outboundConversationProfileRef(f.approval), "abby-outbound-v1:f84df2cd02f4cf5cda0b28edd528cbb7a4ace116e42cfaa9b58127e4ca0deaa1");
  assert.equal(outboundConversationProfileRef({ ...f.approval, stopSpeechBinding: "b".repeat(64) }), "abby-outbound-v1:dff8572a07e1c7eb91c75982f364cff3edb4a0b7deb94d77f94f3d87922eebe6");
  const selected = { ...f.approval, terminalObservationBinding: "c".repeat(64) };
  assert.notEqual(outboundConversationProfileRef(selected), outboundConversationProfileRef(f.approval));
  assert.notEqual(outboundConversationProfileRef({ ...selected, terminalObservationBinding: "d".repeat(64) }), outboundConversationProfileRef(selected));
  assert.equal(outboundConversationProfileRef({ ...selected, terminalObservationBinding: "not-a-selection" }), undefined);
});
